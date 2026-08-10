import { Buffer } from "node:buffer";

import {
  LAB_PROFILE_DIR,
  TABBIT_CHAT_URL,
  TABBIT_MODELS_URL,
  TABBIT_USER_DATA_DIR,
} from "./config.js";
import { materializeAttachmentsForUpload } from "./attachments.js";
import { prepareLabProfile } from "./profile.js";
import { launchTabbitSession, openPage } from "./tabbit-session.js";
import {
  buildGatewayCatalogBundle,
  classifyAttemptFailure,
  normalizeRequestedModelId,
  resolveRoutePlan,
  toGatewayModelId,
} from "./tabbit-bridge-core.js";

export { classifyAttemptFailure, toGatewayModelId } from "./tabbit-bridge-core.js";

const DEFAULT_TIMEOUT_MS = Number(process.env.TABBIT_SEND_TIMEOUT_MS || 180_000);
const MODEL_CACHE_MS = Number(process.env.TABBIT_MODEL_CACHE_MS || 300_000);
const LARGE_AGENT_PROMPT_CHARS = 20_500;

let bridgePromise = null;
let chatPagePromise = null;
let modelCache = null;
let sendQueue = Promise.resolve();
let activeSendCount = 0;
let lastBridgeError = null;
let streamSequence = 0;
let pageModuleSendUnavailable = false;

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function rememberBridgeError(error, source) {
  lastBridgeError = {
    source,
    message: serializeError(error),
    at: new Date().toISOString(),
  };
}

function summarizePath(value) {
  const parts = cleanText(value).split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) {
    return parts.join("/");
  }

  return `.../${parts.slice(-2).join("/")}`;
}

function bridgeDiagnostics(profile = null) {
  const syncWarnings = Array.isArray(profile?.syncWarnings)
    ? profile.syncWarnings
    : [];
  return {
    modelCache: {
      cached: Boolean(modelCache),
      modelCount: modelCache?.models?.length || 0,
      expiresAt: modelCache?.expiresAt || null,
      ttlMs: modelCache ? Math.max(0, modelCache.expiresAt - Date.now()) : 0,
    },
    queue: {
      active: activeSendCount,
      busy: activeSendCount > 0,
    },
    runtimeProfile: {
      labProfileDir: summarizePath(profile?.labProfileDir || LAB_PROFILE_DIR),
      defaultProfileDir: summarizePath(profile?.defaultProfileDir || ""),
      syncWarnings,
    },
    lastBridgeError,
  };
}

