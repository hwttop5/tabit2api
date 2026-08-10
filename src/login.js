import { pathToFileURL } from "node:url";

import {
  LAB_PROFILE_DIR,
  TABBIT_CHAT_URL,
  TABBIT_USER_DATA_DIR,
} from "./config.js";
import { prepareLabProfile } from "./profile.js";
import { launchTabbitSession, openPage } from "./tabbit-session.js";

async function readLoginState(page) {
  return page.evaluate(async () => {
    const tabSignin = globalThis.chrome?.tabSignin;
    return tabSignin && typeof tabSignin.getLoginState === "function"
      ? await tabSignin.getLoginState()
      : null;
  });
}

export function isLoggedIn(loginState) {
  const direct = loginState?.loginState;
  const nested = direct?.loginState;
  const flags =
    nested && typeof nested === "object"
      ? nested
      : direct && typeof direct === "object"
        ? direct
        : loginState;
  return Boolean(flags?.isLoggedIn || flags?.hasToken);
}

function printProfileSyncWarnings(profile) {
  const warnings = Array.isArray(profile?.syncWarnings)
    ? profile.syncWarnings
    : [];
  if (!warnings.length) {
    return;
  }

  console.warn("Tabbit2API could not copy some Tabbit login-state files.");
  console.warn("Close all Tabbit windows, then run `tabbit2api login --refresh`.");
  for (const warning of warnings) {
    console.warn(`- ${warning.path} (${warning.code})`);
  }
}

async function waitForLogin(page, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const loginState = await readLoginState(page);
    if (isLoggedIn(loginState)) {
      return loginState;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Tabbit login to complete.`,
  );
}

export async function runLogin(options = {}) {
  const forceRefresh = Boolean(options.refresh);
  const profile = await prepareLabProfile({
    sourceUserDataDir: TABBIT_USER_DATA_DIR,
    labProfileDir: LAB_PROFILE_DIR,
    forceRefresh,
  });
  printProfileSyncWarnings(profile);

  const context = await launchTabbitSession(profile.labProfileDir, {
    headless: false,
  });

  const page = await openPage(context, TABBIT_CHAT_URL);

  console.log("Tabbit2API login browser window is ready.");
  console.log(`Runtime profile: ${profile.labProfileDir}`);

  if (options.waitForLogin) {
    console.log("Waiting for Tabbit login to complete...");
    try {
      await waitForLogin(
        page,
        options.loginTimeoutMs || 10 * 60_000,
      );
      console.log("Tabbit login detected. Continuing startup.");
    } finally {
      await context.close();
    }
    return;
  }

  console.log("Sign in there once, then press Ctrl+C here to close it.");

  const shutdown = async () => {
    try {
      await context.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.resume();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runLogin({
    refresh: process.argv.includes("--refresh"),
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
