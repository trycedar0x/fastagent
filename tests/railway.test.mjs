import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRailwayProvider } from '../dist/deployment/providers/railway.js';
import { DeploymentStore, createDeploymentRecord, deploymentKey, validateDeploymentRecord } from '../dist/deployment/state.js';
import { temporaryDirectory } from './helpers.mjs';
import { FastagentError } from '../dist/errors.js';

const env = () => ({ FASTAGENT_PASSWORD_HASH: `scrypt-v1$${'a'.repeat(32)}$${'b'.repeat(128)}`,
  OPENAI_API_KEY: 'synthetic-model-credential', REDIS_URL: 'rediss://fixture:synthetic-redis-credential@redis.invalid/0',
  FASTAGENT_SESSION_NAMESPACE: 'railway-test' });
const tokenApiToken = 't'.repeat(43);
const tokenEnv = (extra = {}) => ({ FASTAGENT_API_TOKEN: tokenApiToken, OPENROUTER_API_KEY: 'synthetic-openrouter-credential',
  REDIS_URL: 'rediss://fixture:synthetic-redis-credential@redis.invalid/0', FASTAGENT_HISTORY_NAMESPACE: 'railway-ephemeral', ...extra });
const ephemeralEnv = () => ({ FASTAGENT_API_TOKEN: tokenApiToken, OPENROUTER_API_KEY: 'synthetic-openrouter-credential',
  FASTAGENT_EPHEMERAL_HISTORY: '1', FASTAGENT_HISTORY_NAMESPACE: 'railway-ephemeral' });
