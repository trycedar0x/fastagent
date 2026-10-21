import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { createModel, selectModelApiKey, resolveModelReference } from './agent.js';
import { validateApiToken } from './auth.js';
import type { ChatModel } from './agent.js';
import type { HistoryStore } from './history-store.js';
import { validateRedisConfig } from './redis-history-store.js';

export const DEFAULT_MODEL_REFERENCE = 'openrouter/deepseek/deepseek-v4.1-flash';

const schema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  framework: z.literal('openai'),
  model: z.string().trim().min(1).max(270).regex(/^[^\x00-\x1f\x7f]+$/).default(DEFAULT_MODEL_REFERENCE),
  deployment: z.strictObject({ access: z.literal('token') }),
});

// Exact strings, exported so the startup entrypoint can allowlist them without duplicating text.
export const OPENROUTER_KEY_REQUIRED = 'OPENROUTER_API_KEY is required to start the agent. Set it in the app\'s ignored .env file; never paste or print the key. Local models are not supported.';
export const OPENAI_KEY_REQUIRED = 'OPENAI_API_KEY is required to start an openai/<model> agent. Set it in the app\'s ignored .env file; never paste or print the key. Local models are not supported.';
export const EPHEMERAL_HISTORY_VALUE_ERROR = 'FASTAGENT_EPHEMERAL_HISTORY must be exactly 1 when set.';
export const EPHEMERAL_HISTORY_CONFLICT_ERROR = 'FASTAGENT_EPHEMERAL_HISTORY cannot be combined with REDIS_URL. Configure exactly one history backend.';
export const EPHEMERAL_HISTORY_LOCAL_ERROR = 'FASTAGENT_EPHEMERAL_HISTORY is not allowed in local development; local development already uses in-memory history.';

export interface RuntimeConfig {
  origin: string;
  localDev: boolean;
  apiToken: string;
  model: ChatModel | undefined;
  redisUrl?: string | undefined;
  historyNamespace?: string;
  // Opt-in production in-memory history for single-instance deployments; never a Redis outage fallback.
  ephemeralHistory?: boolean;
  // Only programmatic tests/custom runtimes inject stores; environment cannot bypass Redis.
  historyStore?: HistoryStore;
}

export function validateRuntimeConfig(config: RuntimeConfig): void {
  validateApiToken(config.apiToken);
  let url: URL;
  try { url = new URL(config.origin); } catch { throw new Error('Invalid APP_ORIGIN configuration.'); }
  if (config.localDev && url.hostname === '[::1]') throw new Error('IPv6 localhost APP_ORIGIN is not supported. Use http://localhost or http://127.0.0.1 with the configured port.');
  if (url.origin !== config.origin || url.username || url.password ||
      (config.localDev ? url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) : url.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN must be an HTTPS origin, or an HTTP localhost origin in explicit local development mode.');
  }
  if (config.ephemeralHistory) {
    // Ambiguity and redundancy are refused before any store is built.
    if (config.redisUrl) throw new Error(EPHEMERAL_HISTORY_CONFLICT_ERROR);
    if (config.localDev) throw new Error(EPHEMERAL_HISTORY_LOCAL_ERROR);
  }
  if (!config.historyStore && !config.ephemeralHistory) validateRedisConfig(config.redisUrl, config.historyNamespace, config.localDev);
}

export async function loadRuntimeConfig(env: NodeJS.ProcessEnv): Promise<RuntimeConfig> {
  let modelIdentifier: string;
  let appName: string;
  try {
    const document = parseDocument(await readFile('fastagent.yaml', 'utf8'), { uniqueKeys: true });
    if (document.errors.length) throw new Error();
    const project = schema.parse(document.toJS({ maxAliasCount: 0 }));
    modelIdentifier = project.model;
    appName = project.name;
  } catch { throw new Error('Invalid fastagent.yaml configuration.'); }
  if (env.FASTAGENT_LOCAL_DEV !== undefined && env.FASTAGENT_LOCAL_DEV !== '1') throw new Error('Invalid local development configuration.');
  if (env.FASTAGENT_EPHEMERAL_HISTORY !== undefined && env.FASTAGENT_EPHEMERAL_HISTORY !== '1') throw new Error(EPHEMERAL_HISTORY_VALUE_ERROR);
  const apiKey = selectModelApiKey(modelIdentifier, env);
  if (!apiKey?.trim()) throw new Error(resolveModelReference(modelIdentifier).provider === 'openrouter' ? OPENROUTER_KEY_REQUIRED : OPENAI_KEY_REQUIRED);
  const localDev = env.FASTAGENT_LOCAL_DEV === '1';
  const config: RuntimeConfig = {
    origin: env.APP_ORIGIN || (localDev ? `http://localhost:${env.PORT ?? '3000'}` : ''),
    localDev,
    apiToken: env.FASTAGENT_API_TOKEN ?? '',
    model: createModel(modelIdentifier, apiKey),
    redisUrl: env.REDIS_URL,
    historyNamespace: env.FASTAGENT_HISTORY_NAMESPACE ?? appName,
    ephemeralHistory: env.FASTAGENT_EPHEMERAL_HISTORY === '1',
  };
  validateRuntimeConfig(config);
  return config;
}
