import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';
import { initProject } from '../dist/scaffold/init.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const password = 'test-only-password-123';
const salt = randomBytes(16);
const passwordHash = `scrypt-v1$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
const textChunks = [
  { type: 'text-delta', text: 'Hello <script>' },
  { type: 'text-delta', text: '世界' },
];
function mockModel(produce = async function* () { for (const part of textChunks) yield part; }) {
  const calls = [];
  const generate = typeof produce === 'function' ? produce : async function* () { for (const part of produce) yield part; };
  return { calls, async *stream(call) { calls.push(call); yield* generate(call); } };
}
let directory;
let parent;
let createRuntime;
let createAuth;
let createMemorySessionStore;
let validateRedisConfig;
let createRedisSessionStore;
let validateRuntimeConfig;
let createModel;
let tools;

before(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'fastagent-runtime-test-')));
  directory = (await initProject({ directory: 'agent', cwd: parent })).directory;
  // Repository tests reuse installed development SDK/compiler; standalone npm install is a separate gate.
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const built = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: directory, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  ({ createRuntime } = await import(pathToFileURL(join(directory, 'dist/server.js'))));
  ({ createMemorySessionStore } = await import(pathToFileURL(join(directory, 'dist/session-store.js'))));
  ({ validateRedisConfig, createRedisSessionStore } = await import(pathToFileURL(join(directory, 'dist/redis-session-store.js'))));
  ({ createAuth } = await import(pathToFileURL(join(directory, 'dist/auth.js'))));
  ({ validateRuntimeConfig } = await import(pathToFileURL(join(directory, 'dist/config.js'))));
  ({ createModel } = await import(pathToFileURL(join(directory, 'dist/agent.js'))));
  ({ tools } = await import(pathToFileURL(join(directory, 'dist/tools.js'))));
});
after(async () => { if (parent) await rm(parent, { recursive: true, force: true }); });

async function runtime(t, model = mockModel(), production = false, sessionStore) {
  const config = { origin: production ? 'https://chat.example' : 'http://localhost:3000', localDev: !production, passwordHash, model, sessionStore: sessionStore ?? (production ? createMemorySessionStore() : undefined) };
  const instance = await createRuntime(config);
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.abortAll(); await instance.closeStore(); instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const client = {
    ...instance, config, base, cookie: '', csrf: '',
    async bootstrap() {
      const response = await fetch(`${base}/api/session`, { headers: { Cookie: this.cookie } });
      this.cookie = response.headers.get('set-cookie')?.split(';')[0] ?? this.cookie;
      const session = await response.json(); this.csrf = session.csrf;
      return { response, session };
    },
    async post(path, data, overrides = {}, signal) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.origin, Cookie: this.cookie, 'X-CSRF-Token': this.csrf, ...overrides }, body: JSON.stringify(data), signal });
      return response;
    },
    async login() {
      await this.bootstrap();
      const response = await this.post('/api/login', { password });
      assert.equal(response.status, 200);
      this.cookie = response.headers.get('set-cookie').split(';')[0]; this.csrf = (await response.json()).csrf;
    },
  };
  return client;
}
const chat = { messages: [{ role: 'user', content: 'Hi' }] };

test('runtime/server: health and static UI never call model; UI has no HTML injection', async t => {
  const model = mockModel(); const app = await runtime(t, model);
  const health = await fetch(`${app.base}/healthz`);
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
  const page = await fetch(`${app.base}/`); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /app.js/);
  const ui = await (await fetch(`${app.base}/app.js`)).text();
  assert.match(ui, /textContent/); assert.doesNotMatch(ui, /innerHTML|document.write/);
  assert.match(ui, /TextDecoder/); assert.match(ui, /frame.type === 'done'/);
  assert.equal((await fetch(`${app.base}/.env`)).status, 404);
  assert.equal(model.calls.length, 0);
});

test('runtime/auth: production cookies, pre-login CSRF, rotation, hashed session, revocation', async t => {
  const app = await runtime(t, mockModel(), true);
  const { response, session } = await app.bootstrap();
  const cookieHeader = response.headers.get('set-cookie');
  assert.equal(session.authenticated, false);
  assert.match(cookieHeader, /^__Host-fastagent=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=300']) assert.ok(cookieHeader.includes(flag));
  assert.doesNotMatch(cookieHeader, /Domain=/i);
  assert.equal((await app.post('/api/chat', chat)).status, 401);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'X-CSRF-Token': '' }, { Cookie: '' }]) {
    const denied = await app.post('/api/login', { password }, headers);
    assert.ok([401, 403].includes(denied.status));
    assert.deepEqual(await denied.json(), { error: 'Authentication failed.' });
  }
  const oldCookie = app.cookie; const oldCsrf = app.csrf;
  const login = await app.post('/api/login', { password }); assert.equal(login.status, 200);
  app.cookie = login.headers.get('set-cookie').split(';')[0]; app.csrf = (await login.json()).csrf;
  assert.match(login.headers.get('set-cookie'), /Max-Age=3600/);
  assert.notEqual(app.cookie, oldCookie); assert.notEqual(app.csrf, oldCsrf);
  assert.equal((await app.post('/api/chat', chat, { Cookie: oldCookie, 'X-CSRF-Token': oldCsrf })).status, 401);
  assert.equal((await app.post('/api/chat', chat, { 'X-CSRF-Token': oldCsrf })).status, 401);
  assert.equal((await app.post('/api/logout', {})).status, 200);
  assert.equal((await app.post('/api/chat', chat)).status, 401);
  const source = await readFile(join(directory, 'src/auth.ts'), 'utf8');
  assert.match(source, /store.issue\(digest\(raw\)/); assert.doesNotMatch(source, /store.issue\(raw/);
});

// Exercise production capacities without HTTP connection overhead; all password checks use real scrypt.
async function authClient(auth, peer) {
  let cookie = '';
  const req = { headers: {}, socket: { remoteAddress: peer } };
  const res = { setHeader(name, value) { if (name === 'Set-Cookie') cookie = value.split(';')[0]; } };
  const session = await auth.session(req, res);
  if (session) { req.headers.cookie = cookie; req.headers['x-csrf-token'] = session.csrf; }
  return { req, res, session, update(session) {
    this.session = session; req.headers.cookie = cookie; req.headers['x-csrf-token'] = session.csrf;
  } };
}

test('runtime/auth: anonymous issuance throttles socket peers, ignores forwarded headers and recovers', async t => {
  const app = await runtime(t); await app.login();
  const now = Date.now(); let time = now;
  t.mock.method(Date, 'now', () => time);
  try {
    // Login already issued one anonymous cookie in this peer's window.
    let retained;
    for (let i = 0; i < 19; i++) {
      const response = await fetch(`${app.base}/api/session`, { headers: { 'X-Forwarded-For': `192.0.2.${i}` } });
      assert.equal(response.status, 200);
      retained = { Cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf };
    }
    const limited = await fetch(`${app.base}/api/session`, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
    assert.equal(limited.status, 503); assert.equal(limited.headers.get('set-cookie'), null);
    assert.deepEqual(await limited.json(), { error: 'Authentication failed.' });
    const existing = await fetch(`${app.base}/api/session`, { headers: { Cookie: retained.Cookie } });
    assert.equal(existing.status, 200); assert.equal(existing.headers.get('set-cookie'), null);
    assert.equal((await existing.json()).csrf, retained.csrf);
    const authenticated = await fetch(`${app.base}/api/session`, { headers: { Cookie: app.cookie } });
    assert.equal((await authenticated.json()).authenticated, true);
    const login = await app.post('/api/login', { password }, { Cookie: retained.Cookie, 'X-CSRF-Token': retained.csrf });
    assert.equal(login.status, 200); // Throttled issuance does not prevent valid login.
    const rotation = await app.post('/api/login', { password });
    assert.equal(rotation.status, 200); // Nor rotation of authenticated sessions.
    time = now + 60001;
    const recovered = await fetch(`${app.base}/api/session`);
    assert.equal(recovered.status, 200); await recovered.json();
  } finally { t.mock.restoreAll(); }
});

test('runtime/auth: anonymous capacity evicts oldest only, preserves authenticated sessions and permits login', async t => {
  const auth = createAuth(passwordHash, false, createMemorySessionStore());
  t.mock.method(Date, 'now', () => 1000000);
  const protectedClient = await authClient(auth, 'protected');
  protectedClient.update(await auth.login(protectedClient.req, protectedClient.res, password));
  const oldest = await authClient(auth, 'first-anonymous');
  let latest;
  // Including oldest, 257 anonymous cookies exceeds the independent 256-entry capacity.
  for (let i = 0; i < 256; i++) latest = await authClient(auth, `flood-${Math.floor(i / 20)}`);
  assert.equal(await auth.authorize(protectedClient.req), true);
  assert.notEqual((await auth.session(oldest.req, oldest.res))?.csrf, oldest.session.csrf);
  assert.equal(await auth.session(latest.req, latest.res), latest.session);
  latest.update(await auth.login(latest.req, latest.res, password));
  assert.equal(await auth.authorize(latest.req), true);
  assert.equal(await auth.authorize(protectedClient.req), true);
});

test('runtime/auth: anonymous expiry and issuance bucket saturation recover independently', async t => {
  const auth = createAuth(passwordHash, false, createMemorySessionStore());
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const clients = [];
  for (let i = 0; i < 256; i++) {
    const client = await authClient(auth, `peer-${i}`); assert.ok(client.session); clients.push(client);
  }
  assert.equal((await authClient(auth, 'new-peer')).session, undefined);
  assert.equal(await auth.session(clients.at(-1).req, clients.at(-1).res), clients.at(-1).session);
  now += 60000;
  const fresh = await authClient(auth, 'new-peer'); assert.ok(fresh.session);
  assert.equal(await auth.session(fresh.req, fresh.res), fresh.session);
  now += 300000;
  assert.notEqual((await auth.session(fresh.req, fresh.res))?.csrf, fresh.session.csrf);
});

test('runtime/auth: full authenticated capacity allows own rotation and recovers after logout or expiry', async t => {
  const auth = createAuth(passwordHash, false, createMemorySessionStore());
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const clients = [];
  for (let i = 0; i < 1000; i++) {
    const client = await authClient(auth, `peer-${Math.floor(i / 20)}`);
    const session = await auth.login(client.req, client.res, password);
    assert.ok(session, `authenticated slot ${i}`); client.update(session); clients.push(client);
  }
  const first = clients[0];
  const oldRequest = { ...first.req, headers: { ...first.req.headers } };
  const rotated = await auth.login(first.req, first.res, password);
  assert.ok(rotated); first.update(rotated);
  assert.equal(await auth.authorize(first.req), true); assert.equal(await auth.authorize(oldRequest), false);
  const waiting = await authClient(auth, 'waiting-peer');
  assert.equal(await auth.login(waiting.req, waiting.res, password), undefined);
  assert.equal(await auth.session(waiting.req, waiting.res), waiting.session); // Failed allocation retains pre-login session.
  await auth.logout(first.req, first.res);
  waiting.update(await auth.login(waiting.req, waiting.res, password));
  assert.equal(await auth.authorize(waiting.req), true);
  now += 3600000;
  assert.equal(await auth.authorize(waiting.req), false);
  const recovered = await authClient(auth, 'recovered-peer');
  recovered.update(await auth.login(recovered.req, recovered.res, password));
  assert.equal(await auth.authorize(recovered.req), true);
});

test('runtime/auth: simultaneous rotation consumes one slot and revokes the original', async () => {
  const auth = createAuth(passwordHash, false, createMemorySessionStore());
  const client = await authClient(auth, 'rotation-peer');
  const original = { ...client.req, headers: { ...client.req.headers } };
  const attempts = await Promise.all([auth.login(original, client.res, password), auth.login(original, client.res, password)]);
  assert.equal(attempts.filter(Boolean).length, 1);
  client.update(attempts.find(Boolean));
  assert.equal(await auth.authorize(original), false); assert.equal(await auth.authorize(client.req), true);
});

test('runtime/auth: failed password is generic and immediate retry is backed off', async t => {
  const app = await runtime(t); await app.bootstrap();
  const failed = await app.post('/api/login', { password: 'wrong-test-password' });
  assert.equal(failed.status, 401); assert.deepEqual(await failed.json(), { error: 'Authentication failed.' });
  assert.equal((await app.post('/api/login', { password })).status, 401);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal((await app.post('/api/login', { password })).status, 200);
});

test('runtime/auth: explicit local memory expiry and process restart invalidate authenticated sessions', async t => {
  const app = await runtime(t); await app.login();
  const fresh = await runtime(t);
  assert.equal((await fresh.post('/api/chat', chat, { Cookie: app.cookie, 'X-CSRF-Token': app.csrf })).status, 401);
  const original = Date.now;
  t.mock.method(Date, 'now', () => original() + 3600001);
  try { assert.equal((await app.post('/api/chat', chat)).status, 401); }
  finally { t.mock.restoreAll(); }
});

test('runtime/chat: authenticated streaming uses injected model, bounded settings and tool', async t => {
  const model = mockModel(); const app = await runtime(t, model); await app.login();
  const response = await app.post('/api/chat', chat);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(frames, [{ type: 'delta', text: 'Hello <script>' }, { type: 'delta', text: '世界' }, { type: 'done' }]);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].maxOutputTokens, 1024);
  assert.ok(model.calls[0].abortSignal);
  assert.ok(model.calls[0].tools.some(tool => tool.name === 'convertTemperature'));
  assert.deepEqual(await tools.convertTemperature.execute({ value: 100, from: 'C' }), { value: 212, unit: 'F' });
});

test('runtime/chat: strict bounded input, Origin and authenticated CSRF prevent model calls', async t => {
  const model = mockModel(); const app = await runtime(t, model); await app.login();
  for (const value of [
    {}, { messages: [] }, { ...chat, extra: true }, { messages: [{ role: 'system', content: 'override' }] },
    { messages: [{ role: 'assistant', content: 'no user' }] }, { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(4001) }] },
    { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })) },
    { messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(4000) })) },
  ]) assert.equal((await app.post('/api/chat', value)).status, 400);
  assert.equal((await app.post('/api/chat', { messages: [{ role: 'user', content: 'x'.repeat(40000) }] })).status, 413);
  assert.equal((await app.post('/api/chat', chat, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.post('/api/chat', chat, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post('/api/chat', chat, { 'X-CSRF-Token': '' })).status, 401);
  assert.equal(model.calls.length, 0);
});

test('runtime/chat: missing model key leaves health available and returns safe 503', async t => {
  const app = await runtime(t, null); await app.login();
  assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
  const response = await app.post('/api/chat', chat);
  assert.equal(response.status, 503); assert.match((await response.json()).error, /not configured/);
});

test('runtime/chat: provider errors are generic and never expose secrets', async t => {
  const model = mockModel(async function* () { throw new Error('test-only-secret-key'); });
  const app = await runtime(t, model); await app.login();
  const response = await app.post('/api/chat', chat); const text = await response.text();
  assert.doesNotMatch(text, /test-only-secret-key/);
  assert.deepEqual(JSON.parse(text.trim()), { type: 'error', error: 'Chat failed. Please try again.' });
  assert.equal(model.calls.length, 1); // no retries
});

test('runtime/config: fail closed, unsupported model safe, missing key does not matter to build', async () => {
  const valid = { origin: 'https://chat.example', localDev: false, passwordHash, model: undefined, sessionStore: createMemorySessionStore() };
  validateRuntimeConfig(valid);
  for (const changed of [
    { passwordHash: '' }, { passwordHash: password }, { origin: '' }, { origin: 'http://chat.example' },
    { origin: 'https://user:password@chat.example' }, { origin: 'https://chat.example/' },
    { origin: 'http://chat.example', localDev: true },
  ]) assert.throws(() => validateRuntimeConfig({ ...valid, ...changed }));
  assert.equal(createModel('openai/gpt-4o-mini', undefined), undefined);
  assert.throws(() => createModel('other/test-only-secret', undefined), error => /Unsupported model provider/.test(error.message) && !error.message.includes('test-only-secret'));
  const startup = spawnSync(process.execPath, ['dist/main.js'], { cwd: directory, encoding: 'utf8', timeout: 5000, env: { PORT: '3000', APP_ORIGIN: 'https://chat.example' } });
  assert.equal(startup.status, 1); assert.equal(startup.stdout, ''); assert.match(startup.stderr, /Invalid access protection configuration/);
});

test('runtime/config: IPv6 localhost fails safely before listening; IPv4 local origins remain valid', async t => {
  const valid = { localDev: true, passwordHash, model: undefined };
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) validateRuntimeConfig({ ...valid, origin });
  const errorMessage = 'IPv6 localhost APP_ORIGIN is not supported. Use http://localhost or http://127.0.0.1 with the configured port.';
  assert.throws(() => validateRuntimeConfig({ ...valid, origin: 'http://[::1]:3000' }), { message: errorMessage });
  await assert.rejects(createRuntime({ ...valid, origin: 'http://[::1]:3000' }), { message: errorMessage });
  const startup = spawnSync(process.execPath, ['dist/main.js'], { cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { PORT: '3000', FASTAGENT_LOCAL_DEV: '1', APP_ORIGIN: 'http://[::1]:3000', FASTAGENT_PASSWORD_HASH: passwordHash } });
  assert.equal(startup.status, 1); assert.equal(startup.stdout, ''); assert.equal(startup.stderr, errorMessage + '\n');
});

test('runtime/chat: disconnect cancels model work and concurrency is capped', async t => {
  const signals = [];
  const model = mockModel(async function* ({ abortSignal }) {
    signals.push(abortSignal);
    yield { type: 'text-delta', text: 'first' };
    await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));
  });
  const app = await runtime(t, model); await app.login();
  const pending = [];
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController();
    const response = await app.post('/api/chat', chat, {}, controller.signal);
    const reader = response.body.getReader(); await reader.read();
    pending.push({ controller, reader });
  }
  assert.equal((await app.post('/api/chat', chat)).status, 429);
  for (const { controller } of pending) controller.abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(signals.length, 4); assert.ok(signals.every(signal => signal.aborted));
});

test('runtime/chat: pure tool loop stops after three model steps', async t => {
  const model = mockModel(async function* () {
    yield { type: 'tool-call', toolCallId: randomBytes(4).toString('hex'), toolName: 'convertTemperature', input: JSON.stringify({ value: 0, from: 'C' }) };
  });
  const app = await runtime(t, model); await app.login();
  const response = await app.post('/api/chat', chat); assert.match(await response.text(), /"type":"done"/);
  assert.equal(model.calls.length, 3);
});

test('runtime/Docker: build contains no env or credential copies and runtime is non-root', async () => {
  const docker = await readFile(join(directory, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(docker, /COPY\s+\.\s|ARG.*KEY|ENV.*KEY|COPY.*\.env/);
  assert.match(docker, /USER node/); assert.match(docker, /CMD \["node", "dist\/main.js"\]/);
  const ignore = await readFile(join(directory, '.dockerignore'), 'utf8');
  assert.ok(ignore.split('\n').includes('**')); assert.match(ignore, /\*\*\/\.env\.\*/);
  assert.match(ignore, /\*\*\/\.config\/\*\*/);
});

test('runtime/chat: duration aborts a stalled model and emits a terminal generic error', async t => {
  let signal;
  const model = mockModel(async function* ({ abortSignal }) {
    signal = abortSignal;
    await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));
  });
  const app = await runtime(t, model); await app.login();
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => originalTimeout(callback, ms === 30000 ? 40 : ms, ...args));
  try {
    const response = await app.post('/api/chat', chat);
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(frames, [{ type: 'error', error: 'Chat failed. Please try again.' }]);
    assert.equal(signal.aborted, true);
  } finally { t.mock.restoreAll(); }
});

test('runtime/chat: excessive streamed text is cut off with generic error', async t => {
  const model = mockModel([
    { type: 'text-delta', text: 'x'.repeat(65537) },
  ]);
  const app = await runtime(t, model); await app.login();
  const response = await app.post('/api/chat', chat);
  assert.deepEqual(JSON.parse((await response.text()).trim()), { type: 'error', error: 'Chat failed. Please try again.' });
  assert.equal(model.calls[0].abortSignal.aborted, true);
});

test('runtime/auth: parallel password verification is bounded to two', async t => {
  const app = await runtime(t);
  const headers = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${app.base}/api/session`);
    headers.push({ Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await response.json()).csrf });
  }
  const attempts = await Promise.all(headers.map(header => app.post('/api/login', { password }, header)));
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 200, 401]);
});

