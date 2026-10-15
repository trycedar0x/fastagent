import OpenAI from 'openai';
import { tools, type AgentTool } from './tools.js';
import { contextCharacterLimit, contextMessageLimit } from './history-store.js';

const system = 'You are a helpful chat assistant. Use the temperature conversion tool when appropriate. Never invent external data.';
const toolList = Object.values(tools);

const maxToolSteps = 3;
const maxOutputTokensPerStep = 1024;
// The approved bound applies to the complete request sent to the model: contextMessageLimit messages and
// contextCharacterLimit characters, including the system prompt and any tool turns. Older whole
// user/assistant pairs are dropped from the conversation slice to fit that budget; if the system prompt,
// the current message, and the tool turns alone cannot fit, the request fails without a model call.

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; input: string }[];
}

export interface ModelCall {
  messages: ModelMessage[];
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  tools: AgentTool[];
}

export type ModelPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'error' }
  | { type: 'abort' }
  | { type: 'tool-error' };

export interface ChatModel {
  stream(call: ModelCall): AsyncIterable<ModelPart>;
}

export interface ModelReference {
  provider: 'openai' | 'openrouter';
  model: string;
  apiKeyEnv: 'OPENAI_API_KEY' | 'OPENROUTER_API_KEY';
  baseURL: 'https://api.openai.com/v1' | 'https://openrouter.ai/api/v1';
}

export function resolveModelReference(identifier: string): ModelReference {
  if (/^openai\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150}$/.test(identifier)) {
    return { provider: 'openai', model: identifier.slice(7), apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1' };
  }
  // One leading tilde is an official OpenRouter vendor alias, not an arbitrary URL or the pinned default.
  if (/^openrouter\/~?[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150}$/.test(identifier)) {
    return { provider: 'openrouter', model: identifier.slice(11), apiKeyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' };
  }
  throw new Error('Unsupported model provider or identifier. Use openrouter/<vendor>/<model> or openai/<model> in fastagent.yaml.');
}

export function modelName(identifier: string): string {
  return resolveModelReference(identifier).model;
}

export function selectModelApiKey(identifier: string, environment: Record<string, string | undefined>): string | undefined {
  return environment[resolveModelReference(identifier).apiKeyEnv];
}

export function createModel(identifier: string, apiKey: string | undefined, options: { fetch?: typeof fetch } = {}): ChatModel | undefined {
  const reference = resolveModelReference(identifier);
  if (!apiKey?.trim()) return undefined;
  const client = new OpenAI({ apiKey, baseURL: reference.baseURL, maxRetries: 0, timeout: 30_000, logLevel: 'off', fetch: guardCompletionFetch(options.fetch ?? fetch) });
  return {
    async *stream(call) {
      if (call.abortSignal.aborted) { yield { type: 'abort' }; return; }
      let stream;
      try {
        const request = {
          model: reference.model,
          messages: call.messages.map(toOpenAIMessage),
          ...(call.tools.length ? { tools: call.tools.map(toOpenAITool) } : {}),
          ...(reference.provider === 'openrouter'
            ? { max_tokens: call.maxOutputTokens, ...(call.tools.length ? { provider: { require_parameters: true } } : {}) }
            : { max_completion_tokens: call.maxOutputTokens }),
          stream: true as const,
        };
        stream = await client.chat.completions.create(request, { signal: call.abortSignal, maxRetries: 0, timeout: 30_000 });
      } catch (error) {
        yield call.abortSignal.aborted || isAbort(error) ? { type: 'abort' } : { type: 'error' };
        return;
      }
      const pending = new Map<number, { id: string; name: string; input: string }>();
      let finishReason: string | undefined;
      let hasVisibleContent = false;
      try {
        for await (const chunk of stream) {
          if (call.abortSignal.aborted) { yield { type: 'abort' }; return; }
          if ('error' in chunk) { yield { type: 'error' }; return; }
          const choice = chunk.choices[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
            if (finishReason !== 'stop' && finishReason !== 'tool_calls') { yield { type: 'error' }; return; }
          }
          const delta = choice?.delta;
          if (delta?.content) {
            hasVisibleContent ||= /\S/.test(delta.content);
            yield { type: 'text-delta', text: delta.content };
          }
          for (const tool of delta?.tool_calls ?? []) {
            const current = pending.get(tool.index) ?? { id: '', name: '', input: '' };
            if (tool.id) current.id += tool.id;
            if (tool.function?.name) current.name += tool.function.name;
            if (tool.function?.arguments) current.input += tool.function.arguments;
            pending.set(tool.index, current);
          }
        }
      } catch (error) {
        yield call.abortSignal.aborted || isAbort(error) ? { type: 'abort' } : { type: 'error' };
        return;
      }
      if (call.abortSignal.aborted) { yield { type: 'abort' }; return; }
      if (!finishReason || (finishReason === 'stop' && !hasVisibleContent)
        || (finishReason === 'tool_calls') !== (pending.size > 0)
        || [...pending.values()].some((tool) => !tool.id || !tool.name)) {
        yield { type: 'error' }; return;
      }
      for (const tool of [...pending.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        yield { type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: tool.input };
      }
    },
  };
}

export async function* streamAgent(model: ChatModel, messages: { role: 'user' | 'assistant'; content: string }[], abortSignal: AbortSignal): AsyncIterable<ModelPart> {
  const slice: ModelMessage[] = [...messages];
  const toolTurns: ModelMessage[] = [];
  for (let step = 0; step < maxToolSteps; step++) {
    if (abortSignal.aborted) { yield { type: 'abort' }; return; }
    const request = boundedRequest(slice, toolTurns);
    if (!request) { yield { type: 'error' }; return; }
    const toolCalls: { id: string; name: string; input: string }[] = [];
    let failed: ModelPart | undefined;
    try {
      for await (const part of model.stream({ messages: request, maxOutputTokens: maxOutputTokensPerStep, abortSignal, tools: toolList })) {
        if (part.type === 'text-delta') yield part;
        else if (part.type === 'tool-call') toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
        else { failed = part; break; }
      }
    } catch {
      failed = { type: abortSignal.aborted ? 'abort' : 'error' };
    }
    if (failed) { yield failed; return; }
    if (toolCalls.length === 0) return;
    toolTurns.push({ role: 'assistant', content: '', toolCalls });
    for (const call of toolCalls) {
      const tool = toolList.find((item) => item.name === call.name);
      let parsed: unknown;
      try { parsed = JSON.parse(call.input); } catch { yield { type: 'tool-error' }; return; }
      if (!tool) { yield { type: 'tool-error' }; return; }
      try {
        const result = await tool.execute(parsed);
        toolTurns.push({ role: 'tool', content: JSON.stringify(result), toolCallId: call.id });
      } catch { yield { type: 'tool-error' }; return; }
    }
  }
  yield { type: 'tool-error' };
}

function toOpenAIMessage(message: ModelMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? '' };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.input } })),
    };
  }
  if (message.role === 'system') return { role: 'system', content: message.content };
  return { role: message.role, content: message.content };
}

