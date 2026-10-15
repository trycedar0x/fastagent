import { FastagentError } from '../errors.js';

const idPattern = /^[A-Za-z0-9_-]{43}$/;
const maxMessageChars = 4000;
const defaultTimeoutMs = 45_000;
const defaultMaxBytes = 512 * 1024;

export function validateChatUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new FastagentError('CHAT_URL_INVALID', 'Chat URL must be an HTTPS origin, or explicit http://localhost or http://127.0.0.1.', 2); }
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || local)) {
    throw new FastagentError('CHAT_URL_INVALID', 'Chat URL must be an HTTPS origin, or explicit http://localhost or http://127.0.0.1, without credentials, path, query, or fragment.', 2);
  }
  return url;
}

export interface ChatInput {
  url: string;
  token: string;
  message: string;
  conversationId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ChatSuccess {
  conversationId: string;
  text: string;
}

export function validateChatMessage(value: string): string {
  const message = value.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!message.trim() || message.length > maxMessageChars) {
    throw new FastagentError('CHAT_INPUT_INVALID', 'Chat message must be 1–4000 non-blank characters.', 2);
  }
  return message;
}

/** Calls one validated origin. redirect:error prevents the bearer token from following a redirect. */
export async function sendChat(input: ChatInput): Promise<ChatSuccess> {
  const url = validateChatUrl(input.url);
  const message = validateChatMessage(input.message);
  if (input.conversationId !== undefined && !idPattern.test(input.conversationId)) {
    throw new FastagentError('CHAT_CONVERSATION_INVALID', 'Conversation ID must be a server-generated 32-byte base64url value.', 2);
  }
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(input.token)) throw new FastagentError('CHAT_AUTH_INVALID', 'Bearer token from the explicit env file is invalid.');
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const maxBytes = input.maxBytes ?? defaultMaxBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > defaultMaxBytes) {
    throw new FastagentError('CHAT_INPUT_INVALID', 'Invalid chat client bounds.', 2);
  }
  // A signal aborted before dispatch must prevent the request, not merely cancel one already in flight.
  if (input.signal?.aborted) throw new FastagentError('CHAT_CANCELLED', 'Chat cancelled.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (input.fetchImpl ?? fetch)(new URL('/api/chat', url), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify({ message, ...(input.conversationId ? { conversationId: input.conversationId } : {}) }),
      signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) throw statusError(response.status);
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/x-ndjson')) throw new FastagentError('CHAT_FAILED', 'Chat response was not a bounded NDJSON stream.');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new FastagentError('CHAT_FAILED', 'Chat response exceeded the client byte limit.');
      chunks.push(next.value);
    }
    return parseFrames(Buffer.concat(chunks).toString('utf8'), input.conversationId);
  } catch (error) {
    if (error instanceof FastagentError) throw error;
    if (input.signal?.aborted) throw new FastagentError('CHAT_CANCELLED', 'Chat cancelled.');
    throw new FastagentError('CHAT_FAILED', 'Chat request failed, timed out, or was redirected. The bearer token was not sent to another origin.');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}

function statusError(status: number): FastagentError {
  if (status === 401) return new FastagentError('CHAT_UNAUTHORIZED', 'Chat authentication failed.');
  if (status === 404) return new FastagentError('CHAT_NOT_FOUND', 'Conversation was not found.');
  if (status === 409) return new FastagentError('CHAT_CONFLICT', 'Conversation is busy or cannot be changed.');
  if (status === 429) return new FastagentError('CHAT_REJECTED', 'Chat was rejected by a capacity limit.');
  if (status === 503) return new FastagentError('CHAT_UNAVAILABLE', 'Chat service is unavailable.');
  return new FastagentError('CHAT_FAILED', 'Chat request failed.');
}

function parseFrames(body: string, expectedId: string | undefined): ChatSuccess {
  const frames = body.split('\n').filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line) as { type?: unknown; conversationId?: unknown; text?: unknown }; }
    catch { throw new FastagentError('CHAT_FAILED', 'Chat response was not valid NDJSON.'); }
  });
  const first = frames[0];
  if (!first || first.type !== 'conversation' || typeof first.conversationId !== 'string' || !idPattern.test(first.conversationId) ||
      (expectedId && first.conversationId !== expectedId)) {
    throw new FastagentError('CHAT_FAILED', 'Chat response did not start with the server conversation ID.');
  }
  let text = '';
  for (const frame of frames.slice(1, -1)) {
    if (frame.type !== 'delta' || typeof frame.text !== 'string') throw new FastagentError('CHAT_FAILED', 'Chat response contained an unexpected frame.');
    text += frame.text;
    if (Buffer.byteLength(text) > 65536) throw new FastagentError('CHAT_FAILED', 'Chat response exceeded the output limit.');
  }
  const last = frames.at(-1);
  if (!last || last.type !== 'done' || !text.trim()) throw new FastagentError('CHAT_FAILED', 'Chat did not complete.');
  return { conversationId: first.conversationId, text };
}
