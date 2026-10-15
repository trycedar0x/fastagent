import { DEFAULT_MODEL_REFERENCE, OPENROUTER_MODEL_ID } from './reference.js';

export { DEFAULT_MODEL_REFERENCE };
export const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10_000;
const MODEL_ID = OPENROUTER_MODEL_ID;

export interface OpenRouterModel {
  id: string;
  reference: string;
  name: string;
  contextLength: number;
  supportsTools: boolean | null;
  sourceUrl: string;
  fetchedAt: string;
  // Catalog estimates vary by provider; these are not spending caps.
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export interface OpenRouterCatalog {
  sourceUrl: string;
  fetchedAt: string;
  pricesAreEstimates: true;
  models: OpenRouterModel[];
}

export interface CatalogFilter {
  search?: string;
  limit?: number;
  toolsOnly?: boolean;
}

export interface CatalogOptions extends CatalogFilter {
  transport?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export class OpenRouterCatalogError extends Error {
  constructor() { super('Unable to fetch a valid OpenRouter model catalog.'); this.name = 'OpenRouterCatalogError'; }
}

export function isOpenRouterModelId(value: string): boolean {
  return MODEL_ID.test(value);
}

export function pricePerMillion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || value.length > 100) return null;
  const price = Number(value) * 1_000_000;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function filterOpenRouterModels(models: readonly OpenRouterModel[], filter: CatalogFilter = {}): OpenRouterModel[] {
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (filter.search?.length ?? 0) > 200) {
    throw new Error('Invalid model catalog filter.');
  }
  const search = filter.search?.trim().toLowerCase() ?? '';
  return models.filter((model) => (!filter.toolsOnly || model.supportsTools === true)
    && (!search || `${model.id} ${model.name}`.toLowerCase().includes(search))).slice(0, limit);
}

// Public metadata only: no key, generation request, redirects, or cached-price fallback.
export async function fetchOpenRouterCatalog(options: CatalogOptions = {}): Promise<OpenRouterCatalog> {
  filterOpenRouterModels([], options);
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES) {
    throw new Error('Invalid model catalog request bounds.');
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new OpenRouterCatalogError()); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await (options.transport ?? fetch)(OPENROUTER_CATALOG_URL, {
        method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal,
      });
      if (controller.signal.aborted || !response.ok || response.redirected || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new OpenRouterCatalogError();
      }
      const length = response.headers.get('content-length');
      reader = response.body.getReader();
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) throw new OpenRouterCatalogError();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (controller.signal.aborted) throw new OpenRouterCatalogError();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBodyBytes) throw new OpenRouterCatalogError();
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      const payload: unknown = JSON.parse(text);
      if (!isObject(payload) || !Array.isArray(payload.data) || payload.data.length > 20_000) throw new OpenRouterCatalogError();
      const fetchedAt = new Date().toISOString();
      const ids = new Set<string>();
      const models = payload.data.map((value: unknown): OpenRouterModel => {
        if (!isObject(value) || typeof value.id !== 'string' || !isOpenRouterModelId(value.id)
          || ids.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 1000
          || !Number.isSafeInteger(value.context_length) || (value.context_length as number) <= 0
          || (value.supported_parameters !== undefined && (!Array.isArray(value.supported_parameters)
            || value.supported_parameters.some((parameter: unknown) => typeof parameter !== 'string')))
          || (value.pricing !== undefined && value.pricing !== null && !isObject(value.pricing))) {
          throw new OpenRouterCatalogError();
        }
        ids.add(value.id);
        const pricing = isObject(value.pricing) ? value.pricing : {};
        return {
          id: value.id, reference: `openrouter/${value.id}`, name: value.name,
          contextLength: value.context_length as number,
          supportsTools: Array.isArray(value.supported_parameters) ? value.supported_parameters.includes('tools') : null,
          sourceUrl: `https://openrouter.ai/${value.id}`, fetchedAt,
          inputUsdPerMillion: pricePerMillion(pricing.prompt), outputUsdPerMillion: pricePerMillion(pricing.completion),
        };
      });
      return { sourceUrl: OPENROUTER_CATALOG_URL, fetchedAt, pricesAreEstimates: true as const, models: filterOpenRouterModels(models, options) };
    })()]);
  } catch {
    throw new OpenRouterCatalogError();
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OfflineModelPreset {
  id: string;
  reference: string;
  name: string;
  sourceUrl: string;
  inputUsdPerMillion: null;
  outputUsdPerMillion: null;
}

// Suggestions, not an allowlist or a substitute for live catalog prices.
const presetNames: readonly [string, string][] = [
  ['deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
  ['qwen/qwen3-30b-a3b-instruct-2507', 'Qwen3 30B A3B Instruct 2507'],
  ['google/gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'],
  ['openai/gpt-oss-20b', 'GPT OSS 20B'],
  ['openai/gpt-4o-mini', 'GPT-4o mini'],
];
export const OFFLINE_MODEL_PRESETS: readonly OfflineModelPreset[] = presetNames.map(([id, name]) => ({
  id, reference: `openrouter/${id}`, name, sourceUrl: `https://openrouter.ai/${id}`,
  inputUsdPerMillion: null, outputUsdPerMillion: null,
}));