function runExclusively(task) {
  const nextTask = sendQueue.catch(() => {}).then(async () => {
    activeSendCount += 1;
    try {
      return await task();
    } finally {
      activeSendCount -= 1;
    }
  });
  sendQueue = nextTask.catch(() => {});
  return nextTask;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isNavigationContextError(error) {
  return /execution context was destroyed|cannot find context with specified id/i.test(
    serializeError(error),
  );
}

async function waitForTabbitPageReady(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  } catch {
    // A client-side route may already be transitioning to the session page.
  }
  await page.waitForFunction(
    () => Array.isArray(globalThis.webpackChunk_N_E),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
}

export async function evaluateTabbitPageWithNavigationRetry(
  page,
  evaluator,
  argument,
  { preparePage = waitForTabbitPageReady } = {},
) {
  try {
    return await page.evaluate(evaluator, argument);
  } catch (error) {
    if (!isNavigationContextError(error)) {
      throw error;
    }
    await preparePage(page);
    return page.evaluate(evaluator, argument);
  }
}

export function shouldFallbackToTabbitUi(result) {
  return Boolean(
    result &&
      !result.ok &&
      result.error === "send_threw" &&
      /Unable to find Tabbit sendMessage function/i.test(
        cleanText(result.detail),
      ),
  );
}

export function isTabbitModelUnavailableText(value) {
  const text = cleanText(value);
  return Boolean(
    /\[492\]/i.test(text) ||
      /欢迎使用\s*Tabbit\s*浏览器/i.test(text) ||
      /免费使用最全最先进的模型/i.test(text) ||
      /AI\s*服务.*不可用/i.test(text) ||
      /暂时不可用/i.test(text) ||
      /稍后重试/i.test(text) ||
      /Unable to process this request at the moment\.?/i.test(text),
  );
}

async function prepareUiChatPage(page) {
  await page.goto(TABBIT_CHAT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await waitForTabbitPageReady(page);
  await page.waitForSelector('[data-chip-editor="true"]', {
    state: "visible",
    timeout: 30_000,
  });
}

async function selectUiModel(page, selectedModel) {
  const modelButton = page
    .locator('button[aria-haspopup="dialog"]')
    .filter({ hasText: /\S/ })
    .last();
  await modelButton.waitFor({ state: "visible", timeout: 30_000 });
  const currentModel = cleanText(await modelButton.innerText()).split("\n")[0];
  if (currentModel === selectedModel) {
    return;
  }

  await modelButton.click();
  await page.waitForSelector('[role="option"] [data-model-selector-model-name]', {
    state: "visible",
    timeout: 15_000,
  });
  const selected = await page.evaluate((modelName) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const option = options.find(
      (candidate) =>
        candidate
          .querySelector("[data-model-selector-model-name]")
          ?.textContent?.trim() === modelName,
    );
    if (!option) {
      return false;
    }
    option.click();
    return true;
  }, selectedModel);
  if (!selected) {
    throw new Error(`Unable to select Tabbit model '${selectedModel}' in the UI.`);
  }

  await page.waitForFunction(
    (modelName) =>
      Array.from(
        document.querySelectorAll('button[aria-haspopup="dialog"]'),
      ).some(
        (element) =>
          element.innerText?.trim().split("\n")[0] === modelName,
      ),
    selectedModel,
    { timeout: 15_000 },
  );
}

async function readUiAssistantSnapshot(page) {
  return page.evaluate(() => {
    const assistants = Array.from(
      document.querySelectorAll('[data-message-type="assistant"]'),
    );
    const assistant = assistants[assistants.length - 1];
    if (!assistant) {
      return null;
    }
    const renderer = assistant.querySelector(".markdown-renderer");
    const actionBar = assistant.querySelector(
      '[data-message-action-bar="true"]',
    );
    return {
      complete: Boolean(
        actionBar && !actionBar.classList.contains("pointer-events-none"),
      ),
      id: assistant.getAttribute("data-message-id") || null,
      idle: Boolean(document.querySelector("#ChatSendButton")),
      rawText: (assistant.innerText || "").trim(),
      text: (renderer?.innerText || "").trim(),
    };
  });
}

async function sendUsingPageUi(
  page,
  { prompt, selectedModel, timeoutMs, onDelta, attachments = [] },
) {
  if (attachments.length > 0) {
    return {
      ok: false,
      error: "invalid_request",
      detail:
        "The current Tabbit Web UI fallback does not expose attachment injection. Text requests remain supported; attachment requests require a compatible Tabbit page module.",
      source: "ui_fallback",
    };
  }

  try {
    await prepareUiChatPage(page);
    const loginState = await readLoginState(page);
    const loginFailure = diagnoseLoginState(loginState, selectedModel, prompt);
    if (loginFailure) {
      return { ...loginFailure, source: "ui_fallback" };
    }

    await selectUiModel(page, selectedModel);
    const editor = page.locator('[data-chip-editor="true"]');
    await editor.fill(prompt);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#ChatSendButton")
          ?.getAttribute("data-send-blocked") !== "true",
      null,
      { timeout: 15_000 },
    );
    await page.locator("#ChatSendButton").click();

    const deadline = Date.now() + timeoutMs;
    let emittedText = "";
    let latestSnapshot = null;
    while (Date.now() < deadline) {
      const snapshot = await readUiAssistantSnapshot(page);
      if (snapshot) {
        latestSnapshot = snapshot;
        if (snapshot.text && snapshot.text !== emittedText) {
          const delta = snapshot.text.startsWith(emittedText)
            ? snapshot.text.slice(emittedText.length)
            : snapshot.text;
          emittedText = snapshot.text;
          if (delta && typeof onDelta === "function") {
            onDelta(delta);
          }
        }

        if (snapshot.complete) {
          const detail = snapshot.text || snapshot.rawText;
          if (isTabbitModelUnavailableText(detail)) {
            return {
              ok: false,
              error: "model_unavailable",
              detail,
              errorCodes: [492],
              partialText: snapshot.text,
              source: "ui_fallback",
            };
          }
          if (snapshot.text) {
            return {
              ok: true,
              text: snapshot.text,
              source: "ui_fallback",
            };
          }
          if (
            snapshot.rawText &&
            !/^(思考中|Thinking|Generating)[.….]*$/i.test(snapshot.rawText)
          ) {
            return {
              ok: false,
              error: "chatFinished_without_text",
              detail: snapshot.rawText,
              source: "ui_fallback",
            };
          }
        }

        if (
          snapshot.idle &&
          !snapshot.text &&
          snapshot.rawText &&
          !/^(思考中|Thinking|Generating)[.….]*$/i.test(snapshot.rawText)
        ) {
          return {
            ok: false,
            error: "model_unavailable",
            detail: snapshot.rawText,
            partialText: "",
            source: "ui_fallback",
          };
        }
      }
      await page.waitForTimeout(100);
    }

    return {
      ok: false,
      error: "timeout",
      detail: `Timed out after ${timeoutMs}ms waiting for the Tabbit UI response.`,
      partialText: latestSnapshot?.text || "",
      source: "ui_fallback",
    };
  } catch (error) {
    return {
      ok: false,
      error: /timeout/i.test(serializeError(error)) ? "timeout" : "send_threw",
      detail: serializeError(error),
      source: "ui_fallback",
    };
  }
}

function randomReferenceId() {
  return `${Date.now() + Math.floor(Math.random() * 1_000_000)}`;
}

