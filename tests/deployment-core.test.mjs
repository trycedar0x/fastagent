import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createConfig } from '../dist/config/config.js';
import { renderProject } from '../dist/scaffold/render.js';
import { createProcessRunner, redactProcessOutput } from '../dist/deployment/process.js';
import { DeploymentStore, canonicalDeploymentSelector, createDeploymentRecord, deploymentKey, validateDeploymentRecord } from '../dist/deployment/state.js';
import { stageDeploymentSource } from '../dist/deployment/staging.js';
import { runtimeSecretKeys, validateCloudEnvironment, validatePreflightEnvironment, validateHttpsOrigin } from '../dist/deployment/types.js';
import { temporaryDirectory } from './helpers.mjs';

const code = (expected) => (error) => {
  assert.equal(error.code, expected);
  return true;
};
const cloudEnv = () => ({
  FASTAGENT_PASSWORD_HASH: `scrypt-v1$${'a'.repeat(32)}$${'b'.repeat(128)}`,
  OPENAI_API_KEY: 'synthetic-openai-key',
  REDIS_URL: 'rediss://user:synthetic-redis-password@redis.invalid:6380/0',
  APP_ORIGIN: 'https://chat.example.invalid',
  FASTAGENT_SESSION_NAMESPACE: 'stable-test-app',
});
const nodeRequest = (script, additions = {}) => ({
  executable: process.execPath, args: ['--input-type=module', '-e', script], cwd: process.cwd(),
  env: {}, intent: 'read', timeoutMs: 3000, ...additions,
});
async function stateFixture(t) {
  const root = await temporaryDirectory(t);
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const store = new DeploymentStore(join(root, 'records'));
  return { root, store, selector: { projectPath, provider: 'railway', target: 'production' } };
}
async function sourceFixture(t) {
  const root = await temporaryDirectory(t);
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  for (const file of await renderProject(createConfig('core-test'))) {
    await mkdir(dirname(join(projectPath, file.path)), { recursive: true });
    await writeFile(join(projectPath, file.path), file.content);
  }
  return projectPath;
}

test('deployment process: injected spawn receives argument arrays, no shell, explicit environment only', async () => {
  let captured;
  const runner = createProcessRunner((executable, args, options) => {
    captured = { executable, args, options }; return spawn(executable, args, options);
  });
  const result = await runner(nodeRequest('console.log(JSON.stringify({value:process.env.PUBLIC_VALUE,home:process.env.HOME,argv:process.argv.slice(1)}))', {
    env: { PUBLIC_VALUE: 'test-only' }, args: ['-e', 'console.log(JSON.stringify({value:process.env.PUBLIC_VALUE,home:process.env.HOME,argv:process.argv.slice(1)}))', '--', 'literal;$(not-a-command)'],
  }));
  assert.deepEqual(JSON.parse(result.stdout), { value: 'test-only', argv: ['literal;$(not-a-command)'] });
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.options.env, { PUBLIC_VALUE: 'test-only' });
  assert.equal(captured.options.stdio, 'pipe');
});

test('deployment process: stdin/secret environment redacted across chunks, JSON and URL forms', async () => {
  const runner = createProcessRunner();
  const token = 'synthetic-stdin-secret';
  const redis = 'rediss://test:synthetic-password@redis.invalid/0';
  const result = await runner(nodeRequest(`let data=''; for await (const chunk of process.stdin) data+=chunk;
    const token=JSON.parse(data).TOKEN; process.stdout.write(token.slice(0,5));
    await new Promise(r=>setTimeout(r,10)); process.stdout.write(token.slice(5));
    console.error(process.env.REDIS_URL); console.error('synthetic-'+'password');`, {
    stdin: JSON.stringify({ TOKEN: token }), secretEnv: { REDIS_URL: redis }, intent: 'mutate', authorization: 'mutation',
  }));
  assert.equal(result.stdout, '[REDACTED]');
  assert.ok(!result.stderr.includes(redis)); assert.ok(!result.stderr.includes('synthetic-password'));
  assert.equal(redactProcessOutput('a%20b a b https://user:pass@site.invalid/x', ['a b']), '[REDACTED] [REDACTED] [REDACTED_URL]');
});

