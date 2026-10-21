import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DeploymentStore, createDeploymentRecord } from '../dist/deployment/state.js';
import { createConfig, serializeConfig } from '../dist/config/config.js';
import { createDeploymentHttp } from '../dist/deployment/http.js';
import { checkHealth, executeCheck, localSnapshot, recordAction, recordRow, selectCheckRecord } from '../dist/checks/service.js';
import { runDashboard } from '../dist/dashboard/dashboard.js';
import { openDeploymentUrl } from '../dist/dashboard/open.js';
import { temporaryDirectory } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const synthetic = (projectPath = root, provider = 'railway', target = 'agent') => ({
  ...createDeploymentRecord({ projectPath, provider, target }), selectors: { project: provider === 'railway' ? 'workspace-one' : 'cloud-project', ...(provider === 'cloudrun' ? { region: 'us-central1' } : {}) },
  status: 'failed', phase: 'resources-created', url: 'https://chat.example.invalid',
});
async function fixture(t) {
  const directory = await temporaryDirectory(t), projectPath = join(directory, 'project');
  await mkdir(projectPath); await writeFile(join(projectPath, 'fastagent.yaml'), serializeConfig(createConfig('agent')));
  const store = new DeploymentStore(join(directory, 'records'));
  const lock = await store.acquire({ projectPath, provider: 'railway', target: 'agent' });
  const record = await lock.write(synthetic(projectPath)); await lock.release();
  return { directory, projectPath, record, store };
}
function terminal() {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  const raw = []; input.setRawMode = value => { raw.push(value); input.isRaw = value; return input; };
  let screen = '';
  const output = new Writable({ write(chunk, _encoding, cb) { screen += chunk.toString(); cb(); } });
  output.isTTY = true; output.columns = 200; output.rows = 30;
  const signals = new EventEmitter();
  return { input, output, signals, raw, get screen() { return screen; }, key: name => input.emit('keypress', '', { name }) };
}
function clock() {
  const timers = new Map(); let next = 0;
  return { setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimer(id) { timers.delete(id); },
    fire(ms) { const entry = [...timers].find(([, value]) => value.ms === ms); assert.ok(entry, `timer ${ms} exists`); timers.delete(entry[0]); entry[1].fn(); }, timers };
}
const snapshotOf = records => async () => ({ records, rows: records.map(recordRow), diagnostics: [] });
const healthy = async () => ({ health: 'healthy', lastChecked: '2026-01-01T00:00:00.000Z', detail: 'health only' });

test('checks/state: read-only private verified enumeration skips unsafe records with sanitized diagnostics and no locks', async t => {
  const { directory, store, record } = await fixture(t);
  const held = await store.acquire(record); // Listing must not acquire or wait on this lock.
  assert.deepEqual(await store.read(record), record);
  const corrupt = `${'a'.repeat(64)}.json`;
  await writeFile(join(store.directory, corrupt), 'synthetic-secret-that-must-not-appear', { mode: 0o600 });
  await writeFile(join(store.directory, 'secret\x1b[31m.json'), '{}', { mode: 0o600 });
  const unsafe = synthetic(record.projectPath, 'cloudrun');
  await writeFile(join(store.directory, `${unsafe.key}.json`), JSON.stringify(unsafe), { mode: 0o644 });
  await symlink(join(store.directory, `${record.key}.json`), join(store.directory, `${'b'.repeat(64)}.json`));
  await writeFile(join(store.directory, `${'c'.repeat(64)}.json`), JSON.stringify({ ...record, resources: [{ kind: 'service', id: '../escape', ownership: 'owned' }] }), { mode: 0o600 });
  const snapshot = await store.list();
  assert.deepEqual(snapshot.records, [record]); assert.match(snapshot.diagnostics.join(' '), /Skipped 5/);
  assert.ok(!JSON.stringify(snapshot).includes('synthetic-secret')); assert.ok(!snapshot.diagnostics.join('').includes('\x1b'));
  assert.equal((await readdir(store.directory)).filter(name => name.endsWith('.lock')).length, 1);
  const missing = new DeploymentStore(join(directory, 'missing'));
  assert.deepEqual(await missing.list(), { records: [], diagnostics: [] });
  assert.equal((await readdir(directory)).includes('missing'), false);
  await held.release();
});

