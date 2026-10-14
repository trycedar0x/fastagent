import { FastagentError } from '../errors.js';
import type { RailwayHttpTransport } from './providers/railway.js';

/** Native transport: no redirects, no diagnostics containing private request/response data. */
export function createDeploymentHttp(fetcher: typeof fetch = fetch, timeoutMs = 30_000): RailwayHttpTransport {
  return async (request) => {
    const fail = () => new FastagentError('DEPLOYMENT_HTTP_FAILED', 'HTTPS request failed, timed out, or returned an unsupported bounded JSON response.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || request.signal.aborted ||
          !Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes < 1 || request.maxResponseBytes > 4 * 1024 * 1024) throw fail();
      const response = await fetcher(url, { method: request.method, headers: request.headers, redirect: 'error', signal: controller.signal,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
      if (response.status >= 300 && response.status < 400 || !response.body) throw fail();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > request.maxResponseBytes) throw fail();
        chunks.push(next.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.method === 'GET' && (response.status !== 200 || !body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true)) throw fail();
      return { status: response.status, body };
    } catch { throw fail(); }
    finally { controller.abort(); await reader?.cancel().catch(() => {}); clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
  };
}
