import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseConfig, projectNameSchema, type ProjectConfig } from '../config/config.js';
import { FastagentError } from '../errors.js';
import { modelApiKeyName } from '../models/reference.js';
import { createDeploymentHttp } from './http.js';
import { interactiveCloudLogin } from './login.js';
import { createProcessRunner, redactProcessOutput, type ProcessRunner } from './process.js';
import { createCloudRunProvider } from './providers/cloudrun.js';
import { createRailwayProvider } from './providers/railway.js';
import { detectRuntimeEnvFiles, loadExplicitSecrets } from './secrets.js';
import { stageDeploymentSource, type StagedSource } from './staging.js';
import { createDeploymentRecord, DeploymentStore, type DeploymentLock, type DeploymentRecord } from './state.js';
import { validatePreflightEnvironment, type DeploymentProvider, type ProviderName } from './types.js';
import type { RailwayHttpTransport } from './providers/railway.js';

export type DeploymentCommand = 'login' | 'deploy' | 'status' | 'logs' | 'destroy';
export interface DeploymentOptions {
  command: DeploymentCommand;
  provider: ProviderName;
  cwd?: string;
  target?: string;
  workspace?: string;
  project?: string;
  region?: string;
  runtimeAccount?: string;
  buildAccount?: string;
  railwayProject?: string;
  railwayEnvironment?: string;
  envFiles?: string[];
  authFile?: string;
  dryRun?: boolean;
  yes?: boolean;
  interactive?: boolean;
  json?: boolean;
  signal?: AbortSignal;
}
export interface DeploymentDependencies {
  store?: DeploymentStore;
  runner?: ProcessRunner;
  http?: RailwayHttpTransport;
  provider?: DeploymentProvider;
  commandEnv?: Record<string, string>;
  login?: typeof interactiveCloudLogin;
}
const invalid = () => new FastagentError('INVALID_ARGUMENTS', 'Invalid deployment options. Run fastagent --help for command-specific flags.', 2);
const namespaceKeys = ['APP_ORIGIN', 'FASTAGENT_SESSION_NAMESPACE', 'FASTAGENT_HISTORY_NAMESPACE'];
function runtimeKeysFor(config: ProjectConfig): string[] {
  if (config.deployment.access === 'protected') return ['FASTAGENT_PASSWORD_HASH', 'OPENAI_API_KEY', 'REDIS_URL', 'APP_ORIGIN', 'FASTAGENT_SESSION_NAMESPACE'];
  return ['FASTAGENT_API_TOKEN', modelApiKeyName(config.model), 'REDIS_URL', 'FASTAGENT_EPHEMERAL_HISTORY', 'APP_ORIGIN', 'FASTAGENT_HISTORY_NAMESPACE'];
}

/** Select only native CLI configuration, never model credentials or arbitrary ambient variables. */
export function deploymentCommandEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CLOUDSDK_CONFIG', 'CLOUDSDK_ACTIVE_CONFIG_NAME']
    .flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]));
}

