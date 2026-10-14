import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCloudRunProvider } from '../dist/deployment/providers/cloudrun.js';
import { createDeploymentRecord, deploymentKey, validateDeploymentRecord, DeploymentStore } from '../dist/deployment/state.js';
import { temporaryDirectory } from './helpers.mjs';

const project = 'fixture-project', region = 'us-central1', service = 'agent';
const number = '123456789012';
const origin = `https://${service}-${number}.${region}.run.app`;
const serviceId = `projects/${project}/locations/${region}/services/${service}`;
const runtime = `runtime@${project}.iam.gserviceaccount.com`, build = `builder@${project}.iam.gserviceaccount.com`;
const keys = ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL'];
const environment = () => ({ FASTAGENT_PASSWORD_HASH: `scrypt-v1$${'a'.repeat(32)}$${'b'.repeat(128)}`,
  OPENAI_API_KEY: 'synthetic-model-credential', REDIS_URL: 'rediss://fixture:synthetic-redis-credential@redis.invalid/0',
  FASTAGENT_SESSION_NAMESPACE: 'cloudrun-test' });
const code = (expected) => (error) => { assert.equal(error.code, expected); assert.ok(!error.message.includes(environment().OPENAI_API_KEY)); return true; };
const help = '--source --service-account --build-service-account --port --max --max-instances --timeout --concurrency --set-env-vars --set-secrets --no-traffic --[no-]allow-unauthenticated --[no-]invoker-iam-check --[no-]deploy-health-check --labels --to-revisions --clear-tags --replication-policy --data-file --member --role --condition --limit';