test('deployment process: refuses argv secrets and unauthorized mutation/destruction before spawning', async () => {
  let calls = 0;
  const runner = createProcessRunner(() => { calls++; throw new Error('should not spawn'); });
  for (const extra of [
    { intent: 'mutate' }, { intent: 'destroy', authorization: 'mutation' },
    { env: { OPENAI_API_KEY: 'synthetic-credential' } },
    { args: ['--token=synthetic-credential'], secretEnv: { TOKEN: 'synthetic-credential' } },
    { args: ['--token=synthetic%20credential'], stdin: 'TOKEN=synthetic credential' },
    { args: ['--token=redis-private-password'], secretEnv: { REDIS_URL: 'rediss://user:redis-private-password@redis.invalid/0' } },
    { args: ['rediss://user:password@redis.invalid/0'] },
    { args: ['echo\0bad'] }, { timeoutMs: 0 }, { maxOutputBytes: 99_000_000 },
  ]) await assert.rejects(runner(nodeRequest('', extra)), code('PROCESS_INPUT_INVALID'));
  assert.equal(calls, 0);
});

test('deployment process: failures and launch exceptions never expose commands, output or secrets', async () => {
  const token = 'synthetic-private-value';
  await assert.rejects(createProcessRunner()(nodeRequest(`console.error(process.env.TOKEN);process.exit(19)`, { secretEnv: { TOKEN: token } })), (error) => {
    assert.equal(error.code, 'PROCESS_FAILED'); assert.ok(!String(error).includes(token)); assert.ok(!String(error).includes('console')); return true;
  });
  await assert.rejects(createProcessRunner(() => { throw new Error(token); })(nodeRequest('')), (error) => {
    assert.equal(error.code, 'PROCESS_START_FAILED'); assert.ok(!String(error).includes(token)); return true;
  });
  await assert.rejects(createProcessRunner()(nodeRequest('', { executable: '/nonexistent/synthetic-cli' })), code('PROCESS_START_FAILED'));
});

test('deployment process: timeout, cancellation and combined output bounds terminate children', async () => {
  const runner = createProcessRunner();
  await assert.rejects(runner(nodeRequest('setInterval(()=>{},1000)', { timeoutMs: 30 })), code('PROCESS_TIMEOUT'));
  await assert.rejects(runner(nodeRequest("process.stdout.write('a'.repeat(10000));process.stderr.write('b'.repeat(10000))", { maxOutputBytes: 1024 })), code('PROCESS_OUTPUT_LIMIT'));
  const controller = new AbortController();
  const pending = runner(nodeRequest('setInterval(()=>{},1000)', { signal: controller.signal }));
  controller.abort(); await assert.rejects(pending, code('PROCESS_ABORTED'));
  await assert.rejects(runner(nodeRequest('', { signal: controller.signal })), code('PROCESS_ABORTED'));
});