test('checks/state: rejects unsafe directory permissions, symlink ancestors, bad key and extra schema fields', async t => {
  const { directory, store, record } = await fixture(t);
  await chmod(store.directory, 0o755); await assert.rejects(store.list(), { code: 'DEPLOYMENT_STATE_INVALID' });
  await chmod(store.directory, 0o700);
  await symlink(store.directory, join(directory, 'alias'));
  await assert.rejects(new DeploymentStore(join(directory, 'alias')).list(), { code: 'DEPLOYMENT_STATE_INVALID' });
  await writeFile(join(store.directory, `${record.key}.json`), JSON.stringify({ ...record, token: 'not-allowed' }), { mode: 0o600 });
  assert.equal((await store.list()).records.length, 0);
  await assert.rejects(store.read(record), { code: 'DEPLOYMENT_STATE_INVALID' });
  await writeFile(join(store.directory, `${record.key}.json`), JSON.stringify({ ...record, key: 'e'.repeat(64) }), { mode: 0o600 });
  assert.equal((await store.list()).records.length, 0);
});

test('checks/state: special files cannot block read-only enumeration', { skip: process.platform === 'win32' }, async t => {
  const { store } = await fixture(t);
  const fifo = join(store.directory, `${'f'.repeat(64)}.json`);
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 2000 });
  assert.equal(created.status, 0, created.stderr);
  const script = `import { DeploymentStore } from ${JSON.stringify(new URL('../dist/deployment/state.js', import.meta.url).href)}; console.log(JSON.stringify(await new DeploymentStore(process.argv[1]).list()));`;
  const listed = spawnSync(process.execPath, ['--input-type=module', '-e', script, store.directory], { encoding: 'utf8', timeout: 2000 });
  assert.equal(listed.status, 0, listed.stderr); assert.match(JSON.parse(listed.stdout).diagnostics.join(''), /Skipped 1/);
});

test('checks/state: bounded record count is explicit; snapshot stays local/cached with no network', async t => {
  const { store, record } = await fixture(t);
  for (let i = 0; i < 101; i++) {
    const item = synthetic(record.projectPath, 'railway', `app-${i}`);
    await writeFile(join(store.directory, `${item.key}.json`), JSON.stringify(item), { mode: 0o600 });
  }
  const result = await localSnapshot({}, store);
  assert.equal(result.records.length, 100); assert.match(result.diagnostics.join(''), /limit \(100\)/);
  assert.ok(result.rows.every(row => row.statusSource === 'cached' && row.health === 'unchecked' && row.lastChecked === null));
  assert.ok(!JSON.stringify(result.rows).includes('ownershipMarker'));
  assert.equal((await selectCheckRecord({ cwd: record.projectPath }, store)).key, record.key); // Exact target reads are not truncated by list bounds.
  assert.equal((await selectCheckRecord({ cwd: record.projectPath, target: 'app-100' }, store)).target, 'app-100');
  const entries = new DeploymentStore(join(store.directory, 'entries')); await mkdir(entries.directory, { mode: 0o700 });
  for (let i = 0; i < 1001; i++) await writeFile(join(entries.directory, `ignore-${i}.tmp`), '');
  assert.match((await entries.list()).diagnostics.join(''), /entry limit \(1000\)/);
});

