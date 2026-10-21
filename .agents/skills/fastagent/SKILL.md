---
name: fastagent
description: Operate the Fastagent CLI to scaffold, run, check, and deploy a headless bearer-token chat app on the user's own Railway or Cloud Run account. Use when the user asks to init, dev, models, chat, login, deploy, status, logs, destroy, check, or dashboard a Fastagent project, or to drive `fastagent` / `node dist/cli.js`.
---

# Operate Fastagent

Use this skill to create, run, deploy, inspect, or check a Fastagent app. Fastagent deploys headless, bearer-token chat apps to user-owned Railway or Cloud Run accounts. It is not a coding agent or sandbox, and new apps have no browser UI.

## Find the CLI

Use `fastagent` if it is on PATH. Otherwise use this repository's built `dist/cli.js`.

```sh
# In the Fastagent repository
npm ci
npm run build
node dist/cli.js --help
```

From an app directory, use the absolute path to that file. Building does not install a global command or publish a package.

Prefer `--json`. It returns one stdout object with stable `error.code` values. `dev --json` prints one `{"ok":true,"command":"dev","url":...}` line once the server listens and then keeps running, so run it as a background process and poll health with `check --json`. Interactive login is text-only; `dashboard --json` is an offline snapshot.

Exit codes: 0 success, 1 operation/configuration failure, 2 invalid arguments, 130 SIGINT, 143 SIGTERM. Dashboard also handles SIGHUP and SIGQUIT while restoring terminal settings.

## Permission and secrets

Start deployment with `--dry-run`. Remove it only after the user explicitly authorizes a real deployment and understands it can cost money.

Also obtain permission before destructive commands, interactive login, publication, or paid model calls. Never describe a dry run or mock test as a live deployment.

Do not read secrets into chat, print them, or place them in command arguments. CLI `chat` reads credentials only from explicit `--env-file` paths. Deployment uses explicit `--env-file` paths or auto-detects ignored `.env` then `.env.auth`; Railway tokens come only from explicit `--auth-file`. Neither command inherits credentials from the shell. Local `dev` is different: inherited environment variables take precedence over its ignored `.env` and `.env.auth` files. Cloud Run uses native gcloud authentication.

Do not expose unprotected chat or tunnel local development.

## Non-interactive contract

Every command is safe inside a coding-agent tool call and never blocks waiting for input it was not explicitly asked to read.

- No command reads stdin implicitly. `fastagent chat` requires `--message <text>`, or the explicit `--stdin` (`--message -`) opt-in to read a piped message. With neither, it exits immediately with `INVALID_ARGUMENTS`; it never falls back to stdin.
- No TTY is required for any non-interactive command. Interactive behavior is opt-in only: `login --provider cloudrun --interactive` and the TUI `dashboard` need a terminal and fail fast with `LOGIN_INTERACTIVE_REQUIRED` / `TTY_REQUIRED` when it is absent. No command ever waits on stdin it was not explicitly told to read: `chat` requires `--message`, or an explicit `--stdin` (equivalently `--message -`). There are no prompts, pagers, or terminal-dependent progress output.
- Commands are idempotent and safely re-runnable: `init` never overwrites, a repeat `init` fails with `DESTINATION_EXISTS`, `.env.auth` is written once with mode 0600, and deploy reuses recorded state instead of recreating resources.

## Machine-readable output

`--json` writes one JSON object to stdout. Success is `{"ok":true,...}`; errors are `{"ok":false,"error":{"code":"<stable-code>","message":"<actionable, secret-free>"}}`. Exit codes: 0 success, 1 operation/configuration failure, 2 invalid arguments, 130 SIGINT, 143 SIGTERM. Parse `error.code` rather than prose.

Codes for the deployment-smoothing behavior, each usable to branch and recover:

- `DEPLOYMENT_HISTORY_BACKEND_CONFLICT` — both `REDIS_URL` and `FASTAGENT_EPHEMERAL_HISTORY=1` were supplied. Remove one.
- `DEPLOYMENT_HISTORY_BACKEND_MISSING` — neither a TLS `rediss:// REDIS_URL` nor `FASTAGENT_EPHEMERAL_HISTORY=1` was supplied. Add exactly one.
- `DEPLOYMENT_SINGLE_INSTANCE_REQUIRED` — ephemeral history was requested but the provider did not confirm a single-instance pin. Set `REDIS_URL` or resolve the instance setting, then retry.
- `DEPLOYMENT_ENV_FILE_MISSING` — no `--env-file` was given and auto-detection found neither ignored `.env` nor `.env.auth`. Create them or pass `--env-file`.
- `INVALID_ARGUMENTS` — a required flag is missing (for example `chat` without `--message`/`--stdin`).

## Create and run an app

`init <directory> [--name <name>] [--framework openai] [--json]`

- Target must not exist; its parent must exist without symlink ancestors.
- No parent traversal or backslashes. Names are 1–63 lowercase alphanumeric/hyphen characters.
- Only `openai` is supported. Init needs no model key, GitHub, Redis, Docker, or cloud account.
- Existing projects are never merged or overwritten.

A new app is headless with bearer-token access. It does not serve a browser password UI or `/api/login`.

`init` already generated an ignored, owner-only `.env.auth` with a random `FASTAGENT_API_TOKEN`; it is never printed and never returned in JSON. Do not overwrite it on re-run.

If the user wants local chat:

1. Install dependencies in the generated app.
2. Have the user put the model key selected by `fastagent.yaml` into ignored `.env` (`OPENROUTER_API_KEY` or `OPENAI_API_KEY`, never both).
3. Run `dev <directory>`; `--install` separately authorizes dependency installation.
4. Send a message with `fastagent chat --url <origin> --env-file .env.auth --message "..."`.

The chat token is read only from an explicit `--env-file`; never invent one or pass it as a command argument. `chat` never reads stdin unless you pass `--stdin` (`--message -`). Local development uses memory history, needs no Redis, binds to IPv4 loopback, and has no hot reload.

Use the `fastagent-app` skill for prompt/tool edits.

Starting the generated agent requires a nonblank matching model key in ignored `.env`: `OPENROUTER_API_KEY` for the default OpenRouter model, or `OPENAI_API_KEY` for direct OpenAI. Missing/blank keys prevent startup before readiness; `dev --json` returns `MODEL_API_KEY_MISSING` with the required setting. Never ask the user to paste the key into chat. Local models are not supported. Init and builds remain credential-free; startup and health never call a model.

Local `dev` inherits environment variables: inherited values override `.env.auth`, which overrides `.env`. Files are loaded once; restart after edits and unset conflicting inherited values without displaying secrets. Local startup warns that memory history disappears on restart. Unlike local dev, `chat` and deployment never inherit credentials from the shell.

## Choose a model

`fastagent models [--search <text>] [--limit <n>] [--tools] [--json]` reads the public OpenRouter catalog. It needs no key, makes no generation call, and never incurs model charges. It reports estimates with a fetch timestamp, source URL, tool support, and unknown prices marked unknown. Documented tilde-prefixed vendor aliases are accepted. The owner selects the model in `fastagent.yaml`; there is no visitor model picker.

## Deploy

Run lifecycle commands inside the app directory. `--target` defaults to the configured app name.

For production, `.env` supplies the model key selected by `fastagent.yaml` (`OPENROUTER_API_KEY` or `OPENAI_API_KEY`) and exactly one history backend: TLS `REDIS_URL`, or `FASTAGENT_EPHEMERAL_HISTORY=1` for single-instance in-memory history. `.env.auth` supplies `FASTAGENT_API_TOKEN`. When `--env-file` is omitted, deploy auto-detects the ignored `.env` then `.env.auth` in the app directory (never `.env.example`, never the shell); explicit `--env-file` flags still win. Local secret files must be root `.env` or `.env.*`, not `.env.example`; omit empty assignments. Do not set both model keys.

Ephemeral mode is an explicit opt-in accepted only as the literal `1`. It is safe only when the deployment pins one instance: Cloud Run is capped at one instance and Railway is pinned to one replica. Both or neither backend fails closed with a distinct code. History lives in memory and is lost on restart; `GET /health` still works. Never enable it without the single-instance pin.

Leave `APP_ORIGIN` unset on first deployment. The CLI sets the exact provider origin. A supplied update origin must match the recorded URL. Preserve the recorded history namespace.