test('deployment environment: shared TLS Redis, hash/key, exact HTTPS origin and stable namespace', () => {
  const env = cloudEnv();
  assert.deepEqual(validateCloudEnvironment(env), env);
  const { APP_ORIGIN, ...withoutOrigin } = env;
  assert.deepEqual(validatePreflightEnvironment(withoutOrigin), withoutOrigin);
  assert.throws(() => validateCloudEnvironment(withoutOrigin), code('DEPLOYMENT_ENV_INVALID'));
  assert.throws(() => validatePreflightEnvironment({ ...withoutOrigin, APP_ORIGIN: 'https://example.invalid/' }), code('DEPLOYMENT_ORIGIN_INVALID'));
  for (const mutation of [
    { FASTAGENT_LOCAL_DEV: '1' }, { FASTAGENT_LOCAL_DEV: '' }, { OPENAI_API_KEY: '' },
    { FASTAGENT_PASSWORD_HASH: 'plaintext' }, { REDIS_URL: 'redis://redis.invalid' },
    { REDIS_URL: 'rediss://redis.invalid/0?secret=value' }, { REDIS_URL: 'rediss://%zz:pass@redis.invalid' },
    { FASTAGENT_SESSION_NAMESPACE: '../other-app' }, { OTHER_SECRET: 'not-allowed' },
  ]) assert.throws(() => validateCloudEnvironment({ ...env, ...mutation }), code('DEPLOYMENT_ENV_INVALID'));
  for (const origin of ['http://localhost:3000', 'https://chat.example.invalid/', 'https://user:pass@example.invalid', 'https://example.invalid/?token=synthetic']) {
    assert.throws(() => validateHttpsOrigin(origin), code('DEPLOYMENT_ORIGIN_INVALID'));
  }
});

