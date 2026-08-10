import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_API_KEY,
  DEFAULT_HOST,
  DEFAULT_PORT,
  HELP_TEXT,
  parseCliArgs,
  readPackageVersion,
} from "../src/cli-options.js";
import { collectDoctorReport, runDoctor } from "../src/doctor.js";
import {
  defaultAppDataRoot,
  defaultTabbitExecutable,
  defaultTabbitUserDataDir,
  readWindowsTabbitAppPath,
  resolveTabbitExecutable,
} from "../src/config.js";
import { runStart } from "../src/cli.js";
import { isLoggedIn } from "../src/login.js";

test("CLI defaults to start command and documented gateway options", () => {
  assert.deepEqual(parseCliArgs([], {}), {
    apiKey: DEFAULT_API_KEY,
    command: "start",
    help: false,
    host: DEFAULT_HOST,
    keepOpen: false,
    optionSources: {
      apiKey: `default:${DEFAULT_API_KEY}`,
      host: `default:${DEFAULT_HOST}`,
      port: `default:${DEFAULT_PORT}`,
    },
    port: DEFAULT_PORT,
    refresh: false,
    version: false,
  });
});

test("CLI supports explicit start command and option values", () => {
  const parsed = parseCliArgs(
    [
      "start",
      "--port",
      "51234",
      "--host=0.0.0.0",
      "--api-key",
      "local-test-key",
      "--refresh",
    ],
    {},
  );

  assert.equal(parsed.command, "start");
  assert.equal(parsed.port, 51234);
  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed.apiKey, "local-test-key");
  assert.equal(parsed.refresh, true);
});

test("CLI supports login and probe subcommands", () => {
  const login = parseCliArgs(["login", "--refresh"], {});
  assert.equal(login.command, "login");
  assert.equal(login.refresh, true);

  const doctor = parseCliArgs(["doctor"], {});
  assert.equal(doctor.command, "doctor");

  const probe = parseCliArgs(["probe", "--keep-open"], {});
  assert.equal(probe.command, "probe");
  assert.equal(probe.keepOpen, true);
});

test("CLI environment values are defaults and flags override them", () => {
  const parsed = parseCliArgs(["--port=50125", "--api-key=flag-key"], {
    HOST: "0.0.0.0",
    PORT: "50124",
    TABBIT_API_KEY: "env-key",
  });

  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed.port, 50125);
  assert.equal(parsed.apiKey, "flag-key");
  assert.equal(parsed.optionSources.host, "env:HOST");
  assert.equal(parsed.optionSources.port, "flag:--port");
  assert.equal(parsed.optionSources.apiKey, "flag:--api-key");
});

test("CLI detects help and version", () => {
  assert.equal(parseCliArgs(["--help"], {}).help, true);
  assert.equal(parseCliArgs(["--version"], {}).version, true);
  assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/);
  assert.match(HELP_TEXT, /tabbit2api doctor/);
  assert.match(HELP_TEXT, /Examples:/);
});

test("CLI rejects unknown commands, unknown options, and invalid ports", () => {
  assert.throws(() => parseCliArgs(["serve"], {}), /Unknown command/);
  assert.throws(() => parseCliArgs(["--bogus"], {}), /Unknown option/);
  assert.throws(() => parseCliArgs(["--port", "0"], {}), /Invalid --port/);
  assert.throws(() => parseCliArgs(["--host"], {}), /requires a value/);
});

test("platform defaults resolve Windows Tabbit and runtime paths", () => {
  const homeDir = "C:\\Users\\tester";
  const env = { LOCALAPPDATA: "D:\\LocalAppData" };
  const legacyExecutable =
    "D:\\LocalAppData\\Tabbit\\Application\\Tabbit.exe";
  const browserExecutable =
    "D:\\LocalAppData\\Tabbit\\Application\\Tabbit Browser.exe";

  assert.equal(
    defaultTabbitExecutable({ platform: "win32", homeDir, env }),
    legacyExecutable,
  );
  assert.equal(
    defaultTabbitExecutable({
      platform: "win32",
      homeDir,
      env,
      existsSync: (candidate) => candidate === legacyExecutable,
    }),
    legacyExecutable,
  );
  assert.equal(
    defaultTabbitExecutable({
      platform: "win32",
      homeDir,
      env,
      existsSync: (candidate) => candidate === browserExecutable,
    }),
    browserExecutable,
  );
  assert.equal(
    defaultTabbitExecutable({
      platform: "win32",
      homeDir,
      env,
      existsSync: () => false,
    }),
    legacyExecutable,
  );
  assert.equal(
    defaultTabbitUserDataDir({ platform: "win32", homeDir, env }),
    "C:\\Users\\tester\\AppData\\Local\\Tabbit\\User Data",
  );
  assert.equal(
    defaultAppDataRoot({ platform: "win32", homeDir, env }),
    "D:\\LocalAppData\\tabbit2api",
  );
});

