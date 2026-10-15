import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOpenRouterCatalog, filterOpenRouterModels, pricePerMillion, isOpenRouterModelId,
  OPENROUTER_CATALOG_URL, DEFAULT_MODEL_REFERENCE, OFFLINE_MODEL_PRESETS,
} from '../dist/models/openrouter.js';

const row = (changes = {}) => ({
  id: 'qwen/qwen3-30b-a3b-instruct-2507', name: 'Qwen', context_length: 32768,
  supported_parameters: ['tools', 'max_tokens'], pricing: { prompt: '0.00000009', completion: '0.0000003' }, ...changes,
});
const response = (data) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
const valid = async () => response([row()]);
const rejectsSanitized = (promise) => assert.rejects(promise, (error) => {
  assert.equal(error.message, 'Unable to fetch a valid OpenRouter model catalog.'); return true;
});

test('models/openrouter: public fixed GET, no key, fresh metadata and USD-per-million conversion', async () => {
  let request;
  const catalog = await fetchOpenRouterCatalog({ transport: async (url, init) => { request = { url, init }; return response([row()]); } });
  assert.equal(request.url, OPENROUTER_CATALOG_URL);
  assert.equal(request.init.method, 'GET'); assert.equal(request.init.redirect, 'error');
  assert.deepEqual(request.init.headers, { Accept: 'application/json' });
  assert.equal(request.init.body, undefined);
  assert.equal(catalog.sourceUrl, OPENROUTER_CATALOG_URL); assert.equal(catalog.pricesAreEstimates, true);
  const model = catalog.models[0];
  assert.equal(model.id, 'qwen/qwen3-30b-a3b-instruct-2507'); assert.equal(model.reference, 'openrouter/qwen/qwen3-30b-a3b-instruct-2507');
  assert.equal(DEFAULT_MODEL_REFERENCE, 'openrouter/deepseek/deepseek-v4.1-flash');
  assert.equal(model.name, 'Qwen'); assert.equal(model.contextLength, 32768); assert.equal(model.supportsTools, true);
  assert.equal(model.sourceUrl, 'https://openrouter.ai/qwen/qwen3-30b-a3b-instruct-2507');
  assert.equal(model.fetchedAt, catalog.fetchedAt); assert.ok(Number.isFinite(Date.parse(catalog.fetchedAt)));
  assert.equal(model.inputUsdPerMillion, 0.09); assert.equal(model.outputUsdPerMillion, 0.3);
});

test('models/openrouter: invalid/unknown catalog prices stay unknown, including negative routing sentinel', async () => {
  for (const value of [undefined, null, '', '-1', 'NaN', 'Infinity', 'USD 1', '0x10', '1e999', {}, 0.1, ' 0.01 ']) {
    assert.equal(pricePerMillion(value), null);
  }
  assert.equal(pricePerMillion('0'), 0); assert.equal(pricePerMillion('1e-6'), 1);
  const catalog = await fetchOpenRouterCatalog({ transport: async () => response([row({ pricing: { prompt: '-1', completion: null } })]) });
  assert.equal(catalog.models[0].inputUsdPerMillion, null); assert.equal(catalog.models[0].outputUsdPerMillion, null);
  const missing = await fetchOpenRouterCatalog({ transport: async () => response([row({ pricing: undefined, supported_parameters: undefined })]) });
  assert.equal(missing.models[0].inputUsdPerMillion, null); assert.equal(missing.models[0].supportsTools, null);
});

