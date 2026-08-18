# AGENTS.md

This file contains maintenance instructions for AI coding agents. Explicit instructions in the user conversation take priority, followed by this file, then `README.md` and `CONTRIBUTING.md`. Do not interpret these rules as runtime behavior changes.

## Project overview

- Tabbit2API is a local Tabbit -> OpenAI / Anthropic-compatible gateway.
- It uses Playwright to drive the Tabbit client installed and signed in on the local machine, exposing Tabbit Web Chat capabilities through local HTTP / WebSocket interfaces.
- It is not the official Tabbit API or a hosted service; by default it should be used only as a single-machine local bridge.
- Do not assume that the gateway should be exposed publicly, or interpret the local `TABBIT_API_KEY` / `sk-tabbit-local` as an official Tabbit, OpenAI, or Anthropic key.

## Development commands

- Install dependencies: `npm install`
- Start the gateway: `npm start` or `node src/cli.js start`
- Refresh login state: `npm run login` or `node src/cli.js login --refresh`
- Run a probe: `npm run probe`
- Run tests: `npm test`
- Install local Git hooks: `npm run hooks:install`
- Check the package: `npm pack --dry-run --json --registry=https://registry.npmjs.org`

## Architecture

- The project uses Node.js ESM; `package.json` sets `"type": "module"`.
- The CLI entry point is `src/cli.js`, and command-line parsing is in `src/cli-options.js`.
- HTTP routes and compatibility-layer dispatch are primarily in `src/gateway-app.js`.
- Tabbit page bridging, the model catalog, and message sending live in `src/tabbit-web-bridge.js` and related session modules.
- Tests are in `test/` and use Node's built-in test runner, `node --test`.
- Example client configurations are in `examples/` for Codex, Claude Code, OpenClaw, and Hermes Agent.

## API compatibility rules

- Existing compatibility layers include OpenAI Responses, Chat Completions, Assistants, text Realtime WebSocket, and Anthropic Messages.
- When changing `/v1/responses`, `/v1/chat/completions`, `/v1/assistants`, `/v1/threads`, `/v1/realtime`, `/v1/messages`, or `/v1/models`, add or update regression tests.
- `tabbit/priority` is the public recommended virtual model alias; do not remove or rename it casually.
- Before adding a public API path, confirm whether README, example configurations, and tests also need updates.
- Preserve OpenAI-style errors, Anthropic-style errors, SSE events, and WebSocket text events expected by clients; do not simplify them for internal implementation convenience.

## Runtime and security boundaries

- Do not commit `.lab*`, `node_modules/`, `output/`, or local browser profiles / login state.
- Keep the default runtime directories at the user level; overrides such as `TABBIT_LAB_ROOT`, `TABBIT_OUTPUT_DIR`, `TABBIT_EXECUTABLE`, and `TABBIT_USER_DATA_DIR` must remain available.
- Do not write a real local authentication key into documentation; public examples use `sk-tabbit-local`.
- Do not expand the listen address, disable authentication, or add public deployment instructions by default unless the user explicitly requests and accepts the risk.
- `package.json.files` is the npm publication boundary; do not add runtime data, tests, or this file to the package merely because repository maintenance files were added.

## Testing and verification

- After changing documentation or maintenance rules, run at least `npm test`.
- If publication boundaries, package metadata, or example files are affected, run `npm pack --dry-run --json --registry=https://registry.npmjs.org`.
- If CLI startup, login, profiles, platform paths, or the Playwright bridge are affected, prefer adding unit tests first, then perform local `login` / `probe` / `/health` validation as needed.
- When a test fails, locate the cause rather than deleting existing tests to fit the implementation.
- On Windows, read Chinese Markdown as UTF-8, for example `Get-Content -Encoding UTF8 README.md`.

## Commit and documentation rules

- Use Conventional Commits, for example `feat: add priority route alias`, `fix: improve responses stream compatibility`, or `docs: update agent maintenance guide`.
- Local commits pass through `commitlint` and `husky`; do not restore the npm `prepare` lifecycle script just to install hooks automatically.
- README is for users, with priority on installation, usage, and API documentation; AGENTS.md is for AI agents and maintainers, with priority on execution rules.
- When changing APIs, CLI commands, environment variables, or client examples, also check README, `examples/`, and related tests.
- Keep `Tabbit2API` as the displayed documentation name, and `tabbit2api` as the package and command name.
