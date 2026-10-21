import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';
import { createConfig } from '../config/config.js';
import { FastagentError } from '../errors.js';
import { openaiTemplate, renderProject } from './render.js';

export interface InitOptions {
  directory: string;
  name?: string;
  framework?: string;
  cwd?: string;
}

export interface InitResult {
  directory: string;
  name: string;
  framework: 'openai';
  scaffoldStage: 'runnable';
  files: string[];
}

// Generated at init time, never a template asset: the token is per-project and must not ship in a package.
const AUTH_FILE = '.env.auth';
const API_TOKEN_BYTES = 32;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function inspectPath(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new FastagentError('UNSAFE_PATH', 'Unable to safely inspect the destination path. Check permissions.');
  }
}

async function verifyDestination(directory: string): Promise<void> {
  if (directory === parse(directory).root) {
    throw new FastagentError('UNSAFE_PATH', 'The filesystem root cannot be a project destination.', 2);
  }
  if (await inspectPath(directory)) {
    throw new FastagentError('DESTINATION_EXISTS', 'Destination already exists. Choose a new directory; existing files, directories and symlinks are never overwritten.');
  }
  const ancestors: string[] = [];
  for (let ancestor = dirname(directory); ; ancestor = dirname(ancestor)) {
    ancestors.unshift(ancestor);
    if (ancestor === parse(ancestor).root) break;
  }
  for (const ancestor of ancestors) {
    const stat = await inspectPath(ancestor);
    if (!stat) {
      throw new FastagentError('PARENT_NOT_FOUND', 'Destination parent must already exist. Create its parent directory first.');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new FastagentError('UNSAFE_PATH', 'Destination ancestors must be real directories, not symlinks or files.');
    }
  }
}

async function safeTemplateParents(directory: string, path: string): Promise<boolean> {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = await inspectPath(parent);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
    if (parent === directory) return true;
  }
}

export async function initProject(options: InitOptions): Promise<InitResult> {
  if (!options.directory.trim() || options.directory.includes('\0') || options.directory.includes('\\') ||
      options.directory.split(/[\\/]/).includes('..')) {
    throw new FastagentError('UNSAFE_PATH', 'Provide a nonempty directory without NUL, backslashes or parent traversal (..).', 2);
  }
  const directory = resolve(options.cwd ?? process.cwd(), options.directory);
  const config = createConfig(options.name ?? basename(directory), options.framework);
  await verifyDestination(directory);
  const files = await renderProject(config);
  for (const file of files) {
    if (isAbsolute(file.path) || file.path.includes('\\') || file.path.includes('\0') || file.path.split('/').some((part) => part === '..' || part === '.' || !part)) {
      throw new FastagentError('SCAFFOLD_FAILED', 'Template contains an unsafe file path.');
    }
  }

  try {
    // mkdir is exclusive, including for empty directories and dangling symlinks.
    await mkdir(directory);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new FastagentError('DESTINATION_EXISTS', 'Destination already exists. Choose a new directory.');
    }
    throw new FastagentError('SCAFFOLD_FAILED', 'Could not create project directory. Check its parent and permissions.');
  }

  const written: string[] = [];
  const createdDirectories: string[] = [];
  const knownDirectories = new Set<string>([directory]);
  try {
    for (const file of files) {
      const parents: string[] = [];
      for (let parent = dirname(resolve(directory, file.path)); !knownDirectories.has(parent); parent = dirname(parent)) {
        parents.unshift(parent);
      }
      for (const parent of parents) {
        // Exclusive creation refuses even a concurrently inserted symlink/directory.
        await mkdir(parent);
        createdDirectories.push(parent);
        knownDirectories.add(parent);
      }
      if (!await safeTemplateParents(directory, resolve(directory, file.path))) throw new Error('Unsafe template parent');
      await writeFile(resolve(directory, file.path), file.content, { flag: 'wx', mode: 0o644 });
      written.push(file.path);
    }
    // Owner-only bearer token; base64url of 32 random bytes. The value is never returned or logged.
    const apiToken = randomBytes(API_TOKEN_BYTES).toString('base64url');
    await writeFile(resolve(directory, AUTH_FILE), `FASTAGENT_API_TOKEN=${apiToken}\n`, { flag: 'wx', mode: 0o600 });
    written.push(AUTH_FILE);
  } catch {
    // Never recursively remove a destination that may contain somebody else's files.
    for (const file of written.reverse()) {
      const path = resolve(directory, file);
      if (await safeTemplateParents(directory, path).catch(() => false)) await unlink(path).catch(() => {});
    }
    for (const parent of createdDirectories.reverse()) {
      if (await safeTemplateParents(directory, parent).catch(() => false)) await rmdir(parent).catch(() => {});
    }
    await rmdir(directory).catch(() => {});
    throw new FastagentError('SCAFFOLD_FAILED', 'Could not finish scaffold. Check permissions and inspect the destination for partial files before retrying.');
  }
  return {
    directory,
    name: config.name,
    framework: config.framework,
    scaffoldStage: openaiTemplate.stage,
    files: [...files.map((file) => file.path), AUTH_FILE],
  };
}