### Railway

Requires Railway CLI, workspace ID, and an account/workspace token in ignored `.env.railway`.

```sh
fastagent login --provider railway
fastagent deploy --provider railway --workspace WORKSPACE_ID \
  --auth-file .env.railway --dry-run --json
```

`.env` and `.env.auth` are auto-detected; add `--env-file .env --env-file .env.auth` to override. `--auth-file` is always explicit.

Login only prints instructions. It does not prove authentication.

Put `RAILWAY_API_TOKEN` in the explicit `--auth-file` for initial creation and deletion. An environment-scoped `RAILWAY_TOKEN` entry in that file only reuses recorded targets and requires `--railway-project` plus `--railway-environment`. Neither token is inherited from the shell.

### Cloud Run

Requires gcloud auth, project/region, billing/APIs/permissions, and existing distinct runtime/build accounts.

```sh
fastagent login --provider cloudrun --interactive
fastagent deploy --provider cloudrun --project PROJECT_ID --region REGION \
  --runtime-account RUNTIME_EMAIL --build-account BUILD_EMAIL \
  --dry-run --json
```

`.env` and `.env.auth` are auto-detected.

Interactive login needs a terminal and cannot use `--json`. Fastagent does not create Redis, enable billing/APIs, or grant broad project roles.

## Inspect and delete

`status`, `logs`, `recover`, and `destroy` use the same provider settings/authentication, without runtime env files. `status`, `logs`, and `recover` are read-only and do not acquire mutation locks. `recover --provider ... --json` returns recorded IDs, checkpoint, lock-owner diagnostics, remote verification outcome, and manual next steps; it never unlocks, mutates cloud resources, or resets state. New locks include host/PID/time metadata; legacy/foreign locks are unknown. Never infer that cloud operations stopped from a CLI timeout or dead PID. Back up state, independently verify all native/cloud work stopped, then manually archive only the identified lock if appropriate. Preserve record IDs and rerun recover before retrying the same target. `remoteStatusVerified: false` blocks any assumption of readiness; resolve its code first. `CLOUDRUN_OUTPUT_LIMIT` preserves output-overflow diagnosis without payloads.

Deletion requires user permission, `--yes`, and verified ownership. Shared projects, images, and build history may remain billable. Cloud Run logs withhold application payloads.

Do not blindly retry uncertain mutations or delete resources based only on their name.

## Health and chat

`check` reads the current app's saved target and requests HTTPS `/health` for Cloud Run or `/healthz` for Railway. Generated apps serve both. Older Cloud Run apps must add the no-model `/health` history-store readiness endpoint, retain `/healthz` as an alias, and redeploy. Cloud Run reserves some z-suffixed paths; do not retry a reserved path or treat container startup as public health success. Choose `--provider` if both providers are recorded. Health does not certify model keys or tools and never calls a model.

`check --chat` is unsupported and exits before secret/network access. To test chat, use `fastagent chat`, which sends one real, billable request with an explicit `--message <text>` or `--stdin` (`--message -`) and can resume a conversation with `--conversation`. It never reads stdin implicitly.

The dashboard lists local records. It does not discover cloud apps. Keys: arrows select, Enter opens the URL, R refreshes, L shows logs, Q quits. Status/log actions need explicit matching provider settings and auth. Automatic polling is health-only; displayed deployment status is initially cached.

`dashboard --json` is offline and needs no terminal.

Omitting `--conversation` starts a new conversation; follow-ups must reuse the server ID from `conversation: <id>` or JSON `conversationId`. `OUTPUT_TOKEN_LIMIT` means the provider reported completion-budget exhaustion; ask for a shorter reply or have the owner adjust top-level `maxOutputTokens` in `fastagent.yaml` (default 4096, integer 1–16384 per model step). Restart/redeploy after changes. Reasoning may share the budget, and up to three steps can each consume it. Higher caps permit increased cost/latency; timeout and byte limits remain. Never automatically retry; partial replies are not committed.

## Change Fastagent

Read `AGENTS.md` and `docs/architecture.md`. Keep code, help, README, and skills consistent. Report skipped live checks; mock tests do not prove cloud readiness.