export function attachmentUploadResultToReference(
  attachment,
  uploadResult,
  referenceHelpers = null,
) {
  const fileId = cleanText(
    uploadResult?.fileId ||
      uploadResult?.file_id ||
      uploadResult?.id ||
      uploadResult?.path,
  );
  if (!fileId) {
    throw new Error(
      `Tabbit upload did not return a file id for '${attachment?.filename || "attachment"}'.`,
    );
  }

  const title = cleanText(
    uploadResult?.fileName ||
      uploadResult?.filename ||
      uploadResult?.name ||
      attachment?.filename,
  );
  const url = cleanText(uploadResult?.url || uploadResult?.fileUrl || "");

  if (attachment?.kind === "image" && typeof referenceHelpers?.rf === "function") {
    const reference = referenceHelpers.rf(title, url, fileId);
    return attachment.sourceUrl
      ? { ...reference, sourceUrl: attachment.sourceUrl }
      : reference;
  }

  if (attachment?.kind !== "image" && typeof referenceHelpers?.vT === "function") {
    return referenceHelpers.vT(title, fileId);
  }

  if (attachment?.kind === "image") {
    return {
      id: randomReferenceId(),
      type: "image",
      title,
      content: url,
      favicon: "",
      path: fileId,
      ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
    };
  }

  return {
    id: randomReferenceId(),
    type: "document",
    title,
    content: "",
    path: fileId,
  };
}

export async function putPresignedUpload({
  presignedUrl,
  bytes,
  mimeType,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Node fetch is unavailable for Tabbit attachment upload.");
  }

  if (!cleanText(presignedUrl)) {
    throw new Error("Tabbit upload did not return a presigned upload URL.");
  }

  if (!bytes) {
    throw new Error("Attachment has no upload bytes.");
  }

  const response = await fetchImpl(presignedUrl, {
    method: "PUT",
    body: Buffer.from(bytes, "base64"),
    headers: {
      "Content-Type": mimeType || "application/octet-stream",
    },
  });

  if (!response?.ok) {
    throw new Error(
      `Tabbit COS upload failed: HTTP ${response?.status || "error"} ${
        response?.statusText || ""
      }`.trim(),
    );
  }

  return { success: true };
}

async function createBridge() {
  const profile = await prepareLabProfile({
    sourceUserDataDir: TABBIT_USER_DATA_DIR,
    labProfileDir: LAB_PROFILE_DIR,
  });

  const context = await launchTabbitSession(profile.labProfileDir, {
    headless: false,
  });

  const bridge = {
    context,
    page: null,
    profile,
  };

  context.on("close", () => {
    if (bridgePromise) {
      bridgePromise = null;
    }
  });

  return bridge;
}

async function ensureBridge() {
  if (!bridgePromise) {
    bridgePromise = createBridge();
  }

  try {
    return await bridgePromise;
  } catch (error) {
    bridgePromise = null;
    throw error;
  }
}

async function ensureChatPage(bridge) {
  let { page } = bridge;
  if (!page || page.isClosed()) {
    if (!chatPagePromise) {
      chatPagePromise = (async () => {
        const nextPage = await openPage(bridge.context, TABBIT_CHAT_URL);
        await waitForTabbitPageReady(nextPage);
        bridge.page = nextPage;
        return nextPage;
      })().finally(() => {
        chatPagePromise = null;
      });
    }

    return chatPagePromise;
  }

  await waitForTabbitPageReady(page);
  return page;
}

async function readLoginState(page) {
  return page.evaluate(async () => {
    const tabSignin = globalThis.chrome?.tabSignin;
    const hasTabSignin = Boolean(
      tabSignin && typeof tabSignin.getLoginState === "function",
    );
    const loginState =
      hasTabSignin
        ? await tabSignin.getLoginState()
        : null;
    const bodyText = document.body?.innerText || "";

    return {
      loginState,
      hasTabSignin,
      hasBrowserGateMessage:
        /欢迎使用\s*Tabbit\s*浏览器/i.test(bodyText) ||
        /免费使用最全最先进的模型/i.test(bodyText),
      hasComposer: Boolean(
        document.querySelector(
          "textarea, [contenteditable='true'], [data-chip-editor='true'], input[type='text']",
        ),
      ),
      isLoginPage: /\/login(?:\/|$)/i.test(location.pathname),
      url: location.href,
      title: document.title,
    };
  });
}

function loginStateFlags(loginState) {
  const direct = loginState?.loginState;
  const nested = direct?.loginState;
  return nested && typeof nested === "object" ? nested : direct;
}

function isLoggedOut(loginState) {
  const flags = loginStateFlags(loginState);
  return Boolean(
    flags &&
      flags.isLoggedIn === false &&
      flags.hasToken === false,
  );
}

function promptDiagnostics(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  if (!text) {
    return "";
  }

  const diagnostics = [
    `Prompt diagnostics: ${text.length} characters were sent to Tabbit. Agent clients can include hidden system and context text even when the visible user message is short.`,
  ];

  if (text.length > LARGE_AGENT_PROMPT_CHARS) {
    diagnostics.push(
      "This exceeds Tabbit's observed 20500-character prompt limit. Tabbit2API normally compacts agent context before sending; if this still appears after a minimal `/v1/responses` request succeeds, reduce the current user input, attachment metadata, tool schemas, or recent conversation context.",
    );
  }

  return diagnostics.join(" ");
}

function appendPromptDiagnostics(detail, prompt) {
  const diagnostic = promptDiagnostics(prompt);
  const message = cleanText(detail);
  if (!diagnostic || message.includes("Prompt diagnostics:")) {
    return message;
  }

  return `${message}\n\n${diagnostic}`;
}

