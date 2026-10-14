import OpenAI from 'openai';
import { tools, type AgentTool } from './tools.js';

const system = 'You are a helpful chat assistant. Use the temperature conversion tool when appropriate. Never invent external data.';
const toolList = Object.values(tools);

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

export function modelName(identifier: string): string {
  if (!/^openai\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150}$/.test(identifier)) {
    throw new Error('Unsupported model provider or identifier. Use openai/<model> in fastagent.yaml.');
  }
  return identifier.slice('openai/'.length);
}

export function createModel(identifier: string, apiKey: string | undefined): ChatModel | undefined {
  const name = modelName(identifier);
  if (!apiKey?.trim()) return undefined;
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
  return {
    async *stream(call) {
      if (call.abortSignal.aborted) { yield { type: 'abort' }; return; }
      let stream;
      try {
        stream = await client.chat.completions.create({
          model: name,
          messages: call.messages.map(toOpenAIMessage),
          tools: call.tools.map(toOpenAITool),
          max_completion_tokens: call.maxOutputTokens,
          stream: true,
        }, { signal: call.abortSignal, maxRetries: 0, timeout: 30_000 });
      } catch (error) {
        yield call.abortSignal.aborted || isAbort(error) ? { type: 'abort' } : { type: 'error' };
        return;
      }
      const pending = new Map<number, { id: string; name: string; input: string }>();
      try {
        for await (const chunk of stream) {
          if (call.abortSignal.aborted) { yield { type: 'abort' }; return; }
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) yield { type: 'text-delta', text: delta.content };
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
      for (const tool of [...pending.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        if (tool.id && tool.name) yield { type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: tool.input };
      }
    },
  };
}

export async function* streamAgent(model: ChatModel, messages: { role: 'user' | 'assistant'; content: string }[], abortSignal: AbortSignal): AsyncIterable<ModelPart> {
  const history: ModelMessage[] = [{ role: 'system', content: system }, ...messages];
  for (let step = 0; step < 3; step++) {
    if (abortSignal.aborted) { yield { type: 'abort' }; return; }
    const toolCalls: { id: string; name: string; input: string }[] = [];
    let failed: ModelPart | undefined;
    try {
      for await (const part of model.stream({ messages: history, maxOutputTokens: 1024, abortSignal, tools: toolList })) {
        if (part.type === 'text-delta') yield part;
        else if (part.type === 'tool-call') toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
        else { failed = part; break; }
      }
    } catch {
      failed = { type: abortSignal.aborted ? 'abort' : 'error' };
    }
    if (failed) { yield failed; return; }
    if (toolCalls.length === 0) return;
    history.push({ role: 'assistant', content: '', toolCalls });
    for (const call of toolCalls) {
      const tool = toolList.find((item) => item.name === call.name);
      let parsed: unknown;
      try { parsed = JSON.parse(call.input); } catch { yield { type: 'tool-error' }; return; }
      if (!tool) { yield { type: 'tool-error' }; return; }
      try {
        const result = await tool.execute(parsed);
        history.push({ role: 'tool', content: JSON.stringify(result), toolCallId: call.id });
      } catch { yield { type: 'tool-error' }; return; }
    }
  }
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

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}
