import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const documentationFiles = [
  "README.md",
  "README.en.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "AGENTS.md",
  "AGENTS.en.md",
  "docs/api.md",
  "docs/api.en.md",
  "docs/integrations.md",
  "docs/integrations.en.md",
  "docs/publishing.md",
  "docs/publishing.en.md",
  "examples/README.md",
  "examples/README.en.md",
];

const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

function isExternalTarget(target) {
  return /^(?:https?:|mailto:|#)/i.test(target);
}

function isEnglishDocument(file) {
  return file.endsWith(".en.md");
}

test("documentation links resolve and remain within the same language", async () => {
  const contents = new Map(
    await Promise.all(
      documentationFiles.map(async (file) => [
        file,
        await fs.readFile(file, "utf8"),
      ]),
    ),
  );
  const crossLanguageLinks = [];

  for (const [file, content] of contents) {
    if (file !== "README.md" && file !== "README.en.md") {
      assert.doesNotMatch(
        content.split(/\r?\n/).slice(0, 5).join("\n"),
        /\[(?:English|简体中文)\]\(/,
        `${file} must not contain a language-switch link`,
      );
    }

    for (const match of content.matchAll(markdownLinkPattern)) {
      const rawTarget = match[1].trim();
      const target = rawTarget.split("#", 1)[0];
      if (!target || isExternalTarget(target)) {
        continue;
      }

      const resolved = path.resolve(path.dirname(file), target);
      await fs.access(resolved);

      if (!target.endsWith(".md")) {
        continue;
      }

      const sourceIsEnglish = isEnglishDocument(file);
      const targetIsEnglish = isEnglishDocument(target.replaceAll("\\", "/"));
      if (sourceIsEnglish !== targetIsEnglish) {
        crossLanguageLinks.push(`${file} -> ${target}`);
      }
    }
  }

  assert.deepEqual(crossLanguageLinks.sort(), [
    "README.en.md -> README.md",
    "README.md -> README.en.md",
  ]);
});

test("README files expose the sole language switch at the top", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  const englishReadme = await fs.readFile("README.en.md", "utf8");

  assert.match(
    readme.split(/\r?\n/).slice(0, 4).join("\n"),
    /\[English\]\(README\.en\.md\) \| 简体中文/,
  );
  assert.match(
    englishReadme.split(/\r?\n/).slice(0, 4).join("\n"),
    /\[简体中文\]\(README\.md\) \| English/,
  );
});