test('checks/health: bounded no-redirect HTTPS GET ok:true, never model calls or inferred provider readiness', async () => {
  const record = synthetic(); const requests = [];
  const http = createDeploymentHttp(async (url, options) => { requests.push({ url: String(url), ...options }); return new Response('{"ok":true}', { status: 200 }); }, 50);
  const result = await checkHealth(record, { http, now: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(result.health, 'healthy'); assert.equal(record.status, 'failed');
  assert.equal(result.lastChecked, '2026-01-01T00:00:00.000Z'); assert.match(result.detail, /chat was not tested/);
  assert.deepEqual(requests.map(request => [request.url, request.method, request.redirect, request.headers]), [['https://chat.example.invalid/healthz', 'GET', 'error', {}]]);
  assert.equal(requests[0].body, undefined);
});

test('checks/health: Cloud Run public health avoids reserved paths and tells legacy apps to add /health', async () => {
  const record = synthetic(root, 'cloudrun');
  const paths = [];
  const result = await checkHealth(record, { http: createDeploymentHttp(async url => {
    paths.push(new URL(url).pathname);
    return new Response('{"ok":true}');
  }) });
  assert.equal(result.health, 'healthy'); assert.deepEqual(paths, ['/health']);
  const legacy = await checkHealth(record, { http: createDeploymentHttp(async () => new Response('<html>404</html>', { status: 404 })) });
  assert.equal(legacy.health, 'unhealthy'); assert.match(legacy.detail, /add it to older apps and redeploy/);
});

test('checks/health: per-row invalid JSON, status, redirects, oversize, protocol and thrown errors are sanitized', async () => {
  const record = synthetic();
  for (const response of [new Response('not JSON'), new Response('{"ok":false}'), new Response('[]'), new Response('{"ok":true}', { status: 503 }), new Response('', { status: 302 }), new Response('x'.repeat(4097))]) {
    const result = await checkHealth(record, { http: createDeploymentHttp(async () => response, 50) });
    assert.equal(result.health, 'unhealthy');
  }
  let calls = 0;
  const bad = await checkHealth({ ...record, url: 'https://user:synthetic-password@chat.example.invalid' }, { http: async () => { calls++; throw new Error('synthetic-secret'); } });
  assert.equal(calls, 0); assert.equal(bad.health, 'unhealthy'); assert.ok(!JSON.stringify(bad).includes('synthetic-password'));
  const failed = await checkHealth(record, { http: async () => { throw new Error('synthetic-secret'); } });
  assert.ok(!JSON.stringify(failed).includes('synthetic-secret'));
  const { url, ...withoutUrl } = record;
  assert.equal((await checkHealth(withoutUrl)).health, 'unavailable');
  assert.equal((await checkHealth(record, { http: createDeploymentHttp(async () => new Response('{"ok":true}'), 50) })).health, 'healthy');
});

test('checks/health: timeout and cancellation abort fetch/body and clear timer (fake clock)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const fetcher = async (_url, options) => { signal = options.signal; return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('synthetic-private-error')), { once: true })); };
  const pending = checkHealth(synthetic(), { http: createDeploymentHttp(fetcher, 50) });
  t.mock.timers.tick(50);
  assert.equal((await pending).health, 'unhealthy'); assert.equal(signal.aborted, true);
  const controller = new AbortController();
  const cancel = checkHealth(synthetic(), { http: createDeploymentHttp(fetcher, 50), signal: controller.signal });
  controller.abort(); assert.equal((await cancel).health, 'unhealthy');
  // Real fetch streams reject reads on abort; simulate that contract explicitly.
  const streamFetch = async (_url, options) => new Response(new ReadableStream({ start(stream) { options.signal.addEventListener('abort', () => stream.error(new Error('aborted')), { once: true }); } }));
  const bodyPending = checkHealth(synthetic(), { http: createDeploymentHttp(streamFetch, 50) });
  await Promise.resolve(); t.mock.timers.tick(50); assert.equal((await bodyPending).health, 'unhealthy');
  let cancelled = false;
  const oversize = new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } }));
  assert.equal((await checkHealth(synthetic(), { http: createDeploymentHttp(async () => oversize, 50) })).health, 'unhealthy');
  assert.equal(cancelled, true);
});

