# Fastagent

Create a chat agent locally, then deploy it to your own Railway or Google Cloud Run account. Get an HTTPS URL where people can chat with it.

Fastagent provides the project template, chat UI, deployment commands, and a small terminal dashboard. You write the prompt and tools yourself, or ask Claude Code or Codex to help.

**No GitHub repository is required.** The deployed app is a chat agent, not a coding agent or sandbox. It uses the official OpenAI SDK.

![Six steps from creating a local app to deploying and inspecting its protected chat URL](docs/diagrams/workflow.svg)

[Edit this diagram in Excalidraw](docs/diagrams/workflow.excalidraw) · [How to edit the diagrams](docs/diagrams/README.md)

## Build with your coding agent

Paste this into Claude Code, Codex, or another coding agent. Replace the bracketed description with your idea:

```text
Help me build a chat agent using Fastagent.

Agent idea: [Describe who it helps, what it should do, and any APIs it needs.]

Install the CLI with npm install -g @0xtryeva/fastagent (Node.js 22+).
Source: https://github.com/trycedar0x/fastagent.
Create the app in a new directory; never overwrite existing files.

Read AGENTS.md, docs/user-guide.md, and .agents/skills/fastagent/SKILL.md
in the installed package at the npm root -g path under @0xtryeva/fastagent.
Ask me about any missing requirements, then create a separate app with
Fastagent's OpenAI template. Read the app instructions and the
fastagent-app skill before editing its prompt, tools, or UI.

Help me configure my API key locally and run the interactive password
helper. Never ask me to paste secrets into chat, print them, or commit them.
Keep password protection enabled and do not add shell-execution tools.
Build and run the app locally so I can try it. Ask before making paid
model calls yourself.

Once the local app works, ask whether I want Railway or Cloud Run deployment.
Explain the account, billing, authentication, and TLS Redis requirements.
Start with deploy --dry-run. Wait for my explicit approval before real
deployment, interactive cloud login, or deleting resources. Report what
was actually verified; a dry run or health check does not prove chat works.
```

## Start here

You need Node.js 22+ and npm.

Install `@0xtryeva/fastagent`, not the unscoped `fastagent` package (an unrelated project).

Install the CLI and create an app:

```sh
npm install -g @0xtryeva/fastagent
fastagent init ./my-agent --framework openai
```

This creates a new app in `my-agent/`; existing directories are never overwritten.

In the generated app:

```sh
cd my-agent
npm install
npm run hash-password
```

The password helper asks for a password and writes its hash to ignored `.env.auth`. It does not print or save the password.

Create an ignored `.env` file with your `OPENAI_API_KEY`. Then run from the app directory:

```sh
fastagent dev
```

Open the local URL printed by the server and log in. Real chats use your API key and may cost money. Local development does not need Redis or a cloud account; do not expose its HTTP port to the internet.

## Build from source instead

In a new checkout:

```sh
git clone https://github.com/trycedar0x/fastagent.git
cd fastagent
npm ci
npm run build
node dist/cli.js --help
```

This does not install a global command. Use the absolute path to `dist/cli.js` from an app directory, or follow the [source-based user guide](docs/user-guide.md).

## Deploy

For deployment you also need:

- Your own Railway or Cloud Run account, billing, and the provider's CLI.
- A TLS Redis URL. You supply and pay for Redis; Fastagent does not create it.
- For Cloud Run, two existing, different service accounts: one for the app and one for builds.

**Why Redis?** It stores login sessions, not chat history. A shared session store lets all deployed instances recognize the same login and keeps sessions available after an app restart. In-memory sessions would disappear on restart and would not be shared between instances.

Redis is only required in production. Local `dev` uses memory. You provide your own TLS-enabled Redis; Fastagent does not provision it. If Redis is unavailable, the app rejects session-dependent requests rather than silently switching to memory.

Add `REDIS_URL` to the app's ignored `.env`. Keep the password hash in `.env.auth`; do not copy it into `.env` or a command argument.

Deployment commands run **inside the app directory**. Use `fastagent` if installed from npm, or the absolute path to the built `dist/cli.js` when using a source checkout.

Start with `deploy --dry-run`. It checks local inputs without contacting the cloud. Removing `--dry-run` can create billable resources.

See the [user guide](docs/user-guide.md) for complete Railway and Cloud Run commands. Leave `APP_ORIGIN` unset on the first deploy; the CLI sets it from the provider URL.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Create a new app from the local template |
| `dev` | Build and run an app on localhost |
| `login` | Show Railway token instructions or start explicit Cloud Run login |
| `deploy` | Create or update a recorded deployment |
| `status` / `logs` | Inspect a deployment |
| `check` | Check its HTTP health endpoint, without calling a model |
| `dashboard` | View locally recorded deployments in a terminal |
| `destroy` | Delete verified app-owned resources, with `--yes` |

Run `fastagent --help` for exact arguments. Most commands support `--json`. `dev`, interactive login, and the interactive dashboard do not; `dashboard --json` returns an offline snapshot.

## Current limits

- One model adapter: OpenAI. Deployment backends: Railway and Cloud Run.
- Password protection is required. Production sessions use Redis.
- No long-term chat memory, coding tools, sandbox, or automatic GitHub deployment.
- `check --chat` is not supported. Test chat manually at the app URL.
- Cloud Run logs show metadata, not application message bodies.
- Deleting an app may leave shared resources and costs behind.

Local tests and mocked cloud tests pass. A fresh npm installation has been checked, including creating an app with the installed CLI. **Live cloud deployment, real Redis/Lua, Docker, browser login, and Windows behavior still need verification.** Mock tests are not proof of a successful cloud deployment.

## For coding assistants

Before using the CLI, read [the CLI skill](.agents/skills/fastagent/SKILL.md). Before editing an app, read [the app skill](.agents/skills/fastagent-app/SKILL.md). Before changing Fastagent itself, read [AGENTS.md](AGENTS.md) and [the architecture](docs/architecture.md).

Use `--json` where available. Never print secrets. Do not run a billable deployment, destructive command, interactive login, or paid model call without the user's permission. A dry run does not prove cloud permissions or readiness.

## License

[Apache License 2.0](LICENSE).