export async function executeDeployment(options: DeploymentOptions, dependencies: DeploymentDependencies = {}): Promise<Record<string, unknown>> {
  const sensitive: string[] = [];
  let lock: DeploymentLock | undefined, source: StagedSource | undefined;
  try {
    const { command, provider: name } = options;
    if (!['login', 'deploy', 'status', 'logs', 'destroy'].includes(command) || !['railway', 'cloudrun'].includes(name) ||
        (command !== 'deploy' && (options.envFiles !== undefined || options.dryRun !== undefined)) ||
        (command !== 'destroy' && options.yes !== undefined) || (command !== 'login' && options.interactive !== undefined) ||
        (name !== 'railway' && (options.workspace !== undefined || options.authFile !== undefined || options.railwayProject !== undefined || options.railwayEnvironment !== undefined)) ||
        (name !== 'cloudrun' && [options.project, options.region, options.runtimeAccount, options.buildAccount].some((value) => value !== undefined))) throw invalid();
    if (command === 'destroy' && options.yes !== true) throw new FastagentError('DESTRUCTION_CONFIRMATION_REQUIRED', 'destroy requires --yes and verified remote ownership.', 2);
    if (options.signal?.aborted) throw new FastagentError('DEPLOYMENT_CANCELLED', 'Operation cancelled; inspect the checkpoint before retrying.');
    const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
    const commandEnv = dependencies.commandEnv ?? deploymentCommandEnvironment();
    if (command === 'login') {
      if ([options.target, options.workspace, options.project, options.region, options.runtimeAccount, options.buildAccount, options.authFile, options.railwayProject, options.railwayEnvironment].some((value) => value !== undefined)) throw invalid();
      if (name === 'railway') {
        if (options.interactive !== undefined) throw invalid();
        return { command, provider: name, authenticated: false, instructions: 'Create an account/workspace API token and put RAILWAY_API_TOKEN in an ignored file; pass --auth-file explicitly. Cached railway login is not used. Project-scoped RAILWAY_TOKEN requires --railway-project and --railway-environment and an existing recorded target; destroy requires an account token.' };
      }
      if (options.interactive && options.json) throw invalid();
      if (options.interactive) await (dependencies.login ?? interactiveCloudLogin)(cwd, commandEnv, options.signal);
      return { command, provider: name, authenticated: false, instructions: options.interactive ? 'Native gcloud login completed; deployment preflight will verify account and permissions.' : 'Run gcloud auth login, or fastagent login --provider cloudrun --interactive in a terminal. Deployment uses native gcloud configuration; no credentials are copied to Fastagent state.' };
    }
    const config = parseConfig(await readFile(resolve(cwd, 'fastagent.yaml'), 'utf8'));
    const target = options.target ?? config.name;
    if (!projectNameSchema.safeParse(target).success) throw invalid();
    if (name === 'railway' && (!options.workspace || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.workspace))) throw invalid();
    if (name === 'cloudrun' && (!options.project || !options.region || !options.runtimeAccount || !options.buildAccount)) throw invalid();
    const auth = await loadExplicitSecrets(options.authFile ? [options.authFile] : [], cwd, ['RAILWAY_API_TOKEN', 'RAILWAY_TOKEN'], sensitive);
    if (Object.keys(auth).length > 1 || (options.railwayProject === undefined) !== (options.railwayEnvironment === undefined) ||
        (auth.RAILWAY_API_TOKEN && options.railwayProject !== undefined) ||
        (auth.RAILWAY_TOKEN && (!options.railwayProject || !options.railwayEnvironment)) ||
        (!auth.RAILWAY_TOKEN && options.railwayProject !== undefined) ||
        Object.values(auth).some((value) => /\s/.test(value))) throw invalid();
    if (name === 'railway' && !options.dryRun && !Object.keys(auth).length) throw new FastagentError('RAILWAY_AUTH_REQUIRED', 'Pass --auth-file containing RAILWAY_API_TOKEN (account/workspace API token) or a scoped RAILWAY_TOKEN. Cached CLI login is not sufficient.');
    const http = dependencies.http ?? createDeploymentHttp();
    let adapter = dependencies.provider;
    if (!adapter && name === 'cloudrun') adapter = createCloudRunProvider({ project: options.project!, region: options.region!, service: target,
      runtimeServiceAccount: options.runtimeAccount!, buildServiceAccount: options.buildAccount!, commandEnv,
      health: (request) => http({ ...request, method: 'GET', headers: {} }) });
    if (!adapter && name === 'railway' && Object.keys(auth).length) adapter = createRailwayProvider({ workspaceId: options.workspace!,
      credentials: auth.RAILWAY_API_TOKEN ? { scope: 'account', token: auth.RAILWAY_API_TOKEN } :
        { scope: 'project', token: auth.RAILWAY_TOKEN!, projectId: options.railwayProject!, environmentId: options.railwayEnvironment! },
      commandEnv: Object.fromEntries(Object.entries(commandEnv).filter(([key]) => ['PATH', 'HOME', 'TMPDIR'].includes(key))), http });
    if (adapter && adapter.name !== name) throw invalid();
    lock = await (dependencies.store ?? new DeploymentStore()).acquire({ projectPath: cwd, provider: name, target });
    let record = await lock.read();
    const selectors = name === 'railway' ? { project: options.workspace! } : { project: options.project!, region: options.region! };
    if (record && JSON.stringify(record.selectors) !== JSON.stringify(selectors)) throw new FastagentError('DEPLOYMENT_TARGET_MISMATCH', 'Provider selectors differ from the recorded target; select the original target explicitly.');
    const context = { selector: lock.selector, runner: dependencies.runner ?? createProcessRunner(), ...(options.signal ? { signal: options.signal } : {}) };
    let result: Record<string, unknown>;
    if (command === 'deploy') {
      if (record?.status === 'destroying') throw new FastagentError('DEPLOYMENT_DESTROY_PENDING', 'Target destruction is pending; finish or inspect destruction before deploying.');
      // Explicit --env-file flags always win. Otherwise auto-detect only the conventional ignored
      // files; a missing pair fails clearly instead of deploying with partial secrets.
      const envFiles = options.envFiles ?? await detectRuntimeEnvFiles(cwd);
      if (options.envFiles === undefined && envFiles.length === 0) throw new FastagentError('DEPLOYMENT_ENV_FILE_MISSING',
        'No runtime env files found. Create an ignored .env (model key plus either a TLS rediss:// REDIS_URL or FASTAGENT_EPHEMERAL_HISTORY=1) and .env.auth (FASTAGENT_API_TOKEN), or pass --env-file explicitly.');
      const environment = await loadExplicitSecrets(envFiles, cwd, runtimeKeysFor(config), sensitive);
      if (!record && auth.RAILWAY_TOKEN && !options.dryRun) throw new FastagentError('RAILWAY_ACCOUNT_REQUIRED', 'First deployment requires an account/workspace API token; project tokens require an existing recorded target.');
      const initial = record ?? { ...createDeploymentRecord(lock.selector), selectors,
        resources: name === 'cloudrun' ? [{ kind: 'project' as const, id: options.project!, ownership: 'external' as const }] : [] };
      const namespaceKey = config.deployment.access === 'token' ? 'FASTAGENT_HISTORY_NAMESPACE' : 'FASTAGENT_SESSION_NAMESPACE';
      const suppliedNamespace = environment[namespaceKey];
      if (suppliedNamespace && suppliedNamespace !== initial.sessionNamespace && record) throw new FastagentError('DEPLOYMENT_NAMESPACE_MISMATCH', 'Redis namespace must match the recorded target.');
      if (!record && suppliedNamespace) initial.sessionNamespace = suppliedNamespace;
      const validated = validatePreflightEnvironment({ ...environment, [namespaceKey]: initial.sessionNamespace });
      source = await stageDeploymentSource({ projectPath: cwd });
      if (options.signal?.aborted) throw new FastagentError('DEPLOYMENT_CANCELLED', 'Operation cancelled before deployment.');
      if (options.dryRun) result = { command, provider: name, target, dryRun: true, selectors, files: source.files, bytes: source.bytes,
        secretKeys: Object.keys(validated).filter((key) => !namespaceKeys.includes(key)),
        plan: ['Validate explicit runtime secrets and filtered source (complete)', 'On deploy: verify native CLI, authorization, billing and prerequisites', 'Create/update recorded resources, inject secrets, upload source, verify HTTPS health'],
        notice: 'No provider operations performed. Deployment is billable; TLS Redis is user-owned. This plan does not certify cloud permissions or readiness.' };
      else {
        if (!record) record = await lock.write(initial);
        const deployed = await adapter!.deploy({ ...context, state: lock, source, environment: validated });
        result = summary(command, deployed);
      }
    } else {
      if (!record) throw new FastagentError('DEPLOYMENT_NOT_FOUND', 'No recorded deployment for this directory, provider and target.');
      if (command === 'status') result = { ...summary(command, record), ...(await adapter!.status(context, record)) };
      else if (command === 'logs') result = { command, provider: name, target, logs: await adapter!.logs(context, record) };
      else {
        record = await lock.write({ ...record, status: 'destroying', phase: 'destroy-pending' });
        const proof = await adapter!.destroy({ ...context, record, confirmed: true });
        await lock.remove(proof);
        result = { command, provider: name, target, destroyed: true, notice: 'Only verified app-owned resources removed; shared projects, accounts and build artifacts may remain billable.' };
      }
    }
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') return redactProcessOutput(value, sensitive);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    return redact(result) as Record<string, unknown>;
  } catch (error) {
    if (options.signal?.aborted) throw new FastagentError('DEPLOYMENT_CANCELLED', 'Operation cancelled; recorded checkpoints remain available. Inspect status before retrying.');
    if (error instanceof FastagentError) throw new FastagentError(error.code, redactProcessOutput(error.message, sensitive), error.exitCode);
    throw new FastagentError('DEPLOYMENT_FAILED', 'Deployment command failed. Inspect local checkpoints and provider status before retrying.');
  } finally {
    try { await source?.cleanup(); } finally { await lock?.release(); }
  }
}
function summary(command: string, record: DeploymentRecord): Record<string, unknown> {
  return { command, provider: record.provider, target: record.target, status: record.status, phase: record.phase, ...(record.url ? { url: record.url } : {}) };
}

export function formatDeploymentResult(result: Record<string, unknown>): string {
  if (typeof result.instructions === 'string') return `${result.instructions}\n`;
  if (typeof result.logs === 'string') return result.logs + '\n';
  if (result.dryRun) return `Dry run: ${result.provider}/${result.target}\n${(result.files as string[]).length} staged files (${result.bytes} bytes); staging removed after validation.\n${(result.plan as string[]).join('\n')}\n${result.notice}\n`;
  return `${result.provider}/${result.target}: ${result.destroyed ? 'destroyed' : result.status}${result.url ? `\n${result.url}` : ''}${result.notice ? `\n${result.notice}` : ''}\n`;
}
