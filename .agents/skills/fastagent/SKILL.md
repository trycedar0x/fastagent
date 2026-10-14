---
name: fastagent
description: Operate the Fastagent CLI to scaffold, run, check, and deploy a protected chat app on the user's own Railway or Cloud Run account. Use when the user asks to init, dev, login, deploy, status, logs, destroy, check, or dashboard a Fastagent project, or to drive `fastagent` / `node dist/cli.js`.
---

# Operate Fastagent

Use this skill to create, run, deploy, inspect, or check a Fastagent app. Fastagent deploys protected chat apps to user-owned Railway or Cloud Run accounts. It is not a coding agent or sandbox.

## Find the CLI

Use `fastagent` if it is on PATH. Otherwise use this repository's built `dist/cli.js`.

```sh
# In the Fastagent repository
npm ci
npm run build
node dist/cli.js --help
```

From an app directory, use the absolute path to that file. Building does not install a global command or publish a package.

Prefer `--json`. It returns one stdout object. `dev`, interactive login, and the interactive dashboard are text-only; `dashboard --json` is an offline snapshot.

Exit codes: 0 success, 1 operation/configuration failure, 2 invalid arguments, 130 SIGINT, 143 SIGTERM. Dashboard also handles SIGHUP and SIGQUIT while restoring terminal settings.

## Permission and secrets

Start deployment with `--dry-run`. Remove it only after the user explicitly authorizes a real deployment and understands it can cost money.

Also obtain permission before destructive commands, interactive login, publication, or paid model calls. Never describe a dry run or mock test as a live deployment.

Do not read secrets into chat, print them, or place them in command arguments. Deployment reads runtime secrets only from explicit `--env-file` paths and Railway tokens only from `--auth-file`, not from the shell. Local `dev` is different: the app loads its ignored `.env` and `.env.auth` files automatically. Cloud Run uses native gcloud authentication.

Do not expose unprotected chat or tunnel local development.

## Create and run an app

`init <directory> [--name <name>] [--framework openai] [--json]`

- Target must not exist; its parent must exist without symlink ancestors.
- No parent traversal or backslashes. Names are 1–63 lowercase alphanumeric/hyphen characters.
- Only `openai` is supported. Init needs no model key, GitHub, Redis, Docker, or cloud account.
- Existing projects are never merged or overwritten.

If the user wants local chat:

1. Install dependencies in the generated app.
2. Run `npm run hash-password` in an interactive terminal.
3. Have the user put `OPENAI_API_KEY` in ignored `.env`.
4. Run `dev <directory>`; `--install` separately authorizes dependency installation.

The helper writes a hash to ignored `.env.auth`; never invent a hash or copy it to a command argument. Local development uses memory sessions, needs no Redis, and has no hot reload.

Use the `fastagent-app` skill for prompt/tool/UI edits.

## Deploy

Run lifecycle commands inside the app directory. `--target` defaults to the configured app name.

For production, `.env` supplies `OPENAI_API_KEY` and TLS `REDIS_URL`; `.env.auth` supplies the password hash. Pass both explicitly. Local secret files must be root `.env` or `.env.*`, not `.env.example`; omit empty assignments.

Leave `APP_ORIGIN` unset on first deployment. The CLI sets the exact provider origin. A supplied update origin must match the recorded URL. Preserve the recorded session namespace.

### Railway

Requires Railway CLI, workspace ID, and an account/workspace token in ignored `.env.railway`.

```sh
fastagent login --provider railway
fastagent deploy --provider railway --workspace WORKSPACE_ID \
  --auth-file .env.railway \
  --env-file .env --env-file .env.auth --dry-run --json
```

Login only prints instructions. It does not prove authentication.

Put `RAILWAY_API_TOKEN` in the explicit `--auth-file` for initial creation and deletion. An environment-scoped `RAILWAY_TOKEN` entry in that file only reuses recorded targets and requires `--railway-project` plus `--railway-environment`. Neither token is inherited from the shell.

### Cloud Run

Requires gcloud auth, project/region, billing/APIs/permissions, and existing distinct runtime/build accounts.

```sh
fastagent login --provider cloudrun --interactive
fastagent deploy --provider cloudrun --project PROJECT_ID --region REGION \
  --runtime-account RUNTIME_EMAIL --build-account BUILD_EMAIL \
  --env-file .env --env-file .env.auth --dry-run --json
```

Interactive login needs a terminal and cannot use `--json`. Fastagent does not create Redis, enable billing/APIs, or grant broad project roles.

## Inspect and delete

`status`, `logs`, and `destroy` use the same provider settings/authentication, without runtime env files.

Deletion requires user permission, `--yes`, and verified ownership. Shared projects, images, and build history may remain billable. Cloud Run logs withhold application payloads.

Do not blindly retry uncertain mutations or delete resources based only on their name.

## Health and dashboard

`check` reads the current app's saved target and requests HTTPS `/healthz` only. Choose `--provider` if both providers are recorded. Health does not certify model keys or tools.

`check --chat` is unsupported and exits before secret/network access. Do not improvise a paid probe.

The dashboard lists local records. It does not discover cloud apps. Keys: arrows select, Enter opens the URL, R refreshes, L shows logs, Q quits. Status/log actions need explicit matching provider settings and auth. Automatic polling is health-only; displayed deployment status is initially cached.

`dashboard --json` is offline and needs no terminal.

## Change Fastagent

Read `AGENTS.md` and `docs/architecture.md`. Keep code, help, README, and skills consistent. Report skipped live checks; mock tests do not prove cloud readiness.
