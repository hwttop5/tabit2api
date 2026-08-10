# Tabbit2API

Tabbit2API 是一个本地网关，它会把你电脑上已安装的 Tabbit 客户端封装成兼容 OpenAI Responses、Chat Completions、Assistants、Realtime 文本接口，以及 Anthropic Messages 的本地端点，供 Codex、Claude Code、OpenClaw、Hermes Agent 等工具使用。

它运行在你自己的机器上，依赖本机 Tabbit 的登录状态，定位是本地单用户自动化桥接，而不是公网部署服务。

## 快速开始

临时运行：

```powershell
npx tabbit2api
```

全局安装：

```powershell
npm i -g tabbit2api
tabbit2api
```

如果当前还没有可用的运行时 profile，Tabbit2API 会先打开 Tabbit 登录窗口，并在登录完成后再启动网关。

## 首次登录和刷新 profile

Tabbit2API 使用独立的本地运行时 profile，不会直接接管正在运行的 Tabbit 窗口。推荐流程：

1. 先打开官方 Tabbit 客户端并确认网页聊天可用
2. 关闭所有 Tabbit 窗口
3. 运行 `tabbit2api login --refresh`
4. 在弹出的 Tabbit2API 登录窗口中完成登录
5. 再运行 `tabbit2api start`

如果运行态已经跳到 Tabbit 登录页，或接口明确提示登录态不可用，请关闭 Tabbit 后重新执行 `tabbit2api login --refresh`。已登录状态下某个模型返回 `[492]` 时，`tabbit/priority` 会继续尝试当前目录中的其他可用模型，并最终使用 `tabbit/Default` 兜底。

## 验证环境

检查本地路径和网关健康状态：

```powershell
tabbit2api doctor
```

使用默认端口启动网关：

```powershell
tabbit2api start
```

健康检查：

```powershell
curl.exe http://127.0.0.1:50124/health
```

使用本地占位 API 密钥列出模型：

```powershell
curl.exe -H "Authorization: Bearer sk-tabbit-local" http://127.0.0.1:50124/v1/models
```

## 支持的平台

- Windows：官方支持
- macOS：官方支持
- Linux：仅支持通过 `TABBIT_EXECUTABLE` 和 `TABBIT_USER_DATA_DIR` 手动覆盖

默认路径：

```text
Windows 可执行文件: %USERPROFILE%\AppData\Local\Tabbit\Application\Tabbit.exe 或 Tabbit Browser.exe
Windows 用户数据目录: %USERPROFILE%\AppData\Local\Tabbit\User Data
macOS 可执行文件: /Applications/Tabbit.app/Contents/MacOS/Tabbit
macOS 用户数据目录: ~/Library/Application Support/Tabbit/User Data
```

Windows 会优先使用 `TABBIT_EXECUTABLE`；如果该变量指向已改名的 `Tabbit.exe` 或 `Tabbit Browser.exe`，会自动尝试同目录的另一个名称。未设置变量时还会读取 Windows `App Paths` 注册信息，因此 D 盘等自定义安装通常无需手动配置。仍无法识别时，可显式设置：

```powershell
$env:TABBIT_EXECUTABLE = "D:\Program Files\Tabbit\Application\Tabbit Browser.exe"
$env:TABBIT_USER_DATA_DIR = "$env:LOCALAPPDATA\Tabbit\User Data"
tabbit2api doctor
```

运行时状态目录默认值：

```text
Windows 运行态目录: %LOCALAPPDATA%\tabbit2api
macOS 运行态目录: ~/Library/Application Support/tabbit2api
Linux 运行态目录: ~/.local/share/tabbit2api
```

## 常用命令

```powershell
tabbit2api
tabbit2api start --port 50125
tabbit2api login --refresh
tabbit2api probe
tabbit2api doctor
```

## 文档

- [API 参考](docs/api.md)
- [客户端集成](docs/integrations.md)
- [发布指南](docs/publishing.md)
- [示例配置](examples/README.md)
- [贡献说明](CONTRIBUTING.md)

## 使用限制

- 这不是 Tabbit 官方 API。
- 它依赖本地 Tabbit 桌面端安装和登录状态。
- 它面向本地使用，不应直接暴露到公网。

## 许可证

GPL-3.0-only。详见 [LICENSE](LICENSE)。
