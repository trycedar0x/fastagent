import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, access, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { initProject } from '../dist/scaffold/init.js';
import { executeDeployment, deploymentCommandEnvironment, formatDeploymentResult } from '../dist/deployment/service.js';
import { DeploymentStore } from '../dist/deployment/state.js';
import { createDeploymentHttp } from '../dist/deployment/http.js';
import { loadExplicitSecrets } from '../dist/deployment/secrets.js';
import { temporaryDirectory } from './helpers.mjs';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const secrets = { FASTAGENT_API_TOKEN: 'a'.repeat(43),
  OPENROUTER_API_KEY: 'synthetic-model-secret-123456', REDIS_URL: 'rediss://testuser:synthetic-redis-secret@redis.invalid/0' };
const token = 'synthetic-account-token-123456';
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };
async function fixture(t) {
  const root = await temporaryDirectory(t), cwd = join(root, 'agent');
  await initProject({ directory: cwd });
  await writeFile(join(cwd, '.env'), `OPENROUTER_API_KEY=${secrets.OPENROUTER_API_KEY}\nREDIS_URL=${secrets.REDIS_URL}\n`);
  await writeFile(join(cwd, '.env.auth'), `FASTAGENT_API_TOKEN=${secrets.FASTAGENT_API_TOKEN}\n`);
  await writeFile(join(cwd, '.env.railway'), `RAILWAY_API_TOKEN=${token}\n`);
  const store = new DeploymentStore(join(root, 'state'));
  const options = { command: 'deploy', provider: 'railway', workspace: 'workspace-test', cwd,
    envFiles: ['.env', '.env.auth'], authFile: '.env.railway' };
  const deps = { store, commandEnv: {}, runner: async () => { throw new Error('unexpected native command'); }, http: async () => { throw new Error('unexpected HTTP'); } };
  return { root, cwd, store, options, deps };
}
function provider(overrides = {}) {
  return { name: 'railway', preflight: async () => { throw new Error('service must not duplicate adapter preflight'); },
    deploy: async (input) => {
      const record = await input.state.read();
      assert.ok(record.revision > 0); assert.equal(record.sessionNamespace, input.environment.FASTAGENT_HISTORY_NAMESPACE);
      return input.state.write({ ...record, resources: [{ kind: 'service', id: 'service-test', ownership: 'owned' }],
        status: 'ready', phase: 'healthy', url: 'https://agent.example.invalid' });
    }, status: async () => ({ status: 'ready', url: 'https://agent.example.invalid' }),
    logs: async () => `log ${token} [application payload withheld]`,
    destroy: async ({ record }) => ({ verified: true, succeeded: true, ownershipMarker: record.ownershipMarker,
      resourceIdentities: record.resources.filter((r) => r.ownership === 'owned').map((r) => `${r.kind}:${r.id}`) }), ...overrides };
}
async function saved(f) {
  const lock = await f.store.acquire({ projectPath: f.cwd, provider: 'railway', target: 'agent' });
  try { return await lock.read(); } finally { await lock.release(); }
}
function invoke(args, cwd, root, extra = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, env: { PATH: process.env.PATH, HOME: root, ...extra }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return result;
}

test('deployment service keeps an existing protected app on its password contract without rewriting it', async (t) => {
  const f = await fixture(t);
  const legacy = `schemaVersion: 1\nname: agent\nframework: openai\nmodel: openai/gpt-4o-mini\ndeployment:\n  access: protected\n`;
  await writeFile(join(f.cwd, 'fastagent.yaml'), legacy);
  const password = `scrypt-v1$${'a'.repeat(32)}$${'b'.repeat(128)}`;
  await writeFile(join(f.cwd, '.env'), 'OPENAI_API_KEY=synthetic-openai-key\nREDIS_URL=rediss://testuser:synthetic-redis-secret@redis.invalid/0\n');
  await writeFile(join(f.cwd, '.env.auth'), `FASTAGENT_PASSWORD_HASH='${password}'\n`);
  const result = await executeDeployment({ ...f.options, dryRun: true }, f.deps);
  assert.equal(result.dryRun, true);
  assert.ok(result.secretKeys.includes('FASTAGENT_PASSWORD_HASH'));
  assert.ok(result.secretKeys.includes('OPENAI_API_KEY'));
  assert.ok(!result.secretKeys.includes('FASTAGENT_API_TOKEN'));
  assert.equal(await readFile(join(f.cwd, 'fastagent.yaml'), 'utf8'), legacy);
});

