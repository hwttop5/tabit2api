# Tabbit2API 示例配置

这些示例默认你已经在本机启动了 Tabbit2API 网关。

可以使用下面任一方式启动：

```powershell
tabbit2api
```

或者：

```powershell
tabbit2api start
```

首次使用或遇到 `[492] 欢迎使用 Tabbit 浏览器...` 时，先关闭所有 Tabbit 窗口，再刷新 Tabbit2API 的本地运行时 profile：

```powershell
tabbit2api login --refresh
```

如果刷新后只有 Codex 这类客户端仍失败，先用最小 `POST /v1/responses` 请求验证网关登录态。最小请求正常但 Codex 错误里的 `Prompt diagnostics` 很大时，说明客户端隐藏系统提示、工具 schema 或历史上下文已经让实际 prompt 明显变长，建议新开 Codex 会话或减少上下文后重试。

默认本地参数：

```text
OpenAI Responses 基础地址: http://127.0.0.1:50124/v1
Anthropic Messages 基础地址: http://127.0.0.1:50124
API 密钥: sk-tabbit-local
模型名: tabbit/priority
```

## 基础地址如何选择

- Codex 和 Hermes Agent：使用 `http://127.0.0.1:50124/v1`
- Claude Code 和 OpenClaw：使用 `http://127.0.0.1:50124`

## 客户端

- `codex/config.toml.example`
  - Codex Desktop / Codex CLI 提供方配置片段
  - 使用 `http://127.0.0.1:50124/v1` 上的 OpenAI Responses 兼容接口
- `claude-code/env.powershell.example`
  - Claude Code 的 Windows PowerShell 环境变量示例
- `claude-code/env.sh.example`
  - Claude Code 的 POSIX shell 环境变量示例
