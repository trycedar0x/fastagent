# User guide

This guide takes you from a local project to a chat URL. The app uses the official OpenAI SDK and runs in your own cloud account.

Fastagent creates the starting code. You or your coding assistant write the prompt and tools. The CLI does not use a model to generate your business logic.

![Create, customize, and run locally; then preview, deploy, and inspect](diagrams/workflow.svg)

[Editable Excalidraw source](diagrams/workflow.excalidraw)

## 1. Build the CLI

You need Node.js 22+ and npm. In the Fastagent repository:

```sh
npm ci
npm run build
node dist/cli.js --help
```

These commands build the CLI; they do not install it globally. This guide uses `node dist/cli.js` from the repository, and `node /path/to/fastagent/dist/cli.js` from an app directory. Replace that placeholder with the actual absolute path.

If `fastagent` is already on your PATH, you can use it instead.

## 2. Create an app

In the Fastagent repository:

```sh
node dist/cli.js init ./my-agent --name my-agent --framework openai
```

The target directory must not exist, and its parent must exist. Names use lowercase letters, digits, and hyphens, up to 63 characters. Existing files are never overwritten.

You do not need an API key, GitHub, Redis, Docker, or a cloud account for this step.

The app includes:

- `src/agent.ts`: prompt and OpenAI model adapter.
- `src/tools.ts`: predefined tools; the example converts temperatures.
- Server, authentication, session storage, and browser UI.
- `fastagent.yaml`, package files, and a Dockerfile.
- README, contributor instructions, and ignored local secret files.

Edit the app yourself or ask Claude Code or Codex:

> Make this a weather assistant using my weather API. Keep authentication, health checks, and deployment working.

Your coding assistant operates the local CLI. It is not the agent running in the deployed app.

## 3. Run locally

In the generated app directory:

```sh
cd my-agent
npm install
npm run hash-password
```

Enter a password in the terminal. The helper hides the input and writes only its salted hash to `.env.auth`. It refuses to overwrite an existing file.

Create an ignored `.env` containing your `OPENAI_API_KEY`. Do not commit, paste into logs, or pass the key as a command argument.

Back in the Fastagent repository:

```sh
node dist/cli.js dev ./my-agent
```

Open the URL printed by the server and log in. Stop with Ctrl-C.

- Local development uses memory sessions; Redis is not required.
- Real chats can incur OpenAI charges.
- There is no hot reload. Restart after changes.
- `--install` explicitly allows the CLI to install app dependencies.
- Local HTTP binds to IPv4 loopback. Do not expose or tunnel it.

## 4. Prepare for deployment

You need your own cloud account, billing, provider CLI, and a TLS Redis service. Fastagent does not create Redis, enable billing, or set up all cloud permissions.

Use two runtime secret files in the app directory, plus a separate authentication file if you deploy to Railway:

| File | Contents |
| --- | --- |
| `.env` | `OPENAI_API_KEY` and `REDIS_URL` |
| `.env.auth` | `FASTAGENT_PASSWORD_HASH`, written by the password helper |
| `.env.railway` | Railway token, only when using Railway |

Use a `rediss://` Redis URL for production. Keep every secret file ignored. Omit empty optional assignments and do not use `.env.example` as a secret file.

Pass **both** runtime files: `--env-file .env --env-file .env.auth`. The CLI does not inherit runtime secrets or Railway tokens from your shell.

Leave `APP_ORIGIN` unset on the first deploy. Fastagent sets it to the exact provider HTTPS origin before opening chat access. If supplied for an update, it must match the recorded URL exactly: no path, trailing slash, query, or credentials.

![Runtime secrets and provider authentication are separate from the filtered source upload](diagrams/deployment.svg)

[Editable Excalidraw source](diagrams/deployment.excalidraw). Solid arrows show runtime configuration and source flow; dashed arrows show the provider-specific authentication options.

## 5. Deploy to Railway

Install the Railway CLI and prepare your workspace ID. Store an account/workspace API token as `RAILWAY_API_TOKEN` in ignored `.env.railway`.

Run these commands **from the app directory**:

```sh
node /path/to/fastagent/dist/cli.js login --provider railway

node /path/to/fastagent/dist/cli.js deploy \
  --provider railway --workspace WORKSPACE_ID \
  --auth-file .env.railway \
  --env-file .env --env-file .env.auth \
  --dry-run
```

Railway `login` prints token instructions; it does not authenticate you or confirm that the token works.