export function diagnoseLoginState(loginState, requestedModelAlias, prompt) {
  if (loginState?.isLoginPage) {
    return {
      ok: false,
      error: "login_required",
      detail: appendPromptDiagnostics(
        "The local Tabbit runtime page is on the login page even though cached browser state may still contain a token. Close all Tabbit windows, then run `tabbit2api login --refresh` and complete sign-in in the login window.",
        prompt,
      ),
      requestedModelAlias,
      attemptedModels: [],
      fallbackHappened: false,
    };
  }

  if (!loginState?.hasTabSignin) {
    return {
      ok: false,
      error: "login_required",
      detail: appendPromptDiagnostics(
        "Tabbit sign-in state is not available in the runtime page. Close all Tabbit windows, then run `tabbit2api login --refresh` and sign in once inside the login browser window.",
        prompt,
      ),
      requestedModelAlias,
      attemptedModels: [],
      fallbackHappened: false,
    };
  }

  if (loginState.hasBrowserGateMessage) {
    return {
      ok: false,
      error: "login_required",
      detail: appendPromptDiagnostics(
        "Tabbit returned the browser sign-in gate in the runtime page. Close all Tabbit windows, then run `tabbit2api login --refresh` so Tabbit2API can refresh its local runtime profile.",
        prompt,
      ),
      requestedModelAlias,
      attemptedModels: [],
      fallbackHappened: false,
    };
  }

  if (isLoggedOut(loginState)) {
    return {
      ok: false,
      error: "login_required",
      detail: appendPromptDiagnostics(
        "The local Tabbit runtime profile is not logged in. Run `tabbit2api login --refresh` and sign in once inside the login browser window.",
        prompt,
      ),
      requestedModelAlias,
      attemptedModels: [],
      fallbackHappened: false,
    };
  }

  return null;
}

