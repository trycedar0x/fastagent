import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, cp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiToken = randomBytes(32).toString('base64url');
const id = () => randomBytes(32).toString('base64url');
const defaultModel = 'openrouter/deepseek/deepseek-v4.1-flash';
let directory, createRuntime, history, config, auth;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fastagent-runtime-test-'));
  // Runtime ownership deliberately excludes the scaffold manifest, reconciled by integration stage.
  await cp(join(root, 'templates/openai/src'), join(directory, 'src'), { recursive: true });
  await cp(join(root, 'templates/openai/tsconfig.json'), join(directory, 'tsconfig.json'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', scripts: { typecheck: 'tsc --noEmit', build: 'tsc' } }));
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const command of ['typecheck', 'build']) {
    const result = spawnSync('npm', ['run', command], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  ({ createRuntime } = await import(pathToFileURL(join(directory, 'dist/server.js'))));
  history = await import(pathToFileURL(join(directory, 'dist/history-store.js')));
  config = await import(pathToFileURL(join(directory, 'dist/config.js')));
  auth = await import(pathToFileURL(join(directory, 'dist/auth.js')));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
function mockModel(produce = async function* () { yield { type: 'text-delta', text: 'Hello 世界' }; }) {
  const calls = [];
  return { calls, async *stream(call) { calls.push(call); yield* produce(call); } };
}
async function runtime(t, model = mockModel(), historyStore, overrides = {}) {
  const instance = await createRuntime({ origin: 'http://localhost:3000', localDev: true, apiToken, model, ...(historyStore ? { historyStore } : {}), ...overrides });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.abortAll(); await instance.closeStore(); instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  return { ...instance, base,
    get: (path, headers = {}) => fetch(base + path, { headers: { Authorization: `Bearer ${apiToken}`, ...headers } }),
    post: (data, headers = {}, signal) => fetch(base + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data), signal }),
    delete: conversationId => fetch(base + '/api/conversations/' + conversationId, { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` } }),
  };
}
const frames = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));
const turn = async (app, message = 'Hi', conversationId) => {
  const response = await app.post({ message, ...(conversationId ? { conversationId } : {}) });
  assert.equal(response.status, 200); return frames(response);
};
const shared = store => ({ ...store, async close() {} });
const waitUntil = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Condition did not become true');
};

test('runtime/server: headless health is public, serves no assets/login and never calls model', async t => {
  const model = mockModel(); const app = await runtime(t, model);
  const response = await fetch(app.base + '/healthz');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  for (const path of ['/', '/app.js', '/style.css', '/api/session', '/api/login', '/api/logout', '/.env']) assert.equal((await app.get(path)).status, 404);
  assert.equal(model.calls.length, 0);
});

test('runtime/auth: constant-time bounded bearer verification; duplicate fields, cookies and query tokens rejected', async t => {
  for (const token of ['', 'x'.repeat(42), 'x'.repeat(257), 'a'.repeat(43) + '\n', 'test-only secret']) {
    assert.throws(() => auth.validateApiToken(token), { message: 'Invalid bearer token configuration.' });
  }
  const verify = auth.createAuth(apiToken);
  const headers = { authorization: `Bearer ${apiToken}` };
  assert.equal(verify.authorize({ headers, rawHeaders: ['Authorization', headers.authorization] }), true);
  assert.equal(verify.authorize({ headers, rawHeaders: ['Authorization', headers.authorization, 'authorization', headers.authorization] }), false);
  const store = history.createMemoryHistoryStore(); let operations = 0;
  const spy = { ...store, async get(...args) { operations++; return store.get(...args); }, async acquire(...args) { operations++; return store.acquire(...args); }, async delete(...args) { operations++; return store.delete(...args); } };
  const model = mockModel(); const app = await runtime(t, model, spy);
  for (const Authorization of ['', `Bearer ${id()}`, `Bearer ${apiToken} extra`, 'Basic synthetic', `Bearer ${'x'.repeat(257)}`]) {
    // Wrong content type and invalid body would fail differently if parsed before auth.
    const response = await app.post({ messages: [], model: 'secret' }, { Authorization, 'Content-Type': 'text/plain' });
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'Authentication failed.' });
  }
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(app.base + '/api/conversations/' + id(), { method });
    assert.equal(response.status, 401);
  }
  const query = await fetch(app.base + '/api/chat?token=' + apiToken, { method: 'POST', headers: { Cookie: 'fastagent=' + apiToken }, body: '{}' });
  assert.equal(query.status, 401);
  assert.equal((await app.get('/api/conversations/' + id() + '?token=not-auth')).status, 400);
  // Passing an array to http.request replaces Node's default headers, so Host must be set explicitly.
  // Without it the request is malformed and the server answers an empty-bodied 400 before the handler runs,
  // which would assert a client artifact instead of the app's behavior. With a well-formed request,
  // duplicated Authorization fields must fail as an authentication error before any body, history,
  // or model work, matching the in-process authorize() check above.
  const duplicateStatus = await new Promise((resolve, reject) => {
    const headers = ['Host', new URL(app.base).host, 'Authorization', `Bearer ${apiToken}`, 'Authorization', `Bearer ${apiToken}`, 'Content-Type', 'application/json'];
    const req = request(app.base + '/api/chat', { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(duplicateStatus, 401);
  assert.equal(operations, 0); assert.equal(model.calls.length, 0);
});

test('runtime/server: no-Origin machine clients work, supplied browser origin must match exactly', async t => {
  const model = mockModel(); const app = await runtime(t, model);
  for (const Origin of ['', 'http://localhost:3000/', 'https://evil.example']) {
    assert.equal((await app.post({ message: 'Hi' }, { Origin })).status, 403);
    assert.equal((await app.get('/api/conversations/' + id(), { Origin })).status, 403);
  }
  const response = await app.post({ message: 'Hi' }, { Origin: 'http://localhost:3000' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await frames(response)).at(-1).type, 'done');
  assert.equal((await turn(app)).at(-1).type, 'done'); assert.equal(model.calls.length, 2);
});

test('runtime/history: NDJSON starts with server ID, commits completed turns, resumes server-only context across instances', async t => {
  const store = history.createMemoryHistoryStore(); const model = mockModel();
  const a = await runtime(t, model, shared(store)); const b = await runtime(t, model, shared(store));
  const response = await a.post({ message: 'First' });
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const first = await frames(response);
  assert.equal(first[0].type, 'conversation'); assert.match(first[0].conversationId, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(first.slice(1), [{ type: 'delta', text: 'Hello 世界' }, { type: 'done' }]);
  const conversationId = first[0].conversationId;
  await turn(b, 'Second', conversationId);
  assert.deepEqual(model.calls[1].messages.slice(1), [
    { role: 'user', content: 'First' }, { role: 'assistant', content: 'Hello 世界' }, { role: 'user', content: 'Second' },
  ]);
  const fetched = await b.get('/api/conversations/' + conversationId);
  assert.deepEqual(await fetched.json(), { conversationId, messages: [
    { role: 'user', content: 'First' }, { role: 'assistant', content: 'Hello 世界' },
    { role: 'user', content: 'Second' }, { role: 'assistant', content: 'Hello 世界' },
  ] });
  const other = (await turn(a, 'Isolated'))[0].conversationId;
  assert.notEqual(other, conversationId); assert.deepEqual(model.calls.at(-1).messages.slice(1), [{ role: 'user', content: 'Isolated' }]);
  assert.equal((await b.delete(conversationId)).status, 200);
  assert.equal((await a.get('/api/conversations/' + conversationId)).status, 404);
  assert.equal((await a.post({ message: 'Not resurrected', conversationId })).status, 404);
  assert.equal((await a.delete(conversationId)).status, 404);
  assert.equal((await a.get('/api/conversations/' + other)).status, 200);
});

test('runtime/server: strict input bounds exclude client roles/system/model/history and reject unknown conversation before paid work', async t => {
  const model = mockModel(); const app = await runtime(t, model);
  for (const input of [{}, { message: '' }, { message: '  ' }, { message: 'x'.repeat(4001) }, { message: 'Hi', conversationId: '../bad' },
    { messages: [{ role: 'system', content: 'override' }] }, { message: 'Hi', model: 'override' }, { message: 'Hi', messages: [] }]) {
    assert.equal((await app.post(input)).status, 400);
  }
  assert.equal((await app.post({ message: 'Hi' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.post({ message: 'x'.repeat(40000) })).status, 413);
  assert.equal((await app.post({ message: 'Hi', conversationId: id() })).status, 404);
  assert.equal(model.calls.length, 0);
  const noModel = await runtime(t, undefined, undefined, { model: undefined });
  assert.equal((await noModel.post({ message: 'Hi' })).status, 503);
  assert.equal((await noModel.get('/healthz')).status, 200);
});

test('runtime/history: errors, whitespace/empty output, tool failure and oversized output never commit; successful commit precedes done', async t => {
  for (const produce of [
    async function* () { yield { type: 'text-delta', text: 'partial' }; throw new Error('synthetic-sensitive-provider-detail'); },
    async function* () { yield { type: 'text-delta', text: 'partial' }; yield { type: 'error' }; },
    async function* () { yield { type: 'text-delta', text: 'partial' }; yield { type: 'tool-error' }; },
    async function* () { yield { type: 'text-delta', text: ' '.repeat(2) }; },
    async function* () {},
    async function* () { yield { type: 'text-delta', text: 'x'.repeat(65537) }; },
  ]) {
    const store = history.createMemoryHistoryStore(); const app = await runtime(t, mockModel(produce), store);
    const result = await turn(app);
    assert.equal(result.at(-1).type, 'error'); assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive/);
    assert.equal(await store.get(result[0].conversationId), undefined);
    // Failed reservations release immediately, so ID is reusable as a new server reservation.
    const owner = id(); await store.acquire(result[0].conversationId, owner, true); await store.release(result[0].conversationId, owner);
  }
  const store = history.createMemoryHistoryStore(); let commits = 0;
  const app = await runtime(t, mockModel(), { ...store, async commit(...args) { commits++; return store.commit(...args); } });
  const result = await turn(app); assert.equal(result.at(-1).type, 'done'); assert.equal(commits, 1);
  assert.ok(await store.get(result[0].conversationId));
  for (const commit of [async () => false, async () => { throw new Error('synthetic-secret-redis-url'); }]) {
    const raw = history.createMemoryHistoryStore(); const failing = await runtime(t, mockModel(), { ...raw, commit });
    const result = await turn(failing); assert.equal(result.at(-1).type, 'error'); assert.equal(await raw.get(result[0].conversationId), undefined);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
});

test('runtime/history: disconnect and shutdown abort without persisting partial turns, even for uncooperative model', async t => {
  for (const shutdown of [false, true]) {
    const store = history.createMemoryHistoryStore(); let call;
    let finish;
    const blocked = new Promise(resolve => { finish = resolve; });
    const model = mockModel(async function* (value) { call = value; yield { type: 'text-delta', text: 'partial' }; await blocked; yield { type: 'text-delta', text: 'late' }; });
    const app = await runtime(t, model, store); const controller = new AbortController();
    const response = await app.post({ message: 'Hi' }, {}, controller.signal);
    const reader = response.body.getReader(); const { value } = await reader.read();
    const conversationId = JSON.parse(new TextDecoder().decode(value).split('\n')[0]).conversationId;
    await waitUntil(() => !!call);
    if (shutdown) app.abortAll(); else controller.abort();
    await waitUntil(() => call.abortSignal.aborted);
    finish(); await reader.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await store.get(conversationId), undefined);
    const owner = id(); await store.acquire(conversationId, owner, true); await store.release(conversationId, owner);
  }
});

test('runtime/history: same-conversation generations/delete conflict across instances, distinct conversations proceed; per-instance max four', async t => {
  const store = history.createMemoryHistoryStore(); const original = await runtime(t, mockModel(), shared(store));
  const conversationId = (await turn(original))[0].conversationId;
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const model = mockModel(async function* () { await gate; yield { type: 'text-delta', text: 'completed' }; });
  const a = await runtime(t, model, shared(store)); const b = await runtime(t, model, shared(store));
  const first = await a.post({ message: 'Next', conversationId });
  assert.equal((await b.post({ message: 'Conflict', conversationId })).status, 409);
  assert.equal((await b.delete(conversationId)).status, 409);
  assert.equal(model.calls.length, 1);
  const independent = await b.post({ message: 'Other' });
  const concurrent = await Promise.all(Array.from({ length: 3 }, (_, i) => a.post({ message: `new-${i}` })));
  assert.equal((await a.post({ message: 'Overloaded' })).status, 429);
  assert.equal(model.calls.length, 5);
  finish();
  for (const response of [first, independent, ...concurrent]) assert.equal((await frames(response)).at(-1).type, 'done');
  assert.equal((await b.get('/api/conversations/' + conversationId)).status, 200);
});

test('runtime/history-store: memory CAS lease expiry/reacquisition, wrong-owner release, retention and capacity recover without eviction', async t => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const store = history.createMemoryHistoryStore(); const conversationId = id(), owner = id(), wrong = id();
  const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }];
  await store.acquire(conversationId, owner, true);
  assert.equal(await store.commit(conversationId, wrong, messages), false);
  await store.release(conversationId, wrong);
  await assert.rejects(store.acquire(conversationId, wrong, true), history.HistoryConflict);
  now += history.generationLeaseLifetime;
  assert.equal(await store.commit(conversationId, owner, messages), false);
  await store.acquire(conversationId, wrong, true);
  await store.release(conversationId, owner);
  assert.equal(await store.commit(conversationId, wrong, messages), true);
  const expires = now + history.historyLifetime;
  const fetched = await store.get(conversationId); fetched[0].content = 'mutated';
  assert.deepEqual(await store.get(conversationId), messages);
  now += 1000; await store.acquire(conversationId, owner, false); await store.release(conversationId, owner);
  now = expires; assert.equal(await store.get(conversationId), undefined); // Failure/read did not extend expiry.
  const slots = [];
  for (let i = 0; i < history.historyCapacity; i++) { const slot = id(); slots.push(slot); await store.acquire(slot, owner, true); }
  await assert.rejects(store.acquire(id(), owner, true), history.HistoryCapacityExceeded);
  await store.release(slots[0], owner); await store.acquire(id(), owner, true);
  now += history.generationLeaseLifetime; await store.acquire(id(), owner, true); // Expired reservations don't leak capacity.
});

test('runtime/history-store: serialized UTF-8 storage and separate model context are bounded, trimming whole turns only', async () => {
  let messages = [];
  for (let i = 0; i < 30; i++) messages = history.completedHistory(messages, String(i), 'response');
  assert.equal(messages.length, 40); assert.equal(messages[0].content, '10');
  messages = [];
  for (let i = 0; i < 10; i++) messages = history.completedHistory(messages, String(i), '世'.repeat(20000));
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= history.historyByteLimit);
  assert.equal(messages.length % 2, 0);
  const context = history.modelContext(messages, 'last');
  assert.deepEqual(context, [{ role: 'user', content: 'last' }]); // Oversized latest turn cannot be split.
  const small = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(1000) }));
  const bounded = history.modelContext(small, 'z'.repeat(4000));
  assert.equal(bounded.length, 13); assert.equal(bounded.reduce((sum, item) => sum + item.content.length, 0), 16000);
  assert.equal(bounded[0].role, 'user'); assert.equal(bounded.at(-1).role, 'user');
  assert.throws(() => history.validateHistoryMessages([{ role: 'system', content: 'bad' }]), history.HistoryStoreUnavailable);
});

test('runtime/history: outage fails closed before model, health reports unavailable; recovery reuses stored history', async t => {
  const store = history.createMemoryHistoryStore(); let unavailable = false;
  const failing = Object.fromEntries(Object.entries(store).map(([name, fn]) => [name, async (...args) => {
    if (unavailable && name !== 'close') throw new Error('rediss://synthetic:secret@redis.example');
    return fn(...args);
  }]));
  const model = mockModel(); const app = await runtime(t, model, failing);
  const conversationId = (await turn(app))[0].conversationId;
  unavailable = true;
  for (const response of [await app.get('/healthz'), await app.get('/api/conversations/' + conversationId), await app.delete(conversationId), await app.post({ message: 'Hi', conversationId })]) {
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Conversation service unavailable. Please try again.' });
  }
  assert.equal(model.calls.length, 1);
  assert.equal((await app.post({ message: 'Hi' }, { Authorization: '' })).status, 401);
  await assert.rejects(createRuntime({ origin: 'http://localhost:3000', localDev: true, apiToken, model, historyStore: failing }), history.HistoryStoreUnavailable);
  unavailable = false; await turn(app, 'Recovered', conversationId);
  assert.equal(model.calls[1].messages[1].content, 'Hi');
});

test('runtime/config: provider-key selection, exact default, token YAML and stable app history namespace; legacy password config rejected', async () => {
  const yaml = (model = defaultModel, extra = '') => `schemaVersion: 1\nname: runtime-app\nframework: openai\n${model ? `model: ${model}\n` : ''}deployment:\n  access: token\n${extra}`;
  const environment = { FASTAGENT_API_TOKEN: apiToken, FASTAGENT_LOCAL_DEV: '1' };
  const load = (env = {}, code = `import {loadRuntimeConfig} from './dist/config.js'; const c = await loadRuntimeConfig(process.env); console.log(JSON.stringify({configured:!!c.model,namespace:c.historyNamespace}));`) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8', env: { ...environment, ...env } });
  for (const [reference, matching, wrong] of [[defaultModel, 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'], ['openai/gpt-4o-mini', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']]) {
    await writeFile(join(directory, 'fastagent.yaml'), yaml(reference));
    for (const [env, configured] of [[{ [wrong]: 'synthetic-wrong-key' }, false], [{ [matching]: 'synthetic-matching-key' }, true]]) {
      const result = load(env);
      if (!configured) {
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(`${matching} is required`));
        assert.ok(!result.stderr.includes('synthetic-wrong-key'));
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { configured, namespace: 'runtime-app' });
      }
    }
  }
  await writeFile(join(directory, 'fastagent.yaml'), yaml(null));
  let result = load({ OPENROUTER_API_KEY: 'synthetic', FASTAGENT_HISTORY_NAMESPACE: 'stable-app' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { configured: true, namespace: 'stable-app' });
  assert.equal(config.DEFAULT_MODEL_REFERENCE, defaultModel);
  for (const content of [yaml(defaultModel, 'apiKey: synthetic-sensitive\n'), yaml().replace('access: token', 'access: protected')]) {
    await writeFile(join(directory, 'fastagent.yaml'), content);
    result = load({}, `import {loadRuntimeConfig} from './dist/config.js'; try {await loadRuntimeConfig(process.env)} catch(e) {console.error(e.message); process.exitCode=1}`);
    assert.equal(result.status, 1); assert.equal(result.stderr, 'Invalid fastagent.yaml configuration.\n'); assert.doesNotMatch(result.stderr, /synthetic-sensitive/);
  }
  const valid = { origin: 'https://chat.example', localDev: false, apiToken, model: undefined, historyNamespace: 'stable-app', redisUrl: 'rediss://redis.example/0' };
  config.validateRuntimeConfig(valid);
  for (const origin of ['', 'http://chat.example', 'https://chat.example/', 'https://user:secret@chat.example', 'https://chat.example/path']) assert.throws(() => config.validateRuntimeConfig({ ...valid, origin }));
  assert.throws(() => config.validateRuntimeConfig({ ...valid, apiToken: '' }), { message: 'Invalid bearer token configuration.' });
});

test('runtime/startup: missing or blank matching model keys fail before readiness without network calls', async () => {
  for (const [model, matching, wrong] of [[defaultModel, 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'], ['openai/gpt-4o-mini', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']]) {
    await writeFile(join(directory, 'fastagent.yaml'), `schemaVersion: 1\nname: runtime-app\nframework: openai\nmodel: ${model}\ndeployment:\n  access: token\n`);
    for (const mode of ['local', 'production']) {
      for (const key of [undefined, '', '   ']) {
        const env = { FASTAGENT_API_TOKEN: apiToken, [wrong]: 'synthetic-wrong-key',
          ...(mode === 'local' ? { FASTAGENT_LOCAL_DEV: '1', FASTAGENT_DEV_JSON: '1' } : { APP_ORIGIN: 'https://chat.example', FASTAGENT_EPHEMERAL_HISTORY: '1' }),
          ...(key === undefined ? {} : { [matching]: key }) };
        const result = spawnSync(process.execPath, ['dist/main.js'], { cwd: directory, encoding: 'utf8', env, timeout: 5000 });
        assert.equal(result.status, 1, result.stderr);
        assert.ok(!result.stdout.includes('"ok":true'));
        assert.ok(!(result.stdout + result.stderr).includes('synthetic-wrong-key'));
        assert.ok(!(result.stdout + result.stderr).includes(apiToken));
        if (mode === 'local') {
          const failure = JSON.parse(result.stdout);
          assert.equal(failure.error.code, 'MODEL_API_KEY_MISSING');
          assert.ok(failure.error.message.includes(`${matching} is required`));
          assert.equal(result.stderr, '');
        } else {
          assert.equal(result.stdout, '');
          assert.ok(result.stderr.includes(`${matching} is required`));
        }
      }
    }
  }
});

test('runtime/config: ephemeral history is explicit, exclusive, and rejected in local dev', async () => {
  const base = { origin: 'https://chat.example', localDev: false, apiToken, model: undefined, historyNamespace: 'stable-app' };
  config.validateRuntimeConfig({ ...base, ephemeralHistory: true });
  config.validateRuntimeConfig({ ...base, redisUrl: 'rediss://redis.example/0' });
  assert.throws(() => config.validateRuntimeConfig({ ...base, ephemeralHistory: true, redisUrl: 'rediss://redis.example/0' }), { message: config.EPHEMERAL_HISTORY_CONFLICT_ERROR });
  assert.throws(() => config.validateRuntimeConfig(base), { message: 'REDIS_URL must configure Redis with TLS in production.' });
  assert.throws(() => config.validateRuntimeConfig({ ...base, localDev: true, origin: 'http://localhost:3000', ephemeralHistory: true }), { message: config.EPHEMERAL_HISTORY_LOCAL_ERROR });

  await writeFile(join(directory, 'fastagent.yaml'), `schemaVersion: 1\nname: runtime-app\nframework: openai\nmodel: ${defaultModel}\ndeployment:\n  access: token\n`);
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {loadRuntimeConfig} from './dist/config.js'; try { const c = await loadRuntimeConfig(process.env); console.log(JSON.stringify({ephemeral:c.ephemeralHistory, redis:!!c.redisUrl})); } catch (e) { console.error(e.message); process.exitCode = 1; }`,
  ], { cwd: directory, encoding: 'utf8', env });
  const production = { FASTAGENT_API_TOKEN: apiToken, APP_ORIGIN: 'https://chat.example', OPENROUTER_API_KEY: 'synthetic-key' };
  let result = run({ ...production, FASTAGENT_EPHEMERAL_HISTORY: '1' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { ephemeral: true, redis: false });
  result = run({ ...production, REDIS_URL: 'rediss://redis.example/0' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { ephemeral: false, redis: true });
  result = run({ ...production, FASTAGENT_EPHEMERAL_HISTORY: 'true' });
  assert.equal(result.status, 1); assert.equal(result.stderr, config.EPHEMERAL_HISTORY_VALUE_ERROR + '\n');
  result = run({ ...production, FASTAGENT_EPHEMERAL_HISTORY: '1', REDIS_URL: 'rediss://redis.example/0' });
  assert.equal(result.status, 1); assert.equal(result.stderr, config.EPHEMERAL_HISTORY_CONFLICT_ERROR + '\n');
  result = run(production);
  assert.equal(result.status, 1); assert.equal(result.stderr, 'REDIS_URL must configure Redis with TLS in production.\n');
});

test('runtime/config: ephemeral production runtime warns once and serves public health from memory', async (t) => {
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...rest) => { writes.push(String(chunk)); return original(chunk, ...rest); });
  const store = history.createMemoryHistoryStore();
  const app = await runtime(t, mockModel(), store, { localDev: false, origin: 'https://chat.example', ephemeralHistory: true, historyNamespace: 'stable-app' });
  const warnings = writes.filter((line) => line.includes('FASTAGENT_EPHEMERAL_HISTORY'));
  assert.equal(warnings.length, 1); assert.match(warnings[0], /in memory/); assert.match(warnings[0], /lost on every restart/);
  const response = await fetch(app.base + '/healthz');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
});

// Reads NDJSON frames incrementally so a test can act between frames: returns the first
// conversation frame plus a drain function for the remaining response text.
async function firstFrameThenDrain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let first;
  while (first === undefined) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const newline = buffer.indexOf('\n');
    if (newline >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      if (frame.type !== 'conversation') break;
      first = frame; buffer = buffer.slice(newline + 1);
    }
  }
  return {
    first,
    drain: async () => {
      let text = buffer;
      while (true) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
      return text;
    },
  };
}
const lastFrame = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1);