Review the dry-run output. Remove `--dry-run` to create or update the actual cloud app. This may incur charges.

An environment-scoped `RAILWAY_TOKEN` entry in the explicit `--auth-file` only works for an already recorded target, with `--railway-project` and `--railway-environment`. Both token types are read from the file, not from exported shell variables. First deployment and deletion require an account token.

Railway provides variables to its build infrastructure as well as the runtime. The bundled Dockerfile does not consume secret build arguments, and upload filtering excludes local secret files. This is not a promise that the platform's build infrastructure never receives the variables.

## 6. Deploy to Cloud Run

Install `gcloud`. Prepare your project, billing, required APIs and permissions, and two existing, distinct service accounts: runtime and build.

Run these commands **from the app directory**:

```sh
node /path/to/fastagent/dist/cli.js login \
  --provider cloudrun --interactive

node /path/to/fastagent/dist/cli.js deploy \
  --provider cloudrun --project PROJECT_ID --region REGION \
  --runtime-account RUNTIME_EMAIL --build-account BUILD_EMAIL \
  --env-file .env --env-file .env.auth \
  --dry-run
```

Interactive login opens the native gcloud login flow and requires a terminal. It does not support `--json`.

Review the dry run, then remove `--dry-run` when you want to deploy. Fastagent uses Secret Manager for app secrets. It grants the runtime account access to app-owned secrets and allows public invocation of the password-protected service. It does not automatically grant broad project roles.

## 7. Update, inspect, or delete

Deployment commands use the current app directory. `--target` defaults to the app name in `fastagent.yaml`.

Repeat `deploy` with the same provider and target to update the recorded deployment. If an earlier mutation had an unknown result, the CLI may stop for manual reconciliation rather than risk duplicate resources.

For `status`, `logs`, and `destroy`, use the same provider flags and authentication as deployment, but omit the runtime `--env-file` flags.

```sh
# Example: inspect a Railway deployment
node /path/to/fastagent/dist/cli.js status \
  --provider railway --workspace WORKSPACE_ID \
  --auth-file .env.railway --json
```

Deletion requires `destroy ... --yes`. It only deletes resources whose ownership can be verified. Projects, shared resources, images, and build history may remain and continue costing money.

Cloud Run logs show timestamps and severity only. Application payloads are withheld because they may contain secrets.

## 8. Check health and use the dashboard

From the app directory:

```sh
node /path/to/fastagent/dist/cli.js check --provider railway --json
node /path/to/fastagent/dist/cli.js dashboard
node /path/to/fastagent/dist/cli.js dashboard --json
```

`check` requests HTTPS `/healthz`, does not follow redirects, and times out after five seconds. If both providers are recorded, choose `--provider`.

The dashboard only lists deployments saved on this machine. It does not discover all apps in your cloud accounts.

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a deployment |
| Enter | Open its chat URL |
| R | Refresh health; query selected cloud status when matching provider flags/authentication are supplied |
| L | Show logs when matching provider flags/authentication are supplied |
| Q | Quit |

The interactive dashboard needs a terminal. `dashboard --json` returns cached local records without network requests. Automatic polling checks health only, never the model or cloud status API.

These checks mean different things:

- **Deployment status**: the cloud platform's deployment result, queried by `status`. The dashboard initially shows the cached value.
- **Health**: whether the app and its session service respond.
- **Chat capability**: whether the model key, model, and tools actually work. Test this manually at the URL.

`check --chat` is not implemented. It exits before reading secrets or calling a model.

## Sessions, passwords, and limits

Production uses shared Redis sessions. Login and logout work across app instances. Redis outages fail closed with 503 responses; requests recover after reconnection. Redis eviction may invalidate sessions and require login again.

Changing the password hash does **not** revoke existing Redis sessions. To invalidate all sessions, change the session namespace consistently across active versions. Use different namespaces for different apps. In local memory mode, restarting clears sessions.

There is no saved cross-device chat history or long-term memory. Limits and per-instance throttles reduce abuse but are not hard spending caps. Treat your app code as trusted: upload filtering cannot find every secret embedded in source.

## What has been verified

Local tests, mocked cloud orchestration, generated app builds, packaging smoke tests, and terminal cleanup have been exercised.

Live cloud deployment, real Redis/Lua, Docker, browser login, fresh registry installation, and Windows behavior still need verification. `--dry-run` checks local inputs only; it does not prove cloud permissions, model availability, or production readiness.

GitHub is optional. Importing existing agents, GitHub templates, and push-to-deploy are not part of this version.