async function sendUsingPageModule(
  page,
  { prompt, selectedModel, timeoutMs, models, onDelta, attachments = [] },
) {
  const streamId = `tabbit-stream-${Date.now()}-${++streamSequence}`;
  const uploadBridgeName = `tabbit-upload-${Date.now()}-${streamSequence}`;
  if (onDelta) {
    await page.exposeFunction(streamId, (payload) => {
      if (payload && typeof payload.delta === "string" && payload.delta) {
        onDelta(payload.delta);
      }
    });
  }

  await page.exposeFunction(uploadBridgeName, async (payload) => {
    try {
      await putPresignedUpload(payload || {});
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: serializeError(error),
      };
    }
  });

  try {
    return await page.evaluate(
      async ({
      prompt,
      selectedModel,
      timeoutMs,
      models,
      streamBridgeName,
      uploadBridgeName,
      attachments,
      }) => {
      function captureWebpackRequire() {
        let runtime = null;
        self.webpackChunk_N_E.push([
          [Symbol("tabbit-gateway-bridge")],
          {},
          (require) => {
            runtime = require;
          },
        ]);

        if (!runtime) {
          throw new Error("Unable to capture Tabbit webpack runtime.");
        }

        return runtime;
      }

      function stringifyDetail(detail) {
        if (typeof detail === "string") {
          return detail;
        }

        try {
          return JSON.stringify(detail);
        } catch {
          return String(detail);
        }
      }

      function summarizeFailure(args) {
        return args.map((value) => stringifyDetail(value)).join(" | ");
      }

      function cleanText(value) {
        return typeof value === "string" ? value.trim() : "";
      }

      function bytesFromBase64(base64) {
        const binary = atob(base64 || "");
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }

      function withTimeout(promise, timeout, label) {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeout}ms.`));
          }, timeout);
        });

        return Promise.race([promise, timeoutPromise]).finally(() => {
          clearTimeout(timer);
        });
      }

      function resolveReferenceHelpers(runtime) {
        for (const moduleId of [53045, 45677]) {
          try {
            const candidate = runtime(moduleId);
            if (
              typeof candidate?.rf === "function" ||
              typeof candidate?.vT === "function"
            ) {
              return candidate;
            }
          } catch {
            // Module ids change between Tabbit Web builds.
          }
        }

        return null;
      }

      function resolveCosUploadApi(runtime) {
        try {
          const candidate = runtime(93703);
          if (
            typeof candidate?.Kh === "function" &&
            typeof candidate?.dd === "function"
          ) {
            return candidate;
          }
        } catch {
          // Fall back to the browser-side upload helper.
        }

        return null;
      }

      function resolveSendMessage(runtime) {
        for (const moduleId of [51523, 187]) {
          try {
            const candidate = runtime(moduleId);
            if (typeof candidate?._z === "function") {
              return candidate._z;
            }
          } catch {
            // Module ids change between Tabbit Web builds.
          }
        }

        const requiredSignals = [
          "selectedModels",
          "setMessages",
          "startGenerating",
          "stopGenerating",
          "onChatFinish",
          "onFailed",
          "useDirectApi",
        ];
        for (const moduleId of Object.keys(runtime.m || {})) {
          let candidate;
          try {
            candidate = runtime(moduleId);
          } catch {
            continue;
          }
          if (!candidate || typeof candidate !== "object") {
            continue;
          }
          for (const value of Object.values(candidate)) {
            if (typeof value !== "function") {
              continue;
            }
            let source = "";
            try {
              source = Function.prototype.toString.call(value);
            } catch {
              continue;
            }
            if (requiredSignals.every((signal) => source.includes(signal))) {
              return value;
            }
          }
        }

        throw new Error("Unable to find Tabbit sendMessage function.");
      }

      function resolveModes(runtime) {
        for (const [moduleId, exportKey] of [
          [32386, "R7"],
          [86220, "R7"],
          [81487, "R"],
        ]) {
          try {
            const candidate = runtime(moduleId)?.[exportKey];
            if (candidate?.ASK === "ask") {
              return candidate;
            }
          } catch {
            // Module ids change between Tabbit Web builds.
          }
        }

        for (const moduleId of Object.keys(runtime.m || {})) {
          let candidate;
          try {
            candidate = runtime(moduleId);
          } catch {
            continue;
          }
          if (!candidate || typeof candidate !== "object") {
            continue;
          }
          for (const value of Object.values(candidate)) {
            if (
              value &&
              typeof value === "object" &&
              value.ASK === "ask" &&
              value.MULTI_MODEL === "multi_model"
            ) {
              return value;
            }
          }
        }

        throw new Error("Unable to find Tabbit chat mode constants.");
      }

      function uploadResultToReference(attachment, uploadResult, referenceHelpers) {
        const fileId = cleanText(
          uploadResult?.fileId ||
            uploadResult?.file_id ||
            uploadResult?.id ||
            uploadResult?.path,
        );
        if (!fileId) {
          throw new Error(
            `Tabbit upload did not return a file id for '${
              attachment?.filename || "attachment"
            }'.`,
          );
        }

        const title = cleanText(
          uploadResult?.fileName ||
            uploadResult?.filename ||
            uploadResult?.name ||
            attachment?.filename,
        );
        const url = cleanText(uploadResult?.url || uploadResult?.fileUrl || "");

        if (
          attachment?.kind === "image" &&
          typeof referenceHelpers?.rf === "function"
        ) {
          const reference = referenceHelpers.rf(title, url, fileId);
          return attachment.sourceUrl
            ? { ...reference, sourceUrl: attachment.sourceUrl }
            : reference;
        }

        if (
          attachment?.kind !== "image" &&
          typeof referenceHelpers?.vT === "function"
        ) {
          return referenceHelpers.vT(title, fileId);
        }

        if (attachment?.kind === "image") {
          return {
            id: `${Date.now() + Math.floor(Math.random() * 1_000_000)}`,
            type: "image",
            title,
            content: url,
            favicon: "",
            path: fileId,
            ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
          };
        }

        return {
          id: `${Date.now() + Math.floor(Math.random() * 1_000_000)}`,
          type: "document",
          title,
          content: "",
          path: fileId,
        };
      }

      async function uploadAttachmentWithNodeBridge(
        runtime,
        attachment,
        uploadTimeoutMs,
      ) {
        const uploadApi = resolveCosUploadApi(runtime);
        if (!uploadApi || typeof self[uploadBridgeName] !== "function") {
          return null;
        }

        const mimeType = attachment.mimeType || "application/octet-stream";
        const isImage = attachment.kind === "image";
        const presign = await withTimeout(
          uploadApi.Kh(
            isImage ? "image" : "document",
            attachment.filename,
            mimeType,
            isImage,
            isImage ? 1_728_000 : undefined,
          ),
          uploadTimeoutMs,
          `Preparing attachment '${attachment.filename}'`,
        );

        if (!presign?.success || !presign.presignedUrl || !presign.fileId) {
          throw new Error(
            presign?.error ||
              presign?.message ||
              `Tabbit did not return a presigned upload URL for '${attachment.filename}'.`,
          );
        }

        const uploadResult = await withTimeout(
          self[uploadBridgeName]({
            presignedUrl: presign.presignedUrl,
            bytes: attachment.bytes,
            mimeType,
          }),
          uploadTimeoutMs,
          `Uploading attachment '${attachment.filename}'`,
        );

        if (!uploadResult?.success) {
          throw new Error(
            uploadResult?.error ||
              `Tabbit COS upload failed for '${attachment.filename}'.`,
          );
        }

        const complete = await withTimeout(
          uploadApi.dd(presign.fileId),
          uploadTimeoutMs,
          `Completing attachment upload '${attachment.filename}'`,
        );

        if (!complete?.success) {
          throw new Error(
            complete?.error ||
              complete?.message ||
              `Tabbit upload completion failed for '${attachment.filename}'.`,
          );
        }

        return {
          success: true,
          url:
            isImage && presign.downloadUrl
              ? presign.downloadUrl
              : presign.presignedUrl.split("?")[0],
          fileName: attachment.filename,
          fileId: presign.fileId,
        };
      }

      async function uploadAttachments(runtime, attachmentList, uploadTimeoutMs) {
        if (!Array.isArray(attachmentList) || attachmentList.length === 0) {
          return [];
        }

        let uploadFile;
        try {
          uploadFile = runtime(68886).w;
        } catch {
          uploadFile = null;
        }

        const canUseNodeUpload = Boolean(resolveCosUploadApi(runtime));
        if (typeof uploadFile !== "function" && !canUseNodeUpload) {
          throw new Error("Unable to find Tabbit attachment upload function.");
        }

        const referenceHelpers = resolveReferenceHelpers(runtime);

        const references = [];
        for (const attachment of attachmentList) {
          if (!attachment?.bytes) {
            throw new Error(
              `Attachment '${attachment?.filename || "attachment"}' has no upload bytes.`,
            );
          }

          const file = new File([bytesFromBase64(attachment.bytes)], attachment.filename, {
            type: attachment.mimeType || "application/octet-stream",
          });
          let uploadResult;
          let nodeUploadError = null;
          try {
            uploadResult = await uploadAttachmentWithNodeBridge(
              runtime,
              attachment,
              uploadTimeoutMs,
            );
          } catch (error) {
            nodeUploadError = error;
          }

          if (!uploadResult && typeof uploadFile === "function") {
            try {
              uploadResult = await withTimeout(
                uploadFile(file, {
                  fileCategory: attachment.kind === "image" ? "image" : "document",
                }),
                uploadTimeoutMs,
                `Uploading attachment '${attachment.filename}'`,
              );
            } catch (error) {
              if (nodeUploadError) {
                throw nodeUploadError;
              }
              throw error;
            }
          }

          if (!uploadResult && nodeUploadError) {
            throw nodeUploadError;
          }

          if (!uploadResult || uploadResult.success === false) {
            throw new Error(
              uploadResult?.error ||
                uploadResult?.message ||
                `Tabbit upload failed for '${attachment.filename}'.`,
            );
          }

          references.push(
            uploadResultToReference(attachment, uploadResult, referenceHelpers),
          );
        }

        return references;
      }

      function findLatestAssistant(messages) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index]?.type === "assistant") {
            return messages[index];
          }
        }

        return null;
      }

      function collectAssistantText(assistant) {
        if (!assistant) {
          return "";
        }

        const parts = [];

        function visit(node) {
          if (!node) {
            return;
          }

          if (Array.isArray(node)) {
            for (const item of node) {
              visit(item);
            }
            return;
          }

          if (typeof node === "string") {
            parts.push(node);
            return;
          }

          if (typeof node !== "object") {
            return;
          }

          if (node.type === "assistant" && typeof node.content === "string") {
            parts.push(node.content);
          }

          if (Array.isArray(node.messages)) {
            visit(node.messages);
          }

          if (Array.isArray(node.content)) {
            visit(node.content);
          }
        }

        visit(assistant.messages || []);
        return parts.join("").trim();
      }

      function getAssistantTextParts(assistant) {
        if (!assistant) {
          return [];
        }

        const parts = [];

        function visit(node) {
          if (!node) {
            return;
          }

          if (Array.isArray(node)) {
            for (const item of node) {
              visit(item);
            }
            return;
          }

          if (typeof node === "string") {
            parts.push(node);
            return;
          }

          if (typeof node !== "object") {
            return;
          }

          if (node.type === "assistant" && typeof node.content === "string") {
            parts.push(node.content);
          }

          if (Array.isArray(node.messages)) {
            visit(node.messages);
          }

          if (Array.isArray(node.content)) {
            visit(node.content);
          }
        }

        visit(assistant.messages || []);
        return parts;
      }

      function assistantErrors(assistant) {
        if (!assistant || !Array.isArray(assistant.messages)) {
          return [];
        }

        return assistant.messages
          .filter((entry) => entry?.type === "error")
          .map((entry) => ({
            code: entry.code || null,
            message:
              entry.content ||
              entry.message ||
              `Error ${entry.code || ""}`.trim(),
          }))
          .filter((entry) => entry.message || entry.code);
      }

      function isBrowserGateDetail(detail) {
        return (
          /\[492\]/i.test(detail || "") ||
          /欢迎使用\s*Tabbit\s*浏览器/i.test(detail || "") ||
          /免费使用最全最先进的模型/i.test(detail || "")
        );
      }

      function assistantRequiresLogin(assistant) {
        return assistant?.messages?.some((entry) => entry?.type === "login") || false;
      }

      function summarizeStateMessages(messages, references) {
        return JSON.stringify({
          reference_count: references.length,
          messages: (messages || []).slice(-3).map((message) => ({
            type: message?.type || null,
            status: message?.status || null,
            generating: Boolean(message?.generating),
            content_type: typeof message?.content,
            content_preview:
              typeof message?.content === "string"
                ? message.content.slice(0, 160)
                : "",
            nested_types: Array.isArray(message?.messages)
              ? message.messages.slice(-5).map((entry) => ({
                  type: entry?.type || null,
                  status: entry?.status || null,
                  code: entry?.code || null,
                  content_type: typeof entry?.content,
                  content_preview:
                    typeof entry?.content === "string"
                      ? entry.content.slice(0, 160)
                      : "",
                }))
              : [],
          })),
        });
      }

      const runtime = captureWebpackRequire();
      const sendMessage = resolveSendMessage(runtime);
      const modes = resolveModes(runtime);

      const state = {
        messages: [],
      };
      let emittedText = "";

      let settled = false;
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });

      const settle = (payload) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolveDone(payload);
      };

      const finishFromState = (source) => {
        const assistant = findLatestAssistant(state.messages);
        if (!assistant || assistant.generating) {
          emitDeltaFromAssistant(assistant);
          return false;
        }

        emitDeltaFromAssistant(assistant);

        if (assistantRequiresLogin(assistant)) {
          settle({
            ok: false,
            error: "login_required",
            detail: "The local Tabbit runtime profile is not logged in yet.",
            source,
          });
          return true;
        }

        const errors = assistantErrors(assistant);
        if (errors.length > 0) {
          const detail = errors
            .map((entry) =>
              entry.code ? `[${entry.code}] ${entry.message}` : entry.message,
            )
            .join("\n");
          if (isBrowserGateDetail(detail)) {
            settle({
              ok: false,
              error: "model_unavailable",
              detail,
              errorCodes: errors
                .map((entry) => entry.code)
                .filter(Boolean),
              partialText: collectAssistantText(assistant),
              source,
            });
            return true;
          }

          settle({
            ok: false,
            error: "tabbit_error",
            detail,
            errorCodes: errors
              .map((entry) => entry.code)
              .filter(Boolean),
            partialText: collectAssistantText(assistant),
            source,
          });
          return true;
        }

        const text = collectAssistantText(assistant);
        if (text) {
          settle({
            ok: true,
            text,
            source,
          });
          return true;
        }

        return false;
      };

      const emitDeltaFromAssistant = (assistant) => {
        if (!assistant || typeof self[streamBridgeName] !== "function") {
          return;
        }

        const nextText = getAssistantTextParts(assistant).join("").trim();
        if (!nextText || nextText.length <= emittedText.length) {
          return;
        }

        if (!nextText.startsWith(emittedText)) {
          emittedText = nextText;
          self[streamBridgeName]({ delta: nextText });
          return;
        }

        const delta = nextText.slice(emittedText.length);
        emittedText = nextText;
        if (delta) {
          self[streamBridgeName]({ delta });
        }
      };

      const setMessages = (_sessionId, updater) => {
        state.messages =
          typeof updater === "function" ? updater(state.messages) : updater;
        finishFromState("setMessages");
      };

      const timer = setTimeout(() => {
        const assistant = findLatestAssistant(state.messages);
        settle({
          ok: false,
          error: "timeout",
          detail: `Timed out after ${timeoutMs}ms waiting for Tabbit.`,
          partialText: collectAssistantText(assistant),
        });
      }, timeoutMs);

      let references = [];
      const delayFailure = (kind, detail) => {
        setTimeout(() => {
          if (!finishFromState(kind)) {
            settle({
              ok: false,
              error: kind,
              detail: `${detail}\nState: ${summarizeStateMessages(
                state.messages,
                references,
              )}`,
              partialText: collectAssistantText(findLatestAssistant(state.messages)),
            });
          }
        }, 100);
      };

      try {
        const uploadTimeoutMs = Math.min(
          Math.max(15_000, Math.floor(timeoutMs / 3)),
          60_000,
        );
        references = await uploadAttachments(runtime, attachments, uploadTimeoutMs);
      } catch (error) {
        settle({
          ok: false,
          error: "invalid_request",
          detail:
            error instanceof Error
              ? error.message
              : `Attachment upload failed: ${stringifyDetail(error)}`,
        });
        return done;
      }

      try {
        const maybePromise = sendMessage({
          messageId: null,
          message: prompt,
          originHTML: "",
          references,
          sessionId: "",
          model: selectedModel,
          selectedModels: [selectedModel],
          mod: modes.ASK,
          url: "",
          source: "singleSession",
          useDirectApi: false,
          models,
          updateSessionId: () => {},
          setMessages,
          setSessionTitle: () => {},
          shouldApplyAutoSessionTitle: () => true,
          onBeforeSend: () => {},
          startGenerating: () => {},
          stopGenerating: () => {
            delayFailure(
              "stopGenerating_without_text",
              "Tabbit stopped without returning text.",
            );
          },
          associateTabWithSession: () => {},
          updateBrowserUseStatus: () => {},
          errorMessages: {},
          onModelChange: () => {},
          refreshModels: () => {},
          onChatFinish: () => {
            delayFailure(
              "chatFinished_without_text",
              "Tabbit finished without returning text.",
            );
          },
          onFailed: (...args) => {
            delayFailure(
              "send_failed",
              summarizeFailure(args) || "Tabbit send failed.",
            );
          },
        });

        Promise.resolve(maybePromise).catch((error) => {
          settle({
            ok: false,
            error: "send_threw",
            detail: stringifyDetail(error),
          });
        });
      } catch (error) {
        settle({
          ok: false,
          error: "send_threw",
          detail: stringifyDetail(error),
        });
      }

        return done;
      },
      {
        prompt,
        selectedModel,
        timeoutMs,
        models,
        streamBridgeName: streamId,
        uploadBridgeName,
        attachments,
      },
    );
  } catch (error) {
    return {
      ok: false,
      error: "send_threw",
      detail: serializeError(error),
    };
  }
}

