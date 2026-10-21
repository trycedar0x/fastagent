#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FastagentError } from './errors.js';
import { sendChat, validateChatMessage } from './chat/client.js';
import { initProject } from './scaffold/init.js';
import { devProject } from './dev/dev.js';
import { executeDeployment, formatDeploymentResult, type DeploymentCommand } from './deployment/service.js';
import { loadExplicitSecrets } from './deployment/secrets.js';
import { executeCheck, localSnapshot, type RecordActionOptions } from './checks/service.js';
import { runDashboard } from './dashboard/dashboard.js';
import { fetchOpenRouterCatalog, OpenRouterCatalogError, type OpenRouterCatalog } from './models/openrouter.js';

const help = `Fastagent — headless bearer-token chat applications

Usage:
  fastagent init <directory> [--name <name>] [--framework openai] [--json]
  fastagent dev [directory] [--install] [--json]
  fastagent models [--search <text>] [--limit <n>] [--tools] [--json]
  fastagent chat --url <origin> --env-file <file> [--message <text> | --stdin] [--conversation <id>] [--json]
  fastagent login --provider railway|cloudrun [--interactive] [--json]
  fastagent deploy --provider railway|cloudrun [--target <name>] [provider flags]
    [--env-file <file> ...] [--dry-run] [--json]  (env files auto-detected when omitted)
  fastagent status|logs --provider railway|cloudrun [--target <name>] [provider flags] [--json]
  fastagent destroy --provider railway|cloudrun [--target <name>] [provider flags] --yes [--json]
  fastagent check [--provider railway|cloudrun] [--target <name>] [--json]
  fastagent dashboard [--provider railway|cloudrun] [--target <name>] [provider flags] [--json]
  fastagent --help [--json]
  fastagent --version [--json]

init requires a new destination with an existing, non-symlink parent.
Name defaults to the directory basename; framework defaults to openai.
New apps use deployment.access token and the official OpenAI SDK. The Vercel AI SDK is not supported.
The product default model is openrouter/deepseek/deepseek-v4.1-flash. Existing protected apps are not rewritten.
Starting an agent requires OPENROUTER_API_KEY for openrouter models, or OPENAI_API_KEY for openai models, in the app's ignored .env file. Missing or blank keys prevent startup. Local models are not supported. init and builds need no credentials.
init and dev are implemented, alongside models/chat and login/deploy/status/logs/destroy.
models reads the public OpenRouter catalog. Prices are estimates with timestamps and source URLs; unknown prices stay unknown.
chat is headless. It reads FASTAGENT_API_TOKEN only from explicit --env-file paths, never from arguments or the shell.
Pass --message <text>, or --stdin (or --message -) to read piped stdin explicitly. Chat never reads stdin implicitly, so a coding-agent tool call cannot hang. --conversation resumes a server ID; omitting it starts a new conversation on every call. URL must be HTTPS or explicit localhost HTTP.
Redirects are refused so the bearer token cannot be sent to another origin. Chat can incur model charges.
Deployment commands use the current directory; target defaults to fastagent.yaml name.
Railway flags: --workspace <id> --auth-file <ignored-env-file>
  Account: RAILWAY_API_TOKEN. Project token: RAILWAY_TOKEN plus
  --railway-project <id> --railway-environment <id> (existing recorded targets only).
Cloud Run flags: --project <id> --region <region>
  --runtime-account <email> --build-account <email> (existing distinct identities).
Runtime secrets are loaded from explicit repeatable --env-file (Node env syntax), or, when no
--env-file is passed, auto-detected from the app directory's ignored .env then .env.auth only
(never .env.example, never the shell). Explicit --env-file always wins.
Token apps require FASTAGENT_API_TOKEN, the model key selected by fastagent.yaml, and exactly one
history backend: a TLS REDIS_URL, or FASTAGENT_EPHEMERAL_HISTORY=1 for single-instance in-memory
history that is lost on restart. Set both or neither and the deploy fails closed.
Existing protected apps still require FASTAGENT_PASSWORD_HASH, OPENAI_API_KEY, and TLS REDIS_URL.
Optional: exact APP_ORIGIN only after a URL is recorded; first deploy omits it and the CLI sets the provider origin.
Optional stable FASTAGENT_HISTORY_NAMESPACE (token) or FASTAGENT_SESSION_NAMESPACE (protected).
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
check --chat is not implemented (exit 2). Use fastagent chat for an explicit billable request.
dashboard requires a TTY; --json returns LOCAL cached records without network requests.
TTY keys: arrows select, R refresh health + explicit selected provider status when selectors/auth
are supplied, Enter open URL, L logs with selectors/auth, Q quit. Polling never calls models
or cloud status APIs. Recorded deployment status and HTTP health remain separate.
dev runs on explicit localhost HTTP; --install opts in to npm installation.
Token apps accept optional top-level maxOutputTokens in fastagent.yaml: integer 1–16384, default 4096 per model step (up to three steps). Higher caps permit higher cost/latency; reasoning may share the budget. Restart/redeploy after changes. OUTPUT_TOKEN_LIMIT means request a shorter reply or ask the owner to raise this setting; no automatic retries.
Local dev inherits environment variables, which override .env.auth, then .env. Restart after file edits; unset conflicting inherited values without printing secrets. Local history disappears on restart. chat/deploy never inherit credentials from the shell.
dev --json prints one {"ok":true,"command":"dev","url":...} line once the server listens, then runs until stopped.
There is no native iMessage integration. A separate Mac-side bridge can call this API; cloud hosts cannot access Apple Messages.
Version 0.2.0 provides headless bearer-token apps. Published npm 0.1.0 is the previous password-protected app.
JSON results are written to stdout, including errors; text errors use stderr.
Exit codes: 0 success, 1 operation/configuration failure, 2 invalid arguments;
130 SIGINT and 143 SIGTERM for deployment/check/dashboard/chat (deployment checkpoints retained).
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
          url: { type: 'string' },
          message: { type: 'string' },
          stdin: { type: 'boolean' },
          conversation: { type: 'string' },
          search: { type: 'string' },
          limit: { type: 'string' },
          tools: { type: 'boolean' },
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
    if (positionals[0] !== 'models' && ['search', 'limit', 'tools'].some((key) => values[key as keyof typeof values] !== undefined)) {
      throw new FastagentError('INVALID_ARGUMENTS', 'Model catalog flags are supported only by models.', 2);
    }
    if (positionals[0] !== 'chat' && ['url', 'message', 'stdin', 'conversation'].some((key) => values[key as keyof typeof values] !== undefined)) {
      throw new FastagentError('INVALID_ARGUMENTS', 'Chat flags are supported only by chat.', 2);
    }
    if (values.chat !== undefined) {
      if (positionals[0] === 'check') throw new FastagentError('CHAT_CHECK_UNSUPPORTED', 'check --chat is not implemented. check tests health only, not model keys or tools. Use fastagent chat for an explicit manual model test (billable).', 2);
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
    if (positionals[0] === 'models') {
      if (positionals.length !== 1 || ['name', 'framework', 'install', 'provider', 'target', 'workspace', 'project', 'region', 'runtime-account', 'build-account', 'railway-project', 'railway-environment', 'env-file', 'auth-file', 'dry-run', 'yes', 'interactive'].some((key) => values[key as keyof typeof values] !== undefined)) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Usage: fastagent models [--search <text>] [--limit <n>] [--tools] [--json]', 2);
      }
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      if (values.limit !== undefined && (!/^\d+$/.test(values.limit) || limit !== Number(values.limit))) {
        throw new FastagentError('INVALID_ARGUMENTS', 'models --limit must be an integer from 1 to 1000.', 2);
      }
      let catalog: OpenRouterCatalog;
      try {
        catalog = await fetchOpenRouterCatalog({
          ...(values.search === undefined ? {} : { search: values.search }),
          ...(limit === undefined ? {} : { limit }),
          ...(values.tools ? { toolsOnly: true } : {}),
        });
      } catch (error) {
        if (error instanceof OpenRouterCatalogError) throw new FastagentError('CATALOG_UNAVAILABLE', error.message);
        if (error instanceof Error && /Invalid model catalog filter/.test(error.message)) throw new FastagentError('INVALID_ARGUMENTS', 'Invalid models filter. Limit is 1–1000 and search is at most 200 characters.', 2);
        throw error;
      }
      process.stdout.write(json ? JSON.stringify({ ok: true, command: 'models', ...catalog }) + '\n' : formatModels(catalog));
      return;
    }
    if (positionals[0] === 'chat') {
      if (positionals.length !== 1 || !values.url || !values['env-file']?.length || ['name', 'framework', 'install', 'provider', 'target', 'workspace', 'project', 'region', 'runtime-account', 'build-account', 'railway-project', 'railway-environment', 'auth-file', 'dry-run', 'yes', 'interactive', 'search', 'limit', 'tools'].some((key) => values[key as keyof typeof values] !== undefined)) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Usage: fastagent chat --url <origin> --env-file <file> [--message <text> | --stdin] [--conversation <id>] [--json]', 2);
      }
      if (values.stdin === true && values.message !== undefined) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Pass either --message <text> or --stdin, not both.', 2);
      }
      // No implicit stdin: an agent tool call must fail fast rather than block on an unclosed pipe.
      const useStdin = values.stdin === true || values.message === '-';
      if (!useStdin && !values.message) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Chat needs an explicit message: pass --message <text>, or --stdin (or --message -) to read piped stdin. Chat never reads stdin implicitly.', 2);
      }
      const controller = new AbortController();
      let signalCode: number | undefined;
      const interrupt = () => { signalCode = 130; controller.abort(); };
      const terminate = () => { signalCode = 143; controller.abort(); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
      try {
        const cwd = resolve(process.cwd());
        const loaded = await loadExplicitSecrets(values['env-file'], cwd, ['FASTAGENT_API_TOKEN'], []);
        const token = loaded.FASTAGENT_API_TOKEN;
        if (!token) throw new FastagentError('CHAT_AUTH_INVALID', 'Explicit env file must assign FASTAGENT_API_TOKEN. It is not read from arguments or the shell.');
        const message = useStdin ? await readChatStdin() : values.message!;
        const result = await sendChat({ url: values.url, token, message, ...(values.conversation ? { conversationId: values.conversation } : {}), signal: controller.signal });
        process.stdout.write(json ? JSON.stringify({ ok: true, command: 'chat', ...result }) + '\n' : `conversation: ${result.conversationId}\n${result.text}\n`);
      } finally {
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
        if (signalCode) process.exitCode = signalCode;
      }
      return;
    }
    if (deploymentFlags.some((key) => values[key as keyof typeof values] !== undefined)) throw new FastagentError('INVALID_ARGUMENTS', 'Deployment flags are supported only by deployment commands.', 2);
    if (positionals[0] === 'dev') {
      if (positionals.length > 2 || values.name !== undefined || values.framework !== undefined) {
        throw new FastagentError('INVALID_ARGUMENTS', 'Usage: fastagent dev [directory] [--install]', 2);
      }
      process.exitCode = await devProject({
        ...(positionals[1] === undefined ? {} : { directory: positionals[1] }),
        ...(values.install === undefined ? {} : { install: values.install }),
        ...(json ? { json } : {}),
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
      : `Created scaffold at ${result.directory}\nFramework: ${result.framework}\nGenerated an ignored .env.auth with a random bearer token. Before starting, add OPENROUTER_API_KEY to ignored .env (or OPENAI_API_KEY for direct OpenAI). Local models are not supported. See README.md.\n`);
  } catch (error) {
    const safe = error instanceof FastagentError
      ? error
      : new FastagentError('INTERNAL_ERROR', 'Operation failed. Check installation and filesystem permissions.');
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } }) + '\n');
    else process.stderr.write(`Error [${safe.code}]: ${safe.message}\n`);
    process.exitCode ??= safe.exitCode;
  }
}

function formatModels(catalog: OpenRouterCatalog): string {
  const lines = catalog.models.map((model) => {
    const tools = model.supportsTools === null ? 'tools unknown' : model.supportsTools ? 'tools' : 'no tools';
    const input = model.inputUsdPerMillion === null ? 'input unknown' : `input ~$${model.inputUsdPerMillion}/M`;
    const output = model.outputUsdPerMillion === null ? 'output unknown' : `output ~$${model.outputUsdPerMillion}/M`;
    return `${model.reference}  ${tools}  ${input}  ${output}  ${model.sourceUrl}`;
  });
  return [`OpenRouter catalog ${catalog.sourceUrl}`, `Fetched ${catalog.fetchedAt}; prices are estimates, not spending caps.`, ...lines, ''].join('\n');
}

async function readChatStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_000) throw new FastagentError('CHAT_INPUT_INVALID', 'Chat message must be 1–4000 non-blank characters.', 2);
    chunks.push(buffer);
  }
  return validateChatMessage(Buffer.concat(chunks).toString('utf8'));
}

await run();
