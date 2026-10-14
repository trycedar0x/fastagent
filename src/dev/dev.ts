import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseConfig } from '../config/config.js';
import { FastagentError } from '../errors.js';

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    let timer: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals) => {
      child.kill(name);
      timer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
      timer.unref();
    };
    const interrupt = () => signal('SIGINT');
    const terminate = () => signal('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const clean = () => {
      if (timer) clearTimeout(timer);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', () => { clean(); reject(new FastagentError('DEV_FAILED', 'Could not launch the local process. Check Node.js and npm installation.')); });
    child.once('exit', (code, signalName) => { clean(); resolveResult(code ?? (signalName === 'SIGINT' ? 130 : signalName === 'SIGTERM' ? 143 : 1)); });
  });
}

export async function devProject(options: { directory?: string; install?: boolean; cwd?: string }): Promise<number> {
  const directory = resolve(options.cwd ?? process.cwd(), options.directory ?? '.');
  try {
    parseConfig(await readFile(resolve(directory, 'fastagent.yaml'), 'utf8'));
    await access(resolve(directory, 'src/main.ts'));
  } catch (error) {
    if (error instanceof FastagentError) throw error;
    throw new FastagentError('DEV_INVALID_PROJECT', 'Run dev in a runnable generated project with fastagent.yaml and src/main.ts.');
  }
  if (options.install) {
    const result = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts'], directory, process.env);
    if (result === 130 || result === 143) return result;
    if (result !== 0) throw new FastagentError('DEV_INSTALL_FAILED', 'Dependency installation failed. Inspect npm output.');
  }
  const compiler = resolve(directory, 'node_modules/typescript/bin/tsc');
  try { await access(compiler); } catch {
    throw new FastagentError('DEV_DEPENDENCIES_MISSING', 'Install dependencies with npm install, or opt in using fastagent dev --install.');
  }
  const built = await run(process.execPath, [compiler], directory, process.env);
  if (built === 130 || built === 143) return built;
  if (built !== 0) throw new FastagentError('DEV_BUILD_FAILED', 'Project build failed. Inspect compiler output.');
  // Credentials are read only by the generated child; the CLI never opens env files.
  // Child announces readiness only after listening; no premature CLI success result.
  return run(process.execPath, ['--env-file-if-exists=.env', '--env-file-if-exists=.env.auth', 'dist/main.js'], directory, {
    ...process.env,
    FASTAGENT_LOCAL_DEV: '1',
  });
}