export async function getTabbitModels() {
  if (modelCache && modelCache.expiresAt > Date.now()) {
    return modelCache.models;
  }

  const bridge = await ensureBridge();
  const page = await ensureChatPage(bridge);
  let payload;
  try {
    payload = await evaluateTabbitPageWithNavigationRetry(page, async (url) => {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Tabbit model list request failed: ${response.status}`);
    }

    return response.json();
    }, TABBIT_MODELS_URL);
  } catch (error) {
    rememberBridgeError(error, "getTabbitModels");
    throw error;
  }

  const models = Array.isArray(payload?.models) ? payload.models : [];

  modelCache = {
    expiresAt: Date.now() + MODEL_CACHE_MS,
    models,
  };

  return models;
}

export async function getGatewayModelCatalog() {
  const models = await getTabbitModels();
  return buildGatewayCatalogBundle(models).models;
}

export async function getBridgeHealth() {
  if (!bridgePromise) {
    return {
      status: "ok",
      mode: "tabbit-web-bridge",
      runtimeInitialized: false,
      ...bridgeDiagnostics(),
    };
  }

  try {
    const bridge = await bridgePromise;
    const page =
      bridge.page && !bridge.page.isClosed()
        ? bridge.page
        : bridge.context.pages().find((candidate) => !candidate.isClosed()) ||
          null;

    if (!page) {
      return {
        status: "ok",
        mode: "tabbit-web-bridge",
        runtimeInitialized: true,
        pageReady: false,
        ...bridgeDiagnostics(bridge.profile),
      };
    }

    return {
      status: "ok",
      mode: "tabbit-web-bridge",
      runtimeInitialized: true,
      pageReady: true,
      ...bridgeDiagnostics(bridge.profile),
      ...(await readLoginState(page)),
    };
  } catch (error) {
    rememberBridgeError(error, "getBridgeHealth");
    return {
      status: "degraded",
      mode: "tabbit-web-bridge",
      runtimeInitialized: true,
      ...bridgeDiagnostics(),
      error: serializeError(error),
    };
  }
}

export async function sendPromptToTabbit({
  prompt,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onDelta,
  attachments = [],
}) {
  return runExclusively(async () => {
    const requestedModelAlias = normalizeRequestedModelId(model);
    let bridge;
    let page;
    try {
      bridge = await ensureBridge();
      page = await ensureChatPage(bridge);
    } catch (error) {
      rememberBridgeError(error, "sendPromptToTabbit.ensureBridge");
      throw error;
    }
    const loginState = await readLoginState(page);
    const loginFailure = diagnoseLoginState(
      loginState,
      requestedModelAlias,
      prompt,
    );
    if (loginFailure) {
      return loginFailure;
    }

    let rawModels = [];
    let catalogBundle = buildGatewayCatalogBundle(rawModels);

    try {
      rawModels = await getTabbitModels();
      catalogBundle = buildGatewayCatalogBundle(rawModels);
    } catch {
      rawModels = [];
      catalogBundle = buildGatewayCatalogBundle(rawModels);
    }

    const routePlan = resolveRoutePlan(model, catalogBundle);
    if (!routePlan.ok) {
      return routePlan.result;
    }

    let materializedAttachments;
    try {
      materializedAttachments = await materializeAttachmentsForUpload(attachments);
    } catch (error) {
      return {
        ok: false,
        error: "invalid_request",
        detail: error instanceof Error ? error.message : String(error),
        requestedModelAlias: routePlan.requestedModelAlias,
        attemptedModels: [],
        fallbackHappened: false,
      };
    }

    const attemptedModels = [];

    for (let index = 0; index < routePlan.attempts.length; index += 1) {
      const attempt = routePlan.attempts[index];
      attemptedModels.push(attempt.gatewayModelId);

      let result;
      if (
        catalogBundle.catalogAvailable &&
        attempt.availableInTabbitCatalog === false
      ) {
        result = {
          ok: false,
          error: "model_unavailable",
          detail: `${attempt.gatewayModelId} is not present in the current Tabbit model catalog.`,
        };
      } else {
        const sendOptions = {
          prompt,
          selectedModel: attempt.selectedModel,
          timeoutMs,
          models: rawModels,
          onDelta,
          attachments: materializedAttachments,
        };
        if (pageModuleSendUnavailable) {
          result = await sendUsingPageUi(page, sendOptions);
        } else {
          result = await sendUsingPageModule(page, sendOptions);
          if (shouldFallbackToTabbitUi(result)) {
            pageModuleSendUnavailable = true;
            result = await sendUsingPageUi(page, sendOptions);
          }
        }
      }

      const decoratedResult = {
        ...result,
        detail: result.ok
          ? result.detail
          : appendPromptDiagnostics(result.detail, prompt),
        selectedModel: attempt.selectedModel,
        gatewayModelId: attempt.gatewayModelId,
        requestedModelAlias: routePlan.requestedModelAlias,
        attemptedModels: [...attemptedModels],
        fallbackHappened: index > 0,
      };

      if (decoratedResult.ok) {
        return decoratedResult;
      }

      const failure = classifyAttemptFailure(decoratedResult);
      if (
        routePlan.kind !== "priority_chain" ||
        !failure.retryable ||
        index === routePlan.attempts.length - 1
      ) {
        return {
          ...decoratedResult,
          failure_reason: failure.reason,
        };
      }
    }

    return {
      ok: false,
      error: "tabbit_error",
      detail: "No Tabbit route attempts were executed.",
      requestedModelAlias: routePlan.requestedModelAlias,
      attemptedModels,
      fallbackHappened: attemptedModels.length > 1,
    };
  });
}
