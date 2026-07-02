import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hasLabProfile, prepareLabProfile } from "../src/profile.js";

test("prepareLabProfile creates an empty runtime profile when source Default is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tabbit2api-profile-"));
  const sourceUserDataDir = path.join(tempDir, "source");
  const labProfileDir = path.join(tempDir, "lab");

  await fs.mkdir(sourceUserDataDir, { recursive: true });

  const profile = await prepareLabProfile({
    sourceUserDataDir,
    labProfileDir,
  });

  assert.equal(profile.labProfileDir, labProfileDir);
  assert.equal(profile.defaultProfileDir, path.join(labProfileDir, "Default"));
  assert.equal(await hasLabProfile(labProfileDir), true);
});

test("prepareLabProfile copies existing Default profile while skipping cache directories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tabbit2api-profile-"));
  const sourceUserDataDir = path.join(tempDir, "source");
  const labProfileDir = path.join(tempDir, "lab");
  const sourceDefault = path.join(sourceUserDataDir, "Default");

  await fs.mkdir(path.join(sourceDefault, "Cache"), { recursive: true });
  await fs.writeFile(path.join(sourceDefault, "Preferences"), "{}", "utf8");
  await fs.writeFile(path.join(sourceDefault, "Cache", "ignored"), "x", "utf8");

  await prepareLabProfile({
    sourceUserDataDir,
    labProfileDir,
  });

  assert.equal(
    await fs.readFile(path.join(labProfileDir, "Default", "Preferences"), "utf8"),
    "{}",
  );
  await assert.rejects(
    fs.access(path.join(labProfileDir, "Default", "Cache", "ignored")),
  );
});

test("prepareLabProfile records warnings for inaccessible login-state files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tabbit2api-profile-"));
  const sourceUserDataDir = path.join(tempDir, "source");
  const labProfileDir = path.join(tempDir, "lab");
  const sourceDefault = path.join(sourceUserDataDir, "Default");
  const cookiePath = path.join(sourceDefault, "Network", "Cookies");

  await fs.mkdir(path.dirname(cookiePath), { recursive: true });
  await fs.writeFile(cookiePath, "locked", "utf8");

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const profile = await prepareLabProfile({
      sourceUserDataDir,
      labProfileDir,
      copyFile: async (sourcePath, targetPath) => {
        if (sourcePath === cookiePath) {
          const error = new Error("simulated lock");
          error.code = "EPERM";
          throw error;
        }

        await fs.copyFile(sourcePath, targetPath);
      },
    });

    assert.equal(profile.syncWarnings.length, 1);
    assert.deepEqual(profile.syncWarnings[0], {
      code: "EPERM",
      path: "Default/Network/Cookies",
      message:
        "A Tabbit login-state file could not be copied. Close Tabbit, then run `tabbit2api login --refresh`.",
    });
  } finally {
    console.warn = originalWarn;
  }
});
