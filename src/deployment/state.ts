import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { z } from 'zod';
import { projectNameSchema } from '../config/config.js';
import { FastagentError } from '../errors.js';
import { validateHttpsOrigin, type ProviderName } from './types.js';

export interface DeploymentSelector { projectPath: string; provider: ProviderName; target: string }
const resourceId = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine((value) => !value.includes('..') && !value.includes('//') && !value.includes('://'));
export const deploymentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  projectPath: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value)),
  provider: z.enum(['railway', 'cloudrun']),
  target: projectNameSchema,
  ownershipMarker: z.string().regex(/^[a-f0-9]{32}$/),
  sessionNamespace: projectNameSchema,
  resources: z.array(z.strictObject({
    kind: z.enum(['project', 'environment', 'service', 'secret', 'registry', 'build', 'revision']),
    id: resourceId,
    ownership: z.enum(['owned', 'external']),
  })).max(64),
  selectors: z.strictObject({
    project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).optional(),
    region: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
  }),
  status: z.enum(['pending', 'deploying', 'ready', 'failed', 'destroying']),
  phase: z.enum(['prepared', 'resources-created', 'secrets-configured', 'source-uploaded', 'healthy', 'destroy-pending']),
  url: z.string().max(2048).refine((value) => { try { validateHttpsOrigin(value); return true; } catch { return false; } }).optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;
export interface VerifiedDestruction {
  verified: true;
  succeeded: true;
  ownershipMarker: string;
  /** Every owned identity, encoded as kind:id; external/shared resources are not deleted. */
  resourceIdentities: readonly string[];
}
export interface DeploymentLock {
  readonly selector: DeploymentSelector;
  read(): Promise<DeploymentRecord | undefined>;
  /** revision must be the last read revision (0 for initial creation); write increments it. */
  write(record: DeploymentRecord): Promise<DeploymentRecord>;
  remove(proof: VerifiedDestruction): Promise<void>;
  release(): Promise<void>;
}
const fail = (code = 'DEPLOYMENT_STATE_INVALID') => new FastagentError(code,
  code === 'DEPLOYMENT_LOCKED' ? 'Deployment is locked by another operation; inspect partial resources before manually recovering a stale lock.' :
    'Deployment state is invalid, unsafe or changed concurrently; no resource operation is authorized.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function deploymentKey(selector: DeploymentSelector): string {
  return createHash('sha256').update(JSON.stringify([selector.projectPath, selector.provider, selector.target])).digest('hex');
}
export async function canonicalDeploymentSelector(selector: DeploymentSelector): Promise<DeploymentSelector> {
  if (!['railway', 'cloudrun'].includes(selector.provider) || !projectNameSchema.safeParse(selector.target).success ||
      typeof selector.projectPath !== 'string' || /[\x00-\x1f\x7f]/.test(selector.projectPath)) throw fail();
  try {
    const projectPath = await realpath(resolve(selector.projectPath));
    if (!(await lstat(projectPath)).isDirectory()) throw fail();
    return { projectPath, provider: selector.provider, target: selector.target };
  } catch { throw fail(); }
}
export function validateDeploymentRecord(value: unknown): DeploymentRecord {
  const parsed = deploymentRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.key !== deploymentKey(parsed.data) ||
      new Set(parsed.data.resources.map((resource) => `${resource.kind}:${resource.id}`)).size !== parsed.data.resources.length ||
      (parsed.data.status === 'ready' && (parsed.data.phase !== 'healthy' || !parsed.data.url)) ||
      (parsed.data.status === 'destroying' && parsed.data.phase !== 'destroy-pending') ||
      (parsed.data.provider === 'cloudrun' && parsed.data.resources.some((resource) => resource.kind === 'project' && resource.ownership === 'owned'))) throw fail();
  return parsed.data;
}
/** Use the canonical selector returned by acquire(); customize non-secret selectors before first write. */
export function createDeploymentRecord(selector: DeploymentSelector): DeploymentRecord {
  const marker = randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  return validateDeploymentRecord({ schemaVersion: 1, ...selector, key: deploymentKey(selector), ownershipMarker: marker,
    sessionNamespace: `fa-${marker}`, resources: [], selectors: {}, status: 'pending', phase: 'prepared', revision: 0, createdAt: now, updatedAt: now });
}

async function safeDirectory(directory: string, create = true): Promise<void> {
  if (!isAbsolute(directory) || normalize(directory) !== directory) throw fail();
  // Reject symlink ancestors, even if the final directory itself is private.
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fail(); }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
  }
  const info = await lstat(directory);
  if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fail();
}
async function readPrivateFile(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fail();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let used = 0;
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, used);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used > 64 * 1024 || used !== info.size || (await handle.stat()).size !== info.size) throw fail();
    return buffer.subarray(0, used).toString('utf8');
  } catch (error) { if (missing(error)) return undefined; throw fail(); }
  finally { await handle?.close(); }
}

/** Small local-only store. Locks fail fast and are never automatically stolen after a timeout. */
export class DeploymentStore {
  constructor(readonly directory = join(homedir(), '.fastagent', 'deployments')) {}

