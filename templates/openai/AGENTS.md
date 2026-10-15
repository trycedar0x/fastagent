# App contributor instructions

Read `README.md` before changing this app. It uses Node.js 22+, TypeScript/ESM, and the official OpenAI SDK for OpenRouter or direct OpenAI. Do not add Vercel AI SDK, another provider URL, or a browser password UI.

## Where to edit

- Prompt and model adapter: `src/agent.ts`.
- Predefined tools: `src/tools.ts`.
- Model reference: `fastagent.yaml`, using `openrouter/<vendor>/<model>` or `openai/<model>`.

Keep these separate from server, auth, and config code. Tools must be bounded server logic, not shell or arbitrary code execution. Do not fabricate external data.

## Keep working

- Preserve bearer-token authorization, the NDJSON chat protocol, and the no-model-call health endpoint.
- Keep body, history, context, concurrency, duration, output, and tool-step limits.
- Commit history only after a completed turn. Failed or aborted work must release its lease and must not extend retention.
- Abort model work on disconnect or shutdown where supported.
- Do not disclose reasoning content. Empty or reasoning-only completions are generic failures.
- Keep the scoped SSE guard that rejects `thread.*` events before the SDK logs them.
- Production requires TLS Redis for conversation history; do not fall back to memory on failure. Local memory is development-only.
- Keep the app's history namespace stable across versions and distinct from other apps.
- Do not add native iMessage integration. A separate Mac-side bridge may call this API; cloud hosts cannot access Apple Messages.

Never commit or upload env files, tokens, API keys, Redis URLs, cloud credentials, or conversation logs. Keep `.env.example` blank and builds credential-free. Preserve Docker copies and ignore rules.

## Validate

Run `npm run typecheck` and `npm run build`. Test HTTP/auth/streaming with an injected `ChatModel` and history store, not real credentials or paid models.

Do not deploy, delete resources, publish, or call paid models without authorization. Do not claim cloud readiness from a local build.
