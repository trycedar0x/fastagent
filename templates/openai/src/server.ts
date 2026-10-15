import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { createAuth } from './auth.js';
import { createMemoryHistoryStore, completedHistory, modelContext, HistoryStoreUnavailable,
  HistoryConflict, HistoryNotFound, HistoryCapacityExceeded } from './history-store.js';
import { createRedisHistoryStore } from './redis-history-store.js';
import { streamAgent } from './agent.js';
import { validateRuntimeConfig, type RuntimeConfig } from './config.js';

const chatSchema = z.object({
  message: z.string().min(1).max(4000).refine(value => !!value.trim()),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict();
class HttpError extends Error { constructor(readonly status: number) { super(); } }
const newId = () => randomBytes(32).toString('base64url');
const chatError = { type: 'error', error: 'Chat failed. Please try again.' };

function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const clean = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); };
    const fail = (error: unknown) => { clean(); req.resume(); reject(error); };
    const aborted = () => fail(new HttpError(400));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32768) fail(new HttpError(413));
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400)); }
    };
    const timer = setTimeout(() => fail(new HttpError(408)), 5000);
    req.on('data', data).on('end', end).on('error', fail).on('aborted', aborted);
  });
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function safeStore<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HistoryConflict || error instanceof HistoryNotFound || error instanceof HistoryCapacityExceeded) throw error;
    throw new HistoryStoreUnavailable();
  }
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error());
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Tests/custom runtimes may inject a ChatModel and HistoryStore; standalone uses official SDK/Redis.
export async function createRuntime(config: RuntimeConfig) {
  validateRuntimeConfig(config);
  const store = config.historyStore ?? (config.redisUrl
    ? await createRedisHistoryStore(config.redisUrl, config.historyNamespace!, config.localDev)
    : createMemoryHistoryStore());
  // An injected store is caller-owned; only a store this runtime created is closed when its startup check fails.
  try { await store.check(); } catch { if (config.historyStore === undefined) await store.close(); throw new HistoryStoreUnavailable(); }
  const auth = createAuth(config.apiToken);
  const controllers = new Set<AbortController>();
  let active = 0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    void handle(req, res).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) json(res,
        error instanceof HistoryStoreUnavailable ? 503 : error instanceof HistoryConflict ? 409 :
        error instanceof HistoryNotFound ? 404 : error instanceof HistoryCapacityExceeded ? 429 :
        error instanceof HttpError ? error.status : 500,
        { error: error instanceof HistoryStoreUnavailable ? error.message : 'Request failed.' });
      else res.end(JSON.stringify(chatError) + '\n');
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.maxConnections = 100;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && req.url === '/healthz') {
      await safeStore(() => store.check()); json(res, 200, { ok: true }); return;
    }
    const historyRoute = /^\/api\/conversations\/([A-Za-z0-9_-]{43})$/.exec(path!);
    const chatRoute = path === '/api/chat' && req.method === 'POST';
    if (!chatRoute && !(historyRoute && ['GET', 'DELETE'].includes(req.method ?? ''))) {
      json(res, 404, { error: 'Not found.' }); return;
    }
    // Before body reads, history access, capacity reservation, or model work. No cookie/query auth.
    if (!auth.authorize(req)) { json(res, 401, { error: 'Authentication failed.' }); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== config.origin) {
      json(res, 403, { error: 'Authentication failed.' }); return;
    }
    if (req.url !== path) throw new HttpError(400);
    if (historyRoute) {
      const id = historyRoute[1]!;
      if (req.method === 'GET') {
        const messages = await safeStore(() => store.get(id));
        if (!messages) throw new HistoryNotFound();
        json(res, 200, { conversationId: id, messages });
      } else {
        if (!await safeStore(() => store.delete(id))) throw new HistoryNotFound();
        json(res, 200, { ok: true });
      }
      return;
    }
    if (active >= 4) { json(res, 429, { error: 'Chat temporarily unavailable.' }); return; }
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    res.on('close', abort);
    const timer = setTimeout(() => {
      abort();
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) json(res, 408, { error: 'Request failed.' });
      else res.end(JSON.stringify(chatError) + '\n');
    }, 30000);
    let id: string | undefined;
    const owner = newId();
    let acquired = false;
    try {
      const input = chatSchema.safeParse(await body(req));
      if (!input.success) throw new HttpError(400);
      if (!config.model) { json(res, 503, { error: 'Chat is not configured. Set the server model API key.' }); return; }
      if (controller.signal.aborted) return;
      id = input.data.conversationId ?? newId();
      const previous = await safeStore(() => store.acquire(id!, owner, !input.data.conversationId));
      acquired = true;
      if (controller.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.flushHeaders();
      const send = async (value: unknown) => {
        if (controller.signal.aborted) throw new Error();
        if (!res.write(JSON.stringify(value) + '\n')) await once(res, 'drain', { signal: controller.signal });
      };
      await send({ type: 'conversation', conversationId: id });
      let bytes = 0;
      let reply = '';
      let failed = false;
      const iterator = streamAgent(config.model, modelContext(previous, input.data.message), controller.signal)[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await abortable(iterator.next(), controller.signal);
          if (next.done) break;
          const part = next.value;
          if (part.type === 'error' || part.type === 'abort' || part.type === 'tool-error') { failed = true; break; }
          if (part.type === 'text-delta') {
            bytes += Buffer.byteLength(part.text);
            if (bytes > 65536) { failed = true; break; }
            reply += part.text;
            await send({ type: 'delta', text: part.text });
          }
        }
        if (controller.signal.aborted || !reply.trim()) failed = true;
        if (!failed) {
          const messages = completedHistory(previous, input.data.message, reply);
          // Never start a commit for a request that was already aborted or disconnected.
          if (controller.signal.aborted) failed = true;
          // The commit itself is atomic and cannot be cancelled once it has started, and ownership ends
          // with a successful commit, so a rollback is not possible here. An abort that lands in this
          // sub-atomic window can therefore still store the completed turn, and the response reports the
          // committed turn rather than claiming a failure for history the store holds. The docs state
          // this residual explicitly; closing it requires an atomic rollback operation that preserves the
          // previous messages and their original expiry.
          else if (!await safeStore(() => store.commit(id!, owner, messages))) failed = true;
          if (!failed && controller.signal.aborted) failed = false;
        }
      } catch { failed = true; }
      finally { controller.abort(); void iterator.return?.().catch(() => {}); }
      if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(failed ? chatError : { type: 'done' }) + '\n');
    } finally {
      controller.abort();
      clearTimeout(timer);
      res.off('close', abort);
      // Ownership-checked release cannot undo another instance's lease or a committed turn.
      if (id && acquired) await safeStore(() => store.release(id!, owner)).catch(() => {});
      controllers.delete(controller);
      active--;
    }
  }
  // An injected store is caller-owned: closing it here would destroy state another runtime still uses.
  // The standalone entrypoint always lets the runtime create its store, so production is unaffected.
  return { server, closeStore: config.historyStore === undefined ? () => store.close() : () => Promise.resolve(),
    abortAll() { for (const controller of controllers) controller.abort(); } };
}