  /** Read-only snapshots use atomic record files, not deployment locks or cloud discovery. */
  async list(): Promise<{ records: DeploymentRecord[]; diagnostics: string[] }> {
    try { await safeDirectory(this.directory, false); }
    catch (error) { if (missing(error)) return { records: [], diagnostics: [] }; throw fail(); }
    const records: DeploymentRecord[] = [], diagnostics: string[] = [];
    let entries = 0, candidates = 0, skipped = 0;
    const directory = await opendir(this.directory);
    for await (const entry of directory) {
      if (++entries > 1000) { diagnostics.push('Local state entry limit (1000) reached; snapshot is incomplete.'); break; }
      if (!entry.name.endsWith('.json')) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) { skipped++; continue; }
      if (++candidates > 100) { diagnostics.push('Local deployment limit (100) reached; snapshot is incomplete.'); break; }
      try {
        const text = await readPrivateFile(join(this.directory, entry.name));
        if (text === undefined) continue; // Concurrent verified destruction.
        const record = validateDeploymentRecord(JSON.parse(text));
        if (`${record.key}.json` !== entry.name) throw fail();
        records.push(record);
      } catch { skipped++; }
    }
    await safeDirectory(this.directory, false);
    if (skipped) diagnostics.push(`Skipped ${skipped} invalid or unsafe local deployment record(s); no cloud operation authorized for them.`);
    return { records: records.sort((a, b) => a.key.localeCompare(b.key)), diagnostics };
  }

  async read(input: DeploymentSelector): Promise<DeploymentRecord | undefined> {
    const selector = await canonicalDeploymentSelector(input);
    try { await safeDirectory(this.directory, false); }
    catch (error) { if (missing(error)) return undefined; throw fail(); }
    const text = await readPrivateFile(join(this.directory, `${deploymentKey(selector)}.json`));
    if (text === undefined) return undefined;
    let record: DeploymentRecord;
    try { record = validateDeploymentRecord(JSON.parse(text)); } catch { throw fail(); }
    if (record.key !== deploymentKey(selector)) throw fail();
    await safeDirectory(this.directory, false);
    return record;
  }

  async acquire(input: DeploymentSelector): Promise<DeploymentLock> {
    const selector = await canonicalDeploymentSelector(input);
    await safeDirectory(this.directory);
    const key = deploymentKey(selector), file = join(this.directory, `${key}.json`), lockFile = join(this.directory, `${key}.lock`);
    const token = randomBytes(16).toString('hex');
    let lockHandle;
    try {
      lockHandle = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await lockHandle.writeFile(token); await lockHandle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw fail('DEPLOYMENT_LOCKED');
      throw fail();
    } finally { await lockHandle?.close(); }
    let released = false, busy = false;
    const check = async () => {
      if (released || await readPrivateFile(lockFile) !== token) throw fail();
      await safeDirectory(this.directory);
    };
    const read = async () => {
      await check();
      const text = await readPrivateFile(file);
      if (text === undefined) return undefined;
      let record;
      try { record = validateDeploymentRecord(JSON.parse(text)); } catch { throw fail(); }
      if (record.key !== key || record.projectPath !== selector.projectPath || record.provider !== selector.provider || record.target !== selector.target) throw fail();
      return record;
    };
    const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (busy) throw fail('DEPLOYMENT_LOCKED');
      busy = true;
      try { return await operation(); } finally { busy = false; }
    };
    return {
      selector,
      read: () => exclusive(read),
      write: (inputRecord) => exclusive(async () => {
        const record = validateDeploymentRecord(inputRecord), previous = await read();
        if (record.key !== key || record.projectPath !== selector.projectPath || record.provider !== selector.provider || record.target !== selector.target ||
            record.revision !== (previous?.revision ?? 0) ||
            (previous && (record.ownershipMarker !== previous.ownershipMarker || record.sessionNamespace !== previous.sessionNamespace || record.createdAt !== previous.createdAt ||
              JSON.stringify(record.selectors) !== JSON.stringify(previous.selectors)))) throw fail();
        const next = validateDeploymentRecord({ ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() });
        const text = JSON.stringify(next, null, 2) + '\n';
        if (Buffer.byteLength(text) > 64 * 1024) throw fail();
        const temp = join(this.directory, `${key}.${randomBytes(8).toString('hex')}.tmp`);
        try {
          const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
          await check(); await rename(temp, file);
          const directoryHandle = await open(this.directory, constants.O_RDONLY);
          try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        } catch { throw fail(); }
        finally { try { await unlink(temp); } catch (error) { if (!missing(error)) throw fail(); } }
        return next;
      }),
      remove: (proof) => exclusive(async () => {
        const record = await read();
        if (!record || record.status !== 'destroying' || proof.verified !== true || proof.succeeded !== true || proof.ownershipMarker !== record.ownershipMarker) throw fail();
        const expected = record.resources.filter((resource) => resource.ownership === 'owned').map((resource) => `${resource.kind}:${resource.id}`).sort();
        if (JSON.stringify(expected) !== JSON.stringify([...proof.resourceIdentities].sort())) throw fail();
        await check(); await unlink(file);
      }),
      release: () => exclusive(async () => {
        await check(); await unlink(lockFile); released = true;
      }),
    };
  }
}
