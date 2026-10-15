import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { createModel, selectModelApiKey } from './agent.js';
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

export interface RuntimeConfig {
  origin: string;
  localDev: boolean;
  apiToken: string;
  model: ChatModel | undefined;
  redisUrl?: string | undefined;
  historyNamespace?: string;
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
  if (!config.historyStore) validateRedisConfig(config.redisUrl, config.historyNamespace, config.localDev);
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
  const localDev = env.FASTAGENT_LOCAL_DEV === '1';
  const config: RuntimeConfig = {
    origin: env.APP_ORIGIN || (localDev ? `http://localhost:${env.PORT ?? '3000'}` : ''),
    localDev,
    apiToken: env.FASTAGENT_API_TOKEN ?? '',
    model: createModel(modelIdentifier, selectModelApiKey(modelIdentifier, env)),
    redisUrl: env.REDIS_URL,
    historyNamespace: env.FASTAGENT_HISTORY_NAMESPACE ?? appName,
  };
  validateRuntimeConfig(config);
  return config;
}
