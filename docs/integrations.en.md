# Client Integrations

## Default local gateway

```text
OpenAI Responses base URL: http://127.0.0.1:50124/v1
Anthropic Messages base URL: http://127.0.0.1:50124
API key: sk-tabbit-local
Model name: tabbit/priority
```

Start the local gateway before you begin:

```powershell
tabbit2api start
```

If you do not have a runtime profile yet, you can also run `tabbit2api`; it launches the login flow and waits for it to finish.

For first-time setup or login problems, confirm that web chat works in the official Tabbit client, close all Tabbit windows, and refresh the local runtime profile:

```powershell
tabbit2api login --refresh
```

## Codex integration

Example file:

- [../examples/codex/config.toml.example](../examples/codex/config.toml.example)

Codex uses the OpenAI Responses-compatible interface:

```text
Base URL: http://127.0.0.1:50124/v1
API key environment variable: TABBIT_API_KEY
Model name: tabbit/priority
```

If Codex reports `[492] 欢迎使用 Tabbit 浏览器...` or `browser sign-in gate`, first use a minimal Responses request to confirm the login state and gateway itself. Codex may include large hidden system, developer, and conversation-history context. When the structured prompt exceeds 19000 characters, Tabbit2API automatically compresses this context and leaves headroom under Tabbit's empirically observed limit of about 20500 characters. The latest user message is never truncated; if the request is still too large after safe compression, the endpoint returns `invalid_request` and explains what needs to be reduced.

## Claude Code integration

Example files:

- [../examples/claude-code/env.powershell.example](../examples/claude-code/env.powershell.example)
- [../examples/claude-code/env.sh.example](../examples/claude-code/env.sh.example)

Claude Code uses the Anthropic-style interface:

```text
Base URL: http://127.0.0.1:50124
API key: sk-tabbit-local
Model name: tabbit/priority
```

Do not include `/v1` here.

## OpenClaw integration

OpenClaw also uses the Anthropic-style interface, so use:

```text
Base URL: http://127.0.0.1:50124
```

## Hermes Agent integration

Hermes Agent uses the OpenAI Responses-compatible interface:

```text
Base URL: http://127.0.0.1:50124/v1
API mode: codex_responses
Model name: tabbit/priority
```

## Common differences

- Codex / Hermes Agent: usually use `/v1`
- Claude Code / OpenClaw: usually do not use `/v1`
- All clients are recommended to use `tabbit/priority` consistently

## Recommended first integration steps

1. Run `tabbit2api doctor`
2. Run `tabbit2api start`
3. Visit `/health`
4. Then configure the client

## Common errors

- The runtime page navigates to `/login` or the endpoint returns `login_required`: close all Tabbit windows and run `tabbit2api login --refresh`.
- A signed-in model returns `[492] 欢迎使用 Tabbit 浏览器...`: this can also indicate current model permissions, quota, or policy limits; `tabbit/priority` continues trying free models in the catalog and uses `tabbit/Default` as the final fallback.
- `health ok` but client calls fail: `/health` does not send a real Tabbit message request, so verify with `POST /v1/responses` or an actual client request.
- Codex still fails after `login --refresh`: first use the minimal request below to confirm the login state. If it works, inspect `[tabbit-prompt]` logs and confirm the `sent` length after automatic compression.
- Only “hello” is visibly sent but it still fails: Codex / Claude Code and similar clients may attach hidden system and developer prompts, tool schemas, and conversation history. The gateway compresses this content automatically; if it returns `invalid_request`, reduce the latest user input, attachment metadata, tool schema, or recent context.

Minimal Responses verification request:

```powershell
curl.exe -X POST `
  -H "Authorization: Bearer sk-tabbit-local" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"tabbit/priority\",\"input\":\"hello\"}" `
  http://127.0.0.1:50124/v1/responses
```