async function fixture(t, changes = {}, overrides = {}) {
  const root = await temporaryDirectory(t), projectPath = join(root, 'project'), directory = join(root, 'stage');
  await mkdir(projectPath); await mkdir(directory);
  await writeFile(join(directory, 'Dockerfile'), await readFile(new URL('../templates/openai/Dockerfile', import.meta.url)));
  const selector = { provider: 'cloudrun', projectPath, target: 'production' };
  const requests = [], checkpoints = [], events = [], diagnostics = [];
  let current;
  const state = { selector, read: async () => current && structuredClone(current),
    write: async (record) => {
      validateDeploymentRecord(record); assert.equal(record.key, deploymentKey(selector)); assert.equal(record.revision, current?.revision ?? 0);
      current = structuredClone({ ...record, revision: record.revision + 1 }); checkpoints.push(structuredClone(current)); events.push({ checkpoint: structuredClone(current) });
      return structuredClone(current);
    }, remove: async () => {}, release: async () => {} };
  const remote = { service: undefined, secrets: new Map(), uploads: 0, public: false, trafficUpdates: 0, healthCalls: 0, ...changes };
  const value = (a, flag) => a[a.indexOf(flag) + 1];
  const canonical = (id) => id.replace(`projects/${project}/`, `projects/${number}/`);
  const runner = async (request) => {
    requests.push(request); events.push({ request });
    const a = request.args;
    assert.equal(value(a, '--project'), project);
    assert.equal(request.env.CLOUDSDK_CORE_LOG_HTTP, 'false'); assert.equal(request.env.CLOUDSDK_CORE_VERBOSITY, 'error');
    assert.equal(request.secretEnv, undefined); assert.ok(request.maxOutputBytes <= 256 * 1024); assert.ok(request.timeoutMs > 0); assert.ok(request.signal);
    if (a[0] === 'run' && !a.includes('--help')) assert.equal(value(a, '--region'), region);
    if (remote.hangCommand && !a.includes('--help')) return new Promise(() => {});
    if (remote.cancelOnCommand && !a.includes('--help')) remote.cancelOnCommand.abort();
    if (remote.outputLimit) return { stdout: 'x'.repeat(256 * 1024 + 1), stderr: '', exitCode: 0 };
    let output;
    if (a.includes('--help')) return { stdout: remote.help ?? help, stderr: '', exitCode: 0 };
    if (a[0] === 'version') output = { 'Google Cloud SDK': remote.version ?? '550.0.0', bq: '2.1.25', core: '2025.12.12', gsutil: '5.35' };
    else if (a[0] === 'auth') output = remote.accounts ?? [{ account: 'fixture@example.invalid', status: 'ACTIVE' }];
    else if (a[0] === 'projects' && a[1] === 'describe') output = { projectId: project, projectNumber: number, lifecycleState: remote.lifecycle ?? 'ACTIVE' };
    else if (a[0] === 'billing') output = { name: `projects/${project}/billingInfo`, billingAccountName: 'billingAccounts/000000-111111-222222', billingEnabled: remote.billing ?? true };
    else if (a[0] === 'services') output = (remote.apis ?? ['run', 'cloudbuild', 'artifactregistry', 'secretmanager', 'iam']).map((name) => ({ name: `projects/${number}/services/${name}.googleapis.com`, config: { name: `${name}.googleapis.com` }, state: 'ENABLED' }));
    else if (a[0] === 'iam') output = { name: `projects/${project}/serviceAccounts/${a[3]}`, email: a[3], uniqueId: '123456789012345678901', disabled: remote.disabledSA ?? false };
    else if (a[0] === 'projects' && a[1] === 'get-iam-policy') {
      if (remote.policyDenied) throw new Error('permission denied');
      output = { version: 1, bindings: remote.bindings ?? [{ role: 'roles/run.builder', members: [`serviceAccount:${build}`] }] };
    } else if (a[0] === 'meta') { assert.equal(request.cwd, directory); return { stdout: remote.manifest ?? 'Dockerfile\n.gcloudignore\nfastagent.yaml\n', stderr: '', exitCode: 0 }; }
    else if (a[0] === 'secrets' && a[1] === 'list') {
      const name = value(a, '--filter').slice(5);
      output = [...remote.secrets.values()].filter((s) => s.name.endsWith(`/secrets/${name}`)).map(({ name, labels }) => ({ name, labels, replication: { automatic: {} }, createTime: '2026-01-01T00:00:00Z' }));
    } else if (a[0] === 'secrets' && a[1] === 'create') {
      assert.equal(current.status, 'deploying'); assert.equal(current.phase, 'resources-created');
      const name = `projects/${number}/secrets/${a[2]}`;
      assert.ok(current.resources.some((r) => canonical(r.id) === name)); assert.ok(!remote.secrets.has(name));
      const entry = { name, labels: { 'fastagent-owner': value(a, '--labels').split('=')[1] }, versions: [], grants: [] };
      remote.secrets.set(name, entry); output = { name, labels: entry.labels };
      if (remote.createError) { if (remote.createAbsent) remote.secrets.delete(name); throw new Error('uncertain create'); }
    } else if (a[0] === 'secrets' && a[1] === 'versions') {
      const s = remote.secrets.get(canonical(a[3])); assert.ok(s);
      if (a[2] === 'list') output = s.versions;
      else {
        assert.equal(a[2], 'add'); assert.ok(a.includes('--data-file=-')); assert.equal(current.status, 'deploying');
        assert.ok(keys.some((key) => environment()[key] === request.stdin));
        const name = `${s.name}/versions/${s.versions.length + 1}`;
        output = { name, state: 'ENABLED', createTime: '2026-01-01T00:00:00Z', replicationStatus: { automatic: {} } };
        s.versions.push(output);
        if (remote.versionError) throw new Error(environment().OPENAI_API_KEY);
      }
    } else if (a[0] === 'secrets' && a[1] === 'add-iam-policy-binding') {
      assert.equal(value(a, '--member'), `serviceAccount:${runtime}`); assert.ok(a.includes('--role=roles/secretmanager.secretAccessor'));
      const s = remote.secrets.get(canonical(a[2])); assert.ok(s); assert.equal(s.labels['fastagent-owner'], current.ownershipMarker);
      assert.ok(current.resources.some((r) => canonical(r.id).startsWith(`${s.name}/versions/`)));
      s.grants.push(runtime); output = { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${runtime}`] }] };
      if (remote.secretIAMError) throw new Error('IAM denied');
    } else if (a[0] === 'secrets' && a[1] === 'delete') {
      assert.equal(request.intent, 'destroy'); assert.equal(request.authorization, 'destruction');
      if (!remote.retainDeleted) remote.secrets.delete(canonical(a[2])); output = {};
      if (remote.deleteSecretError) throw new Error('uncertain delete');
    } else if (a[0] === 'run' && a[1] === 'deploy') {
      remote.uploads++; assert.equal(current.phase, 'secrets-configured'); assert.equal(current.status, 'deploying');
      assert.equal(value(a, '--source'), directory); assert.equal(value(a, '--service-account'), runtime);
      assert.equal(value(a, '--build-service-account'), `projects/${project}/serviceAccounts/${build}`);
      if (!remote.service || a.includes('--no-allow-unauthenticated')) { assert.ok(a.includes('--no-allow-unauthenticated')); remote.public = false; }
      else assert.ok(a.includes('--no-traffic'));
      const revision = `agent-0000${remote.uploads}-abc`, generation = remote.uploads;
      const env = value(a, '--set-env-vars').split(',').map((v) => { const index = v.indexOf('='); return { name: v.slice(0, index), value: v.slice(index + 1) }; });
      env.push(...value(a, '--set-secrets').split(',').map((v) => { const [name, ref] = v.split('='); const [secret, version] = ref.split(':'); return { name, valueFrom: { secretKeyRef: { name: secret, key: version } } }; }));
      remote.service = { apiVersion: 'serving.knative.dev/v1', kind: 'Service', metadata: { name: service, namespace: number, generation,
        labels: { 'fastagent-owner': current.ownershipMarker }, annotations: { 'run.googleapis.com/maxScale': '1' } },
        spec: { template: { metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '1' } }, spec: { serviceAccountName: runtime,
          containerConcurrency: 20, timeoutSeconds: 300, containers: [{ image: 'us-central1-docker.pkg.dev/fixture-project/cloud-run-source-deploy/agent@sha256:fixture', ports: [{ containerPort: 8080 }], env }] } } },
        status: { observedGeneration: remote.unobserved ? generation - 1 : generation, conditions: [{ type: 'Ready', status: remote.ready ?? 'True' }],
          latestCreatedRevisionName: revision, latestReadyRevisionName: remote.wrongRevision ? 'agent-unrelated' : revision,
          url: remote.url ?? origin, traffic: remote.service?.status.traffic ?? [{ revisionName: revision, percent: 100 }] } };
      if (remote.localDev) remote.service.spec.template.spec.containers[0].env.push({ name: 'FASTAGENT_LOCAL_DEV', value: '1' });
      if (remote.literalSecret) remote.service.spec.template.spec.containers[0].env.find((e) => e.name === 'REDIS_URL').value = environment().REDIS_URL;
      if (remote.unsafeCap) remote.service.metadata.annotations['run.googleapis.com/maxScale'] = '2';
      if (remote.originDrift) remote.service.spec.template.spec.containers[0].env.find((e) => e.name === 'APP_ORIGIN').value = 'https://wrong.invalid';
      output = remote.service;
      if (remote.uploadError) { if (remote.uploadAbsent) remote.service = undefined; throw new Error('uncertain deploy'); }
    } else if (a[0] === 'run' && a[1] === 'services') {
      if (a[2] === 'list') output = remote.service ? [remote.service] : [];
      else if (a[2] === 'describe') {
        output = structuredClone(remote.service);
        if (remote.unrelatedRevision) output.status.latestCreatedRevisionName = output.status.latestReadyRevisionName = 'agent-unrelated';
      }
      else if (a[2] === 'update-traffic') {
        remote.trafficUpdates++; const revision = value(a, '--to-revisions').split('=')[0]; assert.ok(a.includes('--clear-tags'));
        assert.equal(remote.service.status.conditions[0].status, 'True');
        remote.service.status.traffic = remote.traffic ?? [{ revisionName: revision, percent: 100 }]; output = remote.service;
      } else if (a[2] === 'add-iam-policy-binding') {
        assert.ok(a.includes('--member=allUsers')); assert.ok(a.includes('--role=roles/run.invoker'));
        if (remote.publicDenied) throw new Error('organization policy');
        remote.public = true; output = { version: 1, bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] };
      } else if (a[2] === 'logs') output = remote.logs ?? [{ timestamp: '2026-01-01T00:00:00Z', severity: 'INFO', textPayload: `${environment().OPENAI_API_KEY} unknown-historical-secret`, resource: { type: 'cloud_run_revision' } }];
      else if (a[2] === 'delete') { assert.equal(request.authorization, 'destruction'); if (!remote.retainDeleted) remote.service = undefined; output = {}; }
      else throw new Error(`unsupported ${a.join(' ')}`);
    } else throw new Error(`unsupported ${a.join(' ')}`);
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 };
  };
  const health = async (request) => {
    remote.healthCalls++; assert.ok(remote.public); assert.equal(request.url, `${current.url}/healthz`); assert.equal(request.maxResponseBytes, 4096);
    if (remote.healthHang) return new Promise(() => {});
    if (remote.healthCancel) remote.healthCancel.abort();
    return { status: 200, body: remote.healthBody ?? { ok: true } };
  };
  const options = { project, region, service, runtimeServiceAccount: runtime, buildServiceAccount: build, commandEnv: { PATH: '/synthetic/bin', HOME: '/synthetic/home' },
    health, pollIntervalMs: 1, requestTimeoutMs: 100, deploymentTimeoutMs: 1000, onDiagnostic: (message) => diagnostics.push(message), ...overrides };
  const input = { selector, state, runner, environment: environment(), source: { directory, config: { schemaVersion: 1, name: 'agent', framework: 'openai', model: 'openai/gpt-4o-mini', deployment: { access: 'protected' } }, files: ['Dockerfile', '.gcloudignore', 'fastagent.yaml'], bytes: 0, cleanup: async () => {} } };
  return { provider: createCloudRunProvider(options), options, input, state, remote, requests, checkpoints, events, diagnostics,
    record: () => structuredClone(current), replace: async (record) => state.write(record), markDestroying: async () => state.write({ ...current, status: 'destroying', phase: 'destroy-pending' }) };
}

test('cloudrun preflight: parsed gcloud capabilities, explicit identities, project billing APIs; no mutation', async (t) => {
  const f = await fixture(t); await f.provider.preflight(f.input, environment());
  assert.ok(f.requests.every((r) => r.intent === 'read')); assert.ok(f.diagnostics.some((m) => m.includes('do not certify')));
  for (const bad of [{ REDIS_URL: 'redis://redis.invalid' }, { FASTAGENT_LOCAL_DEV: '1' }, { OPENAI_API_KEY: '' }]) await assert.rejects(f.provider.preflight(f.input, { ...environment(), ...bad }), code('DEPLOYMENT_ENV_INVALID'));
  for (const [change, expected] of [[{ help: '--source' }, 'CLOUDRUN_CLI_UNSUPPORTED'], [{ version: 'unsupported' }, 'CLOUDRUN_CLI_UNSUPPORTED'],
    [{ billing: false }, 'CLOUDRUN_BILLING_REQUIRED'], [{ apis: ['run'] }, 'CLOUDRUN_APIS_REQUIRED'], [{ accounts: [] }, 'CLOUDRUN_AUTH_REQUIRED'],
    [{ disabledSA: true }, 'CLOUDRUN_IDENTITY_REQUIRED'], [{ lifecycle: 'DELETE_REQUESTED' }, 'CLOUDRUN_PROJECT_INVALID']]) {
    const g = await fixture(t, change); await assert.rejects(g.provider.deploy(g.input), code(expected)); assert.ok(g.requests.every((r) => r.intent === 'read'));
  }
  assert.throws(() => createCloudRunProvider({ ...f.options, buildServiceAccount: runtime }), code('CLOUDRUN_OPTIONS_INVALID'));
  assert.throws(() => createCloudRunProvider({ ...f.options, commandEnv: { CLOUDSDK_AUTH_ACCESS_TOKEN: 'synthetic' } }), code('CLOUDRUN_OPTIONS_INVALID'));
  assert.throws(() => createCloudRunProvider({ ...f.options, requestTimeoutMs: 0 }), code('CLOUDRUN_OPTIONS_INVALID'));
});

test('cloudrun IAM diagnostics tolerate unreadable/inherited policy, block known dangerous build role, never grant project roles', async (t) => {
  const f = await fixture(t, { policyDenied: true }); await f.provider.preflight(f.input, environment()); assert.ok(f.diagnostics.some((m) => m.includes('unavailable')));
  const g = await fixture(t, { bindings: [{ role: 'roles/editor', members: [`serviceAccount:${build}`] }] });
  await assert.rejects(g.provider.deploy(g.input), code('CLOUDRUN_BUILD_SECRET_ACCESS')); assert.ok(g.requests.every((r) => r.intent === 'read'));
});

test('cloudrun fresh deploy: predictable protected private origin, owned metadata/version checkpoints, stdin-only secrets, readiness then public', async (t) => {
  const f = await fixture(t); const record = await f.provider.deploy(f.input);
  assert.equal(record.status, 'ready'); assert.equal(record.phase, 'healthy'); assert.equal(record.url, origin); assert.equal(record.sessionNamespace, 'cloudrun-test');
  assert.equal(record.resources.filter((r) => r.kind === 'secret').length, 6); assert.equal(f.remote.uploads, 1); assert.equal(f.remote.public, true);
  const deploy = f.requests.find((r) => r.args[0] === 'run' && r.args[1] === 'deploy' && !r.args.includes('--help'));
  for (const arg of ['--port=8080', '--max=1', '--max-instances=1', '--timeout=300', '--concurrency=20', '--no-allow-unauthenticated']) assert.ok(deploy.args.includes(arg));
  for (const r of f.requests) {
    for (const key of keys) assert.ok(!r.args.join(' ').includes(environment()[key]));
    assert.ok(!r.args.some((a) => a.includes('FASTAGENT_LOCAL_DEV') || a.includes('--log-http')));
    if (r.args[0] === 'secrets' && r.args[1] === 'versions' && r.args[2] === 'add' && !r.args.includes('--help')) assert.ok(keys.some((key) => environment()[key] === r.stdin));
  }
  for (const key of keys) assert.ok(!JSON.stringify(f.checkpoints).includes(environment()[key]));
  assert.equal(f.requests.filter((r) => r.stdin).length, 3);
  const traffic = f.events.findIndex((e) => e.request?.args[2] === 'update-traffic' && !e.request.args.includes('--help'));
  const publicIndex = f.events.findIndex((e) => e.request?.args.includes('--member=allUsers'));
  assert.ok(traffic < publicIndex); assert.ok(f.checkpoints.some((c) => c.phase === 'source-uploaded' && c.status === 'deploying'));
  assert.deepEqual(await f.provider.status(f.input, record), { status: 'ready', url: origin });
});

test('cloudrun prewritten prepared revision acquires origin without changing ownership or namespace', async (t) => {
  const f = await fixture(t);
  const initial = await f.state.write({ ...createDeploymentRecord(f.input.selector),
    sessionNamespace: environment().FASTAGENT_SESSION_NAMESPACE, selectors: { project, region },
    resources: [{ kind: 'project', id: project, ownership: 'external' }] });
  assert.equal(initial.revision, 1); assert.equal(initial.url, undefined);
  const result = await f.provider.deploy(f.input);
  assert.equal(result.status, 'ready'); assert.equal(result.url, origin);
  assert.equal(result.ownershipMarker, initial.ownershipMarker);
  assert.equal(result.sessionNamespace, initial.sessionNamespace);
  assert.equal(f.checkpoints[1].url, origin);
});

test('cloudrun update: same service/secrets/namespace, new pinned versions, no-traffic then explicit 100% clear tags', async (t) => {
  const f = await fixture(t); const first = await f.provider.deploy(f.input); const offset = f.requests.length;
  f.remote.service.status.traffic = [{ revisionName: 'agent-00001-abc', percent: 20, tag: 'old' }, { revisionName: 'agent-older', percent: 80 }];
  const second = await f.provider.deploy(f.input);
  assert.equal(second.ownershipMarker, first.ownershipMarker); assert.equal(second.sessionNamespace, first.sessionNamespace);
  assert.equal(second.resources.filter((r) => r.kind === 'secret').length, 6);
  assert.ok(second.resources.filter((r) => r.id.includes('/versions/')).every((r) => r.id.endsWith('/2')));
  const commands = f.requests.slice(offset).filter((r) => !r.args.includes('--help'));
  assert.equal(commands.filter((r) => r.args[1] === 'create').length, 0);
  assert.ok(commands.find((r) => r.args[1] === 'deploy').args.includes('--no-traffic'));
  assert.deepEqual(f.remote.service.status.traffic, [{ revisionName: 'agent-00002-abc', percent: 100 }]);
});

test('cloudrun legacy hash URL: one private protected reconciliation before public, no guessed annotation schema', async (t) => {
  const legacy = 'https://agent-fixturehash-uc.a.run.app';
  const f = await fixture(t, { url: legacy }); const result = await f.provider.deploy(f.input);
  assert.equal(result.url, legacy); assert.equal(f.remote.uploads, 2);
  const deploys = f.requests.filter((r) => r.args[1] === 'deploy' && !r.args.includes('--help'));
  assert.ok(deploys.every((r) => r.args.includes('--no-allow-unauthenticated')));
  assert.ok(deploys[0].args.includes(`APP_ORIGIN=${origin},FASTAGENT_SESSION_NAMESPACE=cloudrun-test`));
  assert.ok(deploys[1].args.includes(`APP_ORIGIN=${legacy},FASTAGENT_SESSION_NAMESPACE=cloudrun-test`));
  assert.equal(f.requests.filter((r) => r.stdin).length, 3);
});

test('cloudrun origin/upload/remote config fail closed before public invoker', async (t) => {
  for (const [changes, expected] of [[{ url: 'https://attacker.invalid' }, 'CLOUDRUN_ORIGIN_MISMATCH'],
    [{ originDrift: true }, 'CLOUDRUN_CONFIG_MISMATCH'], [{ localDev: true }, 'CLOUDRUN_UNSAFE_REMOTE_ENV'],
    [{ literalSecret: true }, 'CLOUDRUN_UNSAFE_REMOTE_ENV'], [{ unsafeCap: true }, 'CLOUDRUN_CONFIG_MISMATCH'],
    [{ unrelatedRevision: true }, 'CLOUDRUN_REVISION_MISMATCH'],
    [{ manifest: 'Dockerfile\n.env\n' }, 'CLOUDRUN_UPLOAD_UNSAFE']]) {
    const f = await fixture(t, changes); await assert.rejects(f.provider.deploy(f.input), code(expected)); assert.equal(f.remote.public, false); assert.equal(f.remote.healthCalls, 0);
  }
  const f = await fixture(t); await assert.rejects(f.provider.deploy({ ...f.input, environment: { ...environment(), APP_ORIGIN: 'https://different.invalid' } }), code('CLOUDRUN_ORIGIN_MISMATCH'));
  assert.equal(f.requests.filter((r) => r.intent === 'mutate').length, 0);
  const g = await fixture(t, { url: 'https://agent-fixturehash-uc.a.run.app' });
  await assert.rejects(g.provider.deploy({ ...g.input, environment: { ...environment(), APP_ORIGIN: origin } }), code('CLOUDRUN_ORIGIN_MISMATCH')); assert.equal(g.remote.public, false);
});

test('cloudrun Ready False / stale observed generation / different ready revision / tagged traffic are never ready or made public', async (t) => {
  for (const [changes, expected] of [[{ ready: 'False' }, 'CLOUDRUN_NOT_READY'], [{ unobserved: true }, 'CLOUDRUN_DEPLOYMENT_TIMEOUT'],
    [{ wrongRevision: true }, 'CLOUDRUN_DEPLOYMENT_TIMEOUT'], [{ traffic: [{ revisionName: 'agent-00001-abc', percent: 100, tag: 'preview' }] }, 'CLOUDRUN_TRAFFIC_UNSAFE']]) {
    const f = await fixture(t, changes, { deploymentTimeoutMs: 100 });
    await assert.rejects(f.provider.deploy(f.input), code(expected)); assert.equal(f.remote.public, false); assert.equal(f.record().phase, 'source-uploaded');
  }
});

test('cloudrun first-version uncertain outcome recovers single ENABLED version without append; metadata absent/multiple versions fail closed', async (t) => {
  const f = await fixture(t, { versionError: true }); await assert.rejects(f.provider.deploy(f.input), code('CLOUDRUN_COMMAND_FAILED'));
  assert.equal(f.record().phase, 'resources-created'); assert.equal(f.record().status, 'deploying');
  f.remote.versionError = false; const record = await f.provider.deploy(f.input); assert.equal(record.status, 'ready');
  assert.equal(f.requests.filter((r) => r.stdin).length, 3);
  const g = await fixture(t, { createError: true, createAbsent: true }); await assert.rejects(g.provider.deploy(g.input), code('CLOUDRUN_COMMAND_FAILED'));
  g.remote.createError = false; await assert.rejects(g.provider.deploy(g.input), code('CLOUDRUN_MUTATION_UNCERTAIN'));
  const h = await fixture(t, { versionError: true }); await assert.rejects(h.provider.deploy(h.input), code('CLOUDRUN_COMMAND_FAILED'));
  const secret = [...h.remote.secrets.values()][0]; secret.versions.push({ name: `${secret.name}/versions/2`, state: 'ENABLED' }); h.remote.versionError = false;
  await assert.rejects(h.provider.deploy(h.input), code('CLOUDRUN_MUTATION_UNCERTAIN'));
});

test('cloudrun uncertain update version-add refuses blind append; previous protected revision unaffected', async (t) => {
  const f = await fixture(t); await f.provider.deploy(f.input); f.remote.versionError = true;
  await assert.rejects(f.provider.deploy(f.input), code('CLOUDRUN_COMMAND_FAILED')); const count = f.requests.filter((r) => r.stdin).length;
  f.remote.versionError = false; await assert.rejects(f.provider.deploy(f.input), code('CLOUDRUN_MUTATION_UNCERTAIN'));
  assert.equal(f.requests.filter((r) => r.stdin).length, count); assert.equal(f.remote.uploads, 1); assert.equal(f.remote.public, true);
});

test('cloudrun uncertain source outcome reconciles verified revision; absent outcome refuses recreate', async (t) => {
  const f = await fixture(t, { uploadError: true }); await assert.rejects(f.provider.deploy(f.input), code('CLOUDRUN_COMMAND_FAILED'));
  assert.equal(f.record().phase, 'secrets-configured'); f.remote.uploadError = false;
  const result = await f.provider.deploy(f.input); assert.equal(result.status, 'ready'); assert.equal(f.remote.uploads, 1);
  const g = await fixture(t, { uploadError: true, uploadAbsent: true }); await assert.rejects(g.provider.deploy(g.input), code('CLOUDRUN_COMMAND_FAILED'));
  g.remote.uploadError = false; await assert.rejects(g.provider.deploy(g.input), code('CLOUDRUN_MUTATION_UNCERTAIN')); assert.equal(g.remote.uploads, 1);
});

test('cloudrun organization-policy failure retains checkpoint; retry uses same source/secrets then health', async (t) => {
  const f = await fixture(t, { publicDenied: true }); await assert.rejects(f.provider.deploy(f.input), code('CLOUDRUN_COMMAND_FAILED'));
  assert.equal(f.record().phase, 'source-uploaded'); assert.equal(f.record().status, 'deploying'); assert.equal(f.remote.public, false);
  f.remote.publicDenied = false; const result = await f.provider.deploy(f.input); assert.equal(result.status, 'ready');
  assert.equal(f.remote.uploads, 1); assert.equal(f.requests.filter((r) => r.stdin).length, 3);
});

test('cloudrun status/logs: bounded metadata-only logs cannot leak unknown historical or literal config secrets', async (t) => {
  const f = await fixture(t); const record = await f.provider.deploy(f.input);
  const logs = await createCloudRunProvider(f.options).logs(f.input, record);
  assert.match(logs, /2026-01-01/); assert.match(logs, /INFO/); assert.match(logs, /withheld/);
  assert.ok(!logs.includes(environment().OPENAI_API_KEY)); assert.ok(!logs.includes('unknown-historical-secret'));
  f.remote.logs = [{ timestamp: '2026-01-01T00:00:00Z', severity: 'ERROR', jsonPayload: { error: 'different-unknown-secret' }, labels: { secret: 'different-unknown-secret' } }];
  assert.ok(!(await createCloudRunProvider(f.options).logs(f.input, record)).includes('different-unknown-secret'));
  f.remote.service.spec.template.spec.containers[0].env.find((e) => e.name === 'OPENAI_API_KEY').value = 'unknown-historical-secret';
  await assert.rejects(f.provider.status(f.input, record), code('CLOUDRUN_UNSAFE_REMOTE_ENV'));
  f.remote.service = undefined; assert.deepEqual(await f.provider.status(f.input, record), { status: 'missing' });
});

test('cloudrun destruction: confirmation + fail-closed local type + ALL remote ownership before deletion; exact core proof, retained shared artifacts', async (t) => {
  const f = await fixture(t); await f.provider.deploy(f.input); const record = await f.markDestroying(); const offset = f.requests.length;
  await assert.rejects(f.provider.destroy({ ...f.input, record, confirmed: false }), code('CLOUDRUN_DESTRUCTION_UNAUTHORIZED'));
  await assert.rejects(f.provider.destroy({ ...f.input, record: { ...record, resources: [...record.resources, { kind: 'registry', id: 'shared', ownership: 'owned' }] }, confirmed: true }), code('CLOUDRUN_TARGET_MISMATCH'));
  f.remote.secrets.values().next().value.labels['fastagent-owner'] = 'f'.repeat(32);
  await assert.rejects(f.provider.destroy({ ...f.input, record, confirmed: true }), code('CLOUDRUN_OWNERSHIP_MISMATCH'));
  assert.equal(f.requests.slice(offset).filter((r) => r.intent === 'destroy').length, 0);
  f.remote.secrets.values().next().value.labels['fastagent-owner'] = record.ownershipMarker;
  f.remote.service.metadata.labels['fastagent-owner'] = 'f'.repeat(32);
  await assert.rejects(f.provider.destroy({ ...f.input, record, confirmed: true }), code('CLOUDRUN_OWNERSHIP_MISMATCH'));
  f.remote.service.metadata.labels['fastagent-owner'] = record.ownershipMarker;
  const proof = await f.provider.destroy({ ...f.input, record, confirmed: true });
  assert.deepEqual([...proof.resourceIdentities].sort(), record.resources.filter((r) => r.ownership === 'owned').map((r) => `${r.kind}:${r.id}`).sort());
  assert.equal(proof.ownershipMarker, record.ownershipMarker); assert.equal(proof.verified, true); assert.equal(proof.succeeded, true);
  assert.equal(f.requests.filter((r) => r.intent === 'destroy').length, 4); assert.ok(f.diagnostics.some((m) => m.includes('Artifact Registry')));
  const store = new DeploymentStore(join(f.input.selector.projectPath, '.state')); const lock = await store.acquire(f.input.selector);
  try { const persisted = await lock.write({ ...record, revision: 0 }); assert.equal(persisted.status, 'destroying'); await lock.remove(proof); assert.equal(await lock.read(), undefined); }
  finally { await lock.release(); }
});

test('cloudrun destruction failures return no proof; partial deletion safely retried without deleting shared project/identity', async (t) => {
  const f = await fixture(t); await f.provider.deploy(f.input); const record = await f.markDestroying(); f.remote.deleteSecretError = true;
  await assert.rejects(f.provider.destroy({ ...f.input, record, confirmed: true }), code('CLOUDRUN_COMMAND_FAILED'));
  f.remote.deleteSecretError = false; const proof = await f.provider.destroy({ ...f.input, record, confirmed: true }); assert.equal(proof.succeeded, true);
  assert.ok(f.requests.filter((r) => r.intent === 'destroy').every((r) => r.args[0] === 'run' || r.args[0] === 'secrets'));
  const g = await fixture(t); await g.provider.deploy(g.input); const next = await g.markDestroying(); g.remote.retainDeleted = true;
  await assert.rejects(g.provider.destroy({ ...g.input, record: next, confirmed: true }), code('CLOUDRUN_DESTRUCTION_FAILED'));
});

test('cloudrun cancellation, injected hung command/health, deadline and oversized stdout/health fail bounded and sanitized', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.provider.deploy({ ...f.input, signal: controller.signal }), code('CLOUDRUN_CANCELLED')); assert.equal(f.requests.length, 0);
  const g = await fixture(t, { hangCommand: true }, { requestTimeoutMs: 5 }); await assert.rejects(g.provider.preflight(g.input, environment()), code('CLOUDRUN_TIMEOUT'));
  const h = await fixture(t, { outputLimit: true }); await assert.rejects(h.provider.preflight(h.input, environment()), code('CLOUDRUN_OUTPUT_LIMIT'));
  const i = await fixture(t, { healthHang: true }, { requestTimeoutMs: 5 }); await assert.rejects(i.provider.deploy(i.input), code('CLOUDRUN_TIMEOUT')); assert.equal(i.record().status, 'deploying');
  const j = await fixture(t, { healthBody: { ok: true, huge: 'x'.repeat(4097) } }); await assert.rejects(j.provider.deploy(j.input), code('CLOUDRUN_OUTPUT_LIMIT'));
  const k = await fixture(t); const cancel = new AbortController(); k.remote.healthCancel = cancel;
  await assert.rejects(k.provider.deploy({ ...k.input, signal: cancel.signal }), code('CLOUDRUN_CANCELLED'));
  const l = await fixture(t, { healthHang: true }, { requestTimeoutMs: 1000, deploymentTimeoutMs: 50 });
  await assert.rejects(l.provider.deploy(l.input), code('CLOUDRUN_DEPLOYMENT_TIMEOUT')); assert.notEqual(l.record()?.status, 'ready');
});

test('cloudrun local/remote target mismatch and edited source cause no mutation; remote origin/namespace drift blocks update', async (t) => {
  const f = await fixture(t); const record = await f.provider.deploy(f.input); const offset = f.requests.length;
  await assert.rejects(f.provider.deploy({ ...f.input, environment: { ...environment(), FASTAGENT_SESSION_NAMESPACE: 'other' } }), code('CLOUDRUN_TARGET_MISMATCH'));
  await assert.rejects(f.provider.status(f.input, { ...record, resources: record.resources.map((r) => r.kind === 'service' ? { ...r, id: 'projects/other-project/locations/us-central1/services/agent' } : r) }), code('CLOUDRUN_TARGET_MISMATCH'));
  f.remote.service.status.url = 'https://unexpected.run.app';
  await assert.rejects(f.provider.deploy(f.input), code('CLOUDRUN_ORIGIN_MISMATCH')); assert.equal(f.requests.slice(offset).filter((r) => r.intent !== 'read').length, 0);
  const g = await fixture(t); await writeFile(join(g.input.source.directory, 'Dockerfile'), 'FROM scratch');
  await assert.rejects(g.provider.deploy(g.input), code('CLOUDRUN_SOURCE_UNSUPPORTED')); assert.equal(g.requests.length, 0);
  const h = await fixture(t); h.remote.service = structuredClone(f.remote.service);
  await assert.rejects(h.provider.deploy(h.input), code('CLOUDRUN_OWNERSHIP_MISMATCH')); assert.ok(h.requests.every((r) => r.intent === 'read'));
});
