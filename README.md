# Kiro Connect

Kiro Connect is a small standalone Telegram bridge for the local [Kiro CLI](https://kiro.dev/). It lets you talk to Kiro CLI from Telegram without running a reverse proxy and without depending on CC Connect.

The project is intentionally narrow: one Telegram bot, one local Kiro CLI, and direct command passthrough.

## What It Does

- Sends normal Telegram text messages to local Kiro CLI chat.
- Maps Kiro CLI commands into Telegram slash commands.
- Registers discovered Kiro commands in the Telegram `/` command menu.
- Supports nested command shortcuts such as `/settings_list`, `/agent_list`, and `/mcp_status`.
- Shows Kiro chat models as Telegram buttons when you send `/model`.
- Keeps per-chat state for working directory, selected model, and selected agent.
- Runs as a standalone Node.js process or a macOS LaunchAgent.

## What It Is Not

- It is not a reverse proxy.
- It is not a Kiro API wrapper.
- It is not a CloudCore, Claude Code, or CC Connect multiplexer.
- It does not ship your Telegram token, Kiro credentials, chat state, or logs.

## Requirements

- Node.js 20 or newer.
- A working local Kiro CLI installation.
- A Telegram bot token from BotFather.
- Optional but recommended: your Telegram numeric user id for `KIRO_CONNECT_ALLOWED_USERS`.

## Install

Clone the repository and create your private config file:

```bash
git clone https://github.com/YOUR_NAME/kiro-connect.git
cd kiro-connect

mkdir -p ~/.kiro-connect
cp .env.example ~/.kiro-connect/.env
```

Edit `~/.kiro-connect/.env`:

```bash
KIRO_CONNECT_TELEGRAM_TOKEN=<YOUR_TELEGRAM_BOT_TOKEN>
KIRO_CONNECT_ALLOWED_USERS=123456789
KIRO_CONNECT_KIRO_CLI=/path/to/kiro-cli
KIRO_CONNECT_WORK_DIR=/path/to/your/workspace
KIRO_CONNECT_MODEL=claude-opus-4.7
KIRO_CONNECT_TRUST_ALL_TOOLS=1
KIRO_CONNECT_STREAM_OUTPUT=1
```

Do not commit `~/.kiro-connect/.env` or any file containing real tokens.

## Run

Start directly:

```bash
npm start
```

Print the Telegram slash commands that will be registered:

```bash
npm run commands
```

Run a syntax check:

```bash
npm run check
```

## macOS LaunchAgent

Install and start as a user LaunchAgent:

```bash
./scripts/install-launchd.zsh
```

Stop and remove the LaunchAgent:

```bash
./scripts/uninstall-launchd.zsh
```

Logs are written to:

```text
~/.kiro-connect/logs/out.log
~/.kiro-connect/logs/err.log
```

## Telegram Usage

Send a normal message to the bot:

```text
Help me inspect this project.
```

Kiro Connect runs local Kiro CLI chat roughly like this:

```bash
kiro-cli chat --no-interactive --resume --wrap never --model <model> "<message>"
```

Use slash commands for Kiro CLI command passthrough:

```text
/settings_list
/agent_list
/mcp_list
/doctor
/whoami
/chat --list-models
```

Use `/raw` for exact Kiro CLI arguments:

```text
/raw settings list --format json-pretty
```

Unknown slash commands are passed through as `kiro-cli <command> ...`, so newly added Kiro CLI commands can still work before Kiro Connect discovers them.

## Model Picker

Send:

```text
/model
```

Kiro Connect loads available models from:

```bash
kiro-cli chat --list-models --format json
```

It then renders the models as Telegram inline buttons. Tap a model button to set the default model for that Telegram chat.

Manual fallback:

```text
/model claude-opus-4.7
/model reset
/models
```

## Working Directory

Each Telegram chat has its own working directory state.

```text
/workdir
/workdir /path/to/project
/workdir reset
```

Normal chat messages and slash command passthrough run from that directory.

## Streaming Output

Kiro Connect streams Kiro CLI output into Telegram while the command is still running. It edits the current Telegram message at a throttled interval and starts a new message when the output exceeds Telegram's single-message limit.

```bash
KIRO_CONNECT_STREAM_OUTPUT=1
KIRO_CONNECT_STREAM_INTERVAL_MS=1200
```

Set `KIRO_CONNECT_STREAM_OUTPUT=0` to return to one-shot replies after command completion.

## Security Notes

- Keep `KIRO_CONNECT_ALLOWED_USERS` set unless you intentionally want an open bot.
- Treat Telegram access as access to your local Kiro CLI.
- `KIRO_CONNECT_TRUST_ALL_TOOLS` defaults to `1`, which allows Kiro CLI tools to run without interactive confirmation. Set it to `0` if you want Kiro CLI approval prompts.
- `.env`, logs, and local state are intentionally ignored by git.

## Configuration

| Variable | Description |
| --- | --- |
| `KIRO_CONNECT_TELEGRAM_TOKEN` | Telegram bot token. Required. |
| `KIRO_CONNECT_ALLOWED_USERS` | Comma-separated Telegram user ids allowed to use the bot. Empty means anyone who can message the bot can use it. |
| `KIRO_CONNECT_KIRO_CLI` | Path to the local `kiro-cli` binary. |
| `KIRO_CONNECT_WORK_DIR` | Default working directory. |
| `KIRO_CONNECT_MODEL` | Default Kiro chat model. |
| `KIRO_CONNECT_AGENT` | Optional default Kiro agent. |
| `KIRO_CONNECT_STATE_DIR` | Local state directory. Defaults to `~/.kiro-connect`. |
| `KIRO_CONNECT_TRUST_ALL_TOOLS` | Defaults to `1`; passes `--trust-all-tools` for Kiro chat commands. Set to `0` to disable. |
| `KIRO_CONNECT_TRUST_TOOLS` | Passed as `--trust-tools=<value>` when trust-all is disabled. |
| `KIRO_CONNECT_STREAM_OUTPUT` | Defaults to `1`; streams Kiro CLI output to Telegram while commands are running. |
| `KIRO_CONNECT_STREAM_INTERVAL_MS` | Edit interval for streamed Telegram messages. Defaults to `1200`. |
| `KIRO_CONNECT_TIMEOUT_MS` | Timeout for each Kiro CLI command. |
