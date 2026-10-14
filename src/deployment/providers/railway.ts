import { readFile } from 'node:fs/promises';
import { FastagentError } from '../../errors.js';
import { redactProcessOutput } from '../process.js';
import { createDeploymentRecord, deploymentKey, validateDeploymentRecord, type DeploymentRecord } from '../state.js';
import { validateCloudEnvironment, validateHttpsOrigin, validatePreflightEnvironment,
  type DeploymentProvider, type DeployInput, type DestroyInput, type PreflightEnvironment,
  type ProviderContext, type ProviderStatus } from '../types.js';

const API = 'https://backboard.railway.com/graphql/v2';
const MARKER = 'FASTAGENT_OWNERSHIP_MARKER';
const secretKeys = ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL'] as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const failure = (code: string) => new FastagentError(code,
  'Railway operation could not be verified. Inspect the recoverable checkpoint and remote resources before retrying; no automatic creation retry is authorized.');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
  return value;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !idPattern.test(value)) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
  return value;
};
const json = (value: string): unknown => {
  try { return JSON.parse(value); } catch { throw failure('RAILWAY_SCHEMA_UNSUPPORTED'); }
};

/** Implementations must not log requests/responses, follow redirects, or read ambient credentials.
 * Body and headers may contain secrets. Enforce maxResponseBytes while receiving, not after buffering.
 */
export interface RailwayHttpRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Readonly<Record<string, string>>;
  body?: { query: string; variables: Record<string, unknown> };
  signal: AbortSignal;
  maxResponseBytes: number;
}
export interface RailwayHttpResponse { status: number; body: unknown }
export type RailwayHttpTransport = (request: RailwayHttpRequest) => Promise<RailwayHttpResponse>;
export interface RailwayOptions {
  workspaceId: string;
  credentials: { scope: 'account'; token: string } | { scope: 'project'; token: string; projectId: string; environmentId: string };
  http: RailwayHttpTransport;
  /** Explicit nonsecret CLI environment (e.g. PATH/HOME for CLI configuration); no ambient reads. */
  commandEnv?: Readonly<Record<string, string>>;
  executable?: string;
  expectedCliVersion?: string;
  pollIntervalMs?: number;
  deploymentTimeoutMs?: number;
  requestTimeoutMs?: number;
  logLines?: number;
}

/** Railway variables are available to platform builds too. Staging's standard Dockerfile must
 * consume no secret ARGs. Replica configuration is a cost default, NOT a singleton guarantee;
 * existing region overrides/rollout overlap can exceed one process. Shared TLS Redis is mandatory.
 * Official commands: https://docs.railway.com/cli/{init,add,domain,up,variable,deployment,logs}
 * API deletion: https://docs.railway.com/integrations/api/manage-services (serviceDelete only).
 */
