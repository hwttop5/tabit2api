# API 参考

## 概览

Tabbit2API 对外暴露的是本地兼容层，不是 Tabbit 官方 API。默认监听地址：

```text
http://127.0.0.1:50124
```

默认本地占位 API 密钥：

```text
sk-tabbit-local
```

统一模型名：

```text
tabbit/priority
```

## 认证

- OpenAI 风格客户端使用 `Authorization: Bearer <key>`
- Anthropic 风格客户端使用 `x-api-key: <key>`
- 可通过环境变量 `TABBIT_API_KEY` 覆盖默认值

## 路由总览

| 路由 | 用途 |
| --- | --- |
| `GET /health` | 本地健康检查 |
| `GET /v1/models` | OpenAI / Anthropic 模型列表 |
| `GET /v1/models/{model_id}` | 单模型详情 |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/assistants` | OpenAI Assistants |
| `POST /v1/threads` | OpenAI Threads |
| `POST /v1/threads/{thread_id}/runs` | OpenAI Runs |
| `GET /v1/realtime` | OpenAI Realtime text WebSocket |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Anthropic token count |

## `GET /health`

`/health` 不会主动发起 Tabbit 消息请求，适合做启动后自检。

典型返回：

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

`syncWarnings` 只包含相对路径和错误码，用于提示登录态相关文件是否因 Tabbit 正在运行、文件锁或权限问题没有复制成功。若这里出现 `Default/Network/Cookies`、`Local State` 等条目，请关闭所有 Tabbit 窗口后运行：

```powershell
tabbit2api login --refresh
```

## `GET /v1/models`

- 默认返回 OpenAI `models` 列表结构
- 当请求头包含 `anthropic-version` 或 `x-api-key` 时，返回 Anthropic 风格模型列表
- `tabbit/priority` 是虚拟模型别名，会按内置优先级路由到实际模型

## `GET /v1/models/{model_id}`

- 当前推荐统一使用 `tabbit/priority`
- 路径中的 `/` 需要 URL 编码，例如：

```text
GET /v1/models/tabbit%2Fpriority
```

## `POST /v1/responses`

兼容 OpenAI Responses API，支持文本输入、历史消息、工具调用和附件归一化。

重点行为：

- 默认从 `input` 中抽取文本内容
- 支持常见图片、PDF、HTML 和远程 URL 附件
- 支持同步返回和 SSE 流式返回
- 当模型不可用时会按优先级进行有限回退

## `POST /v1/chat/completions`

兼容 OpenAI Chat Completions API。

重点行为：

- 接收 `messages`
- 支持 `stream`
- 支持工具调用的结构化来回传递
- 仍使用 `tabbit/priority` 作为统一模型入口

## Assistants / Threads / Runs 兼容层

提供本地文本版 Assistants 工作流兼容层，状态默认保存在用户级 runtime 目录：

```text
Windows: %LOCALAPPDATA%\tabbit2api\openai-assistants-state.json
macOS: ~/Library/Application Support/tabbit2api/openai-assistants-state.json
Linux: ~/.local/share/tabbit2api/openai-assistants-state.json
```

常见用途：

- 本地 assistant / thread / run 状态持久化
- 文本型 tool call 循环
- 流式 assistant 事件输出

## `GET /v1/realtime`

- 提供 OpenAI Realtime 风格的文本 WebSocket 兼容层
- 当前不支持音频
- 适合需要事件流的本地客户端接入

## `POST /v1/messages`

Anthropic Messages 兼容层，适合 Claude Code、OpenClaw 等客户端。

重点行为：

- 接受 Anthropic 风格消息结构
- 支持流式事件
- 支持附件透传到 Tabbit 侧能力

## `POST /v1/messages/count_tokens`

- 提供近似 token 计数
- 主要用于 Anthropic 风格客户端的前置检查

## 模型路由

`tabbit/priority` 会优先尝试内置主路由模型，若遇到可重试的上游不可用错误，再落到备选模型。

这层路由只影响本地兼容层对 Tabbit 的选择，不改变客户端看到的统一模型名。

如果 Tabbit 返回 `[492] 欢迎使用 Tabbit 浏览器...`，网关会将其视为运行时 profile 未通过 Tabbit 浏览器登录态校验，而不是普通模型繁忙错误。请先关闭所有 Tabbit 窗口并刷新登录态；如果 `tabbit2api login --refresh` 后仍失败，先用最小 `POST /v1/responses` 请求验证网关是否能发送普通文本。

如果最小请求正常，但 Codex / Claude Code 等客户端仍失败，请查看错误中的 `Prompt diagnostics`。这些客户端可能携带隐藏系统提示、工具 schema 和历史上下文，实际发送给 Tabbit 的 prompt 可能明显长于可见的一句消息。超过 32000 字符时，优先新开客户端会话或减少上下文后重试。

## 调用示例

健康检查：

```powershell
curl.exe http://127.0.0.1:50124/health
```

获取模型列表：

```powershell
curl.exe -H "Authorization: Bearer sk-tabbit-local" http://127.0.0.1:50124/v1/models
```

Responses 请求：

```powershell
curl.exe -X POST ^
  -H "Authorization: Bearer sk-tabbit-local" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"tabbit/priority\",\"input\":\"hello\"}" ^
  http://127.0.0.1:50124/v1/responses
```

更完整的客户端接入说明见 [集成文档](integrations.md)。
