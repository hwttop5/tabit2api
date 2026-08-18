# Contributing

## Commit messages

This project uses [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

Accepted examples:

```text
feat: add priority route alias
fix: improve responses stream compatibility
docs: rewrite public readme
chore: initialize tabbit2api open source project
```

Recommended types:

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `chore`
- `build`
- `ci`

Local commits are checked by `commitlint` and `husky`.

Install the local hooks manually:

```powershell
npm run hooks:install
```

This step is for contributors only. End users who install through npm or `npx` do not need to run it.

## Local development

```powershell
npm install
npm run hooks:install
tabbit2api doctor
tabbit2api
```

## Continuous integration

GitHub Actions runs when changes are pushed to `main` or a pull request targets `main`:

- Runs `npm ci` and `npm test` on Node.js 18, 20, 22, and 24
- Runs a full dependency audit at the high-severity threshold
- Runs `npm pack --dry-run` to inspect the npm package contents

Before submitting a change, validate locally against the official npm registry:

```powershell
npm ci --registry=https://registry.npmjs.org
npm test
npm audit --registry=https://registry.npmjs.org --audit-level=high
npm pack --dry-run --json --registry=https://registry.npmjs.org
```

## Notes

- Do not commit `.lab*` runtime profiles.
- Do not commit `node_modules/` or `output/`.
- Runtime data is stored in a user-level directory by default, not in the repository root.
- Published packages intentionally keep the existing CLI shape: `start`, `doctor`, `login`, and `probe`.
- The current public compatibility surface includes Responses, Chat Completions, Assistants, text Realtime, and Anthropic Messages.