const ref = (name) => ({ name, kind: name === 'Int' || name === 'String' || name === 'Boolean' || name === 'JSON' ? 'SCALAR' : 'OBJECT', ofType: null });
const field = (name, type, args = []) => ({ name, type: ref(type), args: args.map(([name, type]) => ({ name, type: ref(type) })) });
function schemaProfile() {
  return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [
    { name: 'Query', fields: [field('project', 'Project', [['id', 'String']]), field('variables', 'JSON',
      [['projectId', 'String'], ['environmentId', 'String'], ['serviceId', 'String']])] },
    { name: 'Mutation', fields: [field('serviceDelete', 'Boolean', [['id', 'String']]),
      field('serviceInstanceUpdate', 'Boolean', [['input', 'ServiceInstanceUpdateInput']])] },
    { name: 'Project', fields: [field('id', 'String'), field('workspaceId', 'String'), field('environments', 'Environments'), field('services', 'Services')] },
    { name: 'Environments', fields: [field('edges', 'EnvironmentEdge')] },
    { name: 'Services', fields: [field('edges', 'ServiceEdge')] },
    { name: 'EnvironmentEdge', fields: [field('node', 'Environment')] },
    { name: 'ServiceEdge', fields: [field('node', 'Service')] },
    { name: 'Environment', fields: [field('id', 'String'), field('name', 'String')] },
    { name: 'Service', fields: [field('id', 'String')] },
    { name: 'ServiceInstanceUpdateInput', inputFields: [field('serviceId', 'String'), field('environmentId', 'String'),
      field('numReplicas', 'Int'), field('healthcheckPath', 'String'), field('healthcheckTimeout', 'Int')] },
  ] };
}
const errorCode = (code) => (error) => { assert.equal(error.code, code); return true; };
async function fixture(t, changes = {}, runtimeEnv = env()) {
  const root = await temporaryDirectory(t);
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const directory = join(root, 'stage'); await mkdir(directory);
  await writeFile(join(directory, 'Dockerfile'), await readFile(new URL('../templates/openai/Dockerfile', import.meta.url)));
  const selector = { projectPath, provider: 'railway', target: 'production' };
  const events = [], commands = [], requests = [], checkpoints = [];
  let current;
  const state = {
    selector, read: async () => current ? structuredClone(current) : undefined,
    write: async (record) => {
      validateDeploymentRecord(record);
      assert.equal(record.key, deploymentKey(selector));
      assert.equal(record.revision, current?.revision ?? 0);
      if (current) { assert.equal(record.ownershipMarker, current.ownershipMarker); assert.equal(record.sessionNamespace, current.sessionNamespace); }
      current = structuredClone({ ...record, revision: record.revision + 1 });
      checkpoints.push(structuredClone(current)); events.push({ checkpoint: structuredClone(current) });
      return structuredClone(current);
    }, remove: async () => {}, release: async () => {},
  };
  const remote = { variables: {}, services: [], domains: [], workspace: 'workspace-1', deployment: 'SUCCESS', health: { ok: true },
    uploads: 0, deletes: 0, schema: schemaProfile(), ...changes };
  const runner = async (request) => {
    commands.push(request); events.push({ command: request });
    const a = request.args;
    assert.deepEqual(request.env, { PATH: '/synthetic/bin' });
    assert.equal(Object.keys(request.secretEnv).length, 1);
    let response = {};
    if (a[0] === '--version') return { stdout: remote.version ?? 'railway 5.28.1', stderr: '', exitCode: 0 };
    if (a.includes('--help')) return { stdout: remote.help ?? '--name --workspace --json --service --project --environment --port --stdin --skip-deploys --path-as-root --detach --lines', stderr: '', exitCode: 0 };
    if (a[0] === 'whoami') response = { name: null, email: 'fixture@example.invalid', workspaces: [{ id: remote.workspace, name: 'workspace' }] };
    else if (a[0] === 'init') {
      if (remote.initError) throw new Error(runtimeEnv.OPENAI_API_KEY ?? runtimeEnv.OPENROUTER_API_KEY);
      assert.equal(current.status, 'deploying');
      response = { id: 'project-1', name: 'agent' };
    } else if (a[0] === 'add') {
      assert.ok(current.resources.some((item) => item.id === 'project-1'));
      assert.ok(current.resources.some((item) => item.id === 'env-1'));
      if (remote.addError) throw new Error('synthetic account credential');
      remote.services.push({ id: 'service-1' }); response = { id: 'service-1', name: 'agent' };
    } else if (a[0] === 'variable') {
      assert.equal(request.intent, 'mutate'); assert.ok(a.includes('--skip-deploys'));
      assert.ok(current.resources.some((item) => item.id === 'service-1'));
      if (a.includes('--stdin')) remote.variables[a[2]] = request.stdin;
      else for (const value of a.slice(2)) if (value.includes('=')) { const index = value.indexOf('='); remote.variables[value.slice(0, index)] = value.slice(index + 1); }
      if (remote.variableError) throw new Error(runtimeEnv.OPENAI_API_KEY ?? runtimeEnv.OPENROUTER_API_KEY);
      return { stdout: `${runtimeEnv.OPENAI_API_KEY ?? runtimeEnv.OPENROUTER_API_KEY} ${runtimeEnv.REDIS_URL ?? ''}`, stderr: '', exitCode: 0 };
    } else if (a[0] === 'domain' && a[1] === 'list') response = { domains: remote.domains };
    else if (a[0] === 'domain') {
      assert.equal(current.status, 'deploying'); assert.ok(current.resources.some((item) => item.id === 'service-1'));
      if (!remote.domainEmpty) remote.domains.push({ id: 'domain-1', domain: 'agent.up.railway.app', kind: 'service', targetPort: 8080,
        environmentId: 'env-1', serviceId: 'service-1' });
      if (remote.domainError) throw new Error('uncertain domain');
      response = { deliberately: 'creation schema ignored; actual identity from domain list' };
    } else if (a[0] === 'up') {
      assert.equal(current.phase, 'secrets-configured'); assert.equal(current.status, 'deploying');
      assert.equal(current.url, 'https://agent.up.railway.app');
      assert.equal(remote.variables.APP_ORIGIN, current.url);
      const namespaceKey = 'FASTAGENT_SESSION_NAMESPACE' in runtimeEnv ? 'FASTAGENT_SESSION_NAMESPACE' : 'FASTAGENT_HISTORY_NAMESPACE';
      assert.equal(remote.variables[namespaceKey], current.sessionNamespace);
      assert.ok(!('FASTAGENT_LOCAL_DEV' in remote.variables));
      remote.uploads++;
      if (remote.upError) throw new Error('uncertain upload');
      response = { deploymentId: remote.uploadId ?? `deployment-${remote.uploads}`, logsUrl: 'https://railway.app/project/synthetic' };
    } else if (a[0] === 'deployment') {
      if (remote.cancel) remote.cancel.abort();
      response = remote.deploymentList ?? [
        { id: `deployment-${remote.uploads}`, status: remote.deployment, createdAt: '2026-01-01T00:00:00Z', meta: {} },
        { id: 'newer-unrelated', status: 'SUCCESS', createdAt: '2026-02-01T00:00:00Z', meta: {} },
      ];
    } else if (a[0] === 'logs') {
      response = { timestamp: '2026-01-01T00:00:00Z', message: `${runtimeEnv.OPENAI_API_KEY ?? runtimeEnv.OPENROUTER_API_KEY} ${runtimeEnv.REDIS_URL ?? ''} synthetic-redis-credential ${remote.variables.CUSTOM_AUTH ?? ''}` };
    } else assert.equal(a[0], 'link');
    return { stdout: JSON.stringify(response), stderr: '', exitCode: 0 };
  };
  const http = async (request) => {
    requests.push(request); events.push({ http: request });
    if (request.method === 'GET') {
      assert.deepEqual(request.headers, {}); assert.equal(request.url, 'https://agent.up.railway.app/healthz');
      return { status: remote.healthStatus ?? 200, body: remote.health };
    }
    assert.equal(request.url, 'https://backboard.railway.com/graphql/v2');
    const { query, variables } = request.body;
    if (remote.httpError) throw new Error(runtimeEnv.REDIS_URL ?? 'synthetic-redis-error');
    if (remote.graphqlErrors) return { status: 200, body: { errors: [{ message: runtimeEnv.OPENAI_API_KEY ?? runtimeEnv.OPENROUTER_API_KEY }] } };
    let data;
    if (query.includes('__schema')) data = { __schema: remote.schema };
    else if (query.includes('serviceInstanceUpdate')) {
      assert.deepEqual({ ...variables, ...variables.input, input: undefined }, { serviceId: 'service-1', environmentId: 'env-1', numReplicas: 1, healthcheckPath: '/healthz', healthcheckTimeout: 300, input: undefined });
      data = { serviceInstanceUpdate: remote.configureResult ?? true };
    } else if (query.includes('serviceDelete')) {
      assert.deepEqual(variables, { id: 'service-1' }); remote.deletes++;
      if (!remote.deleteRetained) remote.services = [];
      data = { serviceDelete: remote.deleteResult ?? true };
    } else if (query.includes('variables(')) {
      assert.deepEqual(variables, { projectId: 'project-1', environmentId: 'env-1', serviceId: 'service-1' });
      data = { variables: structuredClone(remote.variables) };
    } else if (query.includes('project(')) {
      assert.deepEqual(variables, { id: 'project-1' });
      data = { project: { id: remote.projectId ?? 'project-1', workspaceId: remote.workspace,
        environments: { edges: [{ node: { id: remote.environmentId ?? 'env-1', name: 'production' } }] },
        services: { edges: remote.services.map((node) => ({ node })) } } };
    } else throw new Error('unrecognized query');
    return { status: 200, body: { data } };
  };
  const options = { workspaceId: 'workspace-1', credentials: { scope: 'account', token: 'synthetic-account-credential' }, http,
    commandEnv: { PATH: '/synthetic/bin' }, pollIntervalMs: 1, deploymentTimeoutMs: 30, requestTimeoutMs: 1000 };
  const input = { selector, runner, state, source: { directory, config: { name: 'agent' }, files: ['Dockerfile', '.railwayignore'] }, environment: runtimeEnv };
  return { options, input, state, remote, commands, requests, events, checkpoints, provider: createRailwayProvider(options), runtimeEnv,
    record: () => current, seed: async () => {
      let record = createDeploymentRecord(selector);
      record = { ...record, sessionNamespace: runtimeEnv.FASTAGENT_SESSION_NAMESPACE ?? runtimeEnv.FASTAGENT_HISTORY_NAMESPACE, selectors: { project: 'workspace-1' },
        resources: [{ kind: 'project', id: 'project-1', ownership: 'external' }, { kind: 'environment', id: 'env-1', ownership: 'external' },
          { kind: 'service', id: 'service-1', ownership: 'owned' }], phase: 'resources-created' };
      remote.services = [{ id: 'service-1' }]; remote.variables = { FASTAGENT_OWNERSHIP_MARKER: record.ownershipMarker };
      return state.write(record);
    } };
}

