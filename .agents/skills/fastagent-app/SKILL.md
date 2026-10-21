---
name: fastagent-app
description: Edit a Fastagent-generated headless chat app, or the openai template, without breaking bearer auth, health, streaming, history, or secret boundaries. Use when changing prompts, models, or tools in a project created by `fastagent init`, or in `templates/openai`.
---

# Edit a Fastagent app

Use this skill when changing prompts, models, or tools in a generated app or `templates/openai/`. Use the `fastagent` skill for deployment.

Read the app's README and AGENTS.md first. The adapter is the official OpenAI SDK, aimed at OpenRouter or direct OpenAI, not Vercel AI SDK.

## Edit the right files

- Prompt and model adapter: `src/agent.ts`.
- Model reference: `fastagent.yaml`, using `openrouter/<vendor>/<model>` or `openai/<model>`. The product default is `openrouter/deepseek/deepseek-v4.1-flash`.
- Predefined tools: `src/tools.ts`.

Keep agent logic out of transport/auth modules. Tools must be bounded server logic, not shell or arbitrary execution. Do not fabricate external data.

There is no browser UI in a newly generated app. Do not add a password page or a per-visitor login. A separate client, including a Mac-side bridge, can call the HTTP API.

In the CLI repository, adding a template asset also requires adding it to the manifest in `src/scaffold/render.ts`.

Replace the sample temperature-conversion system prompt and tool together. Keep tool descriptions and input schemas aligned with implementations. Token apps accept owner-only top-level `maxOutputTokens` in `fastagent.yaml` (default 4096, integer 1–16384 per model step); clients cannot override it. Preserve the typed `OUTPUT_TOKEN_LIMIT` path without exposing provider details, saving partial replies, or retrying automatically.

## Preserve the runtime contract

- Health never calls a model. It returns 200 when ready and may return 503 during Redis outages.
- One bearer token authorizes every conversation; requests must present exactly one `Authorization: Bearer` field. Query tokens, cookies, and duplicate fields are rejected. If `Origin` is present it must match `APP_ORIGIN` exactly.
- Chat uses the documented NDJSON protocol and bounded input/output/concurrency/duration/tool steps.
- Commit history only after a completed turn. Failed or aborted work must release its lease and must not extend retention. Commit, release, and delete check lease ownership atomically.
- Keep the anti-abuse and history bounds: 7-day sliding expiry, 1000 conversations per app, 40 messages and 256 KiB per conversation, a 45-second generation lease, and a separate model context of 20 messages and 16,000 characters.
- Disconnects and shutdown abort work where supported.
- Do not disclose reasoning content. Empty, whitespace-only, and reasoning-only completions are generic failures.
- Keep the scoped SSE guard that rejects `thread.*` events before the SDK logs them.
- Plain HTTP is explicit localhost development only.
- Production requires user-supplied TLS Redis for conversation history, unless the deployment explicitly opts into single-instance in-memory history with `FASTAGENT_EPHEMERAL_HISTORY=1`. That opt-in is the literal `1`, is refused together with `REDIS_URL` or in local development, and must not weaken the fail-closed default: never fall back to memory on a Redis outage or log the Redis URL. Emit one startup warning that history is in memory and lost on restart, and never log the token.
- Keep the app's history namespace stable across versions and distinct from other apps.
- Do not add native iMessage integration. A separate Mac-side bridge may call this API; cloud hosts cannot access Apple Messages.

Do not commit or upload env files, bearer tokens, API keys, Redis URLs, cloud credentials, or conversation logs. Keep `.env.example` placeholder-only and builds credential-free. Preserve explicit Docker copies and ignore rules.

## Validate

Run `npm run typecheck` and `npm run build` in the app.

Test through `createRuntime` with an injected `ChatModel` implementing `stream(call)` as an async iterable. Inject a history store when needed. Do not use real credentials or paid models.

Health success does not prove chat or tools work. Do not deploy, delete resources, publish, or call paid models without explicit authorization.