test('runtime/history: closing one runtime never closes a caller-injected store', async t => {
  const store = history.createMemoryHistoryStore();
  const a = await runtime(t, mockModel(), store);
  const b = await runtime(t, mockModel(), store);
  const [announced] = await turn(a, 'Hi');
  assert.equal(announced.type, 'conversation');
  assert.equal((await b.get('/api/conversations/' + announced.conversationId)).status, 200);
  await a.closeStore();
  const after = await b.get('/api/conversations/' + announced.conversationId);
  assert.equal(after.status, 200, 'an injected store must outlive the runtime that did not create it');
  assert.equal((await after.json()).messages.length, 2);
});

test('runtime/history: a request aborted before its commit stores nothing and reports an error', async t => {
  const base = history.createMemoryHistoryStore();
  let commits = 0;
  const store = { ...base, async commit(...args) { commits++; return base.commit(...args); } };
  const model = mockModel(async function* (call) {
    yield { type: 'text-delta', text: 'partial' };
    await new Promise(resolve => call.abortSignal.addEventListener('abort', resolve, { once: true }));
  });
  const app = await runtime(t, model, store);
  const response = await app.post({ message: 'Hi' });
  assert.equal(response.status, 200);
  const stream = await firstFrameThenDrain(response);
  app.abortAll();
  assert.equal(lastFrame(await stream.drain()).type, 'error');
  assert.equal(commits, 0, 'an aborted request must not start a commit');
  assert.equal(await base.get(stream.first.conversationId), undefined);
});

