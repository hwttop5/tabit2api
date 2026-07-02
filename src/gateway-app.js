import http from "node:http";
import {
  getBridgeHealth,
  getGatewayModelCatalog,
  sendPromptToTabbit,
} from "./tabbit-web-bridge.js";
import {
  readJson,
  writeJson,
  writeOpenAiError,
  writeAnthropicError,
  writeAuthenticationError,
  isAuthorized,
  isAnthropicRequest,
  normalizedPathname,
} from "./http-utils.js";
import {
  mapGatewayModelsToOpenAi,
  mapGatewayModelsToAnthropic,
  getAnthropicModelById,
  normalizeAnthropicRequestedModel,
  resolveAnthropicModelAlias,
} from "./models.js";
import {
  contentBlocksToText,
  normalizeAnthropicRequest,
  normalizeOpenAiRequest,
  runGatewaySession,
} from "./session-core.js";
import {
  buildAnthropicResponse,
  countAnthropicTokens,
  streamAnthropicResponse,
} from "./anthropic.js";
import { executeServerToolUse, normalizeServerToolDefinition } from "./server-tools.js";
import {
  buildTextResponse,
  streamTextResponse,
} from "./openai-responses.js";
import {
  buildChatCompletionResponse,
  normalizeChatCompletionsRequest,
  streamChatCompletionResponse,
} from "./openai-chat.js";
import {
  createAssistantsRuntime,
  writeAssistantSse,
} from "./openai-assistants.js";

function normalizeRequestMetadata(metadata) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata;
  }

  return {};
}

function statusCodeForResult(result) {
  if (result.error === "login_required" || result.failure_reason === "login_required") {
    return 401;
  }

  if (result.error === "invalid_request") {
    return 400;
  }

  if (result.error === "timeout") {
    return 504;
  }

  if (result.failure_reason === "upstream_unavailable") {
    return 503;
  }

  return 502;
}

function openAiErrorTypeForResult(result) {
  if (result.error === "login_required" || result.failure_reason === "login_required") {
    return "authentication_error";
  }

  if (result.error === "invalid_request") {
    return "invalid_request_error";
  }

  return "api_error";
}

function anthropicErrorTypeForResult(result) {
  if (result.error === "login_required" || result.failure_reason === "login_required") {
    return "authentication_error";
  }

  if (result.error === "invalid_request") {
    return "invalid_request_error";
  }

  return "api_error";
}

function logRouteResult(result, requestedModelAlias) {
  console.log(
    `[tabbit-route] requested=${
      result.requestedModelAlias || requestedModelAlias || "tabbit/priority"
    } attempts=${(result.attemptedModels || []).join(" -> ") || "(none)"} final=${
      result.ok ? result.gatewayModelId || result.selectedModel : "failed"
    } fallback=${Boolean(result.fallbackHappened)}`,
  );
}

async function handleHealth(res, deps) {
  writeJson(res, 200, await deps.getBridgeHealth());
}

async function handleModels(req, res, deps) {
  const models = await deps.getGatewayModelCatalog();
  if (isAnthropicRequest(req)) {
    writeJson(res, 200, mapGatewayModelsToAnthropic(models));
    return;
  }

  writeJson(res, 200, mapGatewayModelsToOpenAi(models));
}

