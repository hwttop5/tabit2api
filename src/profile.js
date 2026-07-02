import fs from "node:fs/promises";
import path from "node:path";

const ROOT_EXCLUDES = new Set([
  "Crashpad",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "component_crx_cache",
  "CertificateRevocation",
  "Crowd Deny",
  "MEIPreload",
  "Safe Browsing",
  "OptimizationHints",
  "PKIMetadata",
  "WasmTtsEngine",
  "Webstore Downloads",
]);

const DEFAULT_EXCLUDES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "Media Cache",
  "DawnCache",
  "blob_storage",
  "Session Storage",
  "shared_proto_db",
]);

function relativeProfilePath(sourceUserDataDir, sourcePath) {
  return path.relative(sourceUserDataDir, sourcePath).replace(/\\/g, "/");
}

function isLikelyLoginStatePath(sourceUserDataDir, sourcePath) {
  const relativePath = relativeProfilePath(sourceUserDataDir, sourcePath);
  return (
    relativePath === "Local State" ||
    relativePath === "Default/Preferences" ||
    relativePath === "Default/Cookies" ||
    relativePath.startsWith("Default/Network/") ||
    relativePath.startsWith("Default/Local Storage/")
  );
}

function shouldIgnoreCopyError(error) {
  return (
    error &&
    typeof error === "object" &&
    ["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(error.code)
  );
}

function recordCopyWarning(context, sourcePath, error) {
  if (!context?.warnings || !context?.sourceUserDataDir) {
    return;
  }

  if (!isLikelyLoginStatePath(context.sourceUserDataDir, sourcePath)) {
    return;
  }

  context.warnings.push({
    code: error?.code || "UNKNOWN",
    path: relativeProfilePath(context.sourceUserDataDir, sourcePath),
    message:
      "A Tabbit login-state file could not be copied. Close Tabbit, then run `tabbit2api login --refresh`.",
  });
}

async function copyPath(sourcePath, targetPath, excludedNames, context = {}) {
  const basename = path.basename(sourcePath);
  if (excludedNames.has(basename)) {
    return;
  }

  const stats = await fs.stat(sourcePath);
  if (stats.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      await copyPath(
        path.join(sourcePath, entry.name),
        path.join(targetPath, entry.name),
        excludedNames,
        context,
      );
    }
    return;
  }

  try {
    await context.copyFile(sourcePath, targetPath);
  } catch (error) {
    if (shouldIgnoreCopyError(error)) {
      console.warn(
        `[profile] skipped busy or inaccessible file: ${sourcePath} (${error.code})`,
      );
      recordCopyWarning(context, sourcePath, error);
      return;
    }
    throw error;
  }
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function hasLabProfile(labProfileDir) {
  return pathExists(path.join(labProfileDir, "Default"));
}

export async function prepareLabProfile({
  sourceUserDataDir,
  labProfileDir,
  forceRefresh = false,
  copyFile = fs.copyFile,
}) {
  const defaultSourceDir = path.join(sourceUserDataDir, "Default");
  const defaultTargetDir = path.join(labProfileDir, "Default");
  const warnings = [];
  const copyContext = {
    copyFile,
    sourceUserDataDir,
    warnings,
  };

  if (forceRefresh) {
    await removeIfExists(labProfileDir);
  }

  if (!forceRefresh && (await pathExists(defaultTargetDir))) {
    return {
      defaultProfileDir: defaultTargetDir,
      labProfileDir,
      syncWarnings: warnings,
    };
  }

  await fs.mkdir(labProfileDir, { recursive: true });

  const requiredRootEntries = ["Local State", "First Run", "Last Version", "Variations"];
  for (const entryName of requiredRootEntries) {
    const sourcePath = path.join(sourceUserDataDir, entryName);
    const targetPath = path.join(labProfileDir, entryName);
    try {
      const stats = await fs.stat(sourcePath);
      if (stats.isDirectory()) {
        await copyPath(sourcePath, targetPath, ROOT_EXCLUDES, copyContext);
      } else {
        try {
          await copyFile(sourcePath, targetPath);
        } catch (error) {
          if (shouldIgnoreCopyError(error)) {
            console.warn(
              `[profile] skipped busy or inaccessible file: ${sourcePath} (${error.code})`,
            );
            recordCopyWarning(copyContext, sourcePath, error);
          } else {
            throw error;
          }
        }
      }
    } catch {
      // Optional source entry.
    }
  }

  if (await pathExists(defaultSourceDir)) {
    await copyPath(defaultSourceDir, defaultTargetDir, DEFAULT_EXCLUDES, copyContext);
  } else {
    await fs.mkdir(defaultTargetDir, { recursive: true });
  }

  for (const lockName of ["LOCK", "lockfile"]) {
    await removeIfExists(path.join(labProfileDir, lockName));
    await removeIfExists(path.join(defaultTargetDir, lockName));
  }

  return {
    defaultProfileDir: defaultTargetDir,
    labProfileDir,
    syncWarnings: warnings,
  };
}
