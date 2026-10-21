# Contributor instructions

## Read before working

- Using the CLI: `.agents/skills/fastagent/SKILL.md`.
- Editing an app or template: `.agents/skills/fastagent-app/SKILL.md`.
- Changing CLI behavior: `docs/architecture.md`.
- User instructions: `docs/user-guide.md`.

`node dist/cli.js --help` is the exact command reference. Keep README, guides, and skills consistent with it.

## Keep the scope small

Build a chat-agent deployment CLI, not a coding agent, sandbox, or hosted billing platform.

Use TypeScript, Node.js 22+, npm, ESM, and the official OpenAI SDK. The template ID is `openai`. That adapter serves both `openrouter/<vendor>/<model>` and direct `openai/<model>`, selecting `OPENROUTER_API_KEY` or `OPENAI_API_KEY` from the model reference; the generated default is `openrouter/deepseek/deepseek-v4.1-flash`. Do not add Vercel AI SDK, Next.js, another provider URL, or a second model adapter without approval.

Generated apps are headless. They have no browser UI and no password login; a bearer token authorizes machine clients, and Redis stores conversation history rather than login sessions.

Users own their Railway/Cloud Run account, model key, and Redis. Local creation needs no GitHub or model call. Local development needs no Redis.

Keep commands thin and separate configuration, scaffolding, runtime, deployment, checks, and TUI code.

## Build for coding agents, not humans

The CLI's primary user is a coding agent running commands inside automated tool calls. Treat that as a design constraint:

- No command may block on input it was not explicitly told to read. Never read stdin implicitly, and never prompt. Interactive behavior stays behind an explicit opt-in flag and must fail fast with a stable error code when a terminal is absent.
- Every data-returning command supports `--json`: one object on stdout, errors included, with stable `error.code` values and non-zero exit codes so an agent can recover without scraping prose.
- Commands must be idempotent and safe to retry, because agents retry on their own.
- Errors must name the exact next command or missing setting, and never leak a secret. Do not over-redact: configuration values such as an origin, a namespace, or a flag literal must remain readable in messages.
- A foreground server such as `dev` still has to announce readiness in a parseable line before it blocks.
- The two `.agents/skills/*/SKILL.md` files are the authoritative usage surface for agents; keep them exact and consistent with `--help`. README prose is secondary.

## Preserve safety

- Never overwrite user files silently.
- Reuse recorded deployments; do not blindly retry uncertain resource creation.
- Delete only remotely verified app-owned resources, with explicit confirmation.
- Never print or store secrets in code, arguments, state, logs, uploads, images, or browser assets.
- Keep `.env.example` placeholder-only. Builds must work without credentials.
- Keep bearer-token authentication: exactly one `Authorization: Bearer` field, no query or cookie credentials, exact `Origin` when a client sends one, and bounded requests. Existing `deployment.access: protected` apps stay deployable and protected; never rewrite one into a token app.
- Production defaults to TLS Redis for conversation history, not login sessions, and must fail closed on Redis outages without falling back to memory. Token apps may explicitly opt into disposable in-memory history with FASTAGENT_EPHEMERAL_HISTORY=1 instead of REDIS_URL; legacy protected apps still require Redis. Ephemeral mode requires a single-instance pin, loses history on restart, and can split history during overlapping rollout processes. Local development uses memory without the flag.
- Never hardcode model prices; `models` reports live catalog estimates with a fetch timestamp. Never claim success for an empty or reasoning-only completion, and never let reasoning content reach replies or stored history.
- Health and dashboard polling must never call a model.

Do not deploy, run paid models, publish, or perform destructive operations without the user's permission. Do not call mocked provider tests a live deployment.

## Test changes

Use temporary directories, synthetic secrets, injected models, and mocked cloud commands. Cover changed behavior, especially overwrite protection, upload filtering, cancellation, recovery, and deletion.

Run typecheck, build, and tests. For template changes, build the generated app too. Report failures and skipped live checks honestly.

## Work with subagents

Delegate only when authorized. Keep one writer per checkout or isolated worktree. Give each worker a clear file boundary and require a handoff with changes, tests, and risks.

Reviewers are read-only. If a tool fails or another writer changes files unexpectedly, pause and report it; do not silently switch execution modes or revert someone else's work.

Do not commit or push unless asked.
