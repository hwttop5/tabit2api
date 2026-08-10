# 客户端集成

## 默认本地网关

```text
OpenAI Responses 基础地址: http://127.0.0.1:50124/v1
Anthropic Messages 基础地址: http://127.0.0.1:50124
API 密钥: sk-tabbit-local
模型名: tabbit/priority
```

开始前先启动本地网关：

```powershell
tabbit2api start
```

如果你还没有 runtime profile，直接运行 `tabbit2api` 也可以，它会自动拉起登录并等待完成。

首次配置或登录异常时，建议先在官方 Tabbit 客户端确认网页聊天可用，然后关闭所有 Tabbit 窗口并刷新本地运行时 profile：

```powershell
tabbit2api login --refresh
```

## Codex 接入

示例文件：

- [../examples/codex/config.toml.example](../examples/codex/config.toml.example)

Codex 使用 OpenAI Responses 兼容接口：

```text
基础地址: http://127.0.0.1:50124/v1
API 密钥环境变量: TABBIT_API_KEY
模型名: tabbit/priority
```

如果 Codex 报 `[492] 欢迎使用 Tabbit 浏览器...` 或 `browser sign-in gate`，先用最小 Responses 请求确认登录态和网关本身是否可用。Codex 可能携带大量隐藏 system、developer 和历史上下文；Tabbit2API 会在结构化 prompt 超过 19000 字符时自动压缩这些上下文，并为 Tabbit 实测约 20500 字符的上限保留余量。最新用户消息不会被截断；若安全压缩后仍然超限，接口会返回 `invalid_request` 并提示需要减少的内容。

## Claude Code 接入

示例文件：

- [../examples/claude-code/env.powershell.example](../examples/claude-code/env.powershell.example)
- [../examples/claude-code/env.sh.example](../examples/claude-code/env.sh.example)

Claude Code 使用 Anthropic 风格接口：

```text
基础地址: http://127.0.0.1:50124
API 密钥: sk-tabbit-local
模型名: tabbit/priority
```

注意：这里不要带 `/v1`。

## OpenClaw 接入

OpenClaw 也走 Anthropic 风格接口，因此同样使用：

```text
基础地址: http://127.0.0.1:50124
```

## Hermes Agent 接入

Hermes Agent 使用 OpenAI Responses 兼容接口：

```text
基础地址: http://127.0.0.1:50124/v1
API 模式: codex_responses
模型名: tabbit/priority
```

## 常见差异

- Codex / Hermes Agent：通常用 `/v1`
- Claude Code / OpenClaw：通常不用 `/v1`
- 所有客户端都建议统一用 `tabbit/priority`

## 首次接入建议

1. 运行 `tabbit2api doctor`
2. 运行 `tabbit2api start`
3. 访问 `/health`
4. 再接客户端配置

## 常见错误

- 运行态页面跳到 `/login` 或接口返回 `login_required`：关闭所有 Tabbit 窗口后运行 `tabbit2api login --refresh`。
- 已登录状态下某个模型返回 `[492] 欢迎使用 Tabbit 浏览器...`：这也可能是当前模型权限、额度或策略限制；`tabbit/priority` 会继续尝试目录中的免费模型，并使用 `tabbit/Default` 作为最终兜底。
- `health ok` 但客户端调用失败：`/health` 不会发起真实 Tabbit 消息请求，需要再用 `POST /v1/responses` 或客户端实际请求验证。
- `login --refresh` 后 Codex 仍失败：先用下面的最小请求确认登录态。最小请求正常时检查 `[tabbit-prompt]` 日志，确认自动压缩后的 `sent` 长度。
- 可见只发了“你好”但仍失败：Codex / Claude Code 等客户端可能附带隐藏 system、developer 和历史上下文。网关会自动压缩这些内容；如果返回 `invalid_request`，需要减少最新用户输入、附件元数据、工具 schema 或最近上下文。

最小 Responses 验证请求：

```powershell
curl.exe -X POST `
  -H "Authorization: Bearer sk-tabbit-local" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"tabbit/priority\",\"input\":\"hello\"}" `
  http://127.0.0.1:50124/v1/responses
```
