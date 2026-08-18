# API Reference

## Overview

Tabbit2API exposes a local compatibility layer, not the official Tabbit API. Default listen address:

```text
http://127.0.0.1:50124
```

Default local placeholder API key:

```text
sk-tabbit-local
```

Unified model name:

```text
tabbit/priority
```

## Authentication

- OpenAI-style clients use `Authorization: Bearer <key>`
- Anthropic-style clients use `x-api-key: <key>`
- The default can be overridden with the `TABBIT_API_KEY` environment variable

## Route overview

| Route | Purpose |
| --- | --- |
| `GET /health` | Local health check |
| `GET /v1/models` | OpenAI / Anthropic model list |
| `GET /v1/models/{model_id}` | Single model details |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/assistants` | OpenAI Assistants |
| `POST /v1/threads` | OpenAI Threads |
| `POST /v1/threads/{thread_id}/runs` | OpenAI Runs |
| `GET /v1/realtime` | OpenAI Realtime text WebSocket |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Anthropic token count |

## `GET /health`

`/health` does not initiate a Tabbit message request and is suitable for a post-startup self-check.

After runtime initialization, the response also includes the current page URL, `isLoginPage`, login bridge status, and the most recent bridge error. `isLoginPage=true` means that the runtime has reached the login page; even if cached state still appears to contain a token, run `tabbit2api login --refresh` again.

Typical response:

```json
{
  "status": "ok",
  "mode": "tabbit-web-bridge",
  "runtimeInitialized": false,
  "modelCache": {
    "cached": false,
    "modelCount": 0,
    "expiresAt": null,
    "ttlMs": 0
  },
  "queue": {
    "active": 0,
    "busy": false
  },
  "runtimeProfile": {
    "labProfileDir": ".../tabbit2api/tabbit-user-data",
    "defaultProfileDir": "",
    "syncWarnings": []
  },
  "lastBridgeError": null
}
```

`syncWarnings` contains only relative paths and error codes. It indicates whether login-state files failed to copy because Tabbit was running, a file was locked, or permissions prevented the copy. If entries such as `Default/Network/Cookies` or `Local State` appear, close all Tabbit windows and run:

```powershell
tabbit2api login --refresh
```

## `GET /v1/models`

- By default, returns an OpenAI `models` list structure
- If the request includes `anthropic-version` or `x-api-key`, returns an Anthropic-style model list
- `tabbit/priority` is a virtual model alias that routes to actual models according to the built-in priority order

## `GET /v1/models/{model_id}`

- The current recommended unified name is `tabbit/priority`
- The `/` in the path must be URL-encoded, for example:

```text
GET /v1/models/tabbit%2Fpriority
```

## `POST /v1/responses`

Compatible with the OpenAI Responses API, including text input, conversation history, tool calls, and attachment normalization.

Key behavior:

- Extracts text content from `input` by default
- Supports common image, PDF, HTML, and remote URL attachments
- Supports synchronous and SSE streaming responses
- Performs limited priority-based fallback when a model is unavailable

## `POST /v1/chat/completions`

Compatible with the OpenAI Chat Completions API.

Key behavior:

- Accepts `messages`
- Supports `stream`
- Passes structured tool calls back and forth
- Still uses `tabbit/priority` as the unified model entry point

## Assistants / Threads / Runs compatibility layer

Provides a local text-based compatibility layer for the Assistants workflow. State is stored in the user-level runtime directory by default:

```text
Windows: %LOCALAPPDATA%\tabbit2api\openai-assistants-state.json
macOS: ~/Library/Application Support/tabbit2api/openai-assistants-state.json
Linux: ~/.local/share/tabbit2api/openai-assistants-state.json
```

Common uses:

- Persisting local assistant / thread / run state
- Text-based tool-call loops
- Streaming assistant event output

## `GET /v1/realtime`

- Provides an OpenAI Realtime-style text WebSocket compatibility layer
- Audio is not currently supported
- Suitable for local clients that need an event stream

## `POST /v1/messages`

Anthropic Messages compatibility layer for clients such as Claude Code and OpenClaw.

Key behavior:

- Accepts Anthropic-style message structures
- Supports streaming events
- Passes attachments through to Tabbit-side capabilities

## `POST /v1/messages/count_tokens`

- Provides approximate token counting
- Mainly intended for preflight checks by Anthropic-style clients

## Model routing

`tabbit/priority` tries the built-in primary model route first. If it receives a retryable upstream-unavailable error, it falls back to an alternate model.

This routing affects only which Tabbit model the local compatibility layer selects; the unified model name shown to clients does not change.

If Tabbit returns `[492] 欢迎使用 Tabbit 浏览器...`, the gateway treats it as a runtime-profile login-state validation failure, not an ordinary model-busy error. Close all Tabbit windows and refresh the login state first. If it still fails after `tabbit2api login --refresh`, use a minimal `POST /v1/responses` request to verify that the gateway can send ordinary text.

If the minimal request works but Codex / Claude Code still fails, inspect the `Prompt diagnostics` in the error. These clients may include hidden system prompts and conversation history, making the actual prompt much longer than the visible messages. When the prompt exceeds 19000 characters, Tabbit2API automatically compresses system, developer, and older history context and keeps the sent length within Tabbit's empirically observed limit of about 20500 characters; the latest user message is never truncated. If it is still too large after safe compression, the endpoint returns `invalid_request`; reduce the current user input, attachment metadata, tool schema, or recent context.

## Request examples

Health check:

```powershell
curl.exe http://127.0.0.1:50124/health
```

List models:

```powershell
curl.exe -H "Authorization: Bearer sk-tabbit-local" http://127.0.0.1:50124/v1/models
```

Responses request:

```powershell
curl.exe -X POST ^
  -H "Authorization: Bearer sk-tabbit-local" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"tabbit/priority\",\"input\":\"hello\"}" ^
  http://127.0.0.1:50124/v1/responses
```

For more complete client setup instructions, see the [Client Integrations](integrations.en.md) guide.