test('railway preflight: version/capabilities, account workspace and TLS secrets before mutation', async (t) => {
  const f = await fixture(t);
  await f.provider.preflight(f.input, env());
  assert.ok(f.commands.every((request) => request.intent === 'read'));
  assert.ok(f.requests.every((request) => !request.body.query.startsWith('mutation')));
  for (const mutation of [{ REDIS_URL: 'redis://redis.invalid' }, { FASTAGENT_LOCAL_DEV: '1' }, { OPENAI_API_KEY: '' }]) {
    await assert.rejects(f.provider.preflight(f.input, { ...env(), ...mutation }), errorCode('DEPLOYMENT_ENV_INVALID'));
  }
  f.remote.version = 'railway 6.0.0'; await assert.rejects(f.provider.preflight(f.input, env()), errorCode('RAILWAY_CLI_UNSUPPORTED'));
  f.remote.version = 'railway 5.28.1'; f.remote.help = '--json';
  await assert.rejects(f.provider.preflight(f.input, env()), errorCode('RAILWAY_CLI_UNSUPPORTED'));
  f.remote.help = undefined; f.remote.workspace = 'other-workspace';
  await assert.rejects(f.provider.preflight(f.input, env()), errorCode('RAILWAY_WORKSPACE_UNAUTHORIZED'));
});

