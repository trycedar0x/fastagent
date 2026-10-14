---
name: fastagent-app
description: Edit a Fastagent-generated protected chat app, or the openai template, without breaking auth, health, streaming, or secret boundaries. Use when changing prompts, models, tools, or UI in a project created by `fastagent init`, or in `templates/openai`.
---

# Edit a Fastagent app

Use this skill when changing prompts, models, tools, or UI in a generated app or `templates/openai/`. Use the `fastagent` skill for deployment.

Read the app's README and AGENTS.md first. The adapter is the official OpenAI SDK, not Vercel AI SDK.

## Edit the right files

- Prompt and model adapter: `src/agent.ts`.
- Model ID: `fastagent.yaml`, using `openai/<model>`.
- Predefined tools: `src/tools.ts`.
- Browser UI: `public/`.

Keep agent logic out of transport/auth modules. Tools must be bounded server logic, not shell or arbitrary execution. Do not fabricate external data. Render output with `textContent`, never untrusted HTML.

In the CLI repository, adding a template asset also requires adding it to the manifest in `src/scaffold/render.ts`.

## Preserve the runtime contract

- Health never calls a model. It returns 200 when ready and may return 503 during Redis outages.
- Chat uses the documented NDJSON protocol and bounded input/output/tool steps.
- Disconnects and shutdown abort work where supported.
- Password protection, salted scrypt hashes, hashed expiring sessions, secure cookies, exact Origin, CSRF, and generic errors stay in place.
- Plain HTTP is explicit localhost development only.
- Production requires user-supplied TLS Redis. Never fall back to memory on outage or log its URL.
- Keep the app namespace stable across versions. Password changes alone do not revoke shared sessions.

Do not commit or upload env files, passwords, hashes, API keys, Redis URLs, cloud credentials, or conversation logs. Keep `.env.example` placeholder-only and builds credential-free. Preserve explicit Docker copies and ignore rules.

## Validate

Run `npm run typecheck` and `npm run build` in the app.

Test through `createRuntime` with an injected `ChatModel` implementing `stream(call)` as an async iterable. Inject a session store when needed. Do not use AI SDK mocks, real credentials, or paid models.

Health success does not prove chat or tools work. Do not deploy, delete resources, publish, or call paid models without explicit authorization.
