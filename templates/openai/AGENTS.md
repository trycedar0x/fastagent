# App contributor instructions

Read `README.md` before changing this app. It uses Node.js 22+, TypeScript/ESM, and the official OpenAI SDK. Do not add Vercel AI SDK.

## Where to edit

- Prompt/model: `src/agent.ts`.
- Predefined tools: `src/tools.ts`.
- Browser UI: `public/`.

Keep these separate from server, auth, and config code. Tools must be bounded server logic, not shell or arbitrary code execution. Do not fabricate external data.

## Keep working

- Preserve the NDJSON chat protocol and no-model-call health endpoint.
- Keep body, context, concurrency, duration, output, and tool-step limits.
- Abort model work on disconnect or shutdown where supported.
- Render browser output with `textContent`, never untrusted HTML.
- Keep password hashing, secure cookies, exact Origin/CSRF checks, and generic errors.
- Production requires TLS Redis; do not fall back to memory on failure. Local memory is development-only.
- Keep the app's session namespace stable across versions and distinct from other apps.

Never commit or upload env files, passwords, hashes, API keys, Redis URLs, cloud credentials, or conversation logs. Keep `.env.example` blank and builds credential-free. Preserve Docker copies and ignore rules.

## Validate

Run `npm run typecheck` and `npm run build`. Test HTTP/auth/streaming with an injected `ChatModel` and session store, not real credentials or paid models.

Do not deploy, delete resources, publish, or call paid models without authorization. Do not claim cloud readiness from a local build.