test('checks/service: default saved target, explicit provider ambiguity and no cloud/model operations', async t => {
  const { projectPath, store, record } = await fixture(t);
  assert.equal((await selectCheckRecord({ cwd: projectPath }, store)).key, record.key);
  const result = await executeCheck({ cwd: projectPath }, { store, http: async () => ({ status: 200, body: { ok: true } }) });
  assert.equal(result.health, 'healthy'); assert.equal(result.deploymentStatus, 'failed'); assert.equal(result.statusSource, 'cached'); assert.equal(result.chatTested, false);
  const lock = await store.acquire({ projectPath, provider: 'cloudrun', target: 'agent' });
  await lock.write(synthetic(projectPath, 'cloudrun')); await lock.release();
  await assert.rejects(selectCheckRecord({ cwd: projectPath }, store), { code: 'DEPLOYMENT_AMBIGUOUS' });
  assert.equal((await selectCheckRecord({ cwd: projectPath, provider: 'railway' }, store)).key, record.key);
  await assert.rejects(selectCheckRecord({ cwd: projectPath, target: 'missing' }, store), { code: 'DEPLOYMENT_NOT_FOUND' });
  await assert.rejects(selectCheckRecord({ cwd: projectPath, provider: 'other' }, store), { code: 'INVALID_ARGUMENTS' });
});

test('checks/recordAction: status/logs reuse service and enforce credentials + exact record selectors', async () => {
  const record = synthetic(); let calls = [];
  const execute = async options => { calls.push(options); return { status: 'ready' }; };
  await assert.rejects(recordAction(record, 'logs', {}, execute), { code: 'PROVIDER_CONTEXT_REQUIRED' });
  const options = { provider: 'railway', workspace: 'workspace-one', authFile: '/synthetic/.env.railway' };
  await assert.rejects(recordAction(record, 'status', { ...options, workspace: 'other' }, execute), { code: 'DEPLOYMENT_TARGET_MISMATCH' });
  await assert.rejects(recordAction(record, 'status', { ...options, target: 'other' }, execute), { code: 'DEPLOYMENT_TARGET_MISMATCH' });
  assert.equal(calls.length, 0);
  await recordAction(record, 'status', options, execute); await recordAction(record, 'logs', options, execute);
  assert.deepEqual(calls.map(call => [call.command, call.cwd, call.target]), [['status', record.projectPath, record.target], ['logs', record.projectPath, record.target]]);
  const cloud = synthetic(root, 'cloudrun');
  const cloudOptions = { provider: 'cloudrun', project: 'cloud-project', region: 'us-central1', runtimeAccount: 'runtime@example.invalid', buildAccount: 'build@example.invalid' };
  await recordAction(cloud, 'logs', cloudOptions, execute);
  await assert.rejects(recordAction(cloud, 'logs', { ...cloudOptions, region: 'other' }, execute), { code: 'DEPLOYMENT_TARGET_MISMATCH' });
});

test('dashboard/open: only strict HTTPS origins, platform argument arrays and bounded user-action subprocesses', async () => {
  const calls = []; const runner = async options => { calls.push(options); return { stdout: '', stderr: '', exitCode: 0 }; };
  for (const platform of ['darwin', 'linux', 'win32']) await openDeploymentUrl('https://chat.example.invalid', { platform, runner });
  assert.deepEqual(calls.map(call => [call.executable, call.args]), [['open', ['https://chat.example.invalid']], ['xdg-open', ['https://chat.example.invalid']], ['rundll32.exe', ['url.dll,FileProtocolHandler', 'https://chat.example.invalid']]]);
  assert.ok(calls.every(call => call.intent === 'read' && call.timeoutMs === 5000 && !('secretEnv' in call)));
  for (const url of ['http://chat.example.invalid', 'https://chat.example.invalid/?secret=bad', 'https://user:pass@chat.example.invalid', 'https://chat.example.invalid/;echo']) await assert.rejects(openDeploymentUrl(url, { runner }), { code: 'DEPLOYMENT_ORIGIN_INVALID' });
  assert.equal(calls.length, 3);
});

test('dashboard/TTY: actionable non-TTY rejection performs no snapshot or network', async () => {
  let calls = 0; const tty = terminal(); tty.input.isTTY = false;
  await assert.rejects(runDashboard({}, { ...tty, snapshot: async () => { calls++; } }), error => error.code === 'TTY_REQUIRED' && error.message.includes('--json'));
  assert.equal(calls, 0); assert.deepEqual(tty.raw, []);
});

