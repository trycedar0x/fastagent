import { readFile } from 'node:fs/promises';
import { FastagentError } from '../../errors.js';
import { createDeploymentRecord, deploymentKey, validateDeploymentRecord, type DeploymentRecord } from '../state.js';
import { validateCloudEnvironment, validateHttpsOrigin, validatePreflightEnvironment,
  type DeploymentProvider, type DeployInput, type ProviderContext, type PreflightEnvironment } from '../types.js';

const keys = ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL'] as const;
const ownerLabel = 'fastagent-owner';
const fail = (code: string) => new FastagentError(code,
  'Cloud Run operation could not be verified. Check gcloud permissions/prerequisites and the recorded resource IDs before retrying; uncertain mutations are not automatically recreated.');
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
  return value;
};
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED'); } };
const text = (value: unknown): string => { if (typeof value !== 'string') throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED'); return value; };

/** Transport must refuse redirects and bound bytes while receiving; never log responses.
 * Only GET /healthz is used. It must not call a model or load credentials. */
export type CloudRunHealthTransport = (request: {
  url: string; signal: AbortSignal; maxResponseBytes: number;
}) => Promise<{ status: number; body: unknown }>;
export interface CloudRunOptions {
  project: string;
  region: string;
  service: string;
  runtimeServiceAccount: string;
  buildServiceAccount: string;
  /** Explicit user gcloud auth/config environment (PATH, HOME, CLOUDSDK_CONFIG etc.).
   * No ambient inheritance, auth tokens, HTTP tracing or application secrets. */
  commandEnv: Readonly<Record<string, string>>;
  health: CloudRunHealthTransport;
  executable?: string;
  expectedCliVersion?: string;
  pollIntervalMs?: number;
  deploymentTimeoutMs?: number;
  requestTimeoutMs?: number;
  logLines?: number;
  /** Nonsecret prerequisite diagnostics; not a certification of effective IAM access. */
  onDiagnostic?: (message: string) => void;
}

/** Source/package scripts are trusted code, NOT a sandbox. Separate existing build/runtime
 * identities are mandatory; direct policy diagnostics cannot certify inherited/custom-role
 * secret isolation. Never grant the build identity app-secret access. max=1 is a cost default,
 * not a singleton guarantee. Secret versions/images/builds remain until separately cleaned up.
 * CLI contracts: https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy
 * Predictable origin: https://docs.cloud.google.com/run/docs/triggering/https-request */
export function createCloudRunProvider(options: CloudRunOptions): DeploymentProvider {
  const sa = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project) || !/^[a-z]+-[a-z]+\d$/.test(options.region) ||
      !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(options.service) || options.service.length > 49 ||
      !sa.test(options.runtimeServiceAccount) || !sa.test(options.buildServiceAccount) ||
      options.runtimeServiceAccount === options.buildServiceAccount || !options.commandEnv || typeof options.health !== 'function' ||
      Object.entries(options.commandEnv).some(([key, value]) => !['PATH', 'HOME', 'CLOUDSDK_CONFIG', 'CLOUDSDK_ACTIVE_CONFIG_NAME', 'TMPDIR'].includes(key) ||
        typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value))) throw fail('CLOUDRUN_OPTIONS_INVALID');
  const interval = options.pollIntervalMs ?? 2000, deadline = options.deploymentTimeoutMs ?? 900_000;
  const requestTimeout = options.requestTimeoutMs ?? 30_000, logLines = options.logLines ?? 100;
  if (![interval, deadline, requestTimeout, logLines].every(Number.isSafeInteger) || interval < 1 || interval > 60_000 ||
      deadline < 1 || deadline > 3_600_000 || requestTimeout < 1 || requestTimeout > 120_000 || logLines < 1 || logLines > 500) throw fail('CLOUDRUN_OPTIONS_INVALID');
  const projectArgs = ['--project', options.project];
  const buildAccountProject = options.buildServiceAccount.split('@')[1]!.split('.iam.')[0]!;
  const buildAccountId = `projects/${buildAccountProject}/serviceAccounts/${options.buildServiceAccount}`;
  const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw fail('CLOUDRUN_CANCELLED'); };
  const diagnostic = (message: string) => { options.onDiagnostic?.(message); };
  let projectNumber: string | undefined;
  function canonicalSecretName(name: string) {
    const prefix = `projects/${projectNumber}/secrets/`;
    if (projectNumber && name.startsWith(prefix)) return `projects/${options.project}/secrets/${name.slice(prefix.length)}`;
    if (name.startsWith(`projects/${options.project}/secrets/`)) return name;
    throw fail('CLOUDRUN_TARGET_MISMATCH');
  }
  async function projectMetadata(context: ProviderContext) {
    const project = obj(parse(await command(context, ['projects', 'describe', options.project, '--format=json'])));
    const number = text(project.projectNumber);
    if (project.projectId !== options.project || project.lifecycleState !== 'ACTIVE' || !/^[1-9]\d{5,19}$/.test(number)) throw fail('CLOUDRUN_PROJECT_INVALID');
    projectNumber = number;
    return number;
  }
  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeout = requestTimeout,
    timeoutCode = 'CLOUDRUN_TIMEOUT'): Promise<T> {
    cancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(fail(signal?.aborted ? 'CLOUDRUN_CANCELLED' : timeoutCode)), { once: true });
        timer = setTimeout(abort, timeout);
        if (signal?.aborted) abort();
      }), operation(controller.signal)]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function command(context: ProviderContext, args: string[], intent: 'read' | 'mutate' | 'destroy' = 'read', stdin?: string,
    cwd = context.selector.projectPath, timeout = requestTimeout): Promise<string> {
    try {
      const output = await bounded(async (signal) => {
        const result = await context.runner({ executable: options.executable ?? 'gcloud', args: [...args, ...projectArgs], cwd,
          env: { ...options.commandEnv, CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_VERBOSITY: 'error', CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }, intent, ...(intent !== 'read' ? { authorization: intent === 'destroy' ? 'destruction' as const : 'mutation' as const } : {}),
          ...(stdin !== undefined ? { stdin } : {}), signal, timeoutMs: timeout, maxOutputBytes: 256 * 1024 });
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 256 * 1024) throw fail('CLOUDRUN_OUTPUT_LIMIT');
        // Raw JSON is private to the adapter. Pre-parse redaction can corrupt identities when
        // a Redis username overlaps a project name; no raw output is returned or logged.
        return result.stdout;
      }, context.signal, timeout);
      cancelled(context.signal);
      return output;
    } catch (error) {
      if (error instanceof FastagentError && ['CLOUDRUN_CANCELLED', 'CLOUDRUN_TIMEOUT', 'CLOUDRUN_OUTPUT_LIMIT'].includes(error.code)) throw fail(error.code);
      throw fail(context.signal?.aborted ? 'CLOUDRUN_CANCELLED' : 'CLOUDRUN_COMMAND_FAILED');
    }
  }
  const run = (args: string[]) => ['run', 'services', ...args, '--region', options.region];
  const serviceId = `projects/${options.project}/locations/${options.region}/services/${options.service}`;
  // Metadata and its current pinned version are separate owned secret identities in core state.
  // Older versions remain until destroy deletes the parent once and proves absence for both.
  const secretId = (record: DeploymentRecord, key: typeof keys[number]) =>
    `projects/${options.project}/secrets/fa-${record.ownershipMarker}-${key.toLowerCase().replaceAll('_', '-')}`;
  const metadataSecrets = (record: DeploymentRecord) => record.resources.filter((r) => r.kind === 'secret' && !r.id.includes('/versions/'));
  function version(record: DeploymentRecord, key: typeof keys[number]) {
    const prefix = `${secretId(record, key)}/versions/`;
    const found = record.resources.filter((r) => r.kind === 'secret' && r.id.startsWith(prefix));
    if (found.length !== 1 || !/^[1-9]\d*$/.test(found[0]!.id.slice(prefix.length))) throw fail('CLOUDRUN_PARTIAL_TARGET');
    return found[0]!.id.slice(prefix.length);
  }
  function recordFor(context: ProviderContext, value: DeploymentRecord) {
    const record = validateDeploymentRecord(value);
    if (context.selector.provider !== 'cloudrun' || record.provider !== 'cloudrun' || record.key !== deploymentKey(context.selector) ||
        record.selectors.project !== options.project || record.selectors.region !== options.region ||
        record.resources.some((r) => {
          if (r.kind === 'project') return r.id !== options.project || r.ownership !== 'external';
          if (r.kind === 'service') return r.id !== serviceId || r.ownership !== 'owned';
          if (r.kind === 'secret') return r.ownership !== 'owned' || !keys.some((key) => r.id === secretId(record, key) ||
            new RegExp(`^${secretId(record, key)}/versions/[1-9]\\d*$`).test(r.id));
          if (r.kind === 'revision') return r.ownership !== 'external' || !new RegExp(`^${options.service}-[a-z0-9-]+$`).test(r.id);
          return true;
        }) || record.resources.filter((r) => r.kind === 'revision').length > 1 || record.resources.filter((r) => r.kind === 'service').length > 1 ||
        keys.some((key) => record.resources.filter((r) => r.id.startsWith(`${secretId(record, key)}/versions/`)).length > 1)) throw fail('CLOUDRUN_TARGET_MISMATCH');
    return record;
  }
  async function cliReady(context: ProviderContext) {
    if (context.selector.provider !== 'cloudrun') throw fail('CLOUDRUN_TARGET_MISMATCH');
    const versionInfo = obj(parse(await command(context, ['version', '--format=json'])));
    const sdk = text(versionInfo['Google Cloud SDK']);
    if (!/^\d+\.\d+\.\d+$/.test(sdk) || (options.expectedCliVersion && options.expectedCliVersion !== sdk)) throw fail('CLOUDRUN_CLI_UNSUPPORTED');
    const capabilities: [string[], string[]][] = [
      [['run', 'deploy'], ['--source', '--service-account', '--build-service-account', '--port', '--max', '--max-instances', '--timeout', '--concurrency', '--set-env-vars', '--set-secrets', '--no-traffic', '--no-allow-unauthenticated', '--invoker-iam-check', '--deploy-health-check', '--labels']],
      [['run', 'services', 'update-traffic'], ['--to-revisions', '--clear-tags']],
      [['secrets', 'create'], ['--replication-policy', '--labels']], [['secrets', 'versions', 'add'], ['--data-file']],
      [['secrets', 'add-iam-policy-binding'], ['--member', '--role', '--condition']],
      [['run', 'services', 'add-iam-policy-binding'], ['--member', '--role']],
      [['run', 'services', 'logs', 'read'], ['--limit']],
    ];
    for (const [args, flags] of capabilities) {
      const help = await command(context, [...args, '--help']);
      // gcloud help commonly expresses boolean negation as --[no-]FLAG.
      const normalized = help.replace(/--\[no-\]([a-z-]+)/g, '--$1 --no-$1');
      if (flags.some((flag) => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s=,<\\[]|$)`, 'm').test(normalized))) throw fail('CLOUDRUN_CLI_UNSUPPORTED');
    }
    await projectMetadata(context);
  }
  async function prepare(context: ProviderContext, environment: PreflightEnvironment) {
    validatePreflightEnvironment(environment);
    diagnostic('Source deployment uses billable Cloud Run, Cloud Build, Artifact Registry and Secret Manager; TLS Redis remains user-owned. No APIs, projects or broad IAM roles are provisioned automatically.');
    await cliReady(context);
    const accounts = list(parse(await command(context, ['auth', 'list', '--filter=status:ACTIVE', '--format=json']))).map(obj);
    if (accounts.length !== 1 || accounts[0]!.status !== 'ACTIVE' || !/^[^\s@]+@[^\s@]+$/.test(text(accounts[0]!.account))) throw fail('CLOUDRUN_AUTH_REQUIRED');
    const number = projectNumber!;
    const billing = obj(parse(await command(context, ['billing', 'projects', 'describe', options.project, '--format=json'])));
    if (billing.billingEnabled !== true) throw fail('CLOUDRUN_BILLING_REQUIRED');
    const enabled = list(parse(await command(context, ['services', 'list', '--enabled', '--format=json']))).map((entry) => text(obj(obj(entry).config).name));
    if (['run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', 'iam.googleapis.com'].some((api) => !enabled.includes(api))) throw fail('CLOUDRUN_APIS_REQUIRED');
    for (const email of [options.runtimeServiceAccount, options.buildServiceAccount]) {
      const identity = obj(parse(await command(context, ['iam', 'service-accounts', 'describe', email, '--format=json'])));
      if (identity.email !== email || identity.disabled === true || !/^\d+$/.test(text(identity.uniqueId))) throw fail('CLOUDRUN_IDENTITY_REQUIRED');
    }
    // This is diagnostic only: project bindings cannot model inherited/group/custom-role IAM.
    let policy: Record<string, unknown> | undefined;
    try { policy = obj(parse(await command(context, ['projects', 'get-iam-policy', options.project, '--format=json']))); }
    catch (error) { if (context.signal?.aborted || (error instanceof FastagentError && error.code === 'CLOUDRUN_TIMEOUT')) throw error;
      diagnostic('Project IAM policy diagnostics unavailable; operator must verify deployer permissions and build secret isolation.'); }
    if (policy) {
      const bindings = list(policy.bindings ?? []).map(obj);
      if (bindings.some((b) => ['roles/owner', 'roles/editor', 'roles/secretmanager.admin', 'roles/secretmanager.secretAccessor'].includes(String(b.role)) &&
          list(b.members).includes(`serviceAccount:${options.buildServiceAccount}`))) throw fail('CLOUDRUN_BUILD_SECRET_ACCESS');
    }
    diagnostic('Verify run.sourceDeveloper/serviceUsageConsumer, service-account actAs and build run.builder permissions. Policy diagnostics do not certify build secret isolation. Source code is trusted; no broad roles are granted.');
    if (`${options.service}-${number}`.length > 63) throw fail('CLOUDRUN_ORIGIN_UNSUPPORTED');
    return validateHttpsOrigin(`https://${options.service}-${number}.${options.region}.run.app`);
  }
  async function service(context: ProviderContext) {
    const found = list(parse(await command(context, run(['list', '--filter', `metadata.name=${options.service}`, '--format=json'])))).map(obj);
    if (found.length > 1) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
    if (!found.length) return undefined;
    return obj(parse(await command(context, run(['describe', options.service, '--format=json']))));
  }
  function ownedService(remote: Record<string, unknown>, record: DeploymentRecord) {
    const metadata = obj(remote.metadata);
    if (metadata.name !== options.service || obj(metadata.labels)[ownerLabel] !== record.ownershipMarker) throw fail('CLOUDRUN_OWNERSHIP_MISMATCH');
    return remote;
  }
  function originOf(remote: Record<string, unknown>, expected: string) {
    const status = obj(remote.status);
    const url = validateHttpsOrigin(text(status.url));
    if (url !== expected) throw fail('CLOUDRUN_ORIGIN_MISMATCH');
    return url;
  }
  function config(remote: Record<string, unknown>, record: DeploymentRecord, checkOrigin = true) {
    ownedService(remote, record);
    if (!record.url) throw fail('CLOUDRUN_ORIGIN_MISMATCH');
    if (checkOrigin) originOf(remote, record.url);
    if (obj(obj(remote.metadata).annotations)['run.googleapis.com/invoker-iam-disabled'] === 'true') throw fail('CLOUDRUN_UNSAFE_REMOTE_ENV');
    const spec = obj(obj(obj(remote.spec).template).spec);
    if (spec.serviceAccountName !== options.runtimeServiceAccount) throw fail('CLOUDRUN_CONFIG_MISMATCH');
    const containers = list(spec.containers).map(obj);
    if (containers.length !== 1) throw fail('CLOUDRUN_CONFIG_MISMATCH');
    const container = containers[0]!;
    const env = list(container.env).map(obj);
    const names = env.map((e) => text(e.name));
    if (new Set(names).size !== names.length || names.some((name) => ![...keys, 'APP_ORIGIN', 'FASTAGENT_SESSION_NAMESPACE', 'PORT'].includes(name))) throw fail('CLOUDRUN_UNSAFE_REMOTE_ENV');
    const value = (key: string) => env.find((e) => e.name === key);
    if (value('APP_ORIGIN')?.value !== record.url || value('FASTAGENT_SESSION_NAMESPACE')?.value !== record.sessionNamespace ||
        (value('PORT') && value('PORT')?.value !== '8080') || list(container.ports).length !== 1 || obj(list(container.ports)[0]).containerPort !== 8080) throw fail('CLOUDRUN_CONFIG_MISMATCH');
    for (const key of keys) {
      const entry = value(key);
      if (!entry || 'value' in entry) throw fail('CLOUDRUN_UNSAFE_REMOTE_ENV');
      const ref = obj(obj(entry.valueFrom).secretKeyRef);
      const name = text(ref.name);
      const selected = name.startsWith('projects/') ? canonicalSecretName(name) : name;
      if (![secretId(record, key), secretId(record, key).split('/').at(-1)].includes(selected) || String(ref.key) !== version(record, key)) throw fail('CLOUDRUN_CONFIG_MISMATCH');
    }
    const template = obj(obj(remote.spec).template);
    const annotations = obj(obj(template.metadata).annotations);
    if (String(annotations['autoscaling.knative.dev/maxScale']) !== '1' ||
        String(obj(obj(remote.metadata).annotations)['run.googleapis.com/maxScale']) !== '1' ||
        spec.containerConcurrency !== 20 || spec.timeoutSeconds !== 300) throw fail('CLOUDRUN_CONFIG_MISMATCH');
  }
  function ready(remote: Record<string, unknown>, revision: string) {
    const status = obj(remote.status), metadata = obj(remote.metadata);
    if (!/^[1-9]\d*$/.test(String(metadata.generation)) || !/^\d+$/.test(String(status.observedGeneration))) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
    if (String(status.observedGeneration) !== String(metadata.generation)) return false;
    const condition = list(status.conditions).map(obj).find((c) => c.type === 'Ready');
    if (condition?.status === 'False') throw fail('CLOUDRUN_NOT_READY');
    return condition?.status === 'True' && status.latestReadyRevisionName === revision && status.latestCreatedRevisionName === revision;
  }
  function traffic(remote: Record<string, unknown>, revision: string) {
    const targets = list(obj(remote.status).traffic).map(obj);
    if (targets.length !== 1 || targets[0]!.percent !== 100 || targets[0]!.revisionName !== revision || targets[0]!.tag !== undefined || targets[0]!.url !== undefined) throw fail('CLOUDRUN_TRAFFIC_UNSAFE');
  }
  async function secret(context: ProviderContext, id: string, record: DeploymentRecord) {
    const found = list(parse(await command(context, ['secrets', 'list', '--filter', `name:${id.split('/').at(-1)}`, '--format=json']))).map(obj);
    if (found.length > 1) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
    if (found.length && (canonicalSecretName(text(found[0]!.name)) !== id || obj(found[0]!.labels)[ownerLabel] !== record.ownershipMarker)) throw fail('CLOUDRUN_OWNERSHIP_MISMATCH');
    return found[0];
  }
  async function wait(signal?: AbortSignal) {
    await bounded((inner) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { inner.removeEventListener('abort', abort); resolve(); }, interval);
      const abort = () => { clearTimeout(timer); reject(fail('CLOUDRUN_CANCELLED')); };
      inner.addEventListener('abort', abort, { once: true });
    }), signal, interval + requestTimeout);
  }
  async function healthy(context: ProviderContext, record: DeploymentRecord) {
    try {
      const result = await bounded((signal) => options.health({ url: `${validateHttpsOrigin(record.url!)}/healthz`, signal, maxResponseBytes: 4096 }), context.signal);
      if (Buffer.byteLength(JSON.stringify(result.body) ?? '') > 4096) throw fail('CLOUDRUN_OUTPUT_LIMIT');
      return result.status === 200 && obj(result.body).ok === true;
    } catch (error) {
      if (context.signal?.aborted) throw fail('CLOUDRUN_CANCELLED');
      if (error instanceof FastagentError && ['CLOUDRUN_TIMEOUT', 'CLOUDRUN_OUTPUT_LIMIT'].includes(error.code)) throw fail(error.code);
      return false;
    }
  }
  async function deploy(input: DeployInput) {
    if (deploymentKey(input.state.selector) !== deploymentKey(input.selector)) throw fail('CLOUDRUN_TARGET_MISMATCH');
    const environment = validatePreflightEnvironment(input.environment);
    let record = await input.state.read();
    if (record) {
      record = recordFor(input, record);
      if (record.status === 'destroying' || record.sessionNamespace !== environment.FASTAGENT_SESSION_NAMESPACE) throw fail('CLOUDRUN_TARGET_MISMATCH');
    } else record = { ...createDeploymentRecord(input.selector), sessionNamespace: environment.FASTAGENT_SESSION_NAMESPACE,
      selectors: { project: options.project, region: options.region }, resources: [{ kind: 'project', id: options.project, ownership: 'external' }] };
    const approved = await readFile(new URL('../../../templates/openai/Dockerfile', import.meta.url), 'utf8');
    if ((await readFile(`${input.source.directory}/Dockerfile`, 'utf8')).replaceAll('\r\n', '\n').trim() !== approved.trim() ||
        !input.source.files.includes('.gcloudignore')) throw fail('CLOUDRUN_SOURCE_UNSUPPORTED');
    const predicted = await prepare(input, environment);
    const expires = Date.now() + deadline;
    const remaining = () => { const ms = expires - Date.now(); if (ms < 1) throw fail('CLOUDRUN_DEPLOYMENT_TIMEOUT'); return ms; };
    const save = async (changes: Partial<DeploymentRecord>) => { record = await input.state.write({ ...record!, ...changes }); return record; };
    let remote = await service(input);
    const freshTarget = !remote;
    if (remote) {
      if (!record.revision || !record.resources.some((r) => r.id === serviceId)) throw fail('CLOUDRUN_OWNERSHIP_MISMATCH');
      ownedService(remote, record);
      if (!record.url) throw fail('CLOUDRUN_ORIGIN_MISMATCH');
      originOf(remote, record.url);
      if (record.phase === 'healthy') config(remote, record);
    } else if (record.phase === 'healthy' || record.phase === 'source-uploaded') throw fail('CLOUDRUN_TARGET_MISSING');
    let origin = record.url ?? predicted;
    if (environment.APP_ORIGIN && environment.APP_ORIGIN !== origin) throw fail('CLOUDRUN_ORIGIN_MISMATCH');
    validateCloudEnvironment({ ...environment, APP_ORIGIN: origin });
    if (!record.url) await save({ url: origin });
    // Inspect gcloud's actual staging upload manifest. Never upload the original project.
    const manifest = (await command(input, ['meta', 'list-files-for-upload'], 'read', undefined, input.source.directory)).trim().split(/\r?\n/).filter(Boolean);
    if (!manifest.length || manifest.some((file) => !input.source.files.includes(file) || /(?:^|\/)\.env(?:\.|$)/.test(file)) || !manifest.includes('Dockerfile')) throw fail('CLOUDRUN_UPLOAD_UNSAFE');
    const recovery = record.status === 'deploying';
    // An interrupted append to an already-versioned secret needs manual reconciliation; core
    // cannot persist the unknown returned version. Only a unique first version is recoverable.
    const unversioned = metadataSecrets(record).filter((r) => !record!.resources.some((v) => v.id.startsWith(`${r.id}/versions/`)));
    if (recovery && record.phase === 'resources-created' && unversioned.length !== 1) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
    if (!recovery || !['secrets-configured', 'source-uploaded'].includes(record.phase)) {
      for (const key of keys) {
        remaining();
        const id = secretId(record, key);
        if (recovery && record.resources.some((r) => r.id.startsWith(`${id}/versions/`))) {
          if (!await secret(input, id, record)) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
          await command(input, ['secrets', 'add-iam-policy-binding', id, '--member', `serviceAccount:${options.runtimeServiceAccount}`,
            '--role=roles/secretmanager.secretAccessor', '--condition=None', '--quiet', '--format=json'], 'mutate');
          continue;
        }
        const recorded = record.resources.some((r) => r.id === id);
        let existing = await secret(input, id, record);
        if (existing && !recorded) throw fail('CLOUDRUN_OWNERSHIP_MISMATCH');
        if (!recorded) await save({ resources: [...record.resources, { kind: 'secret', id, ownership: 'owned' }], phase: 'resources-created', status: 'pending' });
        if (!existing) {
          // A failed create can be reconciled by its exact unique name+marker; never overwrite it.
          if (recorded && recovery) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
          await save({ status: 'deploying', phase: 'resources-created' });
          await command(input, ['secrets', 'create', id.split('/').at(-1)!, '--replication-policy=automatic', '--labels', `${ownerLabel}=${record.ownershipMarker}`, '--quiet', '--format=json'], 'mutate');
          existing = await secret(input, id, record);
          if (!existing) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
          await save({ status: 'pending' });
        }
        let pinned: string | undefined;
        if (recovery) {
          const versions = list(parse(await command(input, ['secrets', 'versions', 'list', id, '--format=json']))).map(obj);
          if (versions.length === 1 && versions[0]!.state === 'ENABLED') pinned = canonicalSecretName(text(versions[0]!.name));
          else if (versions.length) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
        }
        if (!pinned) {
          await save({ phase: 'resources-created', status: 'deploying' });
          const added = obj(parse(await command(input, ['secrets', 'versions', 'add', id, '--data-file=-', '--quiet', '--format=json'], 'mutate', environment[key])));
          pinned = canonicalSecretName(text(added.name));
          if (added.state !== 'ENABLED') throw fail('CLOUDRUN_SECRET_VERSION_INVALID');
        }
        if (!new RegExp(`^${id}/versions/[1-9]\\d*$`).test(pinned)) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
        await save({ status: 'pending', resources: [...record.resources.filter((r) => !r.id.startsWith(`${id}/versions/`)), { kind: 'secret', id: pinned, ownership: 'owned' }] });
        await command(input, ['secrets', 'add-iam-policy-binding', id, '--member', `serviceAccount:${options.runtimeServiceAccount}`,
          '--role=roles/secretmanager.secretAccessor', '--condition=None', '--quiet', '--format=json'], 'mutate');
      }
      await save({ phase: 'secrets-configured', status: 'pending' });
    }
    async function upload(selectedOrigin: string, update: boolean) {
      const references = keys.map((key) => `${key}=${secretId(record!, key).split('/').at(-1)}:${version(record!, key)}`).join(',');
      const response = obj(parse(await command(input, ['run', 'deploy', options.service, '--region', options.region, '--source', input.source.directory,
        '--service-account', options.runtimeServiceAccount, '--build-service-account', buildAccountId,
        '--port=8080', '--max=1', '--max-instances=1', '--timeout=300', '--concurrency=20',
        '--set-env-vars', `APP_ORIGIN=${selectedOrigin},FASTAGENT_SESSION_NAMESPACE=${record!.sessionNamespace}`,
        '--set-secrets', references, '--labels', `${ownerLabel}=${record!.ownershipMarker}`, '--invoker-iam-check', '--deploy-health-check',
        ...(update ? ['--no-traffic'] : ['--no-allow-unauthenticated']), '--quiet', '--format=json'], 'mutate', undefined, input.selector.projectPath, remaining())));
      ownedService(response, record!);
      const revision = text(obj(response.status).latestCreatedRevisionName);
      if (!new RegExp(`^${options.service}-[a-z0-9-]+$`).test(revision)) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
      await save({ phase: 'source-uploaded', status: 'deploying', resources: [...record!.resources.filter((r) => r.kind !== 'revision'), { kind: 'revision', id: revision, ownership: 'external' }] });
    }
    if (record.phase === 'secrets-configured') {
      // Pending means upload has not started; deploying means outcome uncertain, query only.
      const wasUncertain = record.status === 'deploying';
      if (!wasUncertain) {
        await save({ phase: 'secrets-configured', status: 'deploying', resources: [...record.resources.filter((r) => r.kind !== 'revision'),
          ...(!record.resources.some((r) => r.id === serviceId) ? [{ kind: 'service' as const, id: serviceId, ownership: 'owned' as const }] : [])] });
        await upload(origin, !!remote);
      }
      remote = await service(input);
      if (!remote) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
      ownedService(remote, record);
      const expectedRevision = record.resources.find((r) => r.kind === 'revision')?.id;
      if (expectedRevision && obj(remote.status).latestCreatedRevisionName !== expectedRevision) throw fail('CLOUDRUN_REVISION_MISMATCH');
      const observed = validateHttpsOrigin(text(obj(remote.status).url));
      if (observed !== origin) {
        // Legacy hash URL: reconcile at most once while the fresh service is IAM-private.
        // Both revisions are protected from inception; never activate a mismatched origin.
        if (!freshTarget || wasUncertain || origin !== predicted || !new URL(observed).hostname.endsWith('.run.app') ||
            environment.APP_ORIGIN) throw fail('CLOUDRUN_ORIGIN_MISMATCH');
        config(remote, record, false);
        const firstRevision = text(obj(remote.status).latestCreatedRevisionName);
        while (!ready(remote, firstRevision)) {
          remaining(); await wait(input.signal);
          const next = await service(input); if (!next) throw fail('CLOUDRUN_TARGET_MISSING');
          config(next, record, false); remote = next;
        }
        config(remote, record, false);
        if (validateHttpsOrigin(text(obj(remote.status).url)) !== observed) throw fail('CLOUDRUN_ORIGIN_MISMATCH');
        await save({ url: observed, phase: 'secrets-configured', status: 'deploying', resources: record.resources.filter((r) => r.kind !== 'revision') }); origin = observed;
        await upload(origin, false);
        remote = await service(input); if (!remote) throw fail('CLOUDRUN_MUTATION_UNCERTAIN');
      }
      config(remote, record);
      const revision = text(obj(remote.status).latestCreatedRevisionName);
      if (!new RegExp(`^${options.service}-[a-z0-9-]+$`).test(revision)) throw fail('CLOUDRUN_SCHEMA_UNSUPPORTED');
      const captured = record.resources.find((r) => r.kind === 'revision')?.id;
      if (captured && captured !== revision) throw fail('CLOUDRUN_REVISION_MISMATCH');
      if (!captured) await save({ phase: 'source-uploaded', status: 'deploying', resources: [...record.resources, { kind: 'revision', id: revision, ownership: 'external' }] });
    }
    const revision = record.resources.find((r) => r.kind === 'revision')?.id;
    if (!revision) throw fail('CLOUDRUN_PARTIAL_TARGET');
    while (remaining()) {
      cancelled(input.signal);
      remote = await service(input);
      if (!remote) throw fail('CLOUDRUN_TARGET_MISSING');
      config(remote, record);
      if (obj(remote.status).latestCreatedRevisionName !== revision) throw fail('CLOUDRUN_REVISION_MISMATCH');
      if (ready(remote, revision)) break;
      await wait(input.signal);
    }
    await command(input, run(['update-traffic', options.service, '--to-revisions', `${revision}=100`, '--clear-tags', '--quiet', '--format=json']), 'mutate');
    remote = await service(input);
    if (!remote) throw fail('CLOUDRUN_TARGET_MISSING');
    config(remote, record); if (!ready(remote, revision)) throw fail('CLOUDRUN_NOT_READY'); traffic(remote, revision);
    // Public IAM is granted only after protected config, origin, readiness and traffic verification.
    // Policy denial leaves a recoverable source-uploaded checkpoint, not a ready deployment.
    await command(input, run(['add-iam-policy-binding', options.service, '--member=allUsers', '--role=roles/run.invoker', '--quiet', '--format=json']), 'mutate');
    while (remaining()) {
      if (await healthy(input, record)) {
        remote = await service(input); if (!remote) throw fail('CLOUDRUN_TARGET_MISSING');
        config(remote, record); if (!ready(remote, revision)) throw fail('CLOUDRUN_NOT_READY'); traffic(remote, revision);
        return save({ status: 'ready', phase: 'healthy' });
      }
      await wait(input.signal);
    }
    throw fail('CLOUDRUN_DEPLOYMENT_TIMEOUT');
  }
  return {
    name: 'cloudrun', async preflight(context, environment) { await prepare(context, environment); },
    async deploy(input) {
      return bounded((signal) => deploy({ ...input, signal }), input.signal, deadline, 'CLOUDRUN_DEPLOYMENT_TIMEOUT');
    },
    async status(context, value) {
      const record = recordFor(context, value); await cliReady(context);
      const remote = await service(context); if (!remote) return { status: 'missing' };
      ownedService(remote, record);
      const revision = record.resources.find((r) => r.kind === 'revision')?.id;
      if (!revision) return { status: 'pending' };
      config(remote, record);
      try { if (!ready(remote, revision)) return { status: 'deploying', url: record.url! }; }
      catch (error) { if (error instanceof FastagentError && error.code === 'CLOUDRUN_NOT_READY') return { status: 'failed', url: record.url! }; throw error; }
      traffic(remote, revision);
      return { status: await healthy(context, record) ? 'ready' : 'deploying', url: record.url! };
    },
    async logs(context, value) {
      const record = recordFor(context, value); await cliReady(context);
      const remote = await service(context); if (!remote) throw fail('CLOUDRUN_TARGET_MISSING'); ownedService(remote, record);
      const entries = list(parse(await command(context, run(['logs', 'read', options.service, '--limit', String(logLines), '--format=json'])))).map(obj);
      if (entries.length > logLines) throw fail('CLOUDRUN_OUTPUT_LIMIT');
      // Unknown historical secret values cannot be reliably redacted without fetching secrets.
      // Return useful log metadata only; never expose arbitrary application/build payloads.
      return entries.map((entry) => JSON.stringify({ timestamp: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(entry.timestamp)) ? entry.timestamp : undefined,
        severity: ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'].includes(String(entry.severity)) ? entry.severity : 'DEFAULT',
        resource: serviceId, message: '[application log payload withheld: may contain secrets]' })).join('\n');
    },
    async destroy(input) {
      if (input.confirmed !== true) throw fail('CLOUDRUN_DESTRUCTION_UNAUTHORIZED');
      const record = recordFor(input, input.record);
      if (record.status !== 'destroying' || record.phase !== 'destroy-pending') throw fail('CLOUDRUN_DESTRUCTION_UNAUTHORIZED');
      await cliReady(input);
      const remote = await service(input);
      if (remote) {
        if (!record.resources.some((r) => r.id === serviceId)) throw fail('CLOUDRUN_OWNERSHIP_MISMATCH');
        ownedService(remote, record);
      }
      const metadata = metadataSecrets(record);
      // Verify ALL ownership before ANY deletion, including each version's parent.
      for (const r of record.resources.filter((r) => r.kind === 'secret' && r.id.includes('/versions/'))) {
        if (!metadata.some((m) => r.id.startsWith(`${m.id}/versions/`))) throw fail('CLOUDRUN_TARGET_MISMATCH');
      }
      for (const r of metadata) await secret(input, r.id, record);
      if (remote) await command(input, run(['delete', options.service, '--quiet']), 'destroy');
      for (const r of metadata) {
        if (await secret(input, r.id, record)) await command(input, ['secrets', 'delete', r.id, '--quiet'], 'destroy');
      }
      if (await service(input)) throw fail('CLOUDRUN_DESTRUCTION_FAILED');
      for (const r of metadata) if (await secret(input, r.id, record)) throw fail('CLOUDRUN_DESTRUCTION_FAILED');
      diagnostic('Cloud Run service and recorded app-owned secrets deleted. Project, source images, Artifact Registry repositories, build history and service accounts retained.');
      return { verified: true, succeeded: true, ownershipMarker: record.ownershipMarker,
        resourceIdentities: record.resources.filter((r) => r.ownership === 'owned').map((r) => `${r.kind}:${r.id}`) };
    },
  };
}