test('railway fresh deploy: exact checkpoints, origin before activation, stdin secrets and correlated ready', async (t) => {
  const f = await fixture(t);
  const result = await f.provider.deploy(f.input);
  assert.equal(result.status, 'ready'); assert.equal(result.phase, 'healthy');
  assert.equal(result.url, 'https://agent.up.railway.app');
  assert.equal(result.resources.find((resource) => resource.kind === 'build').id, 'deployment-1');
  const mutationCommands = f.commands.filter((request) => request.intent === 'mutate');
  const secretSets = mutationCommands.filter((request) => request.args.includes('--stdin'));
  assert.equal(secretSets.length, 3);
  for (const key of ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL']) {
    const request = secretSets.find((request) => request.args[2] === key);
    assert.equal(request.stdin, env()[key]); assert.ok(request.args.includes('--skip-deploys'));
  }
  for (const request of f.commands) {
    for (const value of Object.values(env()).slice(0, 3)) assert.ok(!request.args.join(' ').includes(value));
    assert.ok(!request.args.some((arg) => arg.includes('FASTAGENT_LOCAL_DEV')));
    assert.deepEqual(Object.keys(request.secretEnv), ['RAILWAY_API_TOKEN']);
    if (request.args[0] === 'up' && !request.args.includes('--help')) { assert.equal(request.args[1], f.input.source.directory); assert.ok(request.args.includes('--path-as-root')); }
  }
  for (const value of Object.values(env()).slice(0, 3)) assert.ok(!JSON.stringify(f.checkpoints).includes(value));
  assert.ok(!JSON.stringify(result).includes('logsUrl'));
  const projectCheckpoint = f.events.findIndex((event) => event.checkpoint?.resources.some((entry) => entry.kind === 'project'));
  const addIndex = f.events.findIndex((event) => event.command?.args[0] === 'add' && event.command.intent === 'mutate');
  const serviceCheckpoint = f.events.findIndex((event) => event.checkpoint?.resources.some((entry) => entry.kind === 'service'));
  const markerIndex = f.events.findIndex((event) => event.command?.args[0] === 'variable' && event.command.intent === 'mutate');
  assert.ok(projectCheckpoint < addIndex); assert.ok(serviceCheckpoint < markerIndex);
});

test('railway token ephemeral: no Redis variable, explicit opt-in flag, single replica pin', async (t) => {
  const f = await fixture(t, {}, ephemeralEnv());
  const result = await f.provider.deploy(f.input);
  assert.equal(result.status, 'ready'); assert.equal(result.sessionNamespace, 'railway-ephemeral');
  const secretSets = f.commands.filter((r) => r.intent === 'mutate' && r.args.includes('--stdin'));
  assert.equal(secretSets.length, 2);
  assert.deepEqual(secretSets.map((r) => r.args[2]).sort(), ['FASTAGENT_API_TOKEN', 'OPENROUTER_API_KEY']);
  assert.ok(!('REDIS_URL' in f.remote.variables));
  assert.equal(f.remote.variables.FASTAGENT_EPHEMERAL_HISTORY, '1');
  const update = f.requests.find((r) => r.body?.query.includes('serviceInstanceUpdate'));
  assert.equal(update.body.variables.input.numReplicas, 1);
  for (const value of [tokenApiToken, 'synthetic-openrouter-credential']) assert.ok(!JSON.stringify(f.checkpoints).includes(value));
});

test('railway ephemeral refuses when the single-replica setting is not confirmed', async (t) => {
  const f = await fixture(t, { configureResult: false }, ephemeralEnv());
  await assert.rejects(f.provider.deploy(f.input), errorCode('DEPLOYMENT_SINGLE_INSTANCE_REQUIRED'));
  assert.equal(f.remote.uploads, 0);
});

test('railway token Redis: REDIS_URL stays a secret variable and no ephemeral flag appears', async (t) => {
  const f = await fixture(t, {}, tokenEnv());
  const result = await f.provider.deploy(f.input);
  assert.equal(result.status, 'ready');
  const secretSets = f.commands.filter((r) => r.intent === 'mutate' && r.args.includes('--stdin'));
  assert.equal(secretSets.length, 3);
  assert.ok(secretSets.some((r) => r.args[2] === 'REDIS_URL'));
  assert.ok(!('FASTAGENT_EPHEMERAL_HISTORY' in f.remote.variables));
});

