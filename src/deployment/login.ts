import { spawn } from 'node:child_process';
import { FastagentError } from '../errors.js';

/** Interactive native login is opt-in and never captured or presented as JSON. */
export async function interactiveCloudLogin(cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || signal?.aborted) throw new FastagentError('LOGIN_INTERACTIVE_REQUIRED', 'Browser login requires an interactive terminal. Otherwise run gcloud auth login yourself.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('gcloud', ['auth', 'login', '--verbosity=error'], { cwd, env: { ...env, CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_VERBOSITY: 'error' }, shell: false, stdio: 'inherit' });
    let killTimer: NodeJS.Timeout | undefined;
    let stopped = false;
    const stop = () => { stopped = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const timer = setTimeout(stop, 300_000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const finish = (ok: boolean) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop);
      if (ok && !stopped) resolve();
      else reject(new FastagentError('LOGIN_FAILED', 'Native login failed or was cancelled. No authentication claim was recorded.'));
    };
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}
