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

const secretText = z.string().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/);
const protectedCloudSchema = z.strictObject({
  FASTAGENT_PASSWORD_HASH: z.string().regex(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
  OPENAI_API_KEY: secretText,
  REDIS_URL: z.string().min(1).max(8192),
  APP_ORIGIN: z.string(),
  FASTAGENT_SESSION_NAMESPACE: projectNameSchema,
});
const tokenCloudSchema = z.strictObject({
  FASTAGENT_API_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43,256}$/),
  OPENAI_API_KEY: secretText.optional(),
  OPENROUTER_API_KEY: secretText.optional(),
  // Exactly one history backend: a TLS Redis URL, or explicit single-instance in-memory history.
  REDIS_URL: z.string().min(1).max(8192).optional(),
  FASTAGENT_EPHEMERAL_HISTORY: z.literal('1').optional(),
  APP_ORIGIN: z.string(),
  FASTAGENT_HISTORY_NAMESPACE: projectNameSchema,
});
export type ProtectedEnvironment = z.infer<typeof protectedCloudSchema>;
export type TokenEnvironment = z.infer<typeof tokenCloudSchema>;
export type CloudEnvironment = ProtectedEnvironment | TokenEnvironment;
const protectedPreflightSchema = protectedCloudSchema.extend({ APP_ORIGIN: z.string().optional() });
const tokenPreflightSchema = tokenCloudSchema.extend({ APP_ORIGIN: z.string().optional() });
export type PreflightEnvironment = z.infer<typeof protectedPreflightSchema> | z.infer<typeof tokenPreflightSchema>;

type ModelKeyEnvironment = { OPENAI_API_KEY?: string | undefined; OPENROUTER_API_KEY?: string | undefined };
function oneModelKey(value: ModelKeyEnvironment): boolean {
  return Number(Boolean(value.OPENAI_API_KEY)) + Number(Boolean(value.OPENROUTER_API_KEY)) === 1;
}
function cleanToken<T extends ModelKeyEnvironment & { APP_ORIGIN?: string | undefined; REDIS_URL?: string | undefined; FASTAGENT_EPHEMERAL_HISTORY?: string | undefined }>(value: T): T {
  const cleaned = { ...value };
  if (!cleaned.OPENAI_API_KEY) delete cleaned.OPENAI_API_KEY;
  if (!cleaned.OPENROUTER_API_KEY) delete cleaned.OPENROUTER_API_KEY;
  if (cleaned.APP_ORIGIN === undefined) delete cleaned.APP_ORIGIN;
  if (cleaned.REDIS_URL === undefined) delete cleaned.REDIS_URL;
  if (cleaned.FASTAGENT_EPHEMERAL_HISTORY === undefined) delete cleaned.FASTAGENT_EPHEMERAL_HISTORY;
  return cleaned;
}
function validateRedisUrl(raw: string): void {
  try {
    const url = new URL(raw);
    decodeURIComponent(url.username); decodeURIComponent(url.password);
    if (/[\x00-\x20\x7f]/.test(raw) || url.protocol !== 'rediss:' || !url.hostname || url.hash || url.search ||
        !/^(?:\/(?:\d+)?)?$/.test(url.pathname) ||
        (url.pathname.length > 1 && !Number.isSafeInteger(Number(url.pathname.slice(1))))) throw new Error();
  } catch { throw new FastagentError('DEPLOYMENT_ENV_INVALID', 'Cloud runtime requires a valid TLS Redis URL.'); }
}
function parsePreflight(value: unknown): PreflightEnvironment | undefined {
  const protectedResult = protectedPreflightSchema.safeParse(value);
  if (protectedResult.success) return protectedResult.data;
  const tokenResult = tokenPreflightSchema.safeParse(value);
  if (tokenResult.success && oneModelKey(tokenResult.data)) return cleanToken(tokenResult.data);
  return undefined;
}
function parseCloud(value: unknown): CloudEnvironment | undefined {
  const protectedResult = protectedCloudSchema.safeParse(value);
  if (protectedResult.success) return protectedResult.data;
  const tokenResult = tokenCloudSchema.safeParse(value);
  if (tokenResult.success && oneModelKey(tokenResult.data)) return cleanToken(tokenResult.data);
  return undefined;
}