test("Windows executable resolution switches known names inside an explicit custom directory", () => {
  const configured = "D:\\Program Files\\Tabbit\\Application\\Tabbit.exe";
  const browserExecutable =
    "D:\\Program Files\\Tabbit\\Application\\Tabbit Browser.exe";

  const resolution = resolveTabbitExecutable({
    env: {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      TABBIT_EXECUTABLE: configured,
    },
    existsSync: (candidate) => candidate === browserExecutable,
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    readRegistryAppPath: () => null,
  });

  assert.equal(resolution.path, browserExecutable);
  assert.equal(resolution.source, "env-sibling");
  assert.deepEqual(resolution.candidates, [configured, browserExecutable]);
});

test("Windows executable resolution uses the registered App Paths target", () => {
  const registered = "D:\\Apps\\Tabbit\\Application\\Tabbit Browser.exe";
  const resolution = resolveTabbitExecutable({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    existsSync: (candidate) => candidate === registered,
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    readRegistryAppPath: () => registered,
  });

  assert.equal(resolution.path, registered);
  assert.equal(resolution.source, "registry");
});

test("Windows App Paths parsing accepts localized value labels and expandable paths", () => {
  const result = readWindowsTabbitAppPath({
    env: { LOCALAPPDATA: "D:\\Local" },
    execFileSyncImpl: () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Tabbit.exe
    （默认）    REG_EXPAND_SZ    %LOCALAPPDATA%\\Tabbit\\Application\\Tabbit Browser.exe
`,
  });

  assert.equal(
    result,
    "D:\\Local\\Tabbit\\Application\\Tabbit Browser.exe",
  );
});

test("Windows executable resolution preserves an invalid arbitrary explicit path", () => {
  const configured = "D:\\Portable\\custom-tabbit-build.exe";
  const resolution = resolveTabbitExecutable({
    env: {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      TABBIT_EXECUTABLE: configured,
    },
    existsSync: () => false,
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    readRegistryAppPath: () => "D:\\Apps\\Tabbit\\Tabbit Browser.exe",
  });

  assert.equal(resolution.path, configured);
  assert.equal(resolution.source, "env-missing");
  assert.deepEqual(resolution.candidates, [configured]);
});

test("platform defaults resolve macOS Tabbit and runtime paths", () => {
  const homeDir = "/Users/tester";

  assert.equal(
    defaultTabbitExecutable({ platform: "darwin", homeDir }),
    "/Applications/Tabbit.app/Contents/MacOS/Tabbit",
  );
  assert.equal(
    defaultTabbitUserDataDir({ platform: "darwin", homeDir }),
    "/Users/tester/Library/Application Support/Tabbit/User Data",
  );
  assert.equal(
    defaultAppDataRoot({ platform: "darwin", homeDir }),
    "/Users/tester/Library/Application Support/tabbit2api",
  );
});

test("platform defaults keep Linux as manual fallback", () => {
  const homeDir = "/home/tester";

  assert.equal(defaultTabbitExecutable({ platform: "linux", homeDir }), "tabbit");
  assert.equal(
    defaultTabbitUserDataDir({
      platform: "linux",
      homeDir,
      env: { XDG_CONFIG_HOME: "/tmp/xdg-config" },
    }),
    "/tmp/xdg-config/Tabbit/User Data",
  );
  assert.equal(
    defaultAppDataRoot({
      platform: "linux",
      homeDir,
      env: { XDG_DATA_HOME: "/tmp/xdg-data" },
    }),
    "/tmp/xdg-data/tabbit2api",
  );
});

test("start waits for login before launching when runtime profile is missing", async () => {
  const calls = [];
  const originalLog = console.log;
  const logs = [];
  console.log = (message) => {
    logs.push(message);
  };

  try {
    await runStart(
      {
        apiKey: "test-key",
        host: "127.0.0.1",
        port: 50124,
        refresh: false,
      },
      {
        hasLabProfile: async (labProfileDir) => {
          calls.push(["hasLabProfile", labProfileDir]);
          return false;
        },
        labProfileDir: "/tmp/tabbit-profile",
        runLogin: async (options) => {
          calls.push(["runLogin", options]);
        },
        startGateway: (options) => {
          calls.push(["startGateway", options]);
        },
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, [
    ["hasLabProfile", "/tmp/tabbit-profile"],
    ["runLogin", { refresh: false, waitForLogin: true }],
    ["startGateway", { apiKey: "test-key", host: "127.0.0.1", port: 50124 }],
  ]);
  assert.match(logs.join("\n"), /did not find a runtime profile/);
  assert.match(logs.join("\n"), /tabbit2api doctor/);
});

test("start launches directly when runtime profile already exists", async () => {
  const calls = [];

  await runStart(
    {
      apiKey: "test-key",
      host: "127.0.0.1",
      port: 50124,
      refresh: false,
    },
    {
      hasLabProfile: async () => true,
      runLogin: async () => {
        calls.push(["runLogin"]);
      },
      startGateway: (options) => {
        calls.push(["startGateway", options]);
      },
    },
  );

  assert.deepEqual(calls, [
    ["startGateway", { apiKey: "test-key", host: "127.0.0.1", port: 50124 }],
  ]);
});

test("login detection accepts current flat and legacy nested Tabbit state", () => {
  assert.equal(isLoggedIn({ isLoggedIn: true, hasToken: true }), true);
  assert.equal(
    isLoggedIn({ loginState: { isLoggedIn: true, hasToken: true } }),
    true,
  );
  assert.equal(
    isLoggedIn({
      loginState: {
        loginState: { isLoggedIn: true, hasToken: true },
      },
    }),
    true,
  );
  assert.equal(isLoggedIn({ isLoggedIn: false, hasToken: false }), false);
});

test("doctor collects filesystem checks and marks health unreachable when gateway is down", async () => {
  const env = {
    HOST: "127.0.0.1",
    PORT: "50124",
    TABBIT_API_KEY: "doctor-key",
  };

  const report = await collectDoctorReport(
    {},
    env,
    {
      checkHealth: async () => ({
        reachable: false,
        statusCode: null,
        runtimeInitialized: null,
        error: "connect ECONNREFUSED",
      }),
      hasLabProfile: async () => false,
    },
  );
  assert.equal(typeof report.tabbitExecutable.exists, "boolean");
  assert.equal(typeof report.tabbitUserData.exists, "boolean");
  assert.equal(report.runtime.profileExists, false);
  assert.equal(report.gateway.baseUrl, "http://127.0.0.1:50124");
  assert.equal(report.gateway.apiKeySource, "TABBIT_API_KEY=doctor-key");
  assert.equal(report.gateway.health.reachable, false);
});

test("doctor prints a readable report", async () => {
  const originalLog = console.log;
  let output = "";
  console.log = (message) => {
    output += `${message}\n`;
  };

  try {
    await runDoctor(
      {
        host: "127.0.0.1",
        port: 50124,
        apiKey: "doctor-key",
      },
      {},
    );
  } finally {
    console.log = originalLog;
  }

  assert.match(output, /Tabbit2API doctor/);
  assert.match(output, /Runtime/);
  assert.match(output, /Gateway/);
  assert.match(output, /\/health/);
});

test("doctor explains executable and user-data overrides when Tabbit paths are missing", async () => {
  const originalLog = console.log;
  let output = "";
  console.log = (message) => {
    output += `${message}\n`;
  };

  try {
    await runDoctor(
      {
        host: "127.0.0.1",
        port: 50124,
        apiKey: "doctor-key",
      },
      {},
      {
        checkHealth: async () => ({
          reachable: false,
          statusCode: null,
          runtimeInitialized: null,
          error: "connect ECONNREFUSED",
        }),
        hasLabProfile: async () => true,
        pathExists: async () => false,
        tabbitExecutable: "D:\\Apps\\Tabbit\\Application\\Tabbit.exe",
        tabbitExecutableSource: "env-missing",
        tabbitUserDataDir: "D:\\Profiles\\Tabbit\\User Data",
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.match(output, /exe source: TABBIT_EXECUTABLE \(missing\)/);
  assert.match(output, /Set `TABBIT_EXECUTABLE`/);
  assert.match(output, /set `TABBIT_USER_DATA_DIR`/i);
});

test("doctor reports reachable health when gateway is already running", async () => {
  const report = await collectDoctorReport(
    {
      optionSources: {
        apiKey: "flag:--api-key",
        host: "flag:--host",
        port: "flag:--port",
      },
    },
    {},
    {
      checkHealth: async () => ({
        reachable: true,
        statusCode: 200,
        runtimeInitialized: false,
      }),
      hasLabProfile: async () => true,
    },
  );

  assert.equal(report.runtime.profileExists, true);
  assert.equal(report.gateway.health.reachable, true);
  assert.equal(report.gateway.hostSource, "flag:--host");
  assert.equal(report.gateway.portSource, "flag:--port");
  assert.equal(report.gateway.apiKeySource, "flag:--api-key");
});