test('deployment environment: token history backend is exactly one of TLS Redis or the ephemeral opt-in', () => {
  const tokenEnv = () => ({ FASTAGENT_API_TOKEN: 'a'.repeat(43), OPENROUTER_API_KEY: 'synthetic-openrouter-key',
    APP_ORIGIN: 'https://chat.example.invalid', FASTAGENT_HISTORY_NAMESPACE: 'stable-token-app' });
  const redis = { ...tokenEnv(), REDIS_URL: 'rediss://user:synthetic-redis@redis.invalid:6380/0' };
  const ephemeral = { ...tokenEnv(), FASTAGENT_EPHEMERAL_HISTORY: '1' };
  assert.deepEqual(validateCloudEnvironment(redis), redis);
  assert.deepEqual(validateCloudEnvironment(ephemeral), ephemeral);
  // Exactly one backend: both and neither both fail closed with distinct codes.
  assert.throws(() => validateCloudEnvironment({ ...ephemeral, REDIS_URL: redis.REDIS_URL }), code('DEPLOYMENT_HISTORY_BACKEND_CONFLICT'));
  assert.throws(() => validateCloudEnvironment(tokenEnv()), code('DEPLOYMENT_HISTORY_BACKEND_MISSING'));
  // The opt-in is the literal 1, and Redis still has to be TLS.
  assert.throws(() => validateCloudEnvironment({ ...tokenEnv(), FASTAGENT_EPHEMERAL_HISTORY: 'true' }), code('DEPLOYMENT_ENV_INVALID'));
  assert.throws(() => validateCloudEnvironment({ ...tokenEnv(), REDIS_URL: 'redis://redis.invalid' }), code('DEPLOYMENT_ENV_INVALID'));
  // Preflight (no origin yet) keeps the same history rule and omits the Redis secret in ephemeral mode.
  const { APP_ORIGIN: _o, ...ephemeralPreflight } = ephemeral;
  assert.deepEqual(validatePreflightEnvironment(ephemeralPreflight), ephemeralPreflight);
  assert.deepEqual(runtimeSecretKeys(redis), ['FASTAGENT_API_TOKEN', 'OPENROUTER_API_KEY', 'REDIS_URL']);
  assert.deepEqual(runtimeSecretKeys(ephemeral), ['FASTAGENT_API_TOKEN', 'OPENROUTER_API_KEY']);
  // The legacy protected variant is unchanged: it still rejects ephemeral and still requires Redis.
  const protectedEnv = cloudEnv();
  assert.deepEqual(runtimeSecretKeys(protectedEnv), ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL']);
  const { REDIS_URL: _r, ...withoutRedis } = protectedEnv;
  assert.throws(() => validateCloudEnvironment(withoutRedis), code('DEPLOYMENT_ENV_INVALID'));
  assert.throws(() => validateCloudEnvironment({ ...protectedEnv, FASTAGENT_EPHEMERAL_HISTORY: '1' }), code('DEPLOYMENT_ENV_INVALID'));
});

test('deployment state: canonical project/provider/target keys and random stable ownership/namespace', async (t) => {
  const { selector } = await stateFixture(t);
  const canonical = await canonicalDeploymentSelector({ ...selector, projectPath: join(selector.projectPath, '..', 'project') });
  assert.equal(canonical.projectPath, selector.projectPath);
  const first = createDeploymentRecord(canonical), second = createDeploymentRecord(canonical);
  assert.equal(first.key, second.key); assert.notEqual(first.ownershipMarker, second.ownershipMarker);
  assert.notEqual(first.sessionNamespace, second.sessionNamespace);
  assert.notEqual(first.key, deploymentKey({ ...canonical, target: 'preview' }));
  assert.notEqual(first.key, deploymentKey({ ...canonical, provider: 'cloudrun' }));
  const cloudSelector = { ...canonical, provider: 'cloudrun' };
  assert.throws(() => validateDeploymentRecord({ ...createDeploymentRecord(cloudSelector), resources: [{ kind: 'project', id: 'gcp-project', ownership: 'owned' }] }), code('DEPLOYMENT_STATE_INVALID'));
  for (const target of ['../production', 'a/b', '--help']) await assert.rejects(canonicalDeploymentSelector({ ...selector, target }), code('DEPLOYMENT_STATE_INVALID'));
});

test('deployment state: private atomic checkpoints resume partial failure without losing confirmed resources', async (t) => {
  const { selector, store } = await stateFixture(t);
  const lock = await store.acquire(selector);
  let record = createDeploymentRecord(lock.selector);
  record.selectors = { project: 'test-project' };
  record = await lock.write(record);
  record = await lock.write({ ...record, resources: [{ kind: 'service', id: 'service-123', ownership: 'owned' }], status: 'deploying', phase: 'resources-created' });
  record = await lock.write({ ...record, status: 'failed' });
  await lock.release();
  const resumed = await store.acquire(selector);
  const recovered = await resumed.read();
  assert.equal(recovered.phase, 'resources-created'); assert.equal(recovered.status, 'failed'); assert.equal(recovered.revision, 3);
  assert.deepEqual(recovered.resources, record.resources);
  assert.equal(recovered.ownershipMarker, record.ownershipMarker); assert.equal(recovered.sessionNamespace, record.sessionNamespace);
  const ready = await resumed.write({ ...recovered, phase: 'healthy', status: 'ready', url: 'https://app.example.invalid' });
  assert.equal(ready.revision, 4);
  await resumed.release();
  assert.equal((await lstat(store.directory)).mode & 0o077, 0);
  assert.equal((await lstat(join(store.directory, `${record.key}.json`))).mode & 0o077, 0);
  assert.deepEqual(await readdir(store.directory), [`${record.key}.json`]);
});

test('deployment state: fail-fast concurrent locks, stale revisions and immutable selectors/markers', async (t) => {
  const { selector, store } = await stateFixture(t);
  const lock = await store.acquire(selector);
  await assert.rejects(new DeploymentStore(store.directory).acquire(selector), code('DEPLOYMENT_LOCKED'));
  let record = await lock.write(createDeploymentRecord(lock.selector));
  await assert.rejects(lock.write({ ...record, revision: 0 }), code('DEPLOYMENT_STATE_INVALID'));
  await assert.rejects(lock.write({ ...record, ownershipMarker: 'f'.repeat(32) }), code('DEPLOYMENT_STATE_INVALID'));
  await assert.rejects(lock.write({ ...record, selectors: { project: 'other-project' } }), code('DEPLOYMENT_STATE_INVALID'));
  await assert.rejects(lock.write({ ...record, sessionNamespace: 'other-app' }), code('DEPLOYMENT_STATE_INVALID'));
  await lock.release();
  await assert.rejects(lock.read(), code('DEPLOYMENT_STATE_INVALID'));
  const next = await store.acquire(selector); assert.equal((await next.read()).revision, 1); await next.release();
});

test('deployment state: strict schema rejects secrets, malicious selectors/URLs/IDs and inconsistent identities', async (t) => {
  const { selector } = await stateFixture(t);
  const record = createDeploymentRecord(await canonicalDeploymentSelector(selector));
  for (const extra of [
    { OPENAI_API_KEY: 'synthetic-secret' }, { secrets: { token: 'synthetic-secret' } },
    { schemaVersion: 2 }, { key: '0'.repeat(64) }, { target: '../other' },
    { selectors: { project: '--help' } }, { selectors: { region: '../region' } },
    { url: 'https://user:synthetic-secret@example.invalid' }, { url: 'https://example.invalid?token=synthetic-secret' },
    { resources: [{ kind: 'service', id: '../victim', ownership: 'owned' }] },
    { resources: [{ kind: 'service', id: 'https://user:pass@victim', ownership: 'owned' }] },
    { status: 'ready', phase: 'prepared' }, { status: 'destroying' },
  ]) assert.throws(() => validateDeploymentRecord({ ...record, ...extra }), code('DEPLOYMENT_STATE_INVALID'));
});

test('deployment state: tampered records/lock tokens and symlink or broad-permission storage fail closed', async (t) => {
  const { root, selector, store } = await stateFixture(t);
  const lock = await store.acquire(selector);
  const record = await lock.write(createDeploymentRecord(lock.selector));
  const file = join(store.directory, `${record.key}.json`);
  await writeFile(file, JSON.stringify({ ...record, target: 'other-target' }));
  await assert.rejects(lock.read(), code('DEPLOYMENT_STATE_INVALID'));
  await writeFile(file, JSON.stringify(record)); await chmod(file, 0o644);
  await assert.rejects(lock.read(), code('DEPLOYMENT_STATE_INVALID'));
  await chmod(file, 0o600);
  await writeFile(join(store.directory, `${record.key}.lock`), 'replacement-token');
  await assert.rejects(lock.write(record), code('DEPLOYMENT_STATE_INVALID'));
  await assert.rejects(lock.release(), code('DEPLOYMENT_STATE_INVALID'));
  const real = join(root, 'real-state'); await mkdir(real, { mode: 0o700 });
  const link = join(root, 'link-state'); await symlink(real, link);
  await assert.rejects(new DeploymentStore(link).acquire(selector), code('DEPLOYMENT_STATE_INVALID'));
  const unsafe = join(root, 'unsafe-state'); await mkdir(unsafe, { mode: 0o755 });
  await assert.rejects(new DeploymentStore(unsafe).acquire(selector), code('DEPLOYMENT_STATE_INVALID'));
});

test('deployment state: refuses symlink records instead of reading their synthetic credential targets', async (t) => {
  const { root, selector, store } = await stateFixture(t);
  const lock = await store.acquire(selector);
  const key = deploymentKey(lock.selector);
  const synthetic = join(root, 'synthetic-credentials'); await writeFile(synthetic, 'synthetic-secret', { mode: 0o600 });
  await symlink(synthetic, join(store.directory, `${key}.json`));
  await assert.rejects(lock.read(), code('DEPLOYMENT_STATE_INVALID')); await lock.release();
  assert.equal(await readFile(synthetic, 'utf8'), 'synthetic-secret');
});

test('deployment state: remove requires verified successful complete owned deletion and preserves failures', async (t) => {
  const { selector, store } = await stateFixture(t);
  const lock = await store.acquire(selector);
  let record = createDeploymentRecord(lock.selector);
  record.resources = [{ kind: 'service', id: 'owned-service', ownership: 'owned' }, { kind: 'project', id: 'shared-project', ownership: 'external' }];
  record = await lock.write(record);
  const proof = { verified: true, succeeded: true, ownershipMarker: record.ownershipMarker, resourceIdentities: ['service:owned-service'] };
  await assert.rejects(lock.remove(proof), code('DEPLOYMENT_STATE_INVALID'));
  record = await lock.write({ ...record, status: 'destroying', phase: 'destroy-pending' });
  for (const extra of [{ verified: false }, { succeeded: false }, { ownershipMarker: '0'.repeat(32) }, { resourceIdentities: [] }, { resourceIdentities: ['service:owned-service', 'project:shared-project'] }]) {
    await assert.rejects(lock.remove({ ...proof, ...extra }), code('DEPLOYMENT_STATE_INVALID'));
    assert.equal((await lock.read()).revision, record.revision);
  }
  await lock.remove(proof); assert.equal(await lock.read(), undefined); await lock.release();
});

test('deployment staging: only necessary files, filtered nested credentials/state/dependencies, editable tools retained', async (t) => {
  const projectPath = await sourceFixture(t);
  await writeFile(join(projectPath, 'package-lock.json'), '{"lockfileVersion":3}');
  await mkdir(join(projectPath, 'src/custom'), { recursive: true });
  await writeFile(join(projectPath, 'src/custom/tools.ts'), 'export const customTool = () => 42;');
  for (const path of ['.env', '.env.auth', '.env.production', '.envrc', 'local.env', 'state.json', 'deployment-state.json', 'credentials.json', 'private.pem', 'service-account.json', 'auth.json', 'token.json', '.npmrc']) {
    await writeFile(join(projectPath, 'src/custom', path), 'synthetic-credential-must-not-upload');
  }
  for (const path of ['src/.git', 'src/node_modules', 'src/state', 'public/.fastagent', 'src/.aws', 'src/.config']) {
    await mkdir(join(projectPath, path), { recursive: true }); await writeFile(join(projectPath, path, 'data'), 'synthetic-credential-must-not-upload');
  }
  await writeFile(join(projectPath, '.env'), 'synthetic-root-credential');
  await writeFile(join(projectPath, 'private-unknown-name'), 'not-allowlisted');
  const staged = await stageDeploymentSource({ projectPath }); t.after(() => staged.cleanup());
  assert.notEqual(staged.directory, projectPath); assert.ok(!staged.directory.startsWith(projectPath + '/'));
  assert.ok(staged.files.includes('src/custom/tools.ts')); assert.ok(staged.files.includes('package-lock.json'));
  assert.ok(!staged.files.includes('scripts/hash-password.mjs')); assert.ok(!staged.files.includes('.env.example'));
  for (const path of staged.files) assert.ok(!(await readFile(join(staged.directory, path), 'utf8')).includes('synthetic-credential-must-not-upload'));
  for (const ignore of ['.dockerignore', '.railwayignore', '.gcloudignore']) {
    const source = await readFile(join(staged.directory, ignore), 'utf8');
    assert.ok(source.includes('**/.env.*')); assert.ok(source.includes('**/node_modules/**')); assert.ok(source.includes('!src/**'));
  }
  assert.equal((await lstat(staged.directory)).mode & 0o077, 0);
  assert.equal((await lstat(join(staged.directory, 'src/custom/tools.ts'))).mode & 0o077, 0);
  await staged.cleanup(); await assert.rejects(lstat(staged.directory), (error) => error.code === 'ENOENT');
});

test('deployment staging: supports fresh generated project without lockfile, never stages original ignore files', async (t) => {
  const projectPath = await sourceFixture(t);
  await writeFile(join(projectPath, '.dockerignore'), '!**\n');
  await writeFile(join(projectPath, '.gcloudignore'), '!**\n');
  const staged = await stageDeploymentSource({ projectPath }); t.after(() => staged.cleanup());
  assert.ok(!staged.files.includes('package-lock.json'));
  assert.ok((await readFile(join(staged.directory, '.dockerignore'), 'utf8')).startsWith('# Generated staging allowlist'));
});

test('deployment staging: rejects nested/root symlinks, including secret-named symlinks', async (t) => {
  const projectPath = await sourceFixture(t);
  await symlink(join(projectPath, 'src/tools.ts'), join(projectPath, 'src/.env.auth'));
  await assert.rejects(stageDeploymentSource({ projectPath }), code('DEPLOYMENT_SOURCE_INVALID'));
  const alias = join(dirname(projectPath), 'alias'); await symlink(projectPath, alias);
  await assert.rejects(stageDeploymentSource({ projectPath: alias }), code('DEPLOYMENT_SOURCE_INVALID'));
});

test('deployment staging: rejects custom Dockerfile secret build injection without evaluating it', async (t) => {
  const projectPath = await sourceFixture(t);
  await writeFile(join(projectPath, 'Dockerfile'), 'FROM node:22\nARG OPENAI_API_KEY\nENV KEY=$OPENAI_API_KEY\nRUN echo "$KEY" > /key\n');
  await assert.rejects(stageDeploymentSource({ projectPath }), code('DEPLOYMENT_DOCKERFILE_UNSUPPORTED'));
});

test('deployment staging: config/local-dev/private-key checks fail safely, not arbitrary secret scanning', async (t) => {
  const projectPath = await sourceFixture(t);
  await assert.rejects(stageDeploymentSource({ projectPath, deploymentEnv: { FASTAGENT_LOCAL_DEV: '' } }), code('DEPLOYMENT_SOURCE_INVALID'));
  await writeFile(join(projectPath, 'src/custom.ts'), 'export const data = "-----BEGIN PRIVATE KEY-----";');
  await assert.rejects(stageDeploymentSource({ projectPath }), code('DEPLOYMENT_SOURCE_INVALID'));
  await writeFile(join(projectPath, 'src/custom.ts'), 'export const data = 42;');
  await writeFile(join(projectPath, 'fastagent.yaml'), 'schemaVersion: 1\nname: test\nframework: openai\nmodel: openai/gpt-4o-mini\ndeployment: {access: protected}\nOPENAI_API_KEY: synthetic-private-config-value\n');
  await assert.rejects(stageDeploymentSource({ projectPath }), (error) => {
    assert.equal(error.code, 'CONFIG_INVALID'); assert.ok(!String(error).includes('synthetic-private-config-value')); return true;
  });
});

test('deployment staging: file/aggregate/count limits fail closed', async (t) => {
  const projectPath = await sourceFixture(t);
  await assert.rejects(stageDeploymentSource({ projectPath, maxFiles: 1 }), code('DEPLOYMENT_SOURCE_LIMIT'));
  await assert.rejects(stageDeploymentSource({ projectPath, maxBytes: 1 }), code('DEPLOYMENT_SOURCE_INVALID'));
  await assert.rejects(stageDeploymentSource({ projectPath, maxFileBytes: 1 }), code('DEPLOYMENT_SOURCE_INVALID'));
  assert.equal(await realpath(projectPath), projectPath);
  assert.ok((await readdir(projectPath)).includes('src'));
});

test('deployment staging: staged editable generated source typechecks and builds without runtime secrets', async (t) => {
  const projectPath = await sourceFixture(t);
  await writeFile(join(projectPath, 'src/custom-tools.ts'), 'export const editedTool = (value: number) => value * 2;');
  const staged = await stageDeploymentSource({ projectPath }); t.after(() => staged.cleanup());
  // Validation-only dependency link, created AFTER staging; no network/install or credential read.
  await symlink(join(process.cwd(), 'node_modules'), join(staged.directory, 'node_modules'));
  const compiler = join(process.cwd(), 'node_modules/typescript/bin/tsc');
  for (const args of [['--noEmit'], []]) {
    const result = spawnSync(process.execPath, [compiler, ...args], { cwd: staged.directory, env: {}, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.ok((await lstat(join(staged.directory, 'dist/main.js'))).isFile());
  assert.ok((await lstat(join(staged.directory, 'dist/custom-tools.js'))).isFile());
});

