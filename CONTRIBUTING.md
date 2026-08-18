# 参与贡献

## 提交信息

本项目使用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)。

可接受的示例：

```text
feat: add priority route alias
fix: improve responses stream compatibility
docs: rewrite public readme
chore: initialize tabbit2api open source project
```

推荐类型：

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `chore`
- `build`
- `ci`

本地提交会经过 `commitlint` 和 `husky` 校验。

手动安装本地 hooks：

```powershell
npm run hooks:install
```

这一步只面向贡献者。通过 npm 或 `npx` 安装的最终用户不需要执行。

## 本地开发

```powershell
npm install
npm run hooks:install
tabbit2api doctor
tabbit2api
```

## 持续集成

GitHub Actions 会在推送到 `main` 或向 `main` 创建 pull request 时运行：

- 在 Node.js 18、20、22 和 24 上执行 `npm ci` 与 `npm test`
- 执行完整的高危级别依赖审计
- 执行 `npm pack --dry-run`，检查 npm 包内容

提交前建议在本地使用官方 npm registry 验证：

```powershell
npm ci --registry=https://registry.npmjs.org
npm test
npm audit --registry=https://registry.npmjs.org --audit-level=high
npm pack --dry-run --json --registry=https://registry.npmjs.org
```

## 说明

- 不要提交 `.lab*` 运行时 profile。
- 不要提交 `node_modules/` 或 `output/`。
- 运行态数据默认放在用户级目录，而不是仓库根目录。
- 已发布包会刻意保持现有 CLI 形态：`start`、`doctor`、`login`、`probe`。
- 当前公开兼容面包括 Responses、Chat Completions、Assistants、文本版 Realtime，以及 Anthropic Messages。