test('deployment service dry run: real generated project, explicit secrets only, no provider calls/state record, cleanup', async (t) => {
  const f = await fixture(t);
  const result = await executeDeployment({ ...f.options, dryRun: true }, { ...f.deps, provider: provider({ deploy: async () => assert.fail('dry run mutated') }) });
  assert.equal(result.dryRun, true); assert.equal(result.target, 'agent');
  assert.ok(result.files.includes('src/main.ts')); assert.ok(result.files.includes('.railwayignore'));
  assert.ok(result.files.every((file) => !file.startsWith('.env')));
  for (const secret of Object.values(secrets)) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(await saved(f), undefined);
  assert.deepEqual(await readdir(f.store.directory), []);
  assert.match(formatDeploymentResult(result), /Dry run: railway\/agent/);
  await assert.rejects(executeDeployment({ ...f.options, envFiles: [], dryRun: true }, f.deps), code('DEPLOYMENT_ENV_INVALID'));
  await assert.rejects(executeDeployment({ ...f.options, envFiles: ['.env', '.env'], dryRun: true }, f.deps), code('DEPLOYMENT_SECRET_FILE_INVALID'));
});

test('deployment service deploy/update/status/logs/destroy: stable identity, redaction, explicit proof checkpoint and lock release', async (t) => {
  const f = await fixture(t); let stage;
  const adapter = provider({ deploy: async (input) => { stage = input.source.directory;
    await assert.rejects(readFile(join(stage, '.env')));
    assert.deepEqual(input.environment.OPENROUTER_API_KEY, secrets.OPENROUTER_API_KEY);
    return provider().deploy(input);
  }, destroy: async (input) => {
    assert.equal(input.record.status, 'destroying'); assert.equal(input.record.phase, 'destroy-pending');
    const checkpoint = JSON.parse(await readFile(join(f.store.directory, `${input.record.key}.json`), 'utf8'));
    assert.equal(checkpoint.status, 'destroying'); assert.equal(checkpoint.phase, 'destroy-pending');
    return provider().destroy(input);
  } });
  const deps = { ...f.deps, provider: adapter };
  const first = await executeDeployment(f.options, deps); assert.equal(first.status, 'ready');
  await assert.rejects(access(stage));
  const a = await saved(f);
  const second = await executeDeployment(f.options, deps); assert.equal(second.status, 'ready');
  const b = await saved(f); assert.equal(b.ownershipMarker, a.ownershipMarker); assert.equal(b.sessionNamespace, a.sessionNamespace);
  const stateText = await readFile(join(f.store.directory, `${b.key}.json`), 'utf8');
  for (const secret of [...Object.values(secrets), token]) assert.ok(!stateText.includes(secret));
  const lifecycle = { ...f.options, envFiles: undefined };
  assert.equal((await executeDeployment({ ...lifecycle, command: 'status' }, deps)).status, 'ready');
  const logs = await executeDeployment({ ...lifecycle, command: 'logs' }, deps);
  for (const secret of [token, secrets.REDIS_URL]) assert.ok(!logs.logs.includes(secret));
  assert.match(logs.logs, /\[application payload withheld\]/);
  await assert.rejects(executeDeployment({ ...lifecycle, command: 'destroy' }, deps), code('DESTRUCTION_CONFIRMATION_REQUIRED'));
  assert.equal((await saved(f)).status, 'ready');
  const done = await executeDeployment({ ...lifecycle, command: 'destroy', yes: true }, deps);
  assert.equal(done.destroyed, true); assert.equal(await saved(f), undefined);
  assert.deepEqual(await readdir(f.store.directory), []);
});