test('runtime/config: generated standalone config rejects unknown secret fields without echoing them', async () => {
  const path = join(directory, 'fastagent.yaml');
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, original + 'apiKey: test-only-secret-config\n');
    const result = spawnSync(process.execPath, ['dist/main.js'], { cwd: directory, encoding: 'utf8', timeout: 5000, env: { APP_ORIGIN: 'https://chat.example', FASTAGENT_PASSWORD_HASH: passwordHash } });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Invalid fastagent.yaml configuration.\n');
    assert.doesNotMatch(result.stderr, /test-only-secret-config/);
  } finally { await writeFile(path, original); }
});

test('runtime/agent: upstream SDK warning details are not logged', async t => {
  const model = mockModel([{ type: 'stream-start', warnings: [{ type: 'other', message: 'test-only-secret-warning' }] }, ...textChunks]);
  const app = await runtime(t, model); await app.login();
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  t.mock.method(process, 'emitWarning', (...args) => logs.push(args));
  try {
    const response = await app.post('/api/chat', chat); await response.text();
    assert.deepEqual(logs, []);
  } finally { t.mock.restoreAll(); }
});

// Separate clients returning deserialized records exercise the remote-store seam, not object identity.
function sharedClient(store, beforeRotate = async () => {}) {
  return {
    check: () => store.check(),
    get: async hash => structuredClone(await store.get(hash)),
    issue: (hash, session) => store.issue(hash, structuredClone(session)),
    rotate: async (...args) => { await beforeRotate(); return store.rotate(...structuredClone(args)); },
    revoke: (...args) => store.revoke(...args),
    async close() {},
  };
}