test('railway update: reuse verified service/domain/namespace, not another latest deployment', async (t) => {
  const f = await fixture(t);
  const first = await f.provider.deploy(f.input); const oldCount = f.commands.length;
  const second = await f.provider.deploy(f.input);
  assert.equal(second.ownershipMarker, first.ownershipMarker); assert.equal(second.sessionNamespace, first.sessionNamespace);
  assert.equal(second.resources.find((item) => item.kind === 'build').id, 'deployment-2');
  assert.ok(!f.commands.slice(oldCount).filter((request) => !request.args.includes('--help')).some((request) => ['init', 'add'].includes(request.args[0]) || (request.args[0] === 'domain' && request.args[1] !== 'list')));
  await assert.rejects(f.provider.deploy({ ...f.input, environment: { ...env(), FASTAGENT_SESSION_NAMESPACE: 'changed' } }), errorCode('RAILWAY_NAMESPACE_MISMATCH'));
});

test('railway resume: confirmed resources and timeout deployment reused, no blind reupload', async (t) => {
  const f = await fixture(t, { deployment: 'QUEUED' });
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_DEPLOYMENT_TIMEOUT'));
  const record = f.record(); assert.equal(record.status, 'deploying'); assert.equal(record.phase, 'source-uploaded');
  assert.equal(f.remote.uploads, 1);
  f.remote.deployment = 'SUCCESS';
  const result = await f.provider.deploy(f.input); assert.equal(result.status, 'ready'); assert.equal(f.remote.uploads, 1);
  const partial = await fixture(t); await partial.seed();
  assert.equal((await partial.provider.deploy(partial.input)).status, 'ready');
  assert.ok(!partial.commands.some((request) => ['init', 'add'].includes(request.args[0]) && !request.args.includes('--help')));
});

test('railway uncertainty: failed init/add/upload never silently repeats creation or source mutation', async (t) => {
  for (const [key, commandName] of [['initError', 'init'], ['addError', 'add'], ['upError', 'up']]) {
    const f = await fixture(t, { [key]: true });
    await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_COMMAND_FAILED'));
    assert.equal(f.record().status, 'deploying');
    f.remote[key] = false;
    await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_MUTATION_UNCERTAIN'));
    assert.equal(f.commands.filter((request) => request.args[0] === commandName && !request.args.includes('--help')).length, 1);
  }
});

test('railway domain bootstrap: never activate without exact origin; recover uncertain existing domain', async (t) => {
  const f = await fixture(t, { domainError: true, domainEmpty: true });
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_COMMAND_FAILED'));
  assert.equal(f.remote.uploads, 0); assert.equal(f.record().resources.find((entry) => entry.kind === 'service').id, 'service-1');
  f.remote.domainError = false;
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_MUTATION_UNCERTAIN'));
  assert.equal(f.remote.uploads, 0);
  const recovered = await fixture(t, { domainError: true });
  await assert.rejects(recovered.provider.deploy(recovered.input), errorCode('RAILWAY_COMMAND_FAILED'));
  recovered.remote.domainError = false;
  assert.equal((await recovered.provider.deploy(recovered.input)).status, 'ready');
  assert.equal(recovered.commands.filter((request) => request.args[0] === 'domain' && request.intent === 'mutate').length, 1);
  const mismatch = await fixture(t);
  await assert.rejects(mismatch.provider.deploy({ ...mismatch.input, environment: { ...env(), APP_ORIGIN: 'https://other.invalid' } }), errorCode('RAILWAY_ORIGIN_MISMATCH'));
  assert.equal(mismatch.remote.uploads, 0);
});

test('railway ownership/identity: fail closed before update, logs and destroy', async (t) => {
  const f = await fixture(t); await f.seed(); f.remote.variables.FASTAGENT_OWNERSHIP_MARKER = 'f'.repeat(32);
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_OWNERSHIP_MISMATCH'));
  await assert.rejects(f.provider.logs(f.input, f.record()), errorCode('RAILWAY_OWNERSHIP_MISMATCH'));
  await assert.rejects(f.provider.destroy({ ...f.input, record: f.record(), confirmed: true }), errorCode('RAILWAY_OWNERSHIP_MISMATCH'));
  assert.equal(f.remote.uploads, 0); assert.equal(f.remote.deletes, 0);
  const other = await fixture(t); await other.seed(); other.remote.environmentId = 'foreign-env';
  await assert.rejects(other.provider.deploy(other.input), errorCode('RAILWAY_TARGET_MISMATCH'));
  other.remote.environmentId = 'env-1'; other.remote.projectId = 'foreign-project';
  await assert.rejects(other.provider.deploy(other.input), errorCode('RAILWAY_TARGET_MISMATCH'));
});

