# Architecture

Fastagent has two parts: a local CLI and a generated chat app. The CLI deploys the app to user-owned Railway or Cloud Run accounts. There is no Fastagent-hosted control plane or billing system.

## System overview

![The local CLI manages app files and deployment; the standalone app serves browsers and connects separately to OpenAI and shared Redis sessions](diagrams/architecture.svg)

[Editable Excalidraw source](diagrams/architecture.excalidraw)

The generated app can build and run without the CLI package. It serves the UI and API together. GitHub is not required.

## Code layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Arguments, output, and exit codes |
| `src/config/` | Validate project configuration |
| `src/scaffold/` | Render the local template; create files without overwriting |
| `src/dev/` | Build and start localhost development |
| `src/deployment/` | Secrets, child processes, source staging, local state, and lifecycle commands |
| `src/deployment/providers/` | Railway and Cloud Run adapters |
| `src/checks/` | Saved-target selection and HTTP health checks |
| `src/dashboard/` | Terminal display and user actions |
| `templates/openai/` | Standalone app source, UI, Dockerfile, and setup instructions |

Use TypeScript, Node.js 22+, npm, and ESM. The only model adapter is the official OpenAI SDK; do not add Vercel AI SDK, Next.js, or another platform without a separate decision.

Keep the CLI thin. Business logic belongs in app `src/agent.ts` and `src/tools.ts`, not in deployment or transport code.

## Project configuration and local state

`fastagent.yaml` has a strict, versioned schema: app name, `framework: openai`, model identifier, and protected access. Unknown fields, duplicate keys, and unsupported YAML aliases are rejected. It contains no secrets.

Deployment records are private local files, normally under `~/.fastagent/deployments`. A record identifies the canonical app path, provider, target, resource IDs, random ownership marker, session namespace, URL, and last known status.

State writes are atomic and locked. Save confirmed IDs before the next cloud operation. Do not steal stale locks automatically or assume that a timed-out mutation did nothing.

Resource names alone do not prove ownership. Adapters verify remote IDs and ownership markers before updating or deleting resources.

## App runtime

The app serves static UI and these endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | App/session-store readiness; no model call |
| `GET /api/session` | Read or create a session and return its CSRF token |
| `POST /api/login` | Verify password and rotate the session |
| `POST /api/chat` | Stream an authenticated chat response |
| `POST /api/logout` | Revoke the session and clear the cookie |

Chat accepts bounded user/assistant messages. The browser sends conversation context on each request; the server does not save chat history.

Responses use newline-delimited JSON: text deltas, then a done or error frame. Tools run on the server. The browser renders text, never model-supplied HTML. Disconnects and shutdown cancel model work where supported.

Production listens on `0.0.0.0` and the platform's `PORT`. Explicit local development uses IPv4 loopback HTTP.

## Authentication and sessions

Password protection is required. Passwords use salted scrypt hashes. Cookies are HttpOnly, SameSite=Strict, host-only, and Secure in production. Login, chat, and logout require the exact configured Origin and a session-bound CSRF token.

Production uses user-supplied TLS Redis. Only cookie-token hashes are stored. Session creation, rotation, and revocation check indexes atomically and use TTLs. Missing or inconsistent indexes invalidate records instead of restoring orphan sessions.

Local development may use memory. Production never falls back to memory during a Redis outage. Startup and store requests are bounded; outages return generic 503 errors and native reconnect restores service.

All versions of an app share its namespace. Different apps must use different namespaces. Password changes alone do not revoke existing sessions; a coordinated namespace change invalidates access to old sessions.

Input, output, concurrency, tool steps, and time are bounded. Login throttles are per instance and may group users behind a proxy. They are not distributed abuse protection or hard spending limits.

## Secret boundaries

Runtime secrets are the password hash, OpenAI key, and Redis URL. The CLI reads only explicitly selected secret files. Do not put values in command arguments, configuration, state, logs, uploads, images, or browser code.

Builds must work without model or Redis credentials. The upload uses an allowlisted temporary directory, rejects symlinks, and excludes environment files and common credential paths. Deployment currently accepts only the bundled Dockerfile.

This does not detect arbitrary secrets embedded in trusted source code.

Cloud Run injects Secret Manager references at runtime. Railway exposes variables to its build infrastructure too; the bundled Dockerfile must not consume secret build arguments. Do not claim provider-level runtime-only isolation on Railway.

## Deployment flow

1. Validate local configuration, explicit secrets, and provider inputs.
2. Stage only allowed source files.
3. Lock the selected target and save stable ownership/session information.
4. Verify or create provider resources, recording each confirmed identity.
5. Obtain an HTTPS origin. Validate it before making chat accessible.
6. Configure protected runtime settings and upload the app.
7. Wait for the exact deployment/revision to become ready and pass health checks.
8. Save the result, release the lock, and remove temporary staging files.

A queued build is not a successful deployment. Unknown mutation outcomes require reconciliation, not blind retries. `--dry-run` stops at local validation; it makes no cloud calls.

### Railway

Use the official CLI for creation, variables via stdin, source upload, deployment polling, and logs. A bounded API transport handles ownership/configuration/deletion where needed.

Acquire the domain before app activation. Account credentials are required for initial creation and deletion; environment-scoped tokens only reuse recorded targets. Delete the verified service, never the whole project.

### Cloud Run

Use `gcloud` with an explicit project, region, and existing runtime/build service accounts. They must differ. Detect prerequisites; do not automatically enable billing or grant broad project roles.

Create app-owned secrets, pin confirmed versions, and grant the runtime account access. Keep initial deployment private and protected until its real HTTPS origin is verified. Route traffic to one selected revision without tags or traffic splits.

Instance caps are cost defaults, not strict singleton guarantees. Shared Redis makes sessions work across rollout overlap. IAM diagnostics are not complete proof of effective inherited/custom-role permissions.

Deletion verifies the service and owned secrets. Projects, accounts, shared registries, images, and build history may remain.

## Health and dashboard

Health and deployment status are separate. `check` requests bounded HTTPS `/healthz` without redirects or model calls. It does not test API keys or tools. `check --chat` is unsupported.

The dashboard reads local records and polls health. Cloud status/log actions require explicit matching provider settings and authentication. Its default status is cached. JSON snapshots are offline.

## Development and validation

Add focused offline tests for configuration, file safety, secrets, state recovery, provider command construction, auth, streaming, and terminal cleanup.

Run `npm run typecheck`, `npm run build`, and `npm test`. Also build a generated app. Use injected models and cloud transports; do not use real credentials or paid calls in tests.

Live cloud, real Redis/Lua, Docker, browser, fresh registry installation, and Windows checks are separate gates. Mock tests do not certify production behavior.

Delegate only when authorized. Keep one writer per checkout; separate component work with explicit handoffs. Do not commit, publish, or provision resources without permission.

## Out of scope

Coding agents, arbitrary code execution, sandboxes, long-term memory, multi-agent orchestration, billing, GitHub autodeploy, and additional model adapters are not part of this version.