test('runtime/session-store: instance A login works on B; B logout revokes A; shared expiry', async t => {
  const store = createMemorySessionStore();
  const a = await runtime(t, mockModel(), true, sharedClient(store));
  const b = await runtime(t, mockModel(), true, sharedClient(store));
  await a.login();
  b.cookie = a.cookie; b.csrf = a.csrf;
  assert.equal((await b.post('/api/chat', chat)).status, 200);
  assert.equal((await b.bootstrap()).session.authenticated, true);
  assert.equal((await b.post('/api/logout', {})).status, 200);
  assert.equal((await a.post('/api/chat', chat)).status, 401);
  await a.login(); b.cookie = a.cookie; b.csrf = a.csrf;
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 3600001);
  assert.equal((await b.post('/api/chat', chat)).status, 401);
});

test('runtime/session-store: two-instance rotation has one winner; logout or TTL during verification wins', async t => {
  const store = createMemorySessionStore();
  const a = createAuth(passwordHash, false, sharedClient(store));
  const b = createAuth(passwordHash, false, sharedClient(store));
  const client = await authClient(a, 'shared-peer');
  const original = { ...client.req, headers: { ...client.req.headers } };
  const attempts = await Promise.all([a.login(original, client.res, password), b.login(original, client.res, password)]);
  assert.equal(attempts.filter(Boolean).length, 1);
  client.update(attempts.find(Boolean));
  assert.equal(await a.authorize(original), false);
  assert.equal(await b.authorize(client.req), true);
  const revoked = createAuth(passwordHash, false, sharedClient(store, async () => {
    assert.equal(await b.logout(client.req, client.res), true);
  }));
  assert.equal(await revoked.login(client.req, client.res, password), undefined);
  assert.equal(await b.authorize(client.req), false);
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const expiring = createAuth(passwordHash, false, sharedClient(store, async () => { now += 300000; }));
  const prelogin = await authClient(expiring, 'expiring');
  assert.equal(await expiring.login(prelogin.req, prelogin.res, password), undefined);
});

