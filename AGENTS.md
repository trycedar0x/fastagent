# Contributor instructions

## Read before working

- Using the CLI: `.agents/skills/fastagent/SKILL.md`.
- Editing an app or template: `.agents/skills/fastagent-app/SKILL.md`.
- Changing CLI behavior: `docs/architecture.md`.
- User instructions: `docs/user-guide.md`.

`node dist/cli.js --help` is the exact command reference. Keep README, guides, and skills consistent with it.

## Keep the scope small

Build a chat-agent deployment CLI, not a coding agent, sandbox, or hosted billing platform.

Use TypeScript, Node.js 22+, npm, ESM, and the official OpenAI SDK. The template ID is `openai`. Do not add Vercel AI SDK, Next.js, or another adapter without approval.

Users own their Railway/Cloud Run account, model key, and Redis. Local creation needs no GitHub or model call. Local development needs no Redis.

Keep commands thin and separate configuration, scaffolding, runtime, deployment, checks, and TUI code.

## Preserve safety

- Never overwrite user files silently.
- Reuse recorded deployments; do not blindly retry uncertain resource creation.
- Delete only remotely verified app-owned resources, with explicit confirmation.
- Never print or store secrets in code, arguments, state, logs, uploads, images, or browser assets.
- Keep `.env.example` placeholder-only. Builds must work without credentials.
- Keep password protection, exact Origin/CSRF checks, bounded requests, and secure production cookies.
- Production sessions require TLS Redis and must fail closed on outages. Memory is local development only.
- Health and dashboard polling must never call a model.

Do not deploy, run paid models, publish, or perform destructive operations without the user's permission. Do not call mocked provider tests a live deployment.

## Test changes

Use temporary directories, synthetic secrets, injected models, and mocked cloud commands. Cover changed behavior, especially overwrite protection, upload filtering, cancellation, recovery, and deletion.

Run typecheck, build, and tests. For template changes, build the generated app too. Report failures and skipped live checks honestly.

## Work with subagents

Delegate only when authorized. Keep one writer per checkout or isolated worktree. Give each worker a clear file boundary and require a handoff with changes, tests, and risks.

Reviewers are read-only. If a tool fails or another writer changes files unexpectedly, pause and report it; do not silently switch execution modes or revert someone else's work.

Do not commit or push unless asked.