test('dashboard/TTY: native arrows/Enter/Q, cached status versus health, local snapshots and timer cleanup', async () => {
  const tty = terminal(), timers = clock(); const records = [synthetic(root, 'railway', 'one'), synthetic(root, 'cloudrun', 'two')];
  const opened = []; let actions = 0, healthCalls = 0;
  const pending = runDashboard({}, { ...tty, ...timers, snapshot: snapshotOf(records), health: async (...args) => { healthCalls++; return healthy(...args); }, action: async () => { actions++; }, open: async url => { opened.push(url); } });
  await tick();
  assert.match(tty.screen, /Status\(cached\)/); assert.match(tty.screen, /failed/); assert.match(tty.screen, /healthy/);
  assert.ok(tty.screen.includes('\x1b[?1049h')); assert.deepEqual(tty.raw, [true]);
  tty.input.write('\x1b[B'); await tick(); // actual readline key parsing
  tty.key('return'); await tick(); assert.deepEqual(opened, [records[1].url]);
  tty.key('l'); await tick(); assert.match(tty.screen, /Status\/logs require matching provider selectors/);
  timers.fire(15_000); await tick(); assert.equal(healthCalls, 4); assert.equal(actions, 0);
  tty.key('q'); assert.equal(await pending, 0);
  assert.deepEqual(tty.raw, [true, false]); assert.ok(tty.screen.endsWith('\x1b[?25h\x1b[?1049l'));
  assert.equal(timers.timers.size, 0); assert.equal(tty.signals.listenerCount('SIGINT'), 0); assert.equal(tty.input.listenerCount('keypress'), 0);
});

test('dashboard/TTY: explicit R status and L logs use shared authenticated actions; polling never does', async () => {
  const tty = terminal(), timers = clock(), record = synthetic(); const actions = [];
  const options = { provider: 'railway', workspace: 'workspace-one', authFile: '/synthetic/.env.railway' };
  const pending = runDashboard(options, { ...tty, ...timers, snapshot: snapshotOf([record]), health: healthy,
    action: async (...args) => { actions.push(args); return args[1] === 'status' ? { status: 'deploying' } : { logs: 'safe log one\nsafe log two\n\x1b[31mnot an escape' }; } });
  await tick(); assert.equal(actions.length, 0);
  tty.key('r'); await tick(); assert.equal(actions[0][1], 'status'); assert.match(tty.screen, /Explicit provider status/);
  tty.key('l'); await tick(); assert.equal(actions[1][1], 'logs'); assert.match(tty.screen, /safe log two/); assert.ok(!tty.screen.includes('\x1b[31m'));
  timers.fire(15_000); await tick(); assert.equal(actions.length, 2);
  tty.key('q'); await pending;
});

test('dashboard/TTY: locked-target remote failures never present cached status as provider-verified', async () => {
  const tty = terminal(), timers = clock(), record = synthetic();
  const options = { provider: 'railway', workspace: 'workspace-one', authFile: '/synthetic/.env.railway' };
  const pending = runDashboard(options, { ...tty, ...timers, snapshot: snapshotOf([record]), health: healthy,
    action: async () => ({ status: 'ready', remoteStatusVerified: false, statusSource: 'cached' }) });
  await tick(); tty.key('r'); await tick();
  assert.match(tty.screen, /Provider status could not be verified/);
  assert.ok(!tty.screen.includes('Explicit provider status for railway/agent: ready'));
  tty.key('q'); await pending;
});