test('runtime/session-store: outages fail closed with safe retryable 503 and no cookies/log secrets', async t => {
  const store = createMemorySessionStore();
  let unavailable = false;
  const secret = 'rediss://test-user:test-only-redis-password@redis.example:6379';
  const client = sharedClient(store);
  const failing = Object.fromEntries(Object.keys(client).map(name => [name, async (...args) => {
    if (unavailable && name !== 'close') throw new Error(secret);
    return client[name](...args);
  }]));
  const app = await runtime(t, mockModel(), true, failing); await app.login();
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  unavailable = true;
  for (const path of ['/api/session', '/healthz', '/api/login', '/api/logout', '/api/chat']) {
    const response = ['/api/session', '/healthz'].includes(path)
      ? await fetch(`${app.base}${path}`, { headers: { Cookie: app.cookie } })
      : await app.post(path, path === '/api/login' ? { password } : chat);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'Session service unavailable. Please try again.' });
  }
  assert.equal((await fetch(`${app.base}/api/session`)).status, 503); // No anonymous memory fallback.
  assert.deepEqual(logs, []);
  await assert.rejects(createRuntime({ ...app.config, sessionStore: failing }), { message: 'Session service unavailable. Please try again.' });
  unavailable = false;
  assert.equal((await app.post('/api/chat', chat)).status, 200); // Existing session survives retry, no local cache.
});