test('deployment explicit nonsecret origin/namespace remain useful in output while known secrets are redacted', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, '.env.production'), 'APP_ORIGIN=https://agent.example.invalid\nFASTAGENT_HISTORY_NAMESPACE=agent\n');
  const result = await executeDeployment({ ...f.options, envFiles: [...f.options.envFiles, '.env.production'] }, { ...f.deps, provider: provider() });
  assert.equal(result.target, 'agent'); assert.equal(result.url, 'https://agent.example.invalid');
  assert.equal((await saved(f)).sessionNamespace, 'agent');
});

test('deployment service errors preserve adapter checkpoint and clean staging; failed destruction cannot remove record', async (t) => {
  const f = await fixture(t); let stage;
  const failing = provider({ deploy: async (input) => {
    stage = input.source.directory; const record = await input.state.read();
    await input.state.write({ ...record, status: 'deploying', phase: 'resources-created', resources: [{ kind: 'service', id: 'partial-service', ownership: 'owned' }] });
    throw new Error(token);
  } });
  await assert.rejects(executeDeployment(f.options, { ...f.deps, provider: failing }), (error) => { assert.equal(error.code, 'DEPLOYMENT_FAILED'); assert.ok(!error.message.includes(token)); return true; });
  await assert.rejects(access(stage)); assert.equal((await saved(f)).status, 'deploying');
  const badProof = provider({ destroy: async (input) => ({ verified: true, succeeded: true, ownershipMarker: input.record.ownershipMarker, resourceIdentities: [] }) });
  await assert.rejects(executeDeployment({ ...f.options, envFiles: undefined, command: 'destroy', yes: true }, { ...f.deps, provider: badProof }), code('DEPLOYMENT_STATE_INVALID'));
  assert.equal((await saved(f)).status, 'destroying');
  assert.ok((await readdir(f.store.directory)).every((file) => !file.endsWith('.lock')));
  await assert.rejects(executeDeployment(f.options, { ...f.deps, provider: provider() }), code('DEPLOYMENT_DESTROY_PENDING'));
});

test('deployment cancellation preserves checkpoints and cleanup; namespaces and selectors fail closed', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); let stage;
  await assert.rejects(executeDeployment({ ...f.options, signal: controller.signal }, { ...f.deps, provider: provider({ deploy: async (input) => {
    stage = input.source.directory; controller.abort(); throw new Error('cancelled');
  } }) }), code('DEPLOYMENT_CANCELLED'));
  await assert.rejects(access(stage)); const initial = await saved(f); assert.equal(initial.status, 'pending');
  await assert.rejects(executeDeployment({ ...f.options, workspace: 'other-workspace' }, { ...f.deps, provider: provider() }), code('DEPLOYMENT_TARGET_MISMATCH'));
  await writeFile(join(f.cwd, '.env.namespace'), 'FASTAGENT_HISTORY_NAMESPACE=other-agent\n');
  await assert.rejects(executeDeployment({ ...f.options, envFiles: [...f.options.envFiles, '.env.namespace'] }, { ...f.deps, provider: provider() }), code('DEPLOYMENT_NAMESPACE_MISMATCH'));
  assert.equal((await saved(f)).ownershipMarker, initial.ownershipMarker);
});

