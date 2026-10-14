import { z } from 'zod';
import { projectNameSchema } from '../config/config.js';
import { FastagentError } from '../errors.js';
import type { ProcessRunner } from './process.js';
import type { DeploymentLock, DeploymentRecord, DeploymentSelector, VerifiedDestruction } from './state.js';
import type { StagedSource } from './staging.js';

export type ProviderName = 'railway' | 'cloudrun';

export function validateHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error();
    return value;
  } catch {
    throw new FastagentError('DEPLOYMENT_ORIGIN_INVALID', 'Deployment requires an exact HTTPS origin without credentials, path, query or fragment.');
  }
}

const cloudEnvironmentSchema = z.strictObject({
  FASTAGENT_PASSWORD_HASH: z.string().regex(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
  OPENAI_API_KEY: z.string().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/),
  REDIS_URL: z.string().min(1).max(8192),
  APP_ORIGIN: z.string(),
  FASTAGENT_SESSION_NAMESPACE: projectNameSchema,
});
export type CloudEnvironment = z.infer<typeof cloudEnvironmentSchema>;
const preflightEnvironmentSchema = cloudEnvironmentSchema.extend({ APP_ORIGIN: z.string().optional() });
export type PreflightEnvironment = z.infer<typeof preflightEnvironmentSchema>;

/** Explicit input only: no dotenv or ambient credential reads. Never serialize this result to state. */
export function validatePreflightEnvironment(value: unknown): PreflightEnvironment {
  const result = preflightEnvironmentSchema.safeParse(value);
  if (!result.success) throw new FastagentError('DEPLOYMENT_ENV_INVALID',
    'Cloud preflight requires a password hash, model key, TLS Redis URL and stable session namespace; local development and unknown variables are forbidden.');
  if (result.data.APP_ORIGIN !== undefined) validateHttpsOrigin(result.data.APP_ORIGIN);
  try {
    const raw = result.data.REDIS_URL;
    const url = new URL(raw);
    decodeURIComponent(url.username); decodeURIComponent(url.password);
    if (/[\x00-\x20\x7f]/.test(raw) || url.protocol !== 'rediss:' || !url.hostname || url.hash || url.search ||
        !/^(?:\/(?:\d+)?)?$/.test(url.pathname) ||
        (url.pathname.length > 1 && !Number.isSafeInteger(Number(url.pathname.slice(1))))) throw new Error();
  } catch { throw new FastagentError('DEPLOYMENT_ENV_INVALID', 'Cloud runtime requires a valid TLS Redis URL.'); }
  return result.data;
}

/** Required after domain acquisition, before activating any chat revision. No placeholder origin. */
export function validateCloudEnvironment(value: unknown): CloudEnvironment {
  const result = cloudEnvironmentSchema.safeParse(value);
  if (!result.success) throw new FastagentError('DEPLOYMENT_ENV_INVALID', 'Cloud runtime requires exact APP_ORIGIN as well as validated preflight secrets and namespace.');
  validatePreflightEnvironment(result.data);
  return result.data;
}

export interface ProviderContext {
  selector: DeploymentSelector;
  runner: ProcessRunner;
  signal?: AbortSignal;
}
export interface DeployInput extends ProviderContext {
  source: StagedSource;
  // Adapters acquire/checkpoint the domain, then validateCloudEnvironment before activation.
  // A supplied origin must match the selected, remotely verified target, never a different record.
  // Namespace must match the persisted record across all replicas/revisions.
  environment: PreflightEnvironment;
  // Hold the lock across mutations; checkpoint confirmed IDs before further cloud operations.
  state: DeploymentLock;
}
export interface DestroyInput extends ProviderContext {
  record: DeploymentRecord;
  confirmed: true;
}
export interface ProviderStatus {
  status: 'pending' | 'deploying' | 'ready' | 'failed' | 'missing';
  url?: string;
}

/** Adapters must verify IDs AND remote ownership markers, not infer ownership from names.
 * Destroy returns proof only after all owned resources are verified and deletion succeeds.
 * No shared projects/secrets/registries may be deleted based on a local record alone.
 * Never delete an entire Google Cloud project or activate an unprotected bootstrap revision.
 */
export interface DeploymentProvider {
  readonly name: ProviderName;
  preflight(context: ProviderContext, environment: PreflightEnvironment): Promise<void>;
  deploy(input: DeployInput): Promise<DeploymentRecord>;
  status(context: ProviderContext, record: DeploymentRecord): Promise<ProviderStatus>;
  logs(context: ProviderContext, record: DeploymentRecord): Promise<string>;
  destroy(input: DestroyInput): Promise<VerifiedDestruction>;
}
