import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseConfig, projectNameSchema } from '../config/config.js';
import { FastagentError } from '../errors.js';
import { createDeploymentHttp } from '../deployment/http.js';
import { executeDeployment, type DeploymentOptions } from '../deployment/service.js';
import { DeploymentStore, validateDeploymentRecord, type DeploymentRecord } from '../deployment/state.js';
import type { ProviderName } from '../deployment/types.js';
import type { RailwayHttpTransport } from '../deployment/providers/railway.js';

export interface RecordFilters { provider?: ProviderName; target?: string }
export interface HealthResult {
  health: 'healthy' | 'unhealthy' | 'unavailable';
  lastChecked: string;
  detail: string;
}
export interface DeploymentRow {
  key: string;
  app: string;
  provider: ProviderName;
  deploymentStatus: DeploymentRecord['status'];
  statusSource: 'cached';
  statusRecordedAt: string;
  url?: string;
  health: HealthResult['health'] | 'unchecked';
  lastChecked: string | null;
}
export function validateFilters(filters: RecordFilters): void {
  if ((filters.provider !== undefined && !['railway', 'cloudrun'].includes(filters.provider)) ||
      (filters.target !== undefined && !projectNameSchema.safeParse(filters.target).success)) {
    throw new FastagentError('INVALID_ARGUMENTS', 'Select a valid --provider railway|cloudrun and/or --target name.', 2);
  }
}
export function recordRow(record: DeploymentRecord): DeploymentRow {
  return { key: record.key, app: record.target, provider: record.provider, deploymentStatus: record.status,
    statusSource: 'cached', statusRecordedAt: record.updatedAt, ...(record.url ? { url: record.url } : {}), health: 'unchecked', lastChecked: null };
}
export async function localSnapshot(filters: RecordFilters = {}, store = new DeploymentStore()) {
  validateFilters(filters);
  const snapshot = await store.list();
  const records = snapshot.records.filter((record) => (!filters.provider || record.provider === filters.provider) && (!filters.target || record.target === filters.target));
  return { records, rows: records.map(recordRow), diagnostics: snapshot.diagnostics };
}

/** Health is separate from recorded/provider deployment status and never invokes a model. */
export async function checkHealth(record: DeploymentRecord, options: { signal?: AbortSignal; http?: RailwayHttpTransport; now?: () => Date } = {}): Promise<HealthResult> {
  const lastChecked = (options.now ?? (() => new Date()))().toISOString();
  try {
    validateDeploymentRecord(record);
    if (!record.url) return { health: 'unavailable', lastChecked, detail: 'No recorded HTTPS URL.' };
    // Existing Railway apps keep /healthz; Cloud Run's public frontend can reserve z-suffixed paths.
    const path = record.provider === 'cloudrun' ? '/health' : '/healthz';
    const response = await (options.http ?? createDeploymentHttp(fetch, 5000))({ url: `${record.url}${path}`, method: 'GET', headers: {},
      signal: options.signal ?? new AbortController().signal, maxResponseBytes: 4096 });
    if (response.status !== 200 || !response.body || typeof response.body !== 'object' || Array.isArray(response.body) || (response.body as { ok?: unknown }).ok !== true) throw new Error();
    return { health: 'healthy', lastChecked, detail: `HTTPS ${path} returned ok:true; chat was not tested.` };
  } catch { return { health: 'unhealthy', lastChecked, detail: `Health request failed, timed out, or returned an invalid response; chat was not tested.${record.provider === 'cloudrun' ? ' Cloud Run requires an app GET /health endpoint returning {"ok":true}; add it to older apps and redeploy, retaining /healthz as an alias.' : ''}` }; }
}

export async function selectCheckRecord(options: RecordFilters & { cwd?: string }, store = new DeploymentStore()): Promise<DeploymentRecord> {
  validateFilters(options);
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  let target = options.target;
  if (target === undefined) {
    try { target = parseConfig(await readFile(resolve(cwd, 'fastagent.yaml'), 'utf8')).name; }
    catch (error) {
      if (error instanceof FastagentError) throw error;
      throw new FastagentError('CHECK_PROJECT_REQUIRED', 'Run check from a generated project with fastagent.yaml, or pass the recorded --target explicitly.');
    }
  }
  if (options.provider) {
    const record = await store.read({ projectPath: cwd, target, provider: options.provider });
    if (record) return record;
  } else {
    const matches = (await Promise.all((['railway', 'cloudrun'] as const)
      .map((provider) => store.read({ projectPath: cwd, provider, target }))))
      .filter((record): record is DeploymentRecord => record !== undefined);
    if (matches.length > 1) throw new FastagentError('DEPLOYMENT_AMBIGUOUS', 'Multiple recorded providers for this target; pass --provider explicitly.', 2);
    if (matches[0]) return matches[0];
  }
  throw new FastagentError('DEPLOYMENT_NOT_FOUND', 'No recorded deployment for this directory and target. Deploy first, or select --provider and --target.');
}

export type RecordActionOptions = Omit<DeploymentOptions, 'command' | 'cwd' | 'target' | 'provider' | 'envFiles' | 'dryRun' | 'yes' | 'interactive'> & RecordFilters;
export const actionInstructions = 'Status/logs require matching provider selectors; restart dashboard with --provider and:\nRailway: --workspace <id> --auth-file <ignored private env file> (prefer absolute path across projects).\nCloud Run: --project <id> --region <region> --runtime-account <email> --build-account <email>.\nUse native gcloud authentication for Cloud Run; records alone do not authorize provider operations.';
export function hasActionContext(record: DeploymentRecord, options: RecordActionOptions): boolean {
  return options.provider === record.provider && (record.provider === 'railway'
    ? !!options.workspace && !!options.authFile
    : !!options.project && !!options.region && !!options.runtimeAccount && !!options.buildAccount);
}
/** Provider work goes through the existing authenticated deployment service, never through the TUI. */
export async function recordAction(record: DeploymentRecord, command: 'status' | 'logs', options: RecordActionOptions,
  execute: typeof executeDeployment = executeDeployment): Promise<Record<string, unknown>> {
  validateDeploymentRecord(record);
  if (!hasActionContext(record, options)) throw new FastagentError('PROVIDER_CONTEXT_REQUIRED', actionInstructions, 2);
  if ((options.target !== undefined && options.target !== record.target) ||
      (record.provider === 'railway' && (options.workspace !== record.selectors.project || options.project !== undefined || options.region !== undefined || options.runtimeAccount !== undefined || options.buildAccount !== undefined)) ||
      (record.provider === 'cloudrun' && (options.project !== record.selectors.project || options.region !== record.selectors.region || options.workspace !== undefined || options.authFile !== undefined || options.railwayProject !== undefined || options.railwayEnvironment !== undefined))) {
    throw new FastagentError('DEPLOYMENT_TARGET_MISMATCH', 'Supplied selectors do not match this local record; no provider operation performed.', 2);
  }
  return execute({ ...options, command, provider: record.provider, cwd: record.projectPath, target: record.target });
}

export async function executeCheck(options: RecordFilters & { cwd?: string; signal?: AbortSignal }, dependencies: { store?: DeploymentStore; http?: RailwayHttpTransport } = {}) {
  const record = await selectCheckRecord(options, dependencies.store);
  const health = await checkHealth(record, { ...(options.signal ? { signal: options.signal } : {}), ...(dependencies.http ? { http: dependencies.http } : {}) });
  return { command: 'check', ...recordRow(record), ...health, chatTested: false };
}
