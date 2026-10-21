import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { FastagentError } from '../errors.js';

/** Conventional ignored runtime files, in priority order. Never recurses, never reads a shell, and
 * never matches .env.example. A symlink or unexpected entry is still handed to loadExplicitSecrets,
 * which refuses to follow it, so auto-detection cannot smuggle in an untrusted file. */
export async function detectRuntimeEnvFiles(projectPath: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ['.env', '.env.auth']) {
    try { await lstat(resolve(projectPath, name)); found.push(name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FastagentError('DEPLOYMENT_ENV_FILE_INVALID', 'Unable to inspect conventional env files in the project directory.');
    }
  }
  return found;
}

const invalid = () => new FastagentError('DEPLOYMENT_SECRET_FILE_INVALID', 'Use explicit bounded regular env files with unique supported assignments; project-local files must be root .env or .env.* files, never .env.example.');

/** Never reads ambient variables. Project-local secret files must be excluded by staging. */
export async function loadExplicitSecrets(paths: readonly string[], projectPath: string, allowed: readonly string[], sensitive: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const input of paths) {
    const path = resolve(projectPath, input);
    const relativeInside = path === projectPath || path.startsWith(`${projectPath}/`);
    if (relativeInside && (dirname(path) !== projectPath || !/^\.env(?:\..+)?$/.test(basename(path)) || basename(path) === '.env.example')) throw invalid();
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) throw invalid();
      const buffer = Buffer.alloc(64 * 1024 + 1);
      let used = 0;
      while (used < buffer.length) {
        const next = await handle.read(buffer, used, buffer.length - used, used);
        if (!next.bytesRead) break;
        used += next.bytesRead;
      }
      if (used > 64 * 1024 || used !== info.size || (await handle.stat()).size !== info.size) throw invalid();
      const source = buffer.subarray(0, used).toString('utf8');
      const parsed = parseEnv(source);
      sensitive.push(...Object.entries(parsed).flatMap(([key, value]) =>
        // Configuration, not credentials: redacting these would corrupt actionable messages that
        // legitimately mention the origin, the namespace, or the ephemeral-history flag value.
        value === undefined || ['APP_ORIGIN', 'FASTAGENT_SESSION_NAMESPACE', 'FASTAGENT_HISTORY_NAMESPACE', 'FASTAGENT_EPHEMERAL_HISTORY'].includes(key) ? [] : [value]));
      // Runtime secrets are single-line; reject parseEnv's permissive handling of malformed lines.
      const seen = new Set<string>();
      for (const line of source.split(/\r?\n/)) {
        if (/^\s*(?:#.*)?$/.test(line)) continue;
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match || seen.has(match[1]!)) throw invalid();
        seen.add(match[1]!);
        const raw = match[2]!;
        if (/^["'`]/.test(raw) && !new RegExp(`^${raw[0]}[^${raw[0]}]*${raw[0]}\\s*(?:#.*)?$`).test(raw)) throw invalid();
      }
      if (!seen.size || seen.size !== Object.keys(parsed).length) throw invalid();
      for (const [key, value] of Object.entries(parsed)) {
        if (!allowed.includes(key) || Object.hasOwn(values, key) || !value || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
        values[key] = value;
      }
    } catch { throw invalid(); }
    finally { await handle?.close(); }
  }
  return values;
}
