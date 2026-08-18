# npm Publishing

## Goal

Publish `tabbit2api` to the official npm registry and ensure users can use it through either of these flows:

```powershell
npx tabbit2api
```

```powershell
npm i -g tabbit2api
tabbit2api
```

## Before publishing

If the local default is an npm mirror, explicitly select the official npm registry when publishing:

```powershell
npm login --registry=https://registry.npmjs.org
```

Check whether the package name already exists:

```powershell
npm view tabbit2api --registry=https://registry.npmjs.org
```

## Local verification

Run tests:

```powershell
npm test
```

Check package contents:

```powershell
npm pack --dry-run --json --registry=https://registry.npmjs.org
```

Verify the tarball's `npx` / `npm exec` invocation path:

```powershell
npm pack --registry=https://registry.npmjs.org
npm exec --yes --package .\tabbit2api-<version>.tgz -- tabbit2api --version
```

Verify a temporary global installation:

```powershell
npm install -g --prefix "$env:TEMP\tabbit2api-global" .\tabbit2api-<version>.tgz
"$env:TEMP\tabbit2api-global\tabbit2api.cmd" doctor
```

Verify runtime self-check and health check:

```powershell
tabbit2api doctor
tabbit2api start
curl.exe http://127.0.0.1:50124/health
```

## Publish

```powershell
npm publish --registry=https://registry.npmjs.org --access public
```

## Verify after publishing

Check the registry:

```powershell
npm view tabbit2api version --registry=https://registry.npmjs.org
```

Check the command entry point:

```powershell
npx tabbit2api --version
```

## Notes

- This repository does not use `prepare` to install husky automatically.
- Contributors who need commit checks should install them manually:

```powershell
npm run hooks:install
```
