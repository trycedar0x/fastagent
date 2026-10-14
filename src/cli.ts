#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { FastagentError } from './errors.js';
import { initProject } from './scaffold/init.js';
import { devProject } from './dev/dev.js';
import { executeDeployment, formatDeploymentResult, type DeploymentCommand } from './deployment/service.js';
import { executeCheck, localSnapshot, type RecordActionOptions } from './checks/service.js';
import { runDashboard } from './dashboard/dashboard.js';

const help = `Fastagent — local protected chat applications

Usage:
  fastagent init <directory> [--name <name>] [--framework openai] [--json]
  fastagent dev [directory] [--install]
  fastagent login --provider railway|cloudrun [--interactive] [--json]
  fastagent deploy --provider railway|cloudrun [--target <name>] [provider flags]
    --env-file <file> [--env-file <file> ...] [--dry-run] [--json]
  fastagent status|logs --provider railway|cloudrun [--target <name>] [provider flags] [--json]
  fastagent destroy --provider railway|cloudrun [--target <name>] [provider flags] --yes [--json]
  fastagent check [--provider railway|cloudrun] [--target <name>] [--json]
  fastagent dashboard [--provider railway|cloudrun] [--target <name>] [provider flags] [--json]
  fastagent --help [--json]
  fastagent --version [--json]

init requires a new destination with an existing, non-symlink parent.
Name defaults to the directory basename; framework defaults to openai.
The only model adapter is the official OpenAI SDK. The Vercel AI SDK is not supported.
init and dev are implemented, alongside login/deploy/status/logs/destroy.
Deployment commands use the current directory; target defaults to fastagent.yaml name.
Railway flags: --workspace <id> --auth-file <ignored-env-file>
  Account: RAILWAY_API_TOKEN. Project token: RAILWAY_TOKEN plus
  --railway-project <id> --railway-environment <id> (existing recorded targets only).
Cloud Run flags: --project <id> --region <region>
  --runtime-account <email> --build-account <email> (existing distinct identities).
Runtime secrets are loaded ONLY from explicit repeatable --env-file (Node env syntax).
Required: FASTAGENT_PASSWORD_HASH, OPENAI_API_KEY, TLS REDIS_URL.
Optional: exact APP_ORIGIN only after a URL is recorded; first deploy omits it and the CLI sets the provider origin. Optional stable FASTAGENT_SESSION_NAMESPACE.
Project-local secret files must be root .env or .env.* (not .env.example).
No runtime variables or Railway tokens are inherited. Native gcloud config is used.
Railway login prints token instructions, not an authentication claim.
Cloud Run login --interactive opts into native browser login (terminal, no --json).
Dry run validates secrets/source and prints a manifest; no provider calls or resource changes.
Deploy is billable; user-owned TLS Redis and cloud prerequisites are required.
Cloud Run grants only app-secret access to the runtime account and public service invocation;
no API enablement, billing setup or broad IAM grants. Logs may withhold payloads for safety.
Destroy requires --yes and verified ownership; retained shared/build resources may remain billable.
check reads the current project's saved target and requests bounded HTTPS /healthz only.
If both providers are recorded, select --provider. Health does not certify model keys/tools.
--chat is deferred (exit 2); manually test protected chat in the browser instead.
dashboard requires a TTY; --json returns LOCAL cached records without network requests.
TTY keys: arrows select, R refresh health + explicit selected provider status when selectors/auth
are supplied, Enter open URL, L logs with selectors/auth, Q quit. Polling never calls models
or cloud status APIs. Recorded deployment status and HTTP health remain separate.
dev runs on explicit localhost HTTP; --install opts in to npm installation.
JSON dev is unsupported; readiness is announced by the running server.
JSON results are written to stdout, including errors; text errors use stderr.
Exit codes: 0 success, 1 operation/configuration failure, 2 invalid arguments;
130 SIGINT and 143 SIGTERM for deployment/check/dashboard (deployment checkpoints retained).
Dashboard also handles SIGHUP (129) and SIGQUIT (131), restoring terminal state.
`;

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  let json = args.includes('--json');
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'v' },
          json: { type: 'boolean' },
          name: { type: 'string' },
          framework: { type: 'string' },
          install: { type: 'boolean' },
          provider: { type: 'string' },
          target: { type: 'string' },
          workspace: { type: 'string' },
          project: { type: 'string' },
          region: { type: 'string' },
          'runtime-account': { type: 'string' },
          'build-account': { type: 'string' },
          'railway-project': { type: 'string' },
          'railway-environment': { type: 'string' },
          'env-file': { type: 'string', multiple: true },
          'auth-file': { type: 'string' },
          'dry-run': { type: 'boolean' },
          yes: { type: 'boolean' },
          interactive: { type: 'boolean' },
          chat: { type: 'boolean' },
        },
      });
    } catch {
      throw new FastagentError('INVALID_ARGUMENTS', 'Invalid options. Run fastagent --help for supported syntax.', 2);
    }
    const { values, positionals } = parsed;
    json = values.json ?? false;
    if (values.help || (args.length === 0)) {
      process.stdout.write(json ? JSON.stringify({ ok: true, command: 'help', help }) + '\n' : help);
      return;
    }
    if (values.version) {
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      process.stdout.write(json ? JSON.stringify({ ok: true, command: 'version', version: metadata.version }) + '\n' : `${metadata.version}\n`);
      return;
    }
    if (values.chat !== undefined) {
      if (positionals[0] === 'check') throw new FastagentError('CHAT_CHECK_UNSUPPORTED', 'check --chat is not implemented. check tests health only, not model keys or tools. Open the protected chat UI for an explicit manual model test (billable).', 2);
      throw new FastagentError('INVALID_ARGUMENTS', '--chat is recognized only by check and is not implemented.', 2);
    }
    const deploymentFlags = ['provider', 'target', 'workspace', 'project', 'region', 'runtime-account', 'build-account', 'railway-project', 'railway-environment', 'env-file', 'auth-file', 'dry-run', 'yes', 'interactive'];
    if (positionals[0] === 'check' || positionals[0] === 'dashboard') {
      const command = positionals[0];
      const providerContextFlags = ['workspace', 'project', 'region', 'runtime-account', 'build-account', 'railway-project', 'railway-environment', 'auth-file'];
      if (positionals.length !== 1 || ['name', 'framework', 'install', 'env-file', 'dry-run', 'yes', 'interactive'].some((key) => values[key as keyof typeof values] !== undefined) ||
          (values.provider !== undefined && !['railway', 'cloudrun'].includes(values.provider)) ||
          ((command === 'check' || json) && providerContextFlags.some((key) => values[key as keyof typeof values] !== undefined)) ||
          (providerContextFlags.some((key) => values[key as keyof typeof values] !== undefined) && values.provider === undefined) ||
          (values.provider === 'cloudrun' && ['workspace', 'auth-file', 'railway-project', 'railway-environment'].some((key) => values[key as keyof typeof values] !== undefined)) ||
          (values.provider === 'railway' && ['project', 'region', 'runtime-account', 'build-account'].some((key) => values[key as keyof typeof values] !== undefined))) {
        throw new FastagentError('INVALID_ARGUMENTS', 'check/dashboard use local records. check and dashboard --json accept only --provider/--target. Interactive dashboard optionally accepts matching provider status/logs flags. See --help.', 2);
      }
      const options: RecordActionOptions = {
        ...(values.provider === undefined ? {} : { provider: values.provider as 'railway' | 'cloudrun' }),
        ...(values.target === undefined ? {} : { target: values.target }),
        ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
        ...(values.project === undefined ? {} : { project: values.project }),
        ...(values.region === undefined ? {} : { region: values.region }),
        ...(values['runtime-account'] === undefined ? {} : { runtimeAccount: values['runtime-account'] }),
        ...(values['build-account'] === undefined ? {} : { buildAccount: values['build-account'] }),
        ...(values['railway-project'] === undefined ? {} : { railwayProject: values['railway-project'] }),
        ...(values['railway-environment'] === undefined ? {} : { railwayEnvironment: values['railway-environment'] }),
        ...(values['auth-file'] === undefined ? {} : { authFile: values['auth-file'] }),
      };
      if (command === 'dashboard' && json) {
        const snapshot = await localSnapshot(options);
        process.stdout.write(JSON.stringify({ ok: true, command, localOnly: true, rows: snapshot.rows, diagnostics: snapshot.diagnostics }) + '\n');
      } else if (command === 'dashboard') process.exitCode = await runDashboard(options);
      else {
        const controller = new AbortController();
        let signalCode: number | undefined;
        const interrupt = () => { signalCode = 130; controller.abort(); };
        const terminate = () => { signalCode = 143; controller.abort(); };
        process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
        try {
          const result = await executeCheck({ ...options, signal: controller.signal });
          const ok = result.health === 'healthy';
          process.stdout.write(json ? JSON.stringify({ ok, ...result }) + '\n'
            : `${result.provider}/${result.app}: deployment ${result.deploymentStatus} (cached); health ${result.health}\n${result.detail}\nLast checked: ${result.lastChecked}\n`);
          if (!ok) process.exitCode = 1;
        } finally {
          process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
          if (signalCode) process.exitCode = signalCode;
        }
      }
      return;
    }
    if (['login', 'deploy', 'status', 'logs', 'destroy'].includes(positionals[0] ?? '')) {
      if (positionals.length !== 1 || values.name !== undefined || values.framework !== undefined || values.install !== undefined || !['railway', 'cloudrun'].includes(values.provider ?? '')) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Deployment commands require --provider railway|cloudrun and use the current directory. See --help.', 2);
      }
      const controller = new AbortController();
      let signalCode: number | undefined;
      const interrupt = () => { signalCode = 130; controller.abort(); };
      const terminate = () => { signalCode = 143; controller.abort(); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
      try {
        const result = await executeDeployment({ command: positionals[0] as DeploymentCommand, provider: values.provider as 'railway' | 'cloudrun', json,
          signal: controller.signal,
          ...(values.target === undefined ? {} : { target: values.target }),
          ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
          ...(values.project === undefined ? {} : { project: values.project }),
          ...(values.region === undefined ? {} : { region: values.region }),
          ...(values['runtime-account'] === undefined ? {} : { runtimeAccount: values['runtime-account'] }),
          ...(values['build-account'] === undefined ? {} : { buildAccount: values['build-account'] }),
          ...(values['railway-project'] === undefined ? {} : { railwayProject: values['railway-project'] }),
          ...(values['railway-environment'] === undefined ? {} : { railwayEnvironment: values['railway-environment'] }),
          ...(values['env-file'] === undefined ? {} : { envFiles: values['env-file'] }),
          ...(values['auth-file'] === undefined ? {} : { authFile: values['auth-file'] }),
          ...(values['dry-run'] === undefined ? {} : { dryRun: values['dry-run'] }),
          ...(values.yes === undefined ? {} : { yes: values.yes }),
          ...(values.interactive === undefined ? {} : { interactive: values.interactive }),
        });
        process.stdout.write(json ? JSON.stringify({ ok: true, ...result }) + '\n' : formatDeploymentResult(result));
      } finally {
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
        if (signalCode) process.exitCode = signalCode;
      }
      return;
    }
    if (deploymentFlags.some((key) => values[key as keyof typeof values] !== undefined)) throw new FastagentError('INVALID_ARGUMENTS', 'Deployment flags are supported only by deployment commands.', 2);
    if (positionals[0] === 'dev') {
      if (json) throw new FastagentError('JSON_UNSUPPORTED', 'dev does not support --json; run it in text mode.', 2);
      if (positionals.length > 2 || values.name !== undefined || values.framework !== undefined) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Usage: fastagent dev [directory] [--install]', 2);
      }
      process.exitCode = await devProject({
        ...(positionals[1] === undefined ? {} : { directory: positionals[1] }),
        ...(values.install === undefined ? {} : { install: values.install }),
      });
      return;
    }
    if (positionals[0] !== 'init') {
      throw new FastagentError('UNKNOWN_COMMAND', 'Unsupported command. Run fastagent --help for implemented commands.', 2);
    }
    if (values.install !== undefined) throw new FastagentError('INVALID_ARGUMENTS', '--install is supported only by dev.', 2);
    if (positionals.length !== 2 || !positionals[1]) {
      throw new FastagentError('INVALID_ARGUMENTS', 'Usage: fastagent init <directory> [--name <name>] [--framework openai] [--json]', 2);
    }
    const result = await initProject({
      directory: positionals[1],
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.framework === undefined ? {} : { framework: values.framework }),
    });
    process.stdout.write(json
      ? JSON.stringify({ ok: true, command: 'init', ...result }) + '\n'
      : `Created scaffold at ${result.directory}\nFramework: ${result.framework}\nRunnable protected chat template; configure access and model secrets as described in README.md.\n`);
  } catch (error) {
    const safe = error instanceof FastagentError
      ? error
      : new FastagentError('INTERNAL_ERROR', 'Operation failed. Check installation and filesystem permissions.');
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } }) + '\n');
    else process.stderr.write(`Error [${safe.code}]: ${safe.message}\n`);
    process.exitCode ??= safe.exitCode;
  }
}

await run();