export function createRailwayProvider(options: RailwayOptions): DeploymentProvider {
  if (!idPattern.test(options.workspaceId) || !['account', 'project'].includes(options.credentials.scope) ||
      !options.credentials.token || /[\s\x00-\x1f\x7f]/.test(options.credentials.token) ||
      (options.credentials.scope === 'project' && (!idPattern.test(options.credentials.projectId) || !idPattern.test(options.credentials.environmentId))) ||
      Object.entries(options.commandEnv ?? {}).some(([key, value]) =>
        /SECRET|TOKEN|PASSWORD|KEY|REDIS|CREDENTIAL/i.test(key) || typeof value !== 'string' || value.includes('\0'))) throw failure('RAILWAY_OPTIONS_INVALID');
  const interval = options.pollIntervalMs ?? 2000, deadline = options.deploymentTimeoutMs ?? 600_000;
  const requestTimeout = options.requestTimeoutMs ?? 30_000, logLines = options.logLines ?? 100;
  if (![interval, deadline, requestTimeout, logLines].every(Number.isSafeInteger) || interval < 1 || deadline < 1 ||
      deadline > 3_600_000 || requestTimeout < 1 || requestTimeout > 120_000 || logLines < 1 || logLines > 500) throw failure('RAILWAY_OPTIONS_INVALID');
  const credentialEnv = options.credentials.scope === 'account'
    ? { RAILWAY_API_TOKEN: options.credentials.token } : { RAILWAY_TOKEN: options.credentials.token };
  const authHeaders = options.credentials.scope === 'account'
    ? { Authorization: `Bearer ${options.credentials.token}` } : { 'Project-Access-Token': options.credentials.token };
  const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw failure('RAILWAY_CANCELLED'); };
  async function http(url: string, body: RailwayHttpRequest['body'], signal?: AbortSignal): Promise<unknown> {
    cancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(failure(signal?.aborted ? 'RAILWAY_CANCELLED' : 'RAILWAY_HTTP_TIMEOUT')), { once: true });
        timer = setTimeout(abort, requestTimeout);
        if (signal?.aborted) abort();
      });
      const response = await Promise.race([
        interrupted,
        options.http({ url, method: body ? 'POST' : 'GET', headers: body ? { ...authHeaders, 'Content-Type': 'application/json' } : {},
          ...(body ? { body } : {}), signal: controller.signal, maxResponseBytes: body ? 4 * 1024 * 1024 : 4096 }),
      ]);
      cancelled(signal);
      if (response.status !== 200) throw failure('RAILWAY_HTTP_FAILED');
      if (Buffer.byteLength(JSON.stringify(response.body) ?? '') > (body ? 4 * 1024 * 1024 : 4096)) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      return response.body;
    } catch (error) {
      if (error instanceof FastagentError && ['RAILWAY_CANCELLED', 'RAILWAY_HTTP_TIMEOUT', 'RAILWAY_HTTP_FAILED', 'RAILWAY_SCHEMA_UNSUPPORTED'].includes(error.code)) throw failure(error.code);
      throw failure(signal?.aborted ? 'RAILWAY_CANCELLED' : 'RAILWAY_HTTP_FAILED');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function api(query: string, variables: Record<string, unknown>, signal?: AbortSignal) {
    const response = object(await http(API, { query, variables }, signal));
    if (response.errors !== undefined && array(response.errors).length) throw failure('RAILWAY_API_FAILED');
    return object(response.data);
  }
  async function command(context: ProviderContext, args: string[], intent: 'read' | 'mutate' = 'read', stdin?: string,
    sensitiveValues: readonly string[] = []) {
    cancelled(context.signal);
    try {
      const result = await context.runner({ executable: options.executable ?? 'railway', args, cwd: context.selector.projectPath,
        env: options.commandEnv ?? {}, secretEnv: credentialEnv, intent, ...(intent === 'mutate' ? { authorization: 'mutation' as const } : {}),
        ...(stdin !== undefined ? { stdin } : {}), sensitiveValues, ...(context.signal ? { signal: context.signal } : {}), timeoutMs: requestTimeout, maxOutputBytes: 256 * 1024 });
      // Redact again at the adapter boundary: injectable runners must never leak arbitrary output.
      return redactProcessOutput(result.stdout, [options.credentials.token, ...sensitiveValues, ...(stdin ? [stdin] : [])]);
    } catch { throw failure(context.signal?.aborted ? 'RAILWAY_CANCELLED' : 'RAILWAY_COMMAND_FAILED'); }
  }
  function recordFor(context: ProviderContext, input: DeploymentRecord) {
    const record = validateDeploymentRecord(input);
    if (context.selector.provider !== 'railway' || record.provider !== 'railway' || record.key !== deploymentKey(context.selector) ||
        record.selectors.project !== options.workspaceId || record.selectors.region !== undefined ||
        record.resources.some((resource) => !['project', 'environment', 'service', 'build'].includes(resource.kind) ||
          resource.ownership !== (resource.kind === 'service' ? 'owned' : 'external'))) throw failure('RAILWAY_TARGET_MISMATCH');
    if (options.credentials.scope === 'project' &&
        (record.resources.find((item) => item.kind === 'project')?.id !== options.credentials.projectId ||
         record.resources.find((item) => item.kind === 'environment')?.id !== options.credentials.environmentId)) throw failure('RAILWAY_TARGET_MISMATCH');
    for (const kind of ['project', 'environment', 'service', 'build']) {
      if (record.resources.filter((resource) => resource.kind === kind).length > 1) throw failure('RAILWAY_TARGET_MISMATCH');
    }
    return record;
  }
  function resource(record: DeploymentRecord, kind: string) {
    const value = record.resources.find((item) => item.kind === kind)?.id;
    if (!value) throw failure('RAILWAY_PARTIAL_TARGET');
    return id(value);
  }
  function scoped(record: DeploymentRecord) {
    return ['--project', resource(record, 'project'), '--service', resource(record, 'service'), '--environment', resource(record, 'environment')];
  }
  function serviceScoped(record: DeploymentRecord) {
    return ['--service', resource(record, 'service'), '--environment', resource(record, 'environment')];
  }

  // Bounded schema profile: introspect before using undocumented API field/argument shapes.
  // This is a guard, not a schema DSL or support for arbitrary Railway APIs.
  async function schema(signal?: AbortSignal) {
    const typeRef = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
    const data = await api(`query { __schema { queryType { name } mutationType { name } types { name kind fields { name args { name type { ${typeRef} } } type { ${typeRef} } } inputFields { name type { ${typeRef} } } } } }`, {}, signal);
    const root = object(data.__schema);
    const types = new Map(array(root.types).map((entry) => { const type = object(entry); return [String(type.name), type]; }));
    function base(ref: unknown): string {
      let value = object(ref);
      for (let depth = 0; depth < 4; depth++) {
        if (typeof value.name === 'string') return value.name;
        value = object(value.ofType);
      }
      throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    function field(type: string, name: string, input = false) {
      const found = array(types.get(type)?.[input ? 'inputFields' : 'fields']).map(object).find((item) => item.name === name);
      if (!found) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      return found;
    }
    function argument(type: string, name: string, arg: string, expected: string[]) {
      const found = array(field(type, name).args).map(object).find((item) => item.name === arg);
      if (!found || !expected.includes(base(found.type))) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    const query = String(object(root.queryType).name), mutation = String(object(root.mutationType).name);
    argument(query, 'project', 'id', ['String']);
    const project = base(field(query, 'project').type);
    for (const name of ['id', 'workspaceId']) if (!['String', 'ID'].includes(base(field(project, name).type))) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    for (const collection of ['environments', 'services']) {
      const edge = base(field(base(field(project, collection).type), 'edges').type);
      const node = base(field(edge, 'node').type);
      if (!['String', 'ID'].includes(base(field(node, 'id').type))) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      if (collection === 'environments' && base(field(node, 'name').type) !== 'String') throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    for (const arg of ['projectId', 'environmentId', 'serviceId']) argument(query, 'variables', arg, ['String']);
    if (!['JSON', 'Json', 'JSONObject'].includes(base(field(query, 'variables').type))) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    argument(mutation, 'serviceDelete', 'id', ['String']);
    if (base(field(mutation, 'serviceDelete').type) !== 'Boolean') throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    argument(mutation, 'serviceInstanceUpdate', 'input', ['ServiceInstanceUpdateInput']);
    const updateArgs = array(field(mutation, 'serviceInstanceUpdate').args).map(object);
    const identityInArgs = updateArgs.some((arg) => arg.name === 'serviceId');
    if (identityInArgs) {
      for (const name of ['serviceId', 'environmentId']) argument(mutation, 'serviceInstanceUpdate', name, ['String']);
    } else {
      for (const name of ['serviceId', 'environmentId']) {
        if (!['String', 'ID'].includes(base(field('ServiceInstanceUpdateInput', name, true).type))) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      }
    }
    for (const [name, expected] of [['numReplicas', 'Int'], ['healthcheckPath', 'String'], ['healthcheckTimeout', 'Int']] as const) {
      if (base(field('ServiceInstanceUpdateInput', name, true).type) !== expected) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    if (base(field(mutation, 'serviceInstanceUpdate').type) !== 'Boolean') throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    return { identityInArgs };
  }
  async function cliReady(context: ProviderContext) {
    if (context.selector.provider !== 'railway') throw failure('RAILWAY_TARGET_MISMATCH');
    const version = (await command(context, ['--version'])).trim();
    const match = /^railway\s+(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match || Number(match[1]) !== 5 || Number(match[2]) < 28 || (Number(match[2]) === 28 && Number(match[3]) < 1) ||
        (options.expectedCliVersion && version !== `railway ${options.expectedCliVersion}`)) throw failure('RAILWAY_CLI_UNSUPPORTED');
    const capabilities: [string[], string[]][] = [
      [['init', '--help'], ['--workspace', '--json', '--name']], [['add', '--help'], ['--service', '--json']],
      [['link', '--help'], ['--project', '--environment', '--service', '--json']],
      [['domain', '--help'], ['--project', '--service', '--environment', '--port', '--json']],
      [['domain', 'list', '--help'], ['--project', '--service', '--environment', '--json']],
      [['variable', 'set', '--help'], ['--stdin', '--skip-deploys', '--service', '--environment']],
      [['up', '--help'], ['--path-as-root', '--project', '--service', '--environment', '--detach', '--json']],
      [['deployment', 'list', '--help'], ['--service', '--environment', '--json']],
      [['logs', '--help'], ['--project', '--service', '--environment', '--lines', '--json']],
    ];
    for (const [args, flags] of capabilities) {
      const help = await command(context, args);
      if (flags.some((flag) => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s=,<\\[]|$)`, 'm').test(help))) throw failure('RAILWAY_CLI_UNSUPPORTED');
    }
    if (options.credentials.scope === 'account') {
      const account = object(json(await command(context, ['whoami', '--json'])));
      if (typeof account.email !== 'string' || (account.name !== null && typeof account.name !== 'string') ||
          !array(account.workspaces).some((entry) => id(object(entry).id) === options.workspaceId)) throw failure('RAILWAY_WORKSPACE_UNAUTHORIZED');
    }
  }
  async function prepare(context: ProviderContext, environment: PreflightEnvironment) {
    validatePreflightEnvironment(environment);
    await cliReady(context);
    const profile = await schema(context.signal);
    if (options.credentials.scope === 'project') {
      const remote = await project(options.credentials.projectId, context.signal);
      const environmentId = options.credentials.environmentId;
      if (!remote.environments.some((entry) => id(entry.id) === environmentId)) throw failure('RAILWAY_TARGET_MISMATCH');
    }
    return profile;
  }
  async function project(projectId: string, signal?: AbortSignal) {
    const data = await api('query($id:String!){project(id:$id){id workspaceId environments{edges{node{id name}}} services{edges{node{id}}}}}', { id: projectId }, signal);
    const value = object(data.project);
    if (id(value.id) !== projectId || id(value.workspaceId) !== options.workspaceId) throw failure('RAILWAY_TARGET_MISMATCH');
    const nodes = (collection: unknown) => array(object(collection).edges).map((edge) => object(object(edge).node));
    return { environments: nodes(value.environments), services: nodes(value.services) };
  }
  async function verify(context: ProviderContext, record: DeploymentRecord) {
    recordFor(context, record);
    const remote = await project(resource(record, 'project'), context.signal);
    if (!remote.services.some((entry) => id(entry.id) === resource(record, 'service')) ||
        !remote.environments.some((entry) => id(entry.id) === resource(record, 'environment'))) throw failure('RAILWAY_TARGET_MISMATCH');
    // Railway exposes a JSON variable collection, not a documented marker-only query. Keep it
    // private in memory: no raw response, credential values, or variable collection enters state.
    const data = await api('query($projectId:String!,$environmentId:String!,$serviceId:String!){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}',
      { projectId: resource(record, 'project'), environmentId: resource(record, 'environment'), serviceId: resource(record, 'service') }, context.signal);
    const variables = object(data.variables);
    if (variables[MARKER] !== record.ownershipMarker) throw failure('RAILWAY_OWNERSHIP_MISMATCH');
    if ('FASTAGENT_LOCAL_DEV' in variables) throw failure('RAILWAY_UNSAFE_REMOTE_ENV');
    return variables;
  }
  async function domain(context: ProviderContext, record: DeploymentRecord): Promise<string | undefined> {
    const response = object(json(await command(context, ['domain', 'list', ...scoped(record), '--json'])));
    const domains = array(response.domains).map(object);
    for (const item of domains) {
      if (id(item.serviceId) !== resource(record, 'service') || id(item.environmentId) !== resource(record, 'environment') ||
          typeof item.domain !== 'string' || !['service', 'custom'].includes(String(item.kind))) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    const candidates = domains.filter((item) => item.kind === 'service' && item.targetPort === 8080);
    if (record.url) {
      if (!candidates.some((item) => `https://${item.domain}` === record.url)) throw failure('RAILWAY_ORIGIN_MISMATCH');
      return record.url;
    }
    if (candidates.length > 1) throw failure('RAILWAY_ORIGIN_MISMATCH');
    return candidates.length === 1 ? validateHttpsOrigin(`https://${String(candidates[0]!.domain)}`) : undefined;
  }
  async function deployment(context: ProviderContext, record: DeploymentRecord): Promise<ProviderStatus['status']> {
    const deployments = array(json(await command(context, ['deployment', 'list', ...serviceScoped(record), '--json']))).map(object);
    for (const entry of deployments) {
      id(entry.id);
      if (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) || typeof entry.status !== 'string' ||
          !['INITIALIZING', 'QUEUED', 'BUILDING', 'DEPLOYING', 'WAITING', 'SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING'].includes(entry.status)) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    const expected = resource(record, 'build');
    const matches = deployments.filter((entry) => entry.id === expected);
    if (matches.length !== 1) return 'missing';
    const status = matches[0]!.status;
    if (status === 'SUCCESS') return 'ready';
    if (['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED'].includes(String(status))) return 'failed';
    return 'deploying';
  }
  function validateRemoteEnvironment(variables: Record<string, unknown>, record: DeploymentRecord) {
    const selected = Object.fromEntries([...secretKeys, 'APP_ORIGIN', 'FASTAGENT_SESSION_NAMESPACE'].map((key) => [key, variables[key]]));
    const environment = validateCloudEnvironment(selected);
    if (environment.APP_ORIGIN !== record.url || environment.FASTAGENT_SESSION_NAMESPACE !== record.sessionNamespace) throw failure('RAILWAY_ORIGIN_MISMATCH');
  }
  async function healthy(context: ProviderContext, record: DeploymentRecord) {
    if (!record.url) return false;
    try { return object(await http(`${validateHttpsOrigin(record.url)}/healthz`, undefined, context.signal)).ok === true; }
    catch (error) { if (context.signal?.aborted) throw error; return false; }
  }
  async function wait(signal?: AbortSignal) {
    cancelled(signal);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure('RAILWAY_CANCELLED')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, interval);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async function deploy(input: DeployInput) {
    if (deploymentKey(input.state.selector) !== deploymentKey(input.selector)) throw failure('RAILWAY_TARGET_MISMATCH');
    const environment = validatePreflightEnvironment(input.environment);
    let record = await input.state.read();
    if (record) {
      record = recordFor(input, record);
      if (record.status === 'destroying') throw failure('RAILWAY_TARGET_MISMATCH');
      if (record.sessionNamespace !== environment.FASTAGENT_SESSION_NAMESPACE) throw failure('RAILWAY_NAMESPACE_MISMATCH');
    } else {
      if (options.credentials.scope !== 'account') throw failure('RAILWAY_ACCOUNT_REQUIRED');
      record = { ...createDeploymentRecord(input.selector), sessionNamespace: environment.FASTAGENT_SESSION_NAMESPACE,
        selectors: { project: options.workspaceId } };
    }
    // Validate the supplied stage independently for the controlled Dockerfile boundary.
    const approved = await readFile(new URL('../../../templates/openai/Dockerfile', import.meta.url), 'utf8');
    const staged = await readFile(`${input.source.directory}/Dockerfile`, 'utf8');
    if (approved.trim() !== staged.replaceAll('\r\n', '\n').trim() || !input.source.files.includes('.railwayignore')) throw failure('RAILWAY_SOURCE_UNSUPPORTED');
    const profile = await prepare(input, environment);
    const save = async (changes: Partial<DeploymentRecord>) => { record = await input.state.write({ ...record!, ...changes }); return record; };
    if (!record.revision) await save({});
    const has = (kind: string) => record!.resources.some((entry) => entry.kind === kind);
    if (!has('project')) {
      if (record.status === 'deploying') throw failure('RAILWAY_MUTATION_UNCERTAIN');
      if (options.credentials.scope !== 'account') throw failure('RAILWAY_ACCOUNT_REQUIRED');
      await save({ status: 'deploying', phase: 'resources-created' });
      const created = object(json(await command(input, ['init', '--name', input.source.config.name, '--workspace', options.workspaceId, '--json'], 'mutate')));
      const projectId = id(created.id);
      await save({ resources: [{ kind: 'project', id: projectId, ownership: 'external' }], status: 'pending' });
      if (typeof created.name !== 'string') throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
    }
    if (!has('environment')) {
      const remote = await project(resource(record, 'project'), input.signal);
      const production = remote.environments.filter((entry) => entry.name === 'production');
      if (production.length !== 1) throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      await save({ resources: [...record.resources, { kind: 'environment', id: id(production[0]!.id), ownership: 'external' }] });
    }
    if (!has('service')) {
      if (record.status === 'deploying') throw failure('RAILWAY_MUTATION_UNCERTAIN');
      if (options.credentials.scope !== 'account') throw failure('RAILWAY_ACCOUNT_REQUIRED');
      await command(input, ['link', '--project', resource(record, 'project'), '--environment', resource(record, 'environment'), '--json']);
      await save({ status: 'deploying', phase: 'resources-created' });
      const created = object(json(await command(input, ['add', '--service', input.source.config.name, '--json'], 'mutate')));
      const serviceId = id(created.id);
      await save({ resources: [...record.resources, { kind: 'service', id: serviceId, ownership: 'owned' }], status: 'pending' });
      if (typeof created.name !== 'string') throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      await command(input, ['variable', 'set', `${MARKER}=${record.ownershipMarker}`, ...serviceScoped(record), '--skip-deploys'], 'mutate');
    }
    const remoteVariables = await verify(input, record);
    // Secrets stay in memory only; refuse unknown source-upload outcomes.
    if (record.phase === 'secrets-configured' && record.status === 'deploying' && !has('build')) throw failure('RAILWAY_MUTATION_UNCERTAIN');
    if (record.phase !== 'source-uploaded' || record.status !== 'deploying') {
      await command(input, ['link', ...scoped(record), '--json']);
      let origin = await domain(input, record);
      if (!origin) {
        if (record.phase === 'resources-created' && record.status === 'deploying') throw failure('RAILWAY_MUTATION_UNCERTAIN');
        await save({ phase: 'resources-created', status: 'deploying' });
        await command(input, ['domain', ...scoped(record), '--port', '8080', '--json'], 'mutate');
        origin = await domain(input, record);
      }
      if (!origin || (environment.APP_ORIGIN && environment.APP_ORIGIN !== origin)) throw failure('RAILWAY_ORIGIN_MISMATCH');
      await save({ url: origin, status: 'pending' });
      const full = validateCloudEnvironment({ ...environment, APP_ORIGIN: origin });
      const secrets = secretKeys.map((key) => full[key]);
      for (const key of secretKeys) await command(input,
        ['variable', 'set', key, '--stdin', '--skip-deploys', ...serviceScoped(record)], 'mutate', full[key], secrets);
      await command(input, ['variable', 'set', `APP_ORIGIN=${origin}`, `FASTAGENT_SESSION_NAMESPACE=${record.sessionNamespace}`, 'PORT=8080',
        ...serviceScoped(record), '--skip-deploys'], 'mutate', undefined, secrets);
      const identities = { serviceId: resource(record, 'service'), environmentId: resource(record, 'environment') };
      const settings = { numReplicas: 1, healthcheckPath: '/healthz', healthcheckTimeout: 300 };
      const configured = await api(profile.identityInArgs
        ? 'mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}'
        : 'mutation($input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(input:$input)}',
      profile.identityInArgs ? { ...identities, input: settings } : { input: { ...identities, ...settings } }, input.signal);
      if (configured.serviceInstanceUpdate !== true) throw failure('RAILWAY_API_FAILED');
      await save({ phase: 'secrets-configured', status: 'deploying', resources: record.resources.filter((entry) => entry.kind !== 'build') });
      const upload = object(json(await command(input, ['up', input.source.directory, '--path-as-root', ...scoped(record), '--detach', '--json'], 'mutate', undefined, secrets)));
      const deploymentId = id(upload.deploymentId);
      // logsUrl is deliberately neither opened nor persisted (it is not the application origin).
      await save({ phase: 'source-uploaded', status: 'deploying', resources: [...record.resources, { kind: 'build', id: deploymentId, ownership: 'external' }] });
    } else {
      validateRemoteEnvironment(remoteVariables, record);
      if (environment.APP_ORIGIN && environment.APP_ORIGIN !== record.url) throw failure('RAILWAY_ORIGIN_MISMATCH');
    }
    const expires = Date.now() + deadline;
    while (Date.now() < expires) {
      cancelled(input.signal);
      const status = await deployment(input, record);
      if (status === 'failed' || status === 'missing') {
        await save({ status: 'failed' });
        throw failure('RAILWAY_DEPLOYMENT_FAILED');
      }
      if (status === 'ready') {
        const variables = await verify(input, record);
        validateRemoteEnvironment(variables, record);
        if (await domain(input, record) !== record.url) throw failure('RAILWAY_ORIGIN_MISMATCH');
        if (await healthy(input, record)) return save({ status: 'ready', phase: 'healthy' });
      }
      await wait(input.signal);
    }
    throw failure('RAILWAY_DEPLOYMENT_TIMEOUT');
  }
  return {
    name: 'railway', async preflight(context, environment) { await prepare(context, environment); }, deploy,
    async status(context, input) {
      const record = recordFor(context, input);
      await cliReady(context);
      await schema(context.signal);
      const variables = await verify(context, record);
      if (!record.resources.some((entry) => entry.kind === 'build')) return { status: 'pending', ...(record.url ? { url: record.url } : {}) };
      const status = await deployment(context, record);
      if (status === 'ready') {
        validateRemoteEnvironment(variables, record);
        await domain(context, record);
        return { status: await healthy(context, record) ? 'ready' : 'deploying', ...(record.url ? { url: record.url } : {}) };
      }
      return { status, ...(record.url ? { url: record.url } : {}) };
    },
    async logs(context, input) {
      const record = recordFor(context, input);
      await cliReady(context);
      await schema(context.signal);
      const variables = await verify(context, record);
      const secrets = Object.entries(variables).filter(([key]) => !['APP_ORIGIN', 'FASTAGENT_SESSION_NAMESPACE', 'PORT'].includes(key))
        .map(([, value]) => typeof value === 'string' ? value : '').filter(Boolean);
      const output = await command(context, ['logs', resource(record, 'build'), ...scoped(record), '--lines', String(logLines), '--json'], 'read', undefined, secrets);
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const entry = object(json(line));
        if (typeof entry.message !== 'string' || typeof entry.timestamp !== 'string') throw failure('RAILWAY_SCHEMA_UNSUPPORTED');
      }
      return output;
    },
    async destroy(input: DestroyInput) {
      if (input.confirmed !== true || options.credentials.scope !== 'account') throw failure('RAILWAY_DESTRUCTION_UNAUTHORIZED');
      const record = recordFor(input, input.record);
      await schema(input.signal);
      await verify(input, record);
      const result = await api('mutation($id:String!){serviceDelete(id:$id)}', { id: resource(record, 'service') }, input.signal);
      if (result.serviceDelete !== true) throw failure('RAILWAY_DESTRUCTION_FAILED');
      const remaining = await project(resource(record, 'project'), input.signal);
      if (remaining.services.some((entry) => id(entry.id) === resource(record, 'service'))) throw failure('RAILWAY_DESTRUCTION_FAILED');
      return { verified: true, succeeded: true, ownershipMarker: record.ownershipMarker,
        resourceIdentities: [`service:${resource(record, 'service')}`] };
    },
  };
}