test('models/openrouter: bounded search/limit and tools-only filtering; presets have no live prices', async () => {
  const transport = async () => response([row(), row({ id: 'vendor/arbitrary-model:free', name: 'Other', supported_parameters: [] })]);
  assert.equal((await fetchOpenRouterCatalog({ transport, search: 'QWEN', toolsOnly: true, limit: 1 })).models.length, 1);
  assert.equal((await fetchOpenRouterCatalog({ transport, search: 'other', toolsOnly: true })).models.length, 0);
  assert.equal((await fetchOpenRouterCatalog({ transport, search: 'arbitrary' })).models[0].reference, 'openrouter/vendor/arbitrary-model:free');
  for (const filter of [{ limit: 0 }, { limit: 1001 }, { limit: 1.1 }, { search: 'x'.repeat(201) }]) assert.throws(() => filterOpenRouterModels([], filter));
  assert.equal(OFFLINE_MODEL_PRESETS.length, 5);
  assert.equal(OFFLINE_MODEL_PRESETS[0].reference, DEFAULT_MODEL_REFERENCE);
  assert.equal(OFFLINE_MODEL_PRESETS[0].name, 'DeepSeek V4.1 Flash');
  for (const preset of OFFLINE_MODEL_PRESETS) {
    assert.ok(isOpenRouterModelId(preset.id)); assert.equal(preset.inputUsdPerMillion, null); assert.equal(preset.outputUsdPerMillion, null);
    assert.equal(preset.reference, `openrouter/${preset.id}`);
  }
  for (const id of ['../secret', 'vendor/model/extra', 'vendor/model?key=secret', 'model', 'vendor/', '~~vendor/model', 'vendor/~model', 'https://evil.example/model']) assert.equal(isOpenRouterModelId(id), false);
  assert.equal(isOpenRouterModelId('~deepseek/deepseek-flash-latest'), true);
});

test('models/openrouter: documented tilde vendor aliases stay in the catalog and do not replace the pinned default', async () => {
  const catalog = await fetchOpenRouterCatalog({ transport: async () => response([
    row(), row({ id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash latest' }),
  ]) });
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[1].id, '~deepseek/deepseek-flash-latest');
  assert.equal(catalog.models[1].reference, 'openrouter/~deepseek/deepseek-flash-latest');
  assert.equal(catalog.models[1].sourceUrl, 'https://openrouter.ai/~deepseek/deepseek-flash-latest');
  assert.equal(DEFAULT_MODEL_REFERENCE, 'openrouter/deepseek/deepseek-v4.1-flash');
  assert.notEqual(catalog.models[1].reference, DEFAULT_MODEL_REFERENCE);
});

test('models/openrouter: malformed, truncated, duplicate and invalid-shaped responses fail closed', async () => {
  for (const text of ['{', '{}', '{"data":null}', '{"data":[', '{"data":[{}]}']) {
    await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => new Response(text) }));
  }
  for (const changes of [{ id: '../secret' }, { name: 5 }, { context_length: -1 }, { context_length: 1.5 }, { supported_parameters: 'tools' }, { supported_parameters: [5] }, { pricing: [] }]) {
    await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => response([row(changes)]) }));
  }
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => response([row(), row()]) }));
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => new Response(new Uint8Array([0xff])) }));
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => { throw new Error('synthetic-secret'); } }));
});

test('models/openrouter: HTTP failures, redirect responses and body bounds never return stale data', async () => {
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => new Response('synthetic-secret', { status: 500 }) }));
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }) }));
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => { const result = response([row()]); Object.defineProperty(result, 'redirected', { value: true }); return result; } }));
  await rejectsSanitized(fetchOpenRouterCatalog({ maxBodyBytes: 10, transport: valid }));
  await rejectsSanitized(fetchOpenRouterCatalog({ maxBodyBytes: 10, transport: async () => new Response('{}', { headers: { 'Content-Length': '11' } }) }));
  await rejectsSanitized(fetchOpenRouterCatalog({ transport: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('truncated-secret')); } })) }));
  for (const bounds of [{ timeoutMs: 10001 }, { timeoutMs: 0 }, { maxBodyBytes: 8 * 1024 * 1024 + 1 }]) await assert.rejects(fetchOpenRouterCatalog({ ...bounds, transport: valid }), /Invalid model catalog request bounds/);
});

test('models/openrouter: timeout bounds transport and body consumption even if transport ignores abort', async () => {
  let signal;
  await rejectsSanitized(fetchOpenRouterCatalog({ timeoutMs: 10, transport: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } }));
  assert.equal(signal.aborted, true);
  let canceled = false;
  await rejectsSanitized(fetchOpenRouterCatalog({ timeoutMs: 10, transport: async () => new Response(new ReadableStream({ cancel() { canceled = true; } })) }));
  assert.equal(canceled, true);
});