test('runtime/redis-session-store: runtime config requires production TLS and a stable validated namespace', async () => {
  const valid = { origin: 'https://chat.example', localDev: false, passwordHash, model: undefined, sessionNamespace: 'shared-app' };
  validateRuntimeConfig({ ...valid, redisUrl: 'rediss://test-user:test-only-redis-password@redis.example:6379/0' });
  for (const redisUrl of [undefined, '', 'not-a-url-test-only-secret', 'redis://redis.example',
    'https://user:test-only-secret@redis.example', 'rediss://redis.example/0?password=test-only-secret', 'rediss://redis.example/bad',
    ' rediss://redis.example', 'rediss://user:%zz@redis.example', 'rediss://redis.example/9999999999999999999']) {
    assert.throws(() => validateRuntimeConfig({ ...valid, redisUrl }), { message: 'REDIS_URL must configure Redis with TLS in production.' });
  }
  for (const namespace of ['', 'UPPER', 'bad/id', '{app}', 'x'.repeat(64)]) {
    assert.throws(() => validateRedisConfig('rediss://redis.example', namespace, false), { message: 'Invalid session namespace configuration.' });
  }
  validateRedisConfig(undefined, 'local-app', true);
  validateRedisConfig('redis://127.0.0.1:6379', 'local-app', true);
  const env = { APP_ORIGIN: valid.origin, FASTAGENT_PASSWORD_HASH: passwordHash };
  for (const changed of [{}, { REDIS_URL: 'redis://user:test-only-redis-password@redis.example' },
    { REDIS_URL: 'rediss://redis.example', FASTAGENT_SESSION_NAMESPACE: 'bad/test-only-secret' }]) {
    const result = spawnSync(process.execPath, ['dist/main.js'], { cwd: directory, encoding: 'utf8', timeout: 5000, env: { ...env, ...changed } });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^(REDIS_URL must configure Redis with TLS in production\.|Invalid session namespace configuration\.)\n$/);
    assert.doesNotMatch(result.stderr, /test-only|redis\.example|user:/);
  }
  for (const override of [undefined, 'stable-app']) {
    const code = `import {loadRuntimeConfig} from './dist/config.js'; console.log((await loadRuntimeConfig(process.env)).sessionNamespace);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8', env: {
      ...env, REDIS_URL: 'rediss://test-user:test-only-redis-password@redis.example',
      ...(override ? { FASTAGENT_SESSION_NAMESPACE: override } : {}),
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), override ?? 'agent');
    assert.equal(result.stderr, ''); // Config loading never connects.
  }
});

test('runtime/redis-session-store: actual library connection errors and stalled handshake are bounded and sanitized', async t => {
  const logs = []; const sockets = new Set();
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  let mode = 'error';
  const server = createTcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', () => {
      if (mode === 'error') socket.end('-ERR rediss://test-user:test-only-redis-password@redis.example\r\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `redis://test-user:test-only-redis-password@127.0.0.1:${server.address().port}`;
  await assert.rejects(createRedisSessionStore(url, 'test-app', true), { message: 'Session service unavailable. Please try again.' });
  mode = 'stalled';
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => originalTimeout(callback, ms === 3000 ? 40 : ms, ...args));
  await assert.rejects(createRedisSessionStore(url, 'test-app', true), { message: 'Session service unavailable. Please try again.' });
  assert.deepEqual(logs, []);
});

