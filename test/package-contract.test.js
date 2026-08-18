import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("package metadata exposes the npm CLI and publish whitelist", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));

  assert.equal(pkg.name, "tabbit2api");
  assert.equal(pkg.bin.tabbit2api, "src/cli.js");
  assert.equal(
    (await fs.readFile("src/cli.js", "utf8")).startsWith("#!/usr/bin/env node"),
    true,
  );
  assert.deepEqual(pkg.files, [
    "src/",
    "docs/",
    "README.md",
    "README.en.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "CONTRIBUTING.en.md",
    "examples/",
  ]);
  assert.equal("prepare" in pkg.scripts, false);
  assert.equal(pkg.scripts["hooks:install"], "husky");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/hwttop5/tabbit2api.git",
  });
  assert.deepEqual(pkg.bugs, {
    url: "https://github.com/hwttop5/tabbit2api/issues",
  });
  assert.equal(pkg.homepage, "https://github.com/hwttop5/tabbit2api#readme");
  assert.equal(pkg.engines.node, ">=18");
  assert.deepEqual(pkg.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(Array.isArray(pkg.keywords), true);
  assert.equal(pkg.keywords.includes("tabbit"), true);

  const docFiles = [
    "docs/api.md",
    "docs/api.en.md",
    "docs/integrations.md",
    "docs/integrations.en.md",
    "docs/publishing.md",
    "docs/publishing.en.md",
    "README.en.md",
    "CONTRIBUTING.en.md",
    "AGENTS.en.md",
  ];
  const exampleFiles = [
    "examples/README.md",
    "examples/README.en.md",
    "examples/codex/config.toml.example",
    "examples/claude-code/env.powershell.example",
    "examples/claude-code/env.sh.example",
  ];

  for (const file of [...docFiles, ...exampleFiles]) {
    await fs.access(file);
  }
});