test('explicit env helper rejects unknown/local/malformed secrets, unsafe paths, duplicate keys and invalid hash/TLS Redis', async (t) => {
  const f = await fixture(t);
  for (const source of ['UNKNOWN_SECRET=hidden-value', 'FASTAGENT_LOCAL_DEV=1', 'OPENROUTER_API_KEY="unterminated', 'not an assignment', 'OPENROUTER_API_KEY=one\nOPENROUTER_API_KEY=two']) {
    await writeFile(join(f.cwd, '.env.bad'), source);
    await assert.rejects(loadExplicitSecrets(['.env.bad'], f.cwd, ['OPENROUTER_API_KEY'], []), code('DEPLOYMENT_SECRET_FILE_INVALID'));
  }
  await assert.rejects(loadExplicitSecrets(['.env.example'], f.cwd, ['OPENAI_API_KEY'], []), code('DEPLOYMENT_SECRET_FILE_INVALID'));
  await assert.rejects(loadExplicitSecrets(['src/private.txt'], f.cwd, ['OPENAI_API_KEY'], []), code('DEPLOYMENT_SECRET_FILE_INVALID'));
  for (const changed of [{ FASTAGENT_API_TOKEN: 'short' }, { OPENROUTER_API_KEY: 'bad key' }, { REDIS_URL: 'redis://redis.invalid' }]) {
    await writeFile(join(f.cwd, '.env.bad'), Object.entries({ ...secrets, ...changed }).map(([key, value]) => `${key}='${value}'`).join('\n'));
    await assert.rejects(executeDeployment({ ...f.options, envFiles: ['.env.bad'], dryRun: true }, f.deps), code('DEPLOYMENT_ENV_INVALID'));
  }
});

test('deployment CLI JSON and text dry run use explicit current directory and repeated env flags; no ambient secrets', async (t) => {
  const f = await fixture(t);
  const args = ['deploy', '--provider', 'railway', '--workspace', 'workspace-test', '--env-file', '.env', '--env-file', '.env.auth', '--dry-run'];
  const output = invoke([...args, '--json'], f.cwd, f.root, { OPENAI_API_KEY: 'ambient-must-not-load', RAILWAY_API_TOKEN: 'ambient-token' });
  assert.equal(output.status, 0, output.stdout + output.stderr); assert.equal(output.stderr, '');
  const result = JSON.parse(output.stdout); assert.equal(result.ok, true); assert.equal(result.dryRun, true); assert.equal(result.target, 'agent');
  for (const secret of [...Object.values(secrets), token, 'ambient-must-not-load', 'ambient-token']) assert.ok(!output.stdout.includes(secret));
  assert.match(invoke(args, f.cwd, f.root).stdout, /Dry run: railway\/agent/);
  assert.equal(invoke(['deploy', '--provider', 'railway', '--workspace', 'workspace-test', '--dry-run', '--json'], f.cwd, f.root, secrets).status, 1);
  for (const args of [
    ['deploy', f.cwd, '--provider', 'railway'], ['status', '--provider', 'railway', '--env-file', '.env'],
    ['deploy', '--provider', 'other'], ['init', 'other-agent', '--provider', 'railway'],
    ['deploy', '--provider', 'railway', '--install'], ['deploy', '--provider', 'railway', '--yes'],
    ['login', '--provider', 'cloudrun', '--interactive', '--json'], ['login', '--provider', 'railway', '--interactive'],
    ['deploy', '--provider', 'railway', '--unknown', 'should-not-echo'],
  ]) {
    const result = invoke([...args, '--json'], f.cwd, f.root); assert.equal(result.status, 2, result.stdout); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout).ok, false); assert.ok(!result.stdout.includes('should-not-echo'));
  }
});