function getQuery(req) {
  return Object.fromEntries(
    new URL(req.url || "/", "http://127.0.0.1").searchParams.entries(),
  );
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

function isAssistantsRoute(pathname) {
  return (
    pathname === "/v1/assistants" ||
    pathname.startsWith("/v1/assistants/") ||
    pathname === "/v1/threads" ||
    pathname.startsWith("/v1/threads/")
  );
}

function writeNotFound(res, message = "Resource was not found.") {
  writeOpenAiError(res, 404, message, "not_found_error");
}

async function handleModelById(_req, res, deps, modelId) {
  const model = getAnthropicModelById(modelId);
  if (!model) {
    writeAnthropicError(
      res,
      404,
      `Model '${modelId}' was not found.`,
      "not_found_error",
    );
    return;
  }

  await deps.getGatewayModelCatalog();
  writeJson(res, 200, model);
}

async function handleOpenAiResponses(req, res, deps) {
  const body = await readJson(req);
  const normalized = normalizeOpenAiRequest(body);

  if (!normalized.messages.length && !normalized.attachments.length) {
    writeOpenAiError(
      res,
      400,
      "No prompt text or attachments were found in the request body.",
      "invalid_request_error",
    );
    return;
  }

  const sessionResult = await deps.runGatewaySession(normalized);
  logRouteResult(sessionResult, body.model || "tabbit/priority");

  if (!sessionResult.ok) {
    writeOpenAiError(
      res,
      statusCodeForResult(sessionResult),
      sessionResult.detail || "Tabbit bridge request failed.",
      openAiErrorTypeForResult(sessionResult),
    );
    return;
  }

  const resultText = contentBlocksToText(sessionResult.contentBlocks);
  const responseBody = {
    ...body,
    metadata: {
      ...normalizeRequestMetadata(body.metadata),
      requested_model_alias: body.model || "tabbit/priority",
      attempted_models: (
        sessionResult.attemptedModels || [sessionResult.selectedModel || body.model]
      ).join(","),
      fallback_happened: String(Boolean(sessionResult.fallbackHappened)),
    },
  };

  if (body?.stream) {
    await streamTextResponse(
      res,
      responseBody,
      resultText,
      sessionResult.selectedModel || body.model || "tabbit/priority",
    );
    return;
  }

  writeJson(
    res,
    200,
    buildTextResponse(
      responseBody,
      resultText,
      sessionResult.selectedModel || body.model || "tabbit/priority",
    ),
  );
}

async function handleOpenAiChatCompletions(req, res, deps) {
  const body = await readJson(req);
  const normalized = normalizeChatCompletionsRequest(body);

  if (!normalized.messages.length && !normalized.attachments.length) {
    writeOpenAiError(
      res,
      400,
      "No conversation messages or attachments were provided.",
      "invalid_request_error",
    );
    return;
  }

  const sessionResult = await deps.runGatewaySession(normalized);
  logRouteResult(sessionResult, normalized.publicModel);

  if (!sessionResult.ok) {
    writeOpenAiError(
      res,
      statusCodeForResult(sessionResult),
      sessionResult.detail || "Tabbit bridge request failed.",
      openAiErrorTypeForResult(sessionResult),
    );
    return;
  }

  if (normalized.stream) {
    streamChatCompletionResponse(res, normalized, sessionResult);
    return;
  }

  writeJson(res, 200, buildChatCompletionResponse(normalized, sessionResult));
}

async function messagesForRun(runtime, threadId, runId) {
  const listed = await runtime.listMessages(threadId, { limit: 100, order: "asc" });
  if (!listed) {
    return [];
  }

  return listed.data.filter((message) => message.run_id === runId);
}

async function handleAssistants(req, res, deps, pathname) {
  const runtime = deps.assistantsRuntime;
  const parts = splitPath(pathname);
  const body =
    req.method === "POST" || req.method === "DELETE" ? await readJson(req) : {};
  const query = getQuery(req);

  if (pathname === "/v1/assistants") {
    if (req.method === "POST") {
      writeJson(res, 200, await runtime.createAssistant(body));
      return;
    }

    if (req.method === "GET") {
      writeJson(res, 200, await runtime.listAssistants(query));
      return;
    }
  }

  if (parts[1] === "assistants" && parts.length === 3) {
    const assistantId = decodeURIComponent(parts[2]);
    if (req.method === "GET") {
      const assistant = await runtime.getAssistant(assistantId);
      assistant ? writeJson(res, 200, assistant) : writeNotFound(res);
      return;
    }

    if (req.method === "POST") {
      const assistant = await runtime.updateAssistant(assistantId, body);
      assistant ? writeJson(res, 200, assistant) : writeNotFound(res);
      return;
    }

    if (req.method === "DELETE") {
      writeJson(res, 200, await runtime.deleteAssistant(assistantId));
      return;
    }
  }

  if (pathname === "/v1/threads") {
    if (req.method === "POST") {
      writeJson(res, 200, await runtime.createThread(body));
      return;
    }
  }

  if (pathname === "/v1/threads/runs" && req.method === "POST") {
    const run = await runtime.createThreadAndRun(body, deps.runGatewaySession);
    if (body.stream) {
      writeAssistantSse(
        res,
        run,
        await messagesForRun(runtime, run.thread_id, run.id),
      );
      return;
    }

    writeJson(res, 200, run);
    return;
  }

  if (parts[1] === "threads" && parts.length === 3) {
    const threadId = decodeURIComponent(parts[2]);
    if (req.method === "GET") {
      const thread = await runtime.getThread(threadId);
      thread ? writeJson(res, 200, thread) : writeNotFound(res);
      return;
    }

    if (req.method === "POST") {
      const thread = await runtime.updateThread(threadId, body);
      thread ? writeJson(res, 200, thread) : writeNotFound(res);
      return;
    }

    if (req.method === "DELETE") {
      writeJson(res, 200, await runtime.deleteThread(threadId));
      return;
    }
  }

  if (parts[1] === "threads" && parts[3] === "messages") {
    const threadId = decodeURIComponent(parts[2]);
    if (parts.length === 4 && req.method === "POST") {
      const message = await runtime.createMessage(threadId, body);
      message ? writeJson(res, 200, message) : writeNotFound(res);
      return;
    }

    if (parts.length === 4 && req.method === "GET") {
      const messages = await runtime.listMessages(threadId, query);
      messages ? writeJson(res, 200, messages) : writeNotFound(res);
      return;
    }

    if (parts.length === 5 && req.method === "GET") {
      const message = await runtime.getMessage(
        threadId,
        decodeURIComponent(parts[4]),
      );
      message ? writeJson(res, 200, message) : writeNotFound(res);
      return;
    }
  }

  if (parts[1] === "threads" && parts[3] === "runs") {
    const threadId = decodeURIComponent(parts[2]);
    if (parts.length === 4 && req.method === "POST") {
      const run = await runtime.createRun(threadId, body, deps.runGatewaySession);
      if (!run) {
        writeNotFound(res);
        return;
      }

      if (body.stream) {
        writeAssistantSse(
          res,
          run,
          await messagesForRun(runtime, threadId, run.id),
        );
        return;
      }

      writeJson(res, 200, run);
      return;
    }

    if (parts.length === 4 && req.method === "GET") {
      const runs = await runtime.listRuns(threadId, query);
      runs ? writeJson(res, 200, runs) : writeNotFound(res);
      return;
    }

    if (parts.length === 5 && req.method === "GET") {
      const run = await runtime.getRun(threadId, decodeURIComponent(parts[4]));
      run ? writeJson(res, 200, run) : writeNotFound(res);
      return;
    }

    if (
      parts.length === 6 &&
      parts[5] === "submit_tool_outputs" &&
      req.method === "POST"
    ) {
      const run = await runtime.submitToolOutputs(
        threadId,
        decodeURIComponent(parts[4]),
        body,
        deps.runGatewaySession,
      );
      if (!run) {
        writeNotFound(res);
        return;
      }

      if (body.stream) {
        writeAssistantSse(
          res,
          run,
          await messagesForRun(runtime, threadId, run.id),
        );
        return;
      }

      writeJson(res, 200, run);
      return;
    }
  }

  writeJson(res, 404, { error: "not_found" });
}

async function handleAnthropicMessages(req, res, deps) {
  const body = await readJson(req);
  const normalized = normalizeAnthropicRequest(body, {
    normalizeModel: normalizeAnthropicRequestedModel,
    normalizeServerTool: normalizeServerToolDefinition,
  });

  if (normalized.invalidToolTypes.length > 0) {
    writeAnthropicError(
      res,
      400,
      `Unsupported tool type(s): ${normalized.invalidToolTypes.join(", ")}`,
      "invalid_request_error",
    );
    return;
  }

  if (!normalized.messages.length && !normalized.attachments.length) {
    writeAnthropicError(
      res,
      400,
      "No conversation messages or attachments were provided.",
      "invalid_request_error",
    );
    return;
  }

  if (body?.model && !resolveAnthropicModelAlias(body.model)) {
    writeAnthropicError(
      res,
      400,
      `Unknown Claude-compatible model '${body.model}'.`,
      "invalid_request_error",
    );
    return;
  }

  const sessionResult = await deps.runGatewaySession(normalized);
  logRouteResult(sessionResult, normalized.publicModel || normalized.requestedModel);

  if (!sessionResult.ok) {
    writeAnthropicError(
      res,
      statusCodeForResult(sessionResult),
      sessionResult.detail || "Tabbit bridge request failed.",
      anthropicErrorTypeForResult(sessionResult),
    );
    return;
  }

  const response = buildAnthropicResponse(normalized, sessionResult);
  if (normalized.stream) {
    streamAnthropicResponse(res, response);
    return;
  }

  writeJson(res, 200, response);
}

async function handleAnthropicTokenCount(req, res, _deps) {
  const body = await readJson(req);
  const normalized = normalizeAnthropicRequest(body, {
    normalizeModel: normalizeAnthropicRequestedModel,
    normalizeServerTool: normalizeServerToolDefinition,
  });

  if (normalized.invalidToolTypes.length > 0) {
    writeAnthropicError(
      res,
      400,
      `Unsupported tool type(s): ${normalized.invalidToolTypes.join(", ")}`,
      "invalid_request_error",
    );
    return;
  }

  if (body?.model && !resolveAnthropicModelAlias(body.model)) {
    writeAnthropicError(
      res,
      400,
      `Unknown Claude-compatible model '${body.model}'.`,
      "invalid_request_error",
    );
    return;
  }

  writeJson(res, 200, countAnthropicTokens(normalized));
}

export function createGatewayApp(overrides = {}) {
  const deps = {
    getBridgeHealth,
    getGatewayModelCatalog,
    sendPromptToTabbit,
    executeServerToolUse,
    assistantsRuntime: createAssistantsRuntime(),
    ...overrides,
  };
  if (!deps.runGatewaySession) {
    deps.runGatewaySession = (normalizedRequest) =>
      runGatewaySession(normalizedRequest, {
        sendPromptToTabbit: deps.sendPromptToTabbit,
        executeServerToolUse: deps.executeServerToolUse || executeServerToolUse,
      });
  }
  const apiKey = overrides.apiKey || process.env.TABBIT_API_KEY || "sk-tabbit-local";

  return async function app(req, res) {
    try {
      const pathname = normalizedPathname(req);

      if (req.method === "GET" && pathname === "/health") {
        await handleHealth(res, deps);
        return;
      }

      if (
        req.method === "GET" &&
        pathname.startsWith("/v1/models/") &&
        isAnthropicRequest(req)
      ) {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, "anthropic");
          return;
        }

        const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
        await handleModelById(req, res, deps, modelId);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, isAnthropicRequest(req) ? "anthropic" : "openai");
          return;
        }

        await handleModels(req, res, deps);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, "anthropic");
          return;
        }

        await handleAnthropicTokenCount(req, res, deps);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages") {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, "anthropic");
          return;
        }

        await handleAnthropicMessages(req, res, deps);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/responses") {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, "openai");
          return;
        }

        await handleOpenAiResponses(req, res, deps);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, "openai");
          return;
        }

        await handleOpenAiChatCompletions(req, res, deps);
        return;
      }

      if (isAssistantsRoute(pathname)) {
        if (!isAuthorized(req, apiKey)) {
          writeAuthenticationError(res, "openai");
          return;
        }

        await handleAssistants(req, res, deps, pathname);
        return;
      }

      writeJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (isAnthropicRequest(req)) {
        writeAnthropicError(
          res,
          400,
          error instanceof Error ? error.message : String(error),
          "invalid_request_error",
        );
        return;
      }

      writeOpenAiError(
        res,
        400,
        error instanceof Error ? error.message : String(error),
        "invalid_request_error",
      );
    }
  };
}

export function createGatewayServer(overrides = {}) {
  return http.createServer(createGatewayApp(overrides));
}
