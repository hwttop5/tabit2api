import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pathForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

const WINDOWS_TABBIT_EXECUTABLE_NAMES = ["Tabbit.exe", "Tabbit Browser.exe"];

function cleanPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }

  return text.replace(/^"|"$/g, "");
}

function expandWindowsEnv(value, env) {
  return value.replace(/%([^%]+)%/g, (match, name) => env[name] || match);
}

export function readWindowsTabbitAppPath({
  env = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl(
      "reg.exe",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Tabbit.exe",
        "/ve",
      ],
      {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const match = String(output).match(
      /^\s*.*?\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im,
    );
    return match ? expandWindowsEnv(cleanPath(match[1]), env) : null;
  } catch {
    return null;
  }
}

function windowsApplicationDir({ env, homeDir }) {
  const localAppData =
    cleanPath(env.LOCALAPPDATA) ||
    path.win32.join(homeDir, "AppData", "Local");
  return path.win32.join(localAppData, "Tabbit", "Application");
}

function alternateWindowsExecutable(candidate) {
  const name = path.win32.basename(candidate).toLowerCase();
  if (name === "tabbit.exe") {
    return path.win32.join(path.win32.dirname(candidate), "Tabbit Browser.exe");
  }
  if (name === "tabbit browser.exe") {
    return path.win32.join(path.win32.dirname(candidate), "Tabbit.exe");
  }
  return null;
}

function resolveKnownWindowsCandidate(candidate, source, existsSync) {
  const cleaned = cleanPath(candidate);
  if (!cleaned) {
    return null;
  }

  const candidates = [cleaned];
  if (existsSync(cleaned)) {
    return { candidates, path: cleaned, source };
  }

  const sibling = alternateWindowsExecutable(cleaned);
  if (sibling) {
    candidates.push(sibling);
    if (existsSync(sibling)) {
      return { candidates, path: sibling, source: `${source}-sibling` };
    }
  }

  return { candidates, path: cleaned, source: `${source}-missing` };
}

export function defaultTabbitExecutable({
  env = process.env,
  existsSync = fs.existsSync,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const platformPath = pathForPlatform(platform);

  if (platform === "win32") {
    const applicationDir = windowsApplicationDir({ env, homeDir });
    const candidates = WINDOWS_TABBIT_EXECUTABLE_NAMES.map((name) =>
      platformPath.join(applicationDir, name),
    );
    return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
  }

  if (platform === "darwin") {
    return "/Applications/Tabbit.app/Contents/MacOS/Tabbit";
  }

  return "tabbit";
}

export function resolveTabbitExecutable({
  env = process.env,
  existsSync = fs.existsSync,
  platform = process.platform,
  homeDir = os.homedir(),
  readRegistryAppPath = () => readWindowsTabbitAppPath({ env }),
} = {}) {
  const explicit = cleanPath(env.TABBIT_EXECUTABLE);
  if (explicit) {
    if (platform !== "win32") {
      return {
        candidates: [explicit],
        path: explicit,
        source: existsSync(explicit) ? "env" : "env-missing",
      };
    }

    return resolveKnownWindowsCandidate(explicit, "env", existsSync);
  }

  if (platform === "win32") {
    const registered = cleanPath(readRegistryAppPath());
    if (registered) {
      const registryResolution = resolveKnownWindowsCandidate(
        registered,
        "registry",
        existsSync,
      );
      if (!registryResolution.source.endsWith("-missing")) {
        return registryResolution;
      }
    }
  }

  const fallback = defaultTabbitExecutable({
    env,
    existsSync,
    platform,
    homeDir,
  });
  const source = existsSync(fallback) ? "default" : "default-missing";
  const candidates = [fallback];
  if (platform === "win32") {
    const sibling = alternateWindowsExecutable(fallback);
    if (sibling && sibling !== fallback) {
      candidates.push(sibling);
    }
  }

  return { candidates, path: fallback, source };
}

export function defaultTabbitUserDataDir({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const platformPath = pathForPlatform(platform);

  if (platform === "win32") {
    return platformPath.join(homeDir, "AppData", "Local", "Tabbit", "User Data");
  }

  if (platform === "darwin") {
    return platformPath.join(
      homeDir,
      "Library",
      "Application Support",
      "Tabbit",
      "User Data",
    );
  }

  return platformPath.join(
    env.XDG_CONFIG_HOME || platformPath.join(homeDir, ".config"),
    "Tabbit",
    "User Data",
  );
}

export function defaultAppDataRoot({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const platformPath = pathForPlatform(platform);

  if (platform === "win32") {
    return platformPath.join(
      env.LOCALAPPDATA || platformPath.join(homeDir, "AppData", "Local"),
      "tabbit2api",
    );
  }

  if (platform === "darwin") {
    return platformPath.join(
      homeDir,
      "Library",
      "Application Support",
      "tabbit2api",
    );
  }

  return platformPath.join(
    env.XDG_DATA_HOME || platformPath.join(homeDir, ".local", "share"),
    "tabbit2api",
  );
}

export const TABBIT_EXECUTABLE_RESOLUTION = resolveTabbitExecutable();
export const TABBIT_EXECUTABLE = TABBIT_EXECUTABLE_RESOLUTION.path;
export const TABBIT_EXECUTABLE_SOURCE = TABBIT_EXECUTABLE_RESOLUTION.source;

export const TABBIT_USER_DATA_DIR =
  process.env.TABBIT_USER_DATA_DIR || defaultTabbitUserDataDir();

export const LAB_ROOT = process.env.TABBIT_LAB_ROOT || defaultAppDataRoot();

export const LAB_PROFILE_DIR = path.join(LAB_ROOT, "tabbit-user-data");
export const OPENAI_ASSISTANTS_STATE_PATH =
  process.env.TABBIT_ASSISTANTS_STATE_PATH ||
  path.join(LAB_ROOT, "openai-assistants-state.json");
export const OUTPUT_DIR =
  process.env.TABBIT_OUTPUT_DIR || path.join(LAB_ROOT, "output", "playwright");
export const TABBIT_CHAT_URL = "https://web.tabbit.ai/chat/new";
export const TABBIT_MODELS_URL =
  "https://web.tabbit.ai/proxy/v1/model_config/models?a=0";

export const MAXAI_EXTENSION_ID = "mhnlakgilnojmhinhkckjpncpbhabphi";
export const CHATGPTBOX_EXTENSION_ID = "eobbhoofkanlmddnplfhnmkfbnlhpbbo";

export const MAXAI_POPUP_URL = `chrome-extension://${MAXAI_EXTENSION_ID}/pages/popup/index.html`;
export const CHATGPTBOX_PANEL_URL = `chrome-extension://${CHATGPTBOX_EXTENSION_ID}/IndependentPanel.html`;

export function summarizeEnvSource(name, fallbackValue, env = process.env) {
  if (Object.hasOwn(env, name) && env[name]) {
    return `${name}=${env[name]}`;
  }

  return `default (${fallbackValue})`;
}