test('deployment CLI SIGINT/SIGTERM cancel a bounded fake native command and preserve recoverable state', async (t) => {
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = await fixture(t), bin = join(f.root, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'railway'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("native-started", "ready"); setInterval(() => {}, 1000);\n', { mode: 0o755 });
    const child = spawn(process.execPath, [cliPath, 'deploy', '--provider', 'railway', '--workspace', 'workspace-test',
      '--auth-file', '.env.railway', '--env-file', '.env', '--env-file', '.env.auth', '--json'], {
      cwd: f.cwd, env: { PATH: `${bin}:${process.env.PATH}`, HOME: f.root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await access(join(f.cwd, 'native-started')); ready = true; break; } catch { await delay(10); }
    }
    assert.ok(ready, stdout + stderr); child.kill(signal);
    let timer;
    const result = await Promise.race([closed, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CLI cancellation did not finish')), 5000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(result.code, exitCode); assert.equal(result.signal, null); assert.equal(stderr, '');
    assert.equal(JSON.parse(stdout).error.code, 'DEPLOYMENT_CANCELLED'); assert.ok(!stdout.includes(token));
    const defaultStore = new DeploymentStore(join(f.root, '.fastagent', 'deployments'));
    const lock = await defaultStore.acquire({ projectPath: f.cwd, provider: 'railway', target: 'agent' });
    try { assert.equal((await lock.read()).status, 'pending'); } finally { await lock.release(); }
    assert.ok((await readdir(defaultStore.directory)).every((file) => !file.endsWith('.lock')));
  }
});

test('login is honest, no credential reads; native browser flow requires opt-in, selective configuration environment', async (t) => {
  const f = await fixture(t);
  const railway = await executeDeployment({ command: 'login', provider: 'railway', cwd: f.cwd }, f.deps);
  assert.equal(railway.authenticated, false); assert.match(railway.instructions, /RAILWAY_API_TOKEN/);
  let calls = 0;
  const deps = { ...f.deps, login: async (cwd, env) => { assert.equal(cwd, f.cwd); assert.deepEqual(env, {}); calls++; } };
  await executeDeployment({ command: 'login', provider: 'cloudrun', cwd: f.cwd }, deps); assert.equal(calls, 0);
  const result = await executeDeployment({ command: 'login', provider: 'cloudrun', interactive: true, cwd: f.cwd }, deps);
  assert.equal(calls, 1); assert.equal(result.authenticated, false);
  assert.deepEqual(deploymentCommandEnvironment({ PATH: '/bin', HOME: '/fixture', OPENAI_API_KEY: 'never', RAILWAY_API_TOKEN: 'never', CLOUDSDK_AUTH_ACCESS_TOKEN: 'never' }), { PATH: '/bin', HOME: '/fixture' });
});

test('Railway auth scope is explicit, project credentials require IDs and an existing record', async (t) => {
  const f = await fixture(t);
  await assert.rejects(executeDeployment({ ...f.options, authFile: undefined }, f.deps), code('RAILWAY_AUTH_REQUIRED'));
  await writeFile(join(f.cwd, '.env.project'), 'RAILWAY_TOKEN=synthetic-project-token\n');
  await assert.rejects(executeDeployment({ ...f.options, authFile: '.env.project' }, f.deps), code('INVALID_ARGUMENTS'));
  await assert.rejects(executeDeployment({ ...f.options, authFile: '.env.project', railwayProject: 'project-id', railwayEnvironment: 'environment-id' }, f.deps), code('RAILWAY_ACCOUNT_REQUIRED'));
  await writeFile(join(f.cwd, '.env.both'), `RAILWAY_API_TOKEN=${token}\nRAILWAY_TOKEN=second-token\n`);
  await assert.rejects(executeDeployment({ ...f.options, authFile: '.env.both', dryRun: true }, f.deps), code('INVALID_ARGUMENTS'));
});

test('Cloud Run dry run validates required existing identities and does not run gcloud or HTTP', async (t) => {
  const f = await fixture(t);
  const options = { command: 'deploy', cwd: f.cwd, provider: 'cloudrun', project: 'fixture-project', region: 'us-central1',
    runtimeAccount: 'runtime@fixture-project.iam.gserviceaccount.com', buildAccount: 'builder@fixture-project.iam.gserviceaccount.com', envFiles: f.options.envFiles, dryRun: true };
  assert.equal((await executeDeployment(options, f.deps)).dryRun, true);
  await assert.rejects(executeDeployment({ ...options, buildAccount: options.runtimeAccount }, f.deps), code('CLOUDRUN_OPTIONS_INVALID'));
  await assert.rejects(executeDeployment({ ...options, authFile: '.env.railway' }, f.deps), code('INVALID_ARGUMENTS'));
  await assert.rejects(executeDeployment({ ...options, region: undefined }, f.deps), code('INVALID_ARGUMENTS'));
});

test('packaged CLI smoke: unpack offline artifact, reuse installed dependencies, init and dry run without cloud access', async (t) => {
  const root = await temporaryDirectory(t);
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: repository, env: { PATH: process.env.PATH, HOME: root, npm_config_cache: join(root, 'cache') }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(pack.error, undefined); assert.equal(pack.status, 0, pack.stderr);
  const artifact = join(root, JSON.parse(pack.stdout)[0].filename);
  const unpack = join(root, 'unpack'); await mkdir(unpack);
  const tar = spawnSync('tar', ['-xzf', artifact, '-C', unpack], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(tar.error, undefined); assert.equal(tar.status, 0, tar.stderr);
  // Deliberately offline: this verifies package contents/bin, not a fresh registry installation.
  await symlink(join(repository, 'node_modules'), join(unpack, 'package', 'node_modules'), 'dir');
  const packagedCli = join(unpack, 'package', 'dist', 'cli.js');
  const invokePackaged = (args, cwd) => spawnSync(process.execPath, [packagedCli, ...args], {
    cwd, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 10_000,
  });
  const init = invokePackaged(['init', 'agent', '--json'], root);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const cwd = join(root, 'agent');
  await writeFile(join(cwd, '.env.production'), Object.entries(secrets).map(([key, value]) => `${key}='${value}'`).join('\n'));
  const dryRun = invokePackaged(['deploy', '--provider', 'railway', '--workspace', 'fixture-workspace', '--env-file', '.env.production', '--dry-run', '--json'], cwd);
  assert.equal(dryRun.error, undefined); assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr); assert.equal(dryRun.stderr, '');
  const result = JSON.parse(dryRun.stdout); assert.equal(result.dryRun, true); assert.ok(result.files.includes('Dockerfile'));
  for (const secret of Object.values(secrets)) assert.ok(!dryRun.stdout.includes(secret));
});

test('native HTTP transport rejects redirects/HTTP/malformed or oversized JSON; verifies health and cancellation', async () => {
  const request = { url: 'https://fixture.invalid/healthz', method: 'GET', headers: {}, signal: new AbortController().signal, maxResponseBytes: 64 };
  const seen = [];
  const http = createDeploymentHttp(async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); });
  assert.deepEqual(await http(request), { status: 200, body: { ok: true } }); assert.equal(seen[0].init.redirect, 'error');
  await assert.rejects(http({ ...request, url: 'http://fixture.invalid/healthz' }), code('DEPLOYMENT_HTTP_FAILED'));
  for (const [body, status] of [['{"ok":false}', 200], ['not-json', 200], ['{"ok":true}', 302], ['x'.repeat(65), 200], ['{"ok":true}', 500]]) {
    await assert.rejects(createDeploymentHttp(async () => new Response(body, { status }))(request), code('DEPLOYMENT_HTTP_FAILED'));
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(http({ ...request, signal: aborted.signal }), code('DEPLOYMENT_HTTP_FAILED'));
  const waiting = createDeploymentHttp(async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private transport error')), { once: true })), 5);
  await assert.rejects(waiting(request), code('DEPLOYMENT_HTTP_FAILED'));
  const graphql = createDeploymentHttp(async (_url, init) => { assert.equal(init.body, JSON.stringify({ query: 'query {}', variables: {} })); return new Response('{"data":{}}'); });
  assert.deepEqual((await graphql({ ...request, method: 'POST', body: { query: 'query {}', variables: {} } })).body, { data: {} });
});
