import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { FastagentError } from '../errors.js';

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** No ambient inheritance. Put credentials in secretEnv or stdin, never args. */
  env: Readonly<Record<string, string>>;
  secretEnv?: Readonly<Record<string, string>>;
  stdin?: string;
  sensitiveValues?: readonly string[];
  intent: 'read' | 'mutate' | 'destroy';
  authorization?: 'mutation' | 'destruction';
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: 0 }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export type SpawnProcess = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

const secretName = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|REDIS_URL|CREDENTIAL)/i;
const credentialUrl = /[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i;
const invalid = () => new FastagentError('PROCESS_INPUT_INVALID', 'Invalid subprocess request; use explicit environment, argument arrays and authorized mutation intent.');

function secretVariants(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of secrets) {
    if (!value) continue;
    variants.add(value);
    variants.add(JSON.stringify(value).slice(1, -1));
    variants.add(encodeURIComponent(value));
    try {
      const url = new URL(value);
      for (const part of [url.username, url.password]) {
        if (part) { variants.add(part); variants.add(decodeURIComponent(part)); }
      }
    } catch { /* Not every secret is a URL. */ }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/** Redacts exact secrets (including common JSON/URL encodings), not arbitrary transformations. */
export function redactProcessOutput(output: string, secrets: readonly string[]): string {
  for (const value of secretVariants(secrets)) output = output.split(value).join('[REDACTED]');
  // Never return credential-bearing URLs even if the caller omitted a redaction value.
  return output.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/]*@[^\s"']*/gi, '[REDACTED_URL]');
}

export function createProcessRunner(spawnProcess: SpawnProcess = spawn): ProcessRunner {
  return async (request) => {
    const { executable, args, cwd, env, secretEnv = {}, stdin, signal } = request;
    if (!env || !secretEnv || typeof env !== 'object' || typeof secretEnv !== 'object' ||
        Object.values({ ...env, ...secretEnv }).some((value) => typeof value !== 'string') ||
        (stdin !== undefined && (typeof stdin !== 'string' || Buffer.byteLength(stdin) > 1024 * 1024)) ||
        (request.sensitiveValues !== undefined && (!Array.isArray(request.sensitiveValues) || request.sensitiveValues.some((value) => typeof value !== 'string')))) throw invalid();
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024;
    const secrets = [...Object.values(secretEnv), ...(request.sensitiveValues ?? []), ...(stdin ? [stdin] : [])];
    // Treat every line of stdin as sensitive, too (e.g. a provider's KEY=value input).
    if (stdin) {
      for (const line of stdin.split(/\r?\n/)) {
        if (line) secrets.push(line, line.includes('=') ? line.slice(line.indexOf('=') + 1) : line);
      }
      // JSON provider input may echo individual values rather than the whole document.
      for (const match of stdin.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        if (/^\s*:/.test(stdin.slice(match.index + match[0].length))) continue;
        try { secrets.push(JSON.parse(match[0]) as string); } catch { /* Non-JSON stdin. */ }
      }
    }
    const argvSecrets = secretVariants(secrets);
    if (!executable || !cwd || !Array.isArray(args) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 ||
        !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024 ||
        !['read', 'mutate', 'destroy'].includes(request.intent) ||
        (request.intent === 'mutate' && !['mutation', 'destruction'].includes(request.authorization ?? '')) ||
        (request.intent === 'destroy' && request.authorization !== 'destruction') ||
        Object.entries(env).some(([key, value]) => secretName.test(key) || typeof value !== 'string') ||
        Object.keys(secretEnv).some((key) => key in env) ||
        Object.entries({ ...env, ...secretEnv }).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) ||
        [executable, cwd, ...args].some((value) => typeof value !== 'string' || value.includes('\0') || credentialUrl.test(value) ||
          argvSecrets.some((secret) => value.includes(secret)))) throw invalid();
    if (signal?.aborted) throw new FastagentError('PROCESS_ABORTED', 'Subprocess cancelled; mutating operations may have partially completed.');
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = spawnProcess(executable, [...args], { cwd, env: { ...env, ...secretEnv }, shell: false, stdio: 'pipe' }); }
      catch { reject(new FastagentError('PROCESS_START_FAILED', 'Could not start subprocess. Check the installed CLI and explicit environment.')); return; }
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let size = 0, settled = false, failure: string | undefined;
      let killTimer: NodeJS.Timeout | undefined, finishTimer: NodeJS.Timeout | undefined;
      const finish = (code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finishTimer);
        signal?.removeEventListener('abort', abort);
        if (failure || code !== 0) {
          reject(new FastagentError(failure ?? 'PROCESS_FAILED',
            'Subprocess did not complete successfully; inspect provider status before retrying a mutation. Output and command details are withheld.'));
        } else resolve({ exitCode: 0, stdout: redactProcessOutput(Buffer.concat(stdout).toString('utf8'), secrets),
          stderr: redactProcessOutput(Buffer.concat(stderr).toString('utf8'), secrets) });
      };
      const stop = (reason: string) => {
        if (settled || failure) return;
        failure = reason;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 200);
        // A broken child/pipe must not keep the caller waiting indefinitely.
        finishTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); finish(); }, 1000);
      };
      const abort = () => stop('PROCESS_ABORTED');
      const timer = setTimeout(() => stop('PROCESS_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const collect = (chunks: Buffer[], data: Buffer) => {
        size += data.length;
        if (size > maxOutputBytes) { stop('PROCESS_OUTPUT_LIMIT'); return; }
        if (!failure) chunks.push(Buffer.from(data));
      };
      child.stdout.on('data', (data: Buffer) => collect(stdout, data));
      child.stderr.on('data', (data: Buffer) => collect(stderr, data));
      child.stdout.on('error', () => stop('PROCESS_IO_FAILED'));
      child.stderr.on('error', () => stop('PROCESS_IO_FAILED'));
      child.once('error', () => { failure = 'PROCESS_START_FAILED'; finish(); });
      child.once('close', finish);
      child.stdin.on('error', () => stop('PROCESS_STDIN_FAILED'));
      child.stdin.end(stdin ?? '');
    });
  };
}