// Minimal local RESP transport double: exercises node-redis reconnection, not Redis Lua semantics.
function consumeResp(buffer) {
  const first = buffer.indexOf('\r\n');
  if (first < 0) return;
  const count = Number(buffer.subarray(1, first).toString());
  if (buffer[0] !== 42 || !Number.isInteger(count)) throw new Error('Unexpected test RESP frame');
  let offset = first + 2; const args = [];
  for (let i = 0; i < count; i++) {
    const end = buffer.indexOf('\r\n', offset); if (end < 0) return;
    const size = Number(buffer.subarray(offset + 1, end).toString());
    if (buffer.length < end + 2 + size + 2) return;
    args.push(buffer.subarray(end + 2, end + 2 + size).toString()); offset = end + 2 + size + 2;
  }
  return { args, offset };
}

test('runtime/redis-session-store: get and CAS use the same atomic index-validation command; zero is invalid', async t => {
  // Transport contract only: the opt-in integration suite exercises real Lua semantics.
  const sockets = new Set(); const commands = [];
  const server = createTcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]); let frame;
      while ((frame = consumeResp(buffer))) {
        buffer = buffer.subarray(frame.offset);
        const command = frame.args[0].toUpperCase();
        commands.push(frame.args);
        socket.write(command === 'EVAL' ? ':0\r\n' : '+OK\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let store;
  t.after(async () => {
    await store?.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  store = await createRedisSessionStore(`redis://127.0.0.1:${server.address().port}`, 'test-consistency', true);
  const hash = 'a'.repeat(64); const replacement = 'b'.repeat(64); const csrf = 'c'.repeat(43);
  assert.equal(await store.get(hash), undefined);
  assert.equal(await store.rotate(hash, csrf, replacement, { csrf, authenticated: true, expires: Date.now() + 3600000 }), false);
  assert.equal(await store.revoke(hash, csrf), false);
  assert.equal(commands.some(args => args[0].toUpperCase() === 'GET'), false);
  const evaluations = commands.filter(args => args[0].toUpperCase() === 'EVAL');
  assert.equal(evaluations.length, 3);
  const prefix = 'fastagent:{test-consistency}:sessions:';
  assert.deepEqual(evaluations[0].slice(2), ['3', prefix + 'authenticated', prefix + 'anonymous', prefix + hash, 'get']);
  for (const args of evaluations.slice(1)) {
    assert.equal(args[1], evaluations[0][1], 'CAS independently executes the same validator');
    assert.deepEqual(args.slice(2, 6), ['4', prefix + 'authenticated', prefix + 'anonymous', prefix + hash]);
  }
  assert.equal(evaluations[1][6], prefix + replacement);
  assert.equal(evaluations[1][7], 'rotate');
  assert.equal(evaluations[2][7], 'revoke');
});

test('runtime/redis-session-store: native outage recovery resumes requests; shutdown stops pending reconnect', async t => {
  const sockets = new Set(); let outage = false; let connections = 0;
  const session = { csrf: 'a'.repeat(43), authenticated: true, expires: Date.now() + 3600000 };
  const value = JSON.stringify(session);
  const server = createTcpServer(socket => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (outage) { socket.destroy(); return; }
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]); let frame;
      while ((frame = consumeResp(buffer))) {
        buffer = buffer.subarray(frame.offset);
        const command = frame.args[0].toUpperCase();
        // EVAL's result is stubbed only for transport recovery; no Lua is evaluated here.
        socket.write(command === 'PING' ? '+PONG\r\n' : command === 'EVAL'
          ? `$${Buffer.byteLength(value)}\r\n${value}\r\n` : '+OK\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let store;
  t.after(async () => {
    await store?.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  store = await createRedisSessionStore(`redis://127.0.0.1:${server.address().port}`, 'test-recovery', true);
  await store.check(); assert.deepEqual(await store.get('a'.repeat(64)), session);
  outage = true; for (const socket of sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(store.check(), { message: 'Session service unavailable. Please try again.' });
  await assert.rejects(store.get('a'.repeat(64)), { message: 'Session service unavailable. Please try again.' });
  outage = false;
  const deadline = Date.now() + 3000; let recovered = false;
  while (Date.now() < deadline) {
    try { await store.check(); recovered = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(recovered, true); assert.ok(connections >= 2);
  assert.deepEqual(await store.get('a'.repeat(64)), session);
  outage = true; for (const socket of sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 150)); // Leave the native retry loop pending.
  await store.close(); const closedConnections = connections;
  outage = false;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(connections, closedConnections);
  await assert.rejects(store.check(), { message: 'Session service unavailable. Please try again.' });
});
