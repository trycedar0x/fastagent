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

## Preserve safety

- Never overwrite user files silently.
- Reuse recorded deployments; do not blindly retry uncertain resource creation.
- Delete only remotely verified app-owned resources, with explicit confirmation.
- Never print or store secrets in code, arguments, state, logs, uploads, images, or browser assets.
- Keep `.env.example` placeholder-only. Builds must work without credentials.
- Keep bearer-token authentication: exactly one `Authorization: Bearer` field, no query or cookie credentials, exact `Origin` when a client sends one, and bounded requests. Existing `deployment.access: protected` apps stay deployable and protected; never rewrite one into a token app.
- Production stores conversation history in TLS Redis and must fail closed on outages. Memory history is local development only, and Redis is not a login-session store.
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
