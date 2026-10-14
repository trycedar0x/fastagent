import { createProcessRunner, type ProcessRunner } from '../deployment/process.js';
import { deploymentCommandEnvironment } from '../deployment/service.js';
import { validateHttpsOrigin } from '../deployment/types.js';
import { FastagentError } from '../errors.js';

/** Only invoked by an explicit Enter action. No shell, credential URLs, or cloud calls. */
export async function openDeploymentUrl(url: string, options: { platform?: NodeJS.Platform; runner?: ProcessRunner; signal?: AbortSignal } = {}): Promise<void> {
  validateHttpsOrigin(url);
  const platform = options.platform ?? process.platform;
  const executable = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : platform === 'linux' ? 'xdg-open' : undefined;
  if (!executable) throw new FastagentError('URL_OPEN_UNSUPPORTED', 'Open the recorded HTTPS URL manually on this platform.');
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await (options.runner ?? createProcessRunner())({ executable, args, cwd: process.cwd(), env: deploymentCommandEnvironment(), intent: 'read',
    timeoutMs: 5000, maxOutputBytes: 4096, ...(options.signal ? { signal: options.signal } : {}) });
}