test('dashboard/TTY: no overlapping refresh, bounded four-way health, per-row failures, budget and signal abort/cleanup', async () => {
  const tty = terminal(), timers = clock(); const records = Array.from({ length: 8 }, (_, index) => synthetic(root, 'railway', `app-${index}`));
  let calls = 0, active = 0, maxActive = 0, aborts = 0;
  const checked = [];
  const health = async (record, { signal }) => {
    checked.push(record.target); calls++; maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => signal.addEventListener('abort', () => { active--; aborts++; resolve(); }, { once: true }));
    return { health: 'unhealthy', lastChecked: new Date().toISOString(), detail: 'safe failure' };
  };
  const pending = runDashboard({}, { ...tty, ...timers, snapshot: snapshotOf(records), health });
  await tick(); tty.key('r'); tty.key('r'); await tick(); assert.equal(calls, 4); assert.equal(maxActive, 4);
  timers.fire(30_000); await tick(); assert.equal(aborts, 4); assert.match(tty.screen, /Refresh budget reached/); assert.match(tty.screen, /unhealthy/);
  timers.fire(15_000); await tick(); assert.equal(calls, 8);
  assert.deepEqual(checked, records.map(record => record.target)); // A bounded poll does not starve later rows.
  tty.signals.emit('SIGTERM'); assert.equal(await pending, 143); assert.equal(aborts, 8);
  assert.equal(timers.timers.size, 0); assert.deepEqual(tty.raw, [true, false]); assert.equal(tty.signals.listenerCount('SIGTERM'), 0);
});

test('dashboard/TTY: SIGINT, stream error and synchronous render failure restore alternate screen and raw mode', async () => {
  for (const reason of ['SIGINT', 'SIGHUP', 'SIGQUIT', 'exit', 'input-error', 'output-error', 'write-error']) {
    const tty = terminal(), timers = clock();
    const pending = runDashboard({}, { ...tty, ...timers, snapshot: snapshotOf([synthetic()]), health: healthy });
    await tick();
    if (['SIGINT', 'SIGHUP', 'SIGQUIT', 'exit'].includes(reason)) tty.signals.emit(reason);
    else if (reason === 'input-error') tty.input.emit('error', new Error('synthetic-private-error'));
    else if (reason === 'output-error') tty.output.emit('error', new Error('synthetic-private-error'));
    else {
      const original = tty.output.write.bind(tty.output); let first = true;
      tty.output.write = (...args) => { if (first) { first = false; throw new Error('synthetic-private-error'); } return original(...args); };
      tty.key('down');
    }
    if (['SIGINT', 'SIGHUP', 'SIGQUIT', 'exit'].includes(reason)) assert.equal(await pending, { SIGINT: 130, SIGHUP: 129, SIGQUIT: 131, exit: 0 }[reason]);
    else await assert.rejects(pending, error => error.code === 'DASHBOARD_FAILED' && !error.message.includes('synthetic-private-error'));
    assert.deepEqual(tty.raw, [true, false]); assert.ok(tty.screen.endsWith('\x1b[?25h\x1b[?1049l')); assert.equal(timers.timers.size, 0);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'exit']) assert.equal(tty.signals.listenerCount(signal), 0);
  }
});