function toOpenAITool(tool: AgentTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

// The SDK logs malformed thread.* events directly to console even with logging off.
// Chat Completions never uses those events: reject them before the SDK sees payloads.
function guardCompletionFetch(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await transport(input, init);
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const signal = init?.signal;
    const line = new Uint8Array(64 * 1024);
    let length = 0;
    let chunk = new Uint8Array(0);
    let offset = 0;
    let skipLF = false;
    let firstLine = true;
    let ended = false;
    let onAbort: (() => void) | undefined;
    const cleanup = () => { if (onAbort) signal?.removeEventListener('abort', onAbort); };
    const cancel = () => { cleanup(); void reader.cancel().catch(() => {}); };
    const invalidStream = () => new Error('Invalid model stream.');
    const completeLine = (newline: boolean): Uint8Array => {
      let text = new TextDecoder().decode(line.subarray(0, length));
      if (firstLine) { text = text.replace(/^\uFEFF/, ''); firstLine = false; }
      if (text.startsWith('event:')) {
        let event = text.slice(6);
        if (event.startsWith(' ')) event = event.slice(1);
        if (event.startsWith('thread.')) throw invalidStream();
      }
      const result = new Uint8Array(length + (newline ? 1 : 0));
      result.set(line.subarray(0, length));
      if (newline) result[length] = 10;
      length = 0;
      return result;
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        onAbort = () => { ended = true; cancel(); controller.error(invalidStream()); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      },
      async pull(controller) {
        try {
          while (!ended) {
            if (offset === chunk.length) {
              const next = await reader.read();
              if (ended) return;
              if (next.done) {
                const last = length ? completeLine(false) : undefined;
                ended = true; cleanup();
                if (last) controller.enqueue(last);
                controller.close(); return;
              }
              chunk = next.value; offset = 0;
            }
            const start = offset;
            while (offset < chunk.length && chunk[offset] !== 10 && chunk[offset] !== 13) offset++;
            if (skipLF) {
              skipLF = false;
              if (offset === start && chunk[offset] === 10) { offset++; continue; }
            }
            const segment = chunk.subarray(start, offset);
            if (length + segment.length > line.length) throw invalidStream();
            line.set(segment, length); length += segment.length;
            if (offset < chunk.length) {
              skipLF = chunk[offset++] === 13;
              controller.enqueue(completeLine(true)); return;
            }
          }
        } catch {
          if (!ended) { ended = true; cancel(); controller.error(invalidStream()); }
        }
      },
      cancel() { ended = true; cancel(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function boundedRequest(slice: ModelMessage[], toolTurns: ModelMessage[]): ModelMessage[] | undefined {
  const systemMessage: ModelMessage = { role: 'system', content: system };
  for (let start = 0; start <= slice.length - 1; start += 2) {
    const candidate = [systemMessage, ...slice.slice(start), ...toolTurns];
    if (candidate.length <= contextMessageLimit && requestCharacters(candidate) <= contextCharacterLimit) return candidate;
  }
  return undefined;
}

function requestCharacters(messages: ModelMessage[]): number {
  let characters = 0;
  for (const message of messages) {
    characters += message.content.length;
    for (const call of message.toolCalls ?? []) characters += call.input.length;
  }
  return characters;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}
