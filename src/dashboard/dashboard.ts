import { emitKeypressEvents } from 'node:readline';
import type { EventEmitter } from 'node:events';
import { FastagentError } from '../errors.js';
import { actionInstructions, checkHealth, hasActionContext, localSnapshot, recordAction, recordRow,
  type DeploymentRow, type HealthResult, type RecordActionOptions } from '../checks/service.js';
import type { DeploymentRecord } from '../deployment/state.js';
import { openDeploymentUrl } from './open.js';

type Input = NodeJS.ReadStream;
type Output = NodeJS.WriteStream;
export interface DashboardDependencies {
  input?: Input;
  output?: Output;
  signals?: Pick<EventEmitter, 'on' | 'off'>;
  snapshot?: typeof localSnapshot;
  health?: typeof checkHealth;
  action?: typeof recordAction;
  open?: typeof openDeploymentUrl;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** Native terminal view: local records, cached status, health-only periodic polling. */
export async function runDashboard(options: RecordActionOptions = {}, dependencies: DashboardDependencies = {}): Promise<number> {
  const input = dependencies.input ?? process.stdin, output = dependencies.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new FastagentError('TTY_REQUIRED', 'dashboard requires an interactive terminal. Use fastagent dashboard --json for a local cached snapshot, or fastagent check --json for health.', 2);
  }
  const signals = dependencies.signals ?? process;
  const snapshot = dependencies.snapshot ?? localSnapshot, health = dependencies.health ?? checkHealth;
  const action = dependencies.action ?? recordAction, open = dependencies.open ?? openDeploymentUrl;
  const setTimer = dependencies.setTimer ?? setTimeout, clearTimer = dependencies.clearTimer ?? clearTimeout;
  const controller = new AbortController();
  const initial = await snapshot(options);
  let records = initial.records, diagnostics = initial.diagnostics, selected = 0, notice = 'HTTP health only; chat is never polled.', stopped = false, exitCode = 0;
  const healthResults = new Map<string, HealthResult>();
  let healthCursor = 0;
  let inFlight: Promise<void> | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: FastagentError | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const priorRaw = input.isRaw ?? false, priorFlowing = input.readableFlowing;
  let terminalRestored = false;
  const restoreTerminal = () => {
    if (terminalRestored) return;
    terminalRestored = true;
    try { input.setRawMode(priorRaw); } catch { /* A disconnected terminal cannot be restored. */ }
    if (priorFlowing !== true) input.pause();
    try { output.write('\x1b[?25h\x1b[?1049l'); } catch { /* Disconnected output. */ }
  };
  const stop = (code = 0) => {
    if (stopped) return;
    stopped = true; exitCode = code; controller.abort(); clearTimer(pollTimer); clearTimer(operationTimer); resolveExit();
  };
  const fail = () => { failure = new FastagentError('DASHBOARD_FAILED', 'Dashboard failed; terminal restored. Retry, or use dashboard --json.'); stop(1); };
  const render = () => {
    if (stopped) return;
    const width = Math.max(20, Math.min(output.columns || 120, 240));
    const line = (value: string) => clean(value).slice(0, width);
    const maxRows = Math.max(1, Math.min((output.rows || 24) - 9, 100));
    const start = Math.max(0, selected - maxRows + 1);
    const rows: DeploymentRow[] = records.slice(start, start + maxRows).map((record) => ({ ...recordRow(record), ...healthResults.get(record.key) }));
    const lines = ['Fastagent — LOCAL recorded deployments (not cloud discovery)',
      'App                  Provider   Status(cached) Health      URL                              Last checked',
      ...rows.map((row, index) => `${start + index === selected ? '>' : ' '} ${row.app.padEnd(20).slice(0, 20)} ${row.provider.padEnd(10)} ${row.deploymentStatus.padEnd(14)} ${row.health.padEnd(11)} ${(row.url ?? '-').padEnd(32).slice(0, 32)} ${row.lastChecked ?? '-'}`),
      ...(!records.length ? ['No local deployments. Deploy from a generated project first.'] : []),
      `Showing ${records.length ? start + 1 : 0}-${Math.min(start + maxRows, records.length)} of ${records.length}. Status remains cached unless R explicitly queries a provider.`,
      '↑/↓ select  R refresh  Enter open  L logs  Q quit (R: health + selected status with provider context)',
      inFlight ? 'Refreshing (bounded, no overlapping operations)…' : 'Health poll: every 15s after completion; 5s per request, 30s per refresh.',
      ...diagnostics, ...notice.split('\n').slice(0, 4)];
    output.write('\x1b[H\x1b[2J' + lines.map(line).join('\r\n'));
  };
  const schedule = () => {
    if (!stopped) pollTimer = setTimer(() => { startOperation('poll'); }, 15_000);
  };
  const refreshHealth = async (signal: AbortSignal) => {
    const fresh = await snapshot(options);
    const selectedKey = records[selected]?.key;
    records = fresh.records; diagnostics = fresh.diagnostics;
    selected = Math.max(0, records.findIndex((record) => record.key === selectedKey));
    let next = 0;
    const start = records.length ? healthCursor % records.length : 0;
    await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
      while (!signal.aborted && next < records.length) {
        const record = records[(start + next++) % records.length]!;
        healthResults.set(record.key, await health(record, { signal }));
        render();
      }
    }));
    healthCursor = records.length ? (start + next) % records.length : 0;
    for (const key of healthResults.keys()) if (!records.some((record) => record.key === key)) healthResults.delete(key);
    if (signal.aborted && !stopped) notice = 'Refresh budget reached; unchecked/previous results remain visible. Next poll continues remaining rows.';
  };
  const startOperation = (kind: 'poll' | 'refresh' | 'logs' | 'open') => {
    if (stopped || inFlight) return;
    clearTimer(pollTimer);
    const operation = new AbortController();
    const abort = () => operation.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    operationTimer = setTimer(abort, 30_000);
    const record = records[selected];
    inFlight = (async () => {
      try {
        if (kind === 'open') {
          if (!record?.url) notice = 'Selected record has no HTTPS URL.';
          else { await open(record.url, { signal: operation.signal }); notice = 'Opened the recorded HTTPS URL.'; }
        } else if (kind === 'logs' || kind === 'refresh') {
          if (!record) notice = 'No deployment selected.';
          else if (!hasActionContext(record, options)) notice = actionInstructions;
          else {
            const result = await action(record, kind === 'logs' ? 'logs' : 'status', { ...options, signal: operation.signal });
            notice = kind === 'logs' ? `Logs (first 3 lines; use fastagent logs for the full bounded output):\n${String(result.logs ?? '').slice(0, 4000)}`
              : result.remoteStatusVerified === false ? 'Provider status could not be verified. The displayed checkpoint is cached; run fastagent recover with the same provider flags for diagnostics.'
              : `Explicit provider status for ${record.provider}/${record.target}: ${clean(String(result.status ?? 'unknown'))}. Recorded status remains cached.`;
          }
          if (kind === 'refresh' && !operation.signal.aborted) await refreshHealth(operation.signal);
        } else await refreshHealth(operation.signal);
      } catch (error) {
        // Provider errors are already redacted, but do not display private request/response content.
        notice = error instanceof FastagentError && ['PROVIDER_CONTEXT_REQUIRED', 'DEPLOYMENT_TARGET_MISMATCH'].includes(error.code)
          ? error.message : 'Operation failed or timed out. Check selectors/authentication; other rows remain usable.';
      }
    })().finally(() => {
      clearTimer(operationTimer); controller.signal.removeEventListener('abort', abort); inFlight = undefined;
      if (!stopped) { render(); schedule(); }
    });
    render();
    void inFlight.catch(fail);
  };
  const keypress = (_text: string, key: { name?: string; ctrl?: boolean } = {}) => {
    try {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) stop(key.ctrl ? 130 : 0);
      else if (key.name === 'up' || key.name === 'down') {
        selected = Math.max(0, Math.min(records.length - 1, selected + (key.name === 'up' ? -1 : 1))); render();
      } else if (key.name === 'r') startOperation('refresh');
      else if (key.name === 'l') startOperation('logs');
      else if (key.name === 'return') startOperation('open');
    } catch { fail(); }
  };
  const interrupt = () => stop(130), terminate = () => stop(143), hangup = () => stop(129), quit = () => stop(131), end = () => stop();
  const processExit = () => { stop(); restoreTerminal(); };
  try {
    input.on('error', fail); output.on('error', fail);
    signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate);
    signals.on('SIGHUP', hangup); signals.on('SIGQUIT', quit); signals.on('exit', processExit);
    input.on('end', end); input.on('close', end);
    emitKeypressEvents(input); input.on('keypress', keypress);
    input.setRawMode(true); input.resume();
    output.write('\x1b[?1049h\x1b[?25l');
    render(); startOperation('poll');
    await exited;
  } catch { fail(); }
  finally {
    stop(exitCode);
    input.off('keypress', keypress); input.off('error', fail); output.off('error', fail);
    input.off('end', end); input.off('close', end);
    signals.off('SIGINT', interrupt); signals.off('SIGTERM', terminate);
    signals.off('SIGHUP', hangup); signals.off('SIGQUIT', quit); signals.off('exit', processExit);
    restoreTerminal();
    await inFlight?.catch(() => {});
  }
  if (failure) throw failure;
  return exitCode;
}
