import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { z } from 'zod';
import { createAuth } from './auth.js';
import { createMemorySessionStore, SessionStoreUnavailable } from './session-store.js';
import { createRedisSessionStore } from './redis-session-store.js';
import { streamAgent } from './agent.js';
import { validateRuntimeConfig, type RuntimeConfig } from './config.js';

const chatSchema = z.object({ messages: z.array(z.object({
  role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000),
}).strict()).min(1).max(20) }).strict().refine(({ messages }) =>
  messages.at(-1)?.role === 'user' && messages.reduce((n, m) => n + m.content.length, 0) <= 16000);
const loginSchema = z.object({ password: z.string().min(1).max(256) }).strict();
class HttpError extends Error { constructor(readonly status: number) { super(); } }

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

// Tests can inject a ChatModel; standalone startup uses the official OpenAI SDK adapter.
export async function createRuntime(config: RuntimeConfig) {
  validateRuntimeConfig(config);
  const staticFiles = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ].map(async ([path, file, type]) => [path!, { content: await readFile(new URL(`../public/${file}`, import.meta.url)), type: type! }] as const)));
  const store = config.sessionStore ?? (config.redisUrl
    ? await createRedisSessionStore(config.redisUrl, config.sessionNamespace!, config.localDev)
    : createMemorySessionStore());
  try { await store.check(); } catch { await store.close(); throw new SessionStoreUnavailable(); }
  const auth = createAuth(config.passwordHash, !config.localDev, store);
  const controllers = new Set<AbortController>();
  let active = 0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, error instanceof SessionStoreUnavailable ? 503 : error instanceof HttpError ? error.status : 500,
        { error: error instanceof SessionStoreUnavailable ? error.message : 'Request failed.' });
      else res.end();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.maxConnections = 100;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url;
    if (req.method === 'GET' && path === '/healthz') {
      try { await store.check(); } catch { throw new SessionStoreUnavailable(); }
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && staticFiles.has(path ?? '')) {
      const file = staticFiles.get(path!)!;
      res.writeHead(200, { 'Content-Type': file.type }); res.end(file.content); return;
    }
    if (req.method === 'GET' && path === '/api/session') {
      if (req.headers.origin && req.headers.origin !== config.origin) { json(res, 403, { error: 'Authentication failed.' }); return; }
      const session = await auth.session(req, res);
      if (!session) { json(res, 503, { error: 'Authentication failed.' }); return; }
      json(res, 200, { authenticated: session.authenticated, csrf: session.csrf }); return;
    }
    if (req.method !== 'POST' || !['/api/login', '/api/logout', '/api/chat'].includes(path ?? '')) { json(res, 404, { error: 'Not found.' }); return; }
    if (req.headers.origin !== config.origin) { json(res, 403, { error: 'Authentication failed.' }); return; }
    if (path === '/api/login') {
      const input = loginSchema.safeParse(await body(req));
      const session = input.success ? await auth.login(req, res, input.data.password) : undefined;
      if (!session) { json(res, 401, { error: 'Authentication failed.' }); return; }
      json(res, 200, { authenticated: true, csrf: session!.csrf }); return;
    }
    if (!await auth.authorize(req)) { json(res, 401, { error: 'Authentication failed.' }); return; }
    if (path === '/api/logout') {
      if (!await auth.logout(req, res)) { json(res, 401, { error: 'Authentication failed.' }); return; }
      json(res, 200, { ok: true }); return;
    }
    if (active >= 4) { json(res, 429, { error: 'Chat temporarily unavailable.' }); return; }
    // Include slow body readers in the concurrency bound.
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    res.on('close', abort);
    const timer = setTimeout(() => {
      abort();
      if (!res.headersSent) json(res, 408, { error: 'Request failed.' });
      else if (!res.destroyed) res.end(JSON.stringify({ type: 'error', error: 'Chat failed. Please try again.' }) + '\n');
    }, 30000);
    try {
      const input = chatSchema.safeParse(await body(req));
      if (!input.success) throw new HttpError(400);
      if (!config.model) { json(res, 503, { error: 'Chat is not configured. Set the server model API key.' }); return; }
      if (controller.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.flushHeaders();
      const send = async (value: unknown) => {
        if (controller.signal.aborted) throw new Error();
        if (!res.write(JSON.stringify(value) + '\n')) await once(res, 'drain', { signal: controller.signal });
      };
      let bytes = 0;
      let failed = false;
      try {
        for await (const part of streamAgent(config.model, input.data.messages, controller.signal)) {
          if (part.type === 'error' || part.type === 'abort' || part.type === 'tool-error') { failed = true; break; }
          if (part.type === 'text-delta') {
            bytes += Buffer.byteLength(part.text);
            if (bytes > 65536) { failed = true; break; }
            await send({ type: 'delta', text: part.text });
          }
        }
        if (controller.signal.aborted) failed = true;
      } catch { failed = true; }
      if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(failed ? { type: 'error', error: 'Chat failed. Please try again.' } : { type: 'done' }) + '\n');
    } finally {
      controller.abort();
      clearTimeout(timer);
      res.off('close', abort);
      controllers.delete(controller);
      active--;
    }
  }
  return { server, closeStore: () => store.close(), abortAll() { for (const controller of controllers) controller.abort(); } };
}
