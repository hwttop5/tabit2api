# Tabbit2API

[简体中文](README.md) | English

Tabbit2API is a local gateway that wraps the Tabbit client installed on your computer and exposes local endpoints compatible with OpenAI Responses, Chat Completions, Assistants, Realtime text, and Anthropic Messages for tools such as Codex, Claude Code, OpenClaw, and Hermes Agent.

It runs on your own machine, relies on the local Tabbit login state, and is intended as a single-user local automation bridge rather than a publicly hosted service.

## Quick start

Run temporarily:

```powershell
npx tabbit2api
```

Install globally:

```powershell
npm i -g tabbit2api
tabbit2api
```

If no usable runtime profile exists yet, Tabbit2API opens the Tabbit login window first and starts the gateway after you finish signing in.

## First login and profile refresh

Tabbit2API uses an independent local runtime profile and does not take over an already running Tabbit window. Recommended flow:

1. Open the official Tabbit client and confirm that web chat works
2. Close all Tabbit windows
3. Run `tabbit2api login --refresh`
4. Complete sign-in in the Tabbit2API login window that opens
5. Run `tabbit2api start`

If the runtime has already navigated to the Tabbit login page, or an endpoint explicitly reports that the login state is unavailable, close Tabbit and run `tabbit2api login --refresh` again. If a model returns `[492]` while you are signed in, `tabbit/priority` continues trying other available models in the current catalog and ultimately falls back to `tabbit/Default`.

## Verify the environment

Check local paths and gateway health:

```powershell
tabbit2api doctor
```

Start the gateway on the default port:

```powershell
tabbit2api start
```

Health check:

```powershell
curl.exe http://127.0.0.1:50124/health
```

List models with the local placeholder API key:

```powershell
curl.exe -H "Authorization: Bearer sk-tabbit-local" http://127.0.0.1:50124/v1/models
```

## Supported platforms

- Windows: officially supported
- macOS: officially supported
- Linux: supported only with manual `TABBIT_EXECUTABLE` and `TABBIT_USER_DATA_DIR` overrides

Default paths:

```text
Windows executable: %USERPROFILE%\AppData\Local\Tabbit\Application\Tabbit.exe or Tabbit Browser.exe
Windows user data directory: %USERPROFILE%\AppData\Local\Tabbit\User Data
macOS executable: /Applications/Tabbit.app/Contents/MacOS/Tabbit
macOS user data directory: ~/Library/Application Support/Tabbit/User Data
```

On Windows, `TABBIT_EXECUTABLE` takes precedence. If it points to a renamed `Tabbit.exe` or `Tabbit Browser.exe`, the other filename in the same directory is tried automatically. When the variable is not set, Windows `App Paths` registry entries are also checked, so custom installations on drives such as D: usually need no manual configuration. If discovery still fails, set the variables explicitly:

```powershell
$env:TABBIT_EXECUTABLE = "D:\Program Files\Tabbit\Application\Tabbit Browser.exe"
$env:TABBIT_USER_DATA_DIR = "$env:LOCALAPPDATA\Tabbit\User Data"
tabbit2api doctor
```

Default runtime state directories:

```text
Windows runtime directory: %LOCALAPPDATA%\tabbit2api
macOS runtime directory: ~/Library/Application Support/tabbit2api
Linux runtime directory: ~/.local/share/tabbit2api
```

## Common commands

```powershell
tabbit2api
tabbit2api start --port 50125
tabbit2api login --refresh
tabbit2api probe
tabbit2api doctor
```

## Documentation

- [API Reference](docs/api.en.md)
- [Client Integrations](docs/integrations.en.md)
- [Publishing Guide](docs/publishing.en.md)
- [Example Configuration](examples/README.en.md)
- [Contributing](CONTRIBUTING.en.md)
- [AI/Maintainer Guide](AGENTS.en.md)

## Usage limitations

- This is not the official Tabbit API.
- It depends on the local Tabbit desktop installation and login state.
- It is intended for local use and should not be exposed directly to the public internet.

## License

GPL-3.0-only. See [LICENSE](LICENSE) for details.