test('runtime/history: an abort during an in-flight commit never reports a false failure', async t => {
  const base = history.createMemoryHistoryStore();
  let entered; const commitEntered = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const store = { ...base, async commit(...args) { entered(); await gate; return base.commit(...args); } };
  const app = await runtime(t, mockModel(), store);
  const response = await app.post({ message: 'Hi' });
  const stream = await firstFrameThenDrain(response);
  assert.equal(stream.first.type, 'conversation');
  await commitEntered;
  app.abortAll();
  release();
  // A commit that has already started is atomic and uncancellable, and a successful commit ends lease
  // ownership, so this sub-atomic window cannot roll back. The response must therefore report the
  // committed turn instead of claiming a failure for history the store holds. This is the documented
  // residual; an abort observed before the commit stores nothing (covered by the test above).
  assert.equal(lastFrame(await stream.drain()).type, 'done');
  assert.equal((await base.get(stream.first.conversationId)).length, 2);
});

test('runtime/history: an owner holding the lease may delete, an unowned delete still conflicts', async () => {
  const store = history.createMemoryHistoryStore();
  const conversationId = randomBytes(32).toString('base64url');
  const first = randomBytes(32).toString('base64url');
  const second = randomBytes(32).toString('base64url');
  await store.acquire(conversationId, first, true);
  await store.commit(conversationId, first, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]);
  // A second generation on the stored conversation holds the lease, as it would mid-commit.
  await store.acquire(conversationId, second, false);
  await assert.rejects(() => store.delete(conversationId), (error) => error instanceof history.HistoryConflict);
  // A stale owner who no longer holds the lease must not be able to delete stored history.
  await assert.rejects(() => store.delete(conversationId, first), (error) => error instanceof history.HistoryConflict);
  assert.equal(await store.delete(conversationId, second), true);
  assert.equal(await store.get(conversationId), undefined);
  await store.release(conversationId, second);
  // With no live lease, an owner-bearing delete is unauthorized while ordinary deletion is allowed.
  await store.acquire(conversationId, first, true);
  await store.commit(conversationId, first, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]);
  await assert.rejects(() => store.delete(conversationId, second), (error) => error instanceof history.HistoryConflict);
  assert.equal(await store.delete(conversationId), true);
});
