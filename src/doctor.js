import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_API_KEY, DEFAULT_HOST, DEFAULT_PORT } from "./cli-options.js";
import {
  LAB_PROFILE_DIR,
  LAB_ROOT,
  TABBIT_EXECUTABLE,
  TABBIT_EXECUTABLE_SOURCE,
  TABBIT_USER_DATA_DIR,
  summarizeEnvSource,
} from "./config.js";
import { hasLabProfile } from "./profile.js";

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function formatStatus(ok) {
  return ok ? "ok" : "missing";
}

function formatExecutableSource(source) {
  const labels = {
    default: "default path",
    "default-missing": "default path (missing)",
    env: "TABBIT_EXECUTABLE",
    "env-missing": "TABBIT_EXECUTABLE (missing)",
    "env-sibling": "TABBIT_EXECUTABLE sibling",
    registry: "Windows App Paths",
    "registry-sibling": "Windows App Paths sibling",
  };
  return labels[source] || source || "unknown";
}

async function checkHealth(baseUrl, apiKey) {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body = await response.json();
    return {
      reachable: response.ok,
      statusCode: response.status,
      runtimeInitialized: body.runtimeInitialized ?? null,
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      runtimeInitialized: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectDoctorReport(
  options = {},
  env = process.env,
  deps = {},
) {
  const host = options.host || env.HOST || DEFAULT_HOST;
  const port = Number(options.port || env.PORT || DEFAULT_PORT);
  const apiKey = options.apiKey || env.TABBIT_API_KEY || DEFAULT_API_KEY;
  const optionSources = options.optionSources || {};
  const baseUrl = `http://${host}:${port}`;
  const pathExistsFn = deps.pathExists || pathExists;
  const tabbitExecutable = deps.tabbitExecutable || TABBIT_EXECUTABLE;
  const tabbitExecutableSource =
    deps.tabbitExecutableSource || TABBIT_EXECUTABLE_SOURCE;
  const tabbitUserDataDir = deps.tabbitUserDataDir || TABBIT_USER_DATA_DIR;
  const runtimeProfileExists = await (deps.hasLabProfile || hasLabProfile)(
    LAB_PROFILE_DIR,
  );
  const health = await (deps.checkHealth || checkHealth)(baseUrl, apiKey);

  return {
    tabbitExecutable: {
      path: tabbitExecutable,
      source: tabbitExecutableSource,
      exists: await pathExistsFn(tabbitExecutable),
    },
    tabbitUserData: {
      path: tabbitUserDataDir,
      exists: await pathExistsFn(tabbitUserDataDir),
    },
    runtime: {
      root: LAB_ROOT,
      profileDir: LAB_PROFILE_DIR,
      profileDefaultDir: path.join(LAB_PROFILE_DIR, "Default"),
      profileExists: runtimeProfileExists,
    },
    gateway: {
      host,
      port,
      baseUrl,
      apiKeySource:
        optionSources.apiKey || summarizeEnvSource("TABBIT_API_KEY", DEFAULT_API_KEY, env),
      hostSource: optionSources.host || summarizeEnvSource("HOST", DEFAULT_HOST, env),
      portSource: optionSources.port || summarizeEnvSource("PORT", DEFAULT_PORT, env),
      health,
    },
  };
}

export async function runDoctor(options = {}, env = process.env, deps = {}) {
  const report = await collectDoctorReport(options, env, deps);

  const lines = [
    "Tabbit2API doctor",
    "",
    "Tabbit",
    `- executable: ${formatStatus(report.tabbitExecutable.exists)} (${report.tabbitExecutable.path})`,
    `- exe source: ${formatExecutableSource(report.tabbitExecutable.source)}`,
    `- user data : ${formatStatus(report.tabbitUserData.exists)} (${report.tabbitUserData.path})`,
    "",
    "Runtime",
    `- root       : ${report.runtime.root}`,
    `- profile    : ${report.runtime.profileDir}`,
    `- default    : ${report.runtime.profileDefaultDir}`,
    `- ready      : ${report.runtime.profileExists ? "yes" : "no"}`,
    "",
    "Gateway",
    `- base URL   : ${report.gateway.baseUrl}`,
    `- host       : ${report.gateway.hostSource}`,
    `- port       : ${report.gateway.portSource}`,
    `- api key    : ${report.gateway.apiKeySource}`,
  ];

  if (report.gateway.health.reachable) {
    lines.push(
      `- /health    : ok (${report.gateway.health.statusCode}, runtimeInitialized=${report.gateway.health.runtimeInitialized})`,
    );
  } else if (report.gateway.health.statusCode) {
    lines.push(`- /health    : http ${report.gateway.health.statusCode}`);
  } else {
    lines.push(
      `- /health    : unreachable${report.gateway.health.error ? ` (${report.gateway.health.error})` : ""}`,
    );
  }

  if (!report.tabbitExecutable.exists || !report.tabbitUserData.exists) {
    lines.push("");
    lines.push("Next step");
    if (!report.tabbitExecutable.exists) {
      lines.push(
        "- Set `TABBIT_EXECUTABLE` to the installed `Tabbit Browser.exe` or `Tabbit.exe` path.",
      );
    }
    if (!report.tabbitUserData.exists) {
      lines.push(
        "- Run Tabbit under this Windows account, or set `TABBIT_USER_DATA_DIR` to its `User Data` directory.",
      );
    }
  } else if (!report.runtime.profileExists) {
    lines.push("");
    lines.push("Next step");
    lines.push("- Run `tabbit2api` or `tabbit2api login --refresh` to create a runtime profile.");
  } else if (!report.gateway.health.reachable) {
    lines.push("");
    lines.push("Next step");
    lines.push("- Run `tabbit2api start` and retry `tabbit2api doctor` or `curl http://127.0.0.1:50124/health`.");
  }

  console.log(lines.join("\n"));
}
