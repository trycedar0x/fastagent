import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig, serializeConfig, type ProjectConfig } from '../config/config.js';
import { FastagentError } from '../errors.js';

export interface StagedSource {
  directory: string;
  config: ProjectConfig;
  files: readonly string[];
  bytes: number;
  cleanup(): Promise<void>;
}
export interface StagingOptions {
  projectPath: string;
  /** Optional synthetic/explicit environment only; staging never reads process.env or dotenv. */
  deploymentEnv?: Readonly<Record<string, string>>;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}
const rootFiles = ['fastagent.yaml', 'package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile'] as const;
const blockedDirectory = /^(?:node_modules|\.git|\.hg|\.svn|\.fastagent|\.aws|\.gcloud|\.config|\.ssh|\.terraform|state|secrets?|credentials?|dist)$/i;
const blockedFile = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.gitcredentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.?credentials?.*|\.?secrets?.*|auth\.json|tokens?\.json|(?:deployment[-_])?state\.json|service[-_]?account.*|application_default_credentials.*|.*\.(?:env|pem|key|p12|pfx|jks|kdbx|tfstate)(?:\.backup)?)$/i;
const privateContent = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----|"(?:private_key|client_secret)"\s*:|"type"\s*:\s*"service_account"|[a-z][a-z0-9+.-]*:\/\/[^\s/"']+@/i;
const fail = (code = 'DEPLOYMENT_SOURCE_INVALID') => new FastagentError(code,
  'Deployment source is unsafe or unsupported. Use the generated Dockerfile, valid non-secret configuration and regular bounded build inputs; symlinks and common credential files are forbidden.');

// Provider ignores are defense in depth; the staged directory is already filtered.
export const deploymentIgnoreFile = `# Generated staging allowlist; never upload the original project directory.
**
!Dockerfile
!.dockerignore
!.railwayignore
!.gcloudignore
!fastagent.yaml
!package.json
!package-lock.json
!tsconfig.json
!src/
!src/**
!public/
!public/**
**/.env
**/.env.*
**/*.env
**/.envrc
**/state.json
**/deployment-state.json
**/*.tfstate
**/.git
**/.git/**
**/node_modules
**/node_modules/**
**/.fastagent
**/.fastagent/**
**/.aws/**
**/.config/**
**/.ssh/**
**/.npmrc
**/.netrc
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/credentials*
**/secret*
**/service-account*
`;

/** Snapshot an editable generated project. Not a scanner for arbitrary secrets embedded in code.
 * Custom Dockerfiles are rejected: a simple ARG/ENV check cannot prove build safety.
 * Editable package scripts/source remain user-owned trusted code, not a build sandbox.
 */
export async function stageDeploymentSource(options: StagingOptions): Promise<StagedSource> {
  const maxFiles = options.maxFiles ?? 1000, maxBytes = options.maxBytes ?? 20 * 1024 * 1024, maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  if ([maxFiles, maxBytes, maxFileBytes].some((value) => !Number.isSafeInteger(value) || value < 1) ||
      maxFiles > 10_000 || maxBytes > 100 * 1024 * 1024 || maxFileBytes > 20 * 1024 * 1024 ||
      Object.prototype.hasOwnProperty.call(options.deploymentEnv ?? {}, 'FASTAGENT_LOCAL_DEV')) throw fail();
  const project = resolve(options.projectPath);
  let directory: string | undefined;
  try {
    // Require canonical source ancestors; do not accidentally stage a link to another project.
    if (await realpath(project) !== project || !(await lstat(project)).isDirectory()) throw fail();
    const rootEntries = await readdir(project, { withFileTypes: true });
    if (rootEntries.length > maxFiles * 4) throw fail('DEPLOYMENT_SOURCE_LIMIT');
    if (rootEntries.some((entry) => entry.isSymbolicLink())) throw fail();
    const tempRoot = await realpath(tmpdir());
    directory = await mkdtemp(join(tempRoot, 'fastagent-deploy-'));
    const files: string[] = [];
    let bytes = 0;
    const reserve = (size: number) => {
      if (size > maxFileBytes || files.length + 1 > maxFiles || bytes + size > maxBytes) throw fail('DEPLOYMENT_SOURCE_LIMIT');
      bytes += size;
    };
    const write = async (path: string, content: Buffer | string) => {
      reserve(Buffer.byteLength(content));
      await writeFile(join(directory!, path), content, { flag: 'wx', mode: 0o600 });
      files.push(path);
    };
    const read = async (path: string) => {
      const info = await lstat(join(project, path));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxFileBytes || info.size > maxBytes - bytes) throw fail();
      const handle = await open(join(project, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) throw fail();
        // Read at most the configured size, even if the source grows during staging.
        const buffer = Buffer.alloc(info.size + 1);
        let used = 0;
        while (used < buffer.length) {
          const result = await handle.read(buffer, used, buffer.length - used, used);
          if (result.bytesRead === 0) break;
          used += result.bytesRead;
        }
        if (used !== info.size || (await handle.stat()).size !== info.size) throw fail();
        const content = buffer.subarray(0, used);
        if (privateContent.test(content.toString('utf8'))) throw fail();
        return content;
      } finally { await handle.close(); }
    };
    const config = parseConfig((await read('fastagent.yaml')).toString('utf8'));
    // The current runtime supports only OpenAI model IDs; reject accidental config credentials.
    if (!/^openai\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.model)) throw fail();
    await write('fastagent.yaml', serializeConfig(config));
    const approvedHandle = await open(new URL('../../templates/openai/Dockerfile', import.meta.url), constants.O_RDONLY);
    let approvedDockerfile: string;
    try { approvedDockerfile = await approvedHandle.readFile('utf8'); } finally { await approvedHandle.close(); }
    for (const path of rootFiles.filter((path) => path !== 'fastagent.yaml')) {
      // A freshly generated project need not have installed dependencies yet.
      if (path === 'package-lock.json') {
        try { await lstat(join(project, path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      }
      const content = await read(path);
      if (path === 'Dockerfile' && content.toString('utf8').replaceAll('\r\n', '\n').trim() !== approvedDockerfile.trim()) throw fail('DEPLOYMENT_DOCKERFILE_UNSUPPORTED');
      if (path.endsWith('.json')) {
        let value: unknown;
        try { value = JSON.parse(content.toString('utf8')); } catch { throw fail(); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
      }
      await write(path, content);
    }
    let entriesSeen = 0;
    const visit = async (path: string, depth = 0): Promise<void> => {
      if (depth > 32) throw fail('DEPLOYMENT_SOURCE_LIMIT');
      const before = await lstat(join(project, path));
      if (!before.isDirectory() || before.isSymbolicLink()) throw fail();
      await mkdir(join(directory!, path), { mode: 0o700 });
      // readdir itself is bounded by the directory's entries; cap traversal as well as copied files.
      const entries = await readdir(join(project, path), { withFileTypes: true });
      entriesSeen += entries.length;
      if (entriesSeen > maxFiles * 4) throw fail('DEPLOYMENT_SOURCE_LIMIT');
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (/[\x00-\x1f\x7f\\]/.test(entry.name)) throw fail();
        const childPath = `${path}/${entry.name}`;
        const info = await lstat(join(project, childPath));
        if (info.isSymbolicLink()) throw fail();
        if (info.isDirectory()) {
          if (!blockedDirectory.test(entry.name) && !blockedFile.test(entry.name)) await visit(childPath, depth + 1);
        } else if (!info.isFile()) throw fail();
        else if (!blockedFile.test(entry.name)) await write(childPath, await read(childPath));
      }
      const after = await lstat(join(project, path));
      if (!after.isDirectory() || before.ino !== after.ino || before.dev !== after.dev) throw fail();
    };
    await visit('src'); await visit('public');
    for (const ignore of ['.dockerignore', '.railwayignore', '.gcloudignore']) await write(ignore, deploymentIgnoreFile);
    const stagedDirectory = directory;
    return { directory: stagedDirectory, config, files, bytes, cleanup: () => rm(stagedDirectory, { recursive: true, force: true }) };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (error instanceof FastagentError) throw error;
    throw fail();
  }
}
