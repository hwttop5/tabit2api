import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pathForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

const WINDOWS_TABBIT_EXECUTABLE_NAMES = ["Tabbit.exe", "Tabbit Browser.exe"];

export function defaultTabbitExecutable({
  existsSync = fs.existsSync,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const platformPath = pathForPlatform(platform);

  if (platform === "win32") {
    const applicationDir = platformPath.join(
      homeDir,
      "AppData",
      "Local",
      "Tabbit",
      "Application",
    );
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

export const TABBIT_EXECUTABLE =
  process.env.TABBIT_EXECUTABLE || defaultTabbitExecutable();

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