export function isTokenRuntime(environment: PreflightEnvironment): environment is z.infer<typeof tokenPreflightSchema> {
  return 'FASTAGENT_API_TOKEN' in environment;
}
export function redisNamespace(environment: PreflightEnvironment): string {
  return isTokenRuntime(environment) ? environment.FASTAGENT_HISTORY_NAMESPACE : environment.FASTAGENT_SESSION_NAMESPACE;
}
export function redisNamespaceVariable(environment: PreflightEnvironment): 'FASTAGENT_HISTORY_NAMESPACE' | 'FASTAGENT_SESSION_NAMESPACE' {
  return isTokenRuntime(environment) ? 'FASTAGENT_HISTORY_NAMESPACE' : 'FASTAGENT_SESSION_NAMESPACE';
}
export function runtimeSecretKeys(environment: PreflightEnvironment): string[] {
  if (!isTokenRuntime(environment)) return ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL'];
  const keys = ['FASTAGENT_API_TOKEN', environment.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'];
  // Ephemeral mode has no Redis secret; Redis mode still pins it.
  if (environment.REDIS_URL !== undefined) keys.push('REDIS_URL');
  return keys;
}
export function secretValue(environment: PreflightEnvironment, key: string): string {
  const value = (environment as unknown as Record<string, string | undefined>)[key];
  if (!value) throw new FastagentError('DEPLOYMENT_ENV_INVALID', 'Cloud runtime secret is missing.');
  return value;
}

/** Explicit input only: no dotenv or ambient credential reads. Never serialize this result to state. */
export function validatePreflightEnvironment(value: unknown): PreflightEnvironment {
  const parsed = parsePreflight(value);
  if (!parsed) throw new FastagentError('DEPLOYMENT_ENV_INVALID',
    'Cloud preflight requires a history backend (TLS Redis or FASTAGENT_EPHEMERAL_HISTORY=1), a stable namespace, and either a password hash plus OpenAI key for an existing protected app, or a bearer token plus the model key selected by fastagent.yaml. Local development and unknown variables are forbidden.');
  if (parsed.APP_ORIGIN !== undefined) validateHttpsOrigin(parsed.APP_ORIGIN);
  if (isTokenRuntime(parsed)) {
    const hasRedis = parsed.REDIS_URL !== undefined;
    const hasEphemeral = parsed.FASTAGENT_EPHEMERAL_HISTORY === '1';
    if (hasRedis && hasEphemeral) throw new FastagentError('DEPLOYMENT_HISTORY_BACKEND_CONFLICT',
      'Set exactly one history backend: remove either REDIS_URL or FASTAGENT_EPHEMERAL_HISTORY=1 before deploying.');
    if (!hasRedis && !hasEphemeral) throw new FastagentError('DEPLOYMENT_HISTORY_BACKEND_MISSING',
      'Set a TLS rediss:// REDIS_URL, or set FASTAGENT_EPHEMERAL_HISTORY=1 for single-instance in-memory history.');
    if (hasRedis) validateRedisUrl(parsed.REDIS_URL!);
  } else {
    validateRedisUrl(parsed.REDIS_URL);
  }
  return parsed;
}

/** Required after domain acquisition, before activating any chat revision. No placeholder origin. */
export function validateCloudEnvironment(value: unknown): CloudEnvironment {
  const parsed = parseCloud(value);
  if (!parsed) throw new FastagentError('DEPLOYMENT_ENV_INVALID', 'Cloud runtime requires exact APP_ORIGIN as well as validated preflight secrets and namespace.');
  validatePreflightEnvironment(parsed);
  return parsed;
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
