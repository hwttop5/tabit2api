# Tabbit2API Example Configuration

These examples assume that you have already started the Tabbit2API gateway locally.

Start it with either of these commands:

```powershell
tabbit2api
```

or:

```powershell
tabbit2api start
```

For first use or when `[492] 欢迎使用 Tabbit 浏览器...` appears, close all Tabbit windows first, then refresh Tabbit2API's local runtime profile:

```powershell
tabbit2api login --refresh
```

If only clients such as Codex still fail after the refresh, use a minimal `POST /v1/responses` request to verify the gateway login state. If the minimal request works but Codex errors contain large `Prompt diagnostics`, the client's hidden system prompt, tool schema, or conversation history has made the actual prompt much longer than it appears. Start a new Codex session or reduce the context and try again.

Default local parameters:

```text
OpenAI Responses base URL: http://127.0.0.1:50124/v1
Anthropic Messages base URL: http://127.0.0.1:50124
API key: sk-tabbit-local
Model name: tabbit/priority
```

## Choosing the base URL

- Codex and Hermes Agent: use `http://127.0.0.1:50124/v1`
- Claude Code and OpenClaw: use `http://127.0.0.1:50124`

## Clients

- `codex/config.toml.example`
  - Provider configuration snippets for Codex Desktop / Codex CLI
  - Uses the OpenAI Responses-compatible interface at `http://127.0.0.1:50124/v1`
- `claude-code/env.powershell.example`
  - Windows PowerShell environment-variable example for Claude Code
- `claude-code/env.sh.example`
  - POSIX shell environment-variable example for Claude Code