test('checks-dashboard/CLI: cached JSON snapshot, non-TTY errors and --chat rejected before record/secret/network reads', async t => {
  const home = await temporaryDirectory(t);
  const cli = args => spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{process.stderr.write("UNEXPECTED_NETWORK");throw new Error("no network allowed")}', join(root, 'dist/cli.js'), ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, OPENAI_API_KEY: 'synthetic-never-inherited' }, encoding: 'utf8', timeout: 5000 });
  const snapshot = cli(['dashboard', '--json']); assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout), { ok: true, command: 'dashboard', localOnly: true, rows: [], diagnostics: [] });
  const ttyError = cli(['dashboard']); assert.equal(ttyError.status, 2); assert.match(ttyError.stderr, /TTY_REQUIRED/); assert.match(ttyError.stderr, /--json/);
  const missing = cli(['check', '--json']); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).ok, false);
  for (const args of [['check', '--chat', '--json'], ['check', '--chat', '--auth-file', '/does-not-exist', '--json']]) {
    const result = cli(args); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error.code, 'CHAT_CHECK_UNSUPPORTED'); assert.ok(!result.stdout.includes('synthetic-never-inherited'));
  }
  const text = cli(['check', '--chat']); assert.equal(text.status, 2); assert.match(text.stderr, /CHAT_CHECK_UNSUPPORTED/);
  assert.deepEqual(await readdir(home), []); // No state or secret access required for rejection.
  for (const args of [['check', '--workspace', 'wrong', '--json'], ['dashboard', '--json', '--auth-file', 'wrong'], ['dashboard', '--provider', 'other', '--json'], ['check', '--password-file', '/never-read', '--json']]) assert.equal(cli(args).status, 2);
  await writeFile(join(home, 'fastagent.yaml'), serializeConfig(createConfig('agent')));
  const store = new DeploymentStore(join(home, '.fastagent', 'deployments'));
  const lock = await store.acquire({ projectPath: home, provider: 'railway', target: 'agent' });
  await lock.write(synthetic(home)); await lock.release();
  const successful = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=async()=>new Response(JSON.stringify({ok:true}))', join(root, 'dist/cli.js'), 'check', '--json'], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 5000 });
  assert.equal(successful.status, 0, successful.stderr); const checked = JSON.parse(successful.stdout);
  assert.equal(checked.ok, true); assert.equal(checked.health, 'healthy'); assert.equal(checked.deploymentStatus, 'failed'); assert.equal(checked.chatTested, false);
  const recorded = cli(['dashboard', '--json']); assert.equal(recorded.status, 0); assert.equal(JSON.parse(recorded.stdout).rows.length, 1); assert.equal(JSON.parse(recorded.stdout).rows[0].health, 'unchecked');
  const missingRecord = cli(['check', '--target', 'missing', '--json']); assert.equal(missingRecord.status, 1); assert.equal(JSON.parse(missingRecord.stdout).error.code, 'DEPLOYMENT_NOT_FOUND');
});

test('checks-dashboard/package: packed CLI local JSON snapshot and health-only check smoke (offline mocked fetch)', async t => {
  const home = await temporaryDirectory(t);
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: root, env: { PATH: process.env.PATH, HOME: home, npm_config_cache: join(home, 'cache') }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(pack.status, 0, pack.stderr);
  const unpack = join(home, 'unpack'); await mkdir(unpack);
  const tar = spawnSync('tar', ['-xzf', join(home, JSON.parse(pack.stdout)[0].filename), '-C', unpack], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(tar.status, 0, tar.stderr);
  // Package contents/bin smoke only; reuse installed dependencies without registry access.
  await symlink(join(root, 'node_modules'), join(unpack, 'package', 'node_modules'), 'dir');
  const cli = join(unpack, 'package', 'dist', 'cli.js');
  const mockFetch = `globalThis.fetch=async(url,init)=>{if(String(url)!=='https://chat.example.invalid/healthz'||init.method!=='GET'||init.redirect!=='error')throw new Error('unexpected request');return new Response(JSON.stringify({ok:true}));};`;
  const invoke = (args, cwd) => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`, cli, ...args], { cwd, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 10_000 });
  const initialized = invoke(['init', 'agent', '--json'], home);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).framework, 'openai');
  const projectPath = join(home, 'agent'), store = new DeploymentStore(join(home, '.fastagent', 'deployments'));
  const lock = await store.acquire({ projectPath, provider: 'railway', target: 'agent' });
  await lock.write(synthetic(projectPath)); await lock.release();
  const dashboard = invoke(['dashboard', '--json'], projectPath); assert.equal(dashboard.status, 0, dashboard.stderr);
  const snapshot = JSON.parse(dashboard.stdout); assert.equal(snapshot.localOnly, true); assert.equal(snapshot.rows[0].health, 'unchecked'); assert.equal(snapshot.rows[0].deploymentStatus, 'failed');
  const check = invoke(['check', '--json'], projectPath); assert.equal(check.status, 0, check.stderr);
  const result = JSON.parse(check.stdout); assert.equal(result.health, 'healthy'); assert.equal(result.deploymentStatus, 'failed'); assert.equal(result.chatTested, false);
  const unavailable = invoke(['check', '--target', 'missing', '--json'], projectPath); assert.equal(unavailable.status, 1); assert.equal(JSON.parse(unavailable.stdout).error.code, 'DEPLOYMENT_NOT_FOUND');
});
