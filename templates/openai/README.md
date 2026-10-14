# Your chat agent

This is a runnable Node.js 22+ app using the official OpenAI SDK. It runs independently of the CLI. One server serves the browser UI, password-protected chat, and health endpoint.

## Run locally

In this app directory:

```sh
npm install
npm run hash-password
```

Enter a password. The helper hides input and creates ignored `.env.auth` with a salted scrypt hash, not plaintext. It refuses to overwrite an existing file.

Create an ignored `.env` with `OPENAI_API_KEY`. Start the app with your Fastagent CLI:

```sh
fastagent dev
```

If Fastagent is not on PATH, use the absolute path to its built `dist/cli.js`:

```sh
node /path/to/fastagent/dist/cli.js dev
```

Open the printed localhost URL and log in. Local development uses memory sessions and needs no Redis. Real chats can cost money.

Stop with Ctrl-C and restart after edits; there is no hot reload. Do not expose the local HTTP port to the internet. Dependency installation is not automatic unless you pass `--install`.

## Edit the agent

- `src/agent.ts`: prompt and OpenAI model adapter.
- `src/tools.ts`: bounded predefined tools; the sample converts temperatures.
- `fastagent.yaml`: app name and `model: openai/<model>`.
- `public/`: chat UI.

Only OpenAI is supported. A configured model ID does not prove the model is available to your account.

Keep tools separate from the HTTP server and authentication. Do not add shell access or arbitrary code execution. Render user/model output as text, never HTML.

Chat history lives in the current browser page and is sent with each request. There is no saved history or long-term memory.

## Deploy

Builds need no model or Redis credentials:

```sh
npm run typecheck
npm run build
```

Use Fastagent's deployment commands from this directory. Pass `--env-file .env --env-file .env.auth`; keep the password hash in its original file.

Production requires:

| Setting | Source |
| --- | --- |
| `FASTAGENT_PASSWORD_HASH` | `.env.auth` |
| `OPENAI_API_KEY` | `.env` |
| TLS `REDIS_URL` | `.env`; you supply Redis |
| Exact HTTPS `APP_ORIGIN` | Set by the deployment CLI from the provider URL |
| `PORT` | Hosting platform |
| Session namespace | Set by the CLI; stable across app versions |

Do not set `FASTAGENT_LOCAL_DEV` in production. Leave `APP_ORIGIN` unset on first deployment; do not invent a URL. A supplied update origin must match the recorded URL exactly.

Redis outages return safe 503 errors, never memory fallback. Native reconnect restores requests. Builds do not connect to Redis.

The Dockerfile runs as a non-root user and copies only known app inputs. Keep env files and credentials out of source and images. Upload filtering cannot detect every secret embedded in code. Fastagent deployment currently expects its bundled Dockerfile.

## Passwords and sessions

Cookies are HttpOnly, SameSite=Strict, host-only, and Secure in production. Login, chat, and logout check Origin and CSRF tokens.

Production sessions use shared Redis and survive app restarts. Only token hashes are stored. Authenticated sessions expire after one hour; anonymous sessions after five minutes. Rotation and logout are atomic across instances.

Logout stops future authorization, not a chat already in progress. Changing the password hash alone does not revoke existing sessions. A coordinated namespace change invalidates old sessions. Different apps need different namespaces.

Redis eviction or inconsistent session indexes may require users to log in again. Local memory sessions disappear on restart.

## HTTP API

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | `200 {"ok":true}` when ready; 503 during session-store outages; no model call |
| `GET /api/session` | Returns `authenticated`, a CSRF token, and a session cookie when needed |
| `POST /api/login` | Accepts `{"password":"..."}`; rotates cookie and CSRF token on success |
| `POST /api/chat` | Accepts bounded user/assistant messages; last message must be from the user |
| `POST /api/logout` | Revokes the authenticated session and clears its cookie |

Login requires the pre-login cookie, exact Origin, and `X-CSRF-Token`. Chat/logout require the authenticated cookie, Origin, and its current CSRF token. Errors are generic.

Chat uses UTF-8 `application/x-ndjson`: one JSON object per line.

```json
{"type":"delta","text":"Hello"}
{"type":"done"}
```

A failed stream ends with an error frame instead of done. Network chunks may split JSON lines or UTF-8 characters. Partial output followed by an error is not a complete answer. Tool activity stays on the server.

## Limits

The defaults limit bodies to 32 KiB, context to 20 messages and 16,000 characters total, chats to four concurrent requests, and each chat to 30 seconds. Agent loops allow three model/tool steps, up to 1,024 output tokens per step and 64 KiB streamed text.

Login throttling and concurrency limits are per instance. Proxies may group users. These controls are not hard spending caps; cancellation may not prevent all provider charges.

A missing model key can leave health working while chat fails. Test real chat manually when authorized; health does not certify the model or tools.

## Tests and verification

Run `npm run typecheck` and `npm run build`. Offline tests can inject a `ChatModel` and async `sessionStore` through `createRuntime`. Production startup has no Redis bypass.

Do not use real keys or paid models in tests. The Fastagent repository has an opt-in `npm run test:redis`; this is not a generated-app command.

Live cloud deployment, real Redis/Lua, Docker, browser, fresh registry installation, and Windows behavior still need verification.

A successful local build is not a cloud deployment integration test. Verify the actual cloud deployment separately before relying on it.