test('railway status: success is not ready unless health true and exact configured origin verified', async (t) => {
  const f = await fixture(t); const record = await f.provider.deploy(f.input);
  f.remote.health = { ok: false };
  assert.equal((await f.provider.status(f.input, record)).status, 'deploying');
  f.remote.health = { ok: true }; assert.equal((await f.provider.status(f.input, record)).status, 'ready');
  f.remote.variables.APP_ORIGIN = 'https://other.invalid';
  await assert.rejects(f.provider.status(f.input, record), errorCode('RAILWAY_ORIGIN_MISMATCH'));
  f.remote.variables.APP_ORIGIN = record.url; f.remote.variables.FASTAGENT_LOCAL_DEV = '1';
  await assert.rejects(f.provider.status(f.input, record), errorCode('RAILWAY_UNSAFE_REMOTE_ENV'));
});

test('railway deployment: terminal failure, exact-ID missing, unknown schema and cancellation retain identity', async (t) => {
  const failed = await fixture(t, { deployment: 'FAILED' });
  await assert.rejects(failed.provider.deploy(failed.input), errorCode('RAILWAY_DEPLOYMENT_FAILED'));
  assert.equal(failed.record().status, 'failed');
  const missing = await fixture(t, { deploymentList: [{ id: 'newer-unrelated', status: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z' }] });
  await assert.rejects(missing.provider.deploy(missing.input), errorCode('RAILWAY_DEPLOYMENT_FAILED'));
  const unknown = await fixture(t, { deployment: 'UNKNOWN_NEW_STATUS' });
  await assert.rejects(unknown.provider.deploy(unknown.input), errorCode('RAILWAY_SCHEMA_UNSUPPORTED'));
  const controller = new AbortController();
  const cancelled = await fixture(t, { deployment: 'QUEUED', cancel: controller });
  await assert.rejects(cancelled.provider.deploy({ ...cancelled.input, signal: controller.signal }), errorCode('RAILWAY_CANCELLED'));
  assert.equal(cancelled.record().phase, 'source-uploaded'); assert.equal(cancelled.remote.uploads, 1);
});

test('railway API schema/errors: reject unsupported profile and secret-bearing errors without disclosure', async (t) => {
  const f = await fixture(t); f.remote.schema.types.find((type) => type.name === 'ServiceInstanceUpdateInput').inputFields.pop();
  await assert.rejects(f.provider.preflight(f.input, env()), errorCode('RAILWAY_SCHEMA_UNSUPPORTED'));
  assert.equal(f.record(), undefined);
  const errors = await fixture(t, { graphqlErrors: true });
  await assert.rejects(errors.provider.preflight(errors.input, env()), (error) => {
    assert.equal(error.code, 'RAILWAY_API_FAILED'); assert.ok(!String(error).includes(env().OPENAI_API_KEY)); return true;
  });
  const network = await fixture(t, { httpError: true });
  await assert.rejects(network.provider.preflight(network.input, env()), (error) => {
    assert.equal(error.code, 'RAILWAY_HTTP_FAILED'); assert.ok(!String(error).includes(env().REDIS_URL)); return true;
  });
});

test('railway logs: exact deployment, bounded lines and values/Redis password redacted', async (t) => {
  const f = await fixture(t); const record = await f.provider.deploy(f.input);
  f.remote.variables.CUSTOM_AUTH = 'synthetic-custom-auth';
  const logs = await f.provider.logs(f.input, record);
  assert.ok(!logs.includes('synthetic-custom-auth'));
  assert.ok(!logs.includes(env().OPENAI_API_KEY)); assert.ok(!logs.includes(env().REDIS_URL));
  assert.ok(!logs.includes('synthetic-redis-credential'));
  const request = f.commands.find((request) => request.args[0] === 'logs' && !request.args.includes('--help'));
  assert.equal(request.args[1], 'deployment-1'); assert.ok(request.args.includes('100')); assert.ok(request.args.includes('--json'));
  assert.ok(request.maxOutputBytes <= 256 * 1024);
});

test('railway destroy: explicit confirmation + verified remote service only, exact proof, preserved project', async (t) => {
  const f = await fixture(t); const record = await f.provider.deploy(f.input);
  await assert.rejects(f.provider.destroy({ ...f.input, record, confirmed: false }), errorCode('RAILWAY_DESTRUCTION_UNAUTHORIZED'));
  assert.equal(f.remote.deletes, 0);
  const proof = await f.provider.destroy({ ...f.input, record, confirmed: true });
  assert.deepEqual(proof, { verified: true, succeeded: true, ownershipMarker: record.ownershipMarker, resourceIdentities: ['service:service-1'] });
  assert.equal(f.remote.deletes, 1);
  assert.ok(!f.commands.some((request) => request.args[0] === 'delete'));
  assert.ok(!f.requests.some((request) => request.body?.query.includes('projectDelete')));
  const retained = await fixture(t); const second = await retained.provider.deploy(retained.input); retained.remote.deleteRetained = true;
  await assert.rejects(retained.provider.destroy({ ...retained.input, record: second, confirmed: true }), errorCode('RAILWAY_DESTRUCTION_FAILED'));
});

test('railway project auth: explicit environment binding, reuse only, no dual token and no destruction', async (t) => {
  const f = await fixture(t); await f.seed();
  const provider = createRailwayProvider({ ...f.options, credentials: { scope: 'project', token: 'synthetic-project-credential', projectId: 'project-1', environmentId: 'env-1' } });
  const record = await provider.deploy(f.input);
  assert.ok(f.commands.every((request) => Object.keys(request.secretEnv).join() === 'RAILWAY_TOKEN'));
  assert.ok(f.requests.filter((request) => request.method === 'POST').every((request) => request.headers['Project-Access-Token'] === 'synthetic-project-credential' && !('Authorization' in request.headers)));
  await assert.rejects(provider.destroy({ ...f.input, record, confirmed: true }), errorCode('RAILWAY_DESTRUCTION_UNAUTHORIZED'));
  const fresh = await fixture(t);
  const onlyProject = createRailwayProvider({ ...fresh.options, credentials: { scope: 'project', token: 'synthetic-project-credential', projectId: 'project-1', environmentId: 'env-1' } });
  await assert.rejects(onlyProject.deploy(fresh.input), errorCode('RAILWAY_ACCOUNT_REQUIRED'));
  assert.equal(fresh.commands.length, 0);
});

test('railway HTTP timeout/cancel and source guard: safe failure without activation', async (t) => {
  const f = await fixture(t);
  const provider = createRailwayProvider({ ...f.options, requestTimeoutMs: 5, http: async () => new Promise(() => {}) });
  await assert.rejects(provider.preflight(f.input, env()), errorCode('RAILWAY_HTTP_TIMEOUT'));
  const controller = new AbortController();
  const pending = provider.preflight({ ...f.input, signal: controller.signal }, env());
  controller.abort(); await assert.rejects(pending, errorCode('RAILWAY_CANCELLED'));
  await writeFile(join(f.input.source.directory, 'Dockerfile'), 'FROM node:22\nARG OPENAI_API_KEY');
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_SOURCE_UNSUPPORTED'));
  assert.equal(f.remote.uploads, 0);
});

test('railway API profile: separate identity mutation args supported only after introspection', async (t) => {
  const f = await fixture(t);
  const mutation = f.remote.schema.types.find((type) => type.name === 'Mutation');
  mutation.fields.find((entry) => entry.name === 'serviceInstanceUpdate').args.push(
    { name: 'serviceId', type: ref('String') }, { name: 'environmentId', type: ref('String') });
  f.remote.schema.types.find((type) => type.name === 'ServiceInstanceUpdateInput').inputFields =
    f.remote.schema.types.find((type) => type.name === 'ServiceInstanceUpdateInput').inputFields.filter((entry) => !['serviceId', 'environmentId'].includes(entry.name));
  assert.equal((await f.provider.deploy(f.input)).status, 'ready');
  const update = f.requests.find((request) => request.body?.query.startsWith('mutation') && request.body.query.includes('serviceInstanceUpdate'));
  assert.deepEqual(update.body.variables, { serviceId: 'service-1', environmentId: 'env-1', input: { numReplicas: 1, healthcheckPath: '/healthz', healthcheckTimeout: 300 } });
});

test('railway partial secrets: resume before source upload while unverified marker gap blocks', async (t) => {
  const f = await fixture(t); await f.seed(); f.remote.variableError = true;
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_COMMAND_FAILED'));
  assert.equal(f.remote.uploads, 0); assert.equal(f.record().phase, 'resources-created');
  f.remote.variableError = false;
  assert.equal((await f.provider.deploy(f.input)).status, 'ready');
  const unmarked = await fixture(t); await unmarked.seed(); delete unmarked.remote.variables.FASTAGENT_OWNERSHIP_MARKER;
  await assert.rejects(unmarked.provider.deploy(unmarked.input), errorCode('RAILWAY_OWNERSHIP_MISMATCH'));
  assert.ok(!unmarked.commands.some((request) => request.intent === 'mutate'));
});

test('railway configuration and schema failures cannot activate chat or return queued ready', async (t) => {
  const f = await fixture(t, { configureResult: false });
  await assert.rejects(f.provider.deploy(f.input), errorCode('RAILWAY_API_FAILED'));
  assert.equal(f.remote.uploads, 0);
  const badUpload = await fixture(t, { uploadId: 'https://credential@bad.invalid' });
  await assert.rejects(badUpload.provider.deploy(badUpload.input), errorCode('RAILWAY_SCHEMA_UNSUPPORTED'));
  assert.equal(badUpload.record().phase, 'secrets-configured');
  badUpload.remote.uploadId = undefined;
  await assert.rejects(badUpload.provider.deploy(badUpload.input), errorCode('RAILWAY_MUTATION_UNCERTAIN'));
  const unhealthy = await fixture(t, { health: { ok: false } });
  await assert.rejects(unhealthy.provider.deploy(unhealthy.input), errorCode('RAILWAY_DEPLOYMENT_TIMEOUT'));
  assert.equal(unhealthy.record().status, 'deploying');
});

test('railway domain binding: reject foreign service, ambiguous domain and drift before reporting ready', async (t) => {
  const foreign = await fixture(t); await foreign.seed();
  foreign.remote.domains = [{ domain: 'agent.up.railway.app', kind: 'service', targetPort: 8080, serviceId: 'foreign-service', environmentId: 'env-1' }];
  await assert.rejects(foreign.provider.deploy(foreign.input), errorCode('RAILWAY_SCHEMA_UNSUPPORTED'));
  assert.equal(foreign.remote.uploads, 0);
  const f = await fixture(t); const record = await f.provider.deploy(f.input);
  f.remote.domains[0].domain = 'other.up.railway.app';
  await assert.rejects(f.provider.status(f.input, record), errorCode('RAILWAY_ORIGIN_MISMATCH'));
  const ambiguous = await fixture(t); await ambiguous.seed();
  ambiguous.remote.domains = ['a', 'b'].map((name) => ({ domain: `${name}.up.railway.app`, kind: 'service', targetPort: 8080, serviceId: 'service-1', environmentId: 'env-1' }));
  await assert.rejects(ambiguous.provider.deploy(ambiguous.input), errorCode('RAILWAY_ORIGIN_MISMATCH'));
});

test('railway target guards and pinned version: no operations on another selector or unexpected version', async (t) => {
  const f = await fixture(t); const record = await f.seed();
  await assert.rejects(f.provider.status({ ...f.input, selector: { ...f.input.selector, target: 'foreign' } }, record), errorCode('RAILWAY_TARGET_MISMATCH'));
  assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0);
  const pinned = createRailwayProvider({ ...f.options, expectedCliVersion: '5.28.2' });
  await assert.rejects(pinned.preflight(f.input, env()), errorCode('RAILWAY_CLI_UNSUPPORTED'));
});

test('railway cancellation while HTTP is in flight propagates to transport and retains safe checkpoint', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(); let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let httpSignal;
  const provider = createRailwayProvider({ ...f.options, http: async (request) => {
    httpSignal = request.signal; resolveStarted(); return new Promise(() => {});
  } });
  const pending = provider.preflight({ ...f.input, signal: controller.signal }, env());
  await started; controller.abort();
  await assert.rejects(pending, errorCode('RAILWAY_CANCELLED'));
  assert.equal(httpSignal.aborted, true); assert.equal(f.record(), undefined);
});

test('railway transport errors never expose even caller-supplied FastagentError details', async (t) => {
  const f = await fixture(t);
  const provider = createRailwayProvider({ ...f.options, http: async () => {
    throw new FastagentError('RAILWAY_HTTP_FAILED', env().REDIS_URL);
  } });
  await assert.rejects(provider.preflight(f.input, env()), (error) => {
    assert.equal(error.code, 'RAILWAY_HTTP_FAILED'); assert.ok(!String(error).includes(env().REDIS_URL)); return true;
  });
});

test('railway deployment state integration: real private lock revisions and exact destruction removal', async (t) => {
  const f = await fixture(t);
  const root = await temporaryDirectory(t);
  const lock = await new DeploymentStore(join(root, 'records')).acquire(f.input.selector);
  try {
    const state = { ...lock, write: async (record) => {
      const written = await lock.write(record); await f.state.write(record); return written;
    } };
    const input = { ...f.input, state, selector: lock.selector };
    const record = await f.provider.deploy(input);
    assert.equal((await lock.read()).revision, record.revision);
    const destroying = await state.write({ ...record, status: 'destroying', phase: 'destroy-pending' });
    const proof = await f.provider.destroy({ ...input, record: destroying, confirmed: true });
    await lock.remove(proof);
    assert.equal(await lock.read(), undefined);
  } finally { await lock.release(); }
});
