import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { WebSocket } from "ws";

import { startGateway } from "../src/gateway.js";
import { createGatewayServer } from "../src/gateway-app.js";
import {
  OpenAiAssistantsStore,
  createAssistantsRuntime,
} from "../src/openai-assistants.js";
import { installRealtimeServer } from "../src/openai-realtime.js";
import {
  normalizeOpenAiRequest,
  normalizeAnthropicRequest,
  buildStructuredPrompt,
  prepareStructuredPrompt,
  parseStructuredEnvelope,
  runGatewaySession,
  TABBIT_PROMPT_TARGET_CHARS,
  TABBIT_PROMPT_MAX_CHARS,
} from "../src/session-core.js";
import { normalizeChatCompletionsRequest } from "../src/openai-chat.js";
import {
  attachmentUploadResultToReference,
  classifyAttemptFailure,
  diagnoseLoginState,
  evaluateTabbitPageWithNavigationRetry,
  isTabbitModelUnavailableText,
  putPresignedUpload,
  shouldFallbackToTabbitUi,
} from "../src/tabbit-web-bridge.js";
import {
  buildGatewayCatalogBundle,
  resolveRoutePlan,
} from "../src/tabbit-bridge-core.js";
import {
  normalizeServerToolDefinition,
  executeServerToolUse,
} from "../src/server-tools.js";

async function startServer(overrides = {}) {
  const server = createGatewayServer({
    apiKey: "test-key",
    getBridgeHealth: async () => ({ status: "ok", runtimeInitialized: false }),
    getGatewayModelCatalog: async () => [
      {
        id: "tabbit/Claude-Sonnet-4.6",
        displayName: "Claude-Sonnet-4.6",
        tabbit_display_name: "Claude-Sonnet-4.6",
        selectedModel: "Claude-Sonnet-4.6",
        supports_tools: true,
        available_in_tabbit_catalog: true,
      },
      {
        id: "tabbit/priority",
        displayName: "priority",
        tabbit_display_name: "priority",
        selectedModel: null,
        supports_tools: true,
        available_in_tabbit_catalog: true,
      },
    ],
    sendPromptToTabbit: async ({ prompt }) => {
      if (prompt.includes("Repair the following assistant output")) {
        return {
          ok: true,
          text: JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "repaired" }],
          }),
          gatewayModelId: "tabbit/Claude-Sonnet-4.6",
          attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
          fallbackHappened: false,
        };
      }

      return {
        ok: true,
        text: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello from tabbit" }],
        }),
        gatewayModelId: "tabbit/Claude-Sonnet-4.6",
        attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
        fallbackHappened: false,
      };
    },
    runGatewaySession: overrides.runGatewaySession,
    assistantsRuntime: overrides.assistantsRuntime,
  });

  if (overrides.realtime) {
    installRealtimeServer(server, {
      apiKey: "test-key",
      runGatewaySession:
        overrides.realtimeRunGatewaySession ||
        overrides.runGatewaySession ||
        (async () => ({
          ok: true,
          contentBlocks: [{ type: "text", text: "hello from tabbit" }],
          stopReason: "end_turn",
          selectedModel: "tabbit/Claude-Sonnet-4.6",
          attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
          fallbackHappened: false,
          usageEstimate: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        })),
    });
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function jsonLineAfterHeader(prompt, header) {
  const marker = `${header}\n`;
  const start = prompt.indexOf(marker);
  assert.notEqual(start, -1, `missing prompt header: ${header}`);
  const lineStart = start + marker.length;
  const lineEnd = prompt.indexOf("\n", lineStart);
  return prompt.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

async function startGatewayForTest(overrides = {}) {
  const originalLog = console.log;
  console.log = () => {};
  let server;

  try {
    server = startGateway({
      apiKey: "test-key",
      host: "127.0.0.1",
      port: 0,
      ...overrides,
    });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } finally {
    console.log = originalLog;
  }

  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return {
      response,
      body: await response.json(),
    };
  }

  return {
    response,
    body: await response.text(),
  };
}

async function createTempAssistantsRuntime() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tabbit2api-asst-"));
  const statePath = path.join(dir, "state.json");
  return {
    dir,
    statePath,
    runtime: createAssistantsRuntime({
      store: new OpenAiAssistantsStore(statePath),
    }),
  };
}

const tinyPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tinyPdfDataUrl =
  "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKJSVFT0Y=";
const tinyHtmlDataUrl =
  "data:text/html;base64,PGh0bWw+PGJvZHk+SGVsbG88L2JvZHk+PC9odG1sPg==";

async function collectRealtimeEvents(baseUrl, actions, headers = {}) {
  const wsUrl = `${baseUrl.replace("http://", "ws://")}/v1/realtime?model=tabbit/priority`;
  const ws = new WebSocket(wsUrl, {
    headers,
  });
  const events = [];
  ws.on("message", (raw) => {
    events.push(JSON.parse(raw.toString("utf8")));
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const action of actions) {
    ws.send(JSON.stringify(action));
  }

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString("utf8"));
      if (event.type === "response.done" || event.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  ws.close();
  return events;
}

test("GET /v1/models returns OpenAI shape by default", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/models`, {
      headers: {
        Authorization: "Bearer test-key",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(body.object, "list");
    assert.equal(Array.isArray(body.data), true);
  } finally {
    await stopServer(server);
  }
});

test("GET /health exposes bridge diagnostics without initializing Tabbit", async () => {
  const server = createGatewayServer({ apiKey: "test-key" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { response, body } = await requestJson(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.runtimeInitialized, false);
    assert.equal(body.modelCache.cached, false);
    assert.equal(body.queue.busy, false);
    assert.match(body.runtimeProfile.labProfileDir, /tabbit-user-data/);
    assert.equal(body.lastBridgeError, null);
  } finally {
    await stopServer(server);
  }
});

test("GET /v1/models returns Anthropic shape with anthropic headers", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/models`, {
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data[0].type, "model");
  } finally {
    await stopServer(server);
  }
});

test("Anthropic routes tolerate a duplicated /v1 prefix", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/v1/models`, {
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data[0].type, "model");
  } finally {
    await stopServer(server);
  }
});

test("GET /v1/models/{id} returns Anthropic model details", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(
      `${baseUrl}/v1/models/tabbit%2Fpriority`,
      {
        headers: {
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(body.id, "tabbit/priority");
  } finally {
    await stopServer(server);
  }
});

test("Anthropic routes reject removed Claude-style model aliases", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");

    const tokenCount = await requestJson(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(tokenCount.response.status, 400);
    assert.equal(tokenCount.body.type, "error");
    assert.equal(tokenCount.body.error.type, "invalid_request_error");
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/messages/count_tokens returns a stable estimate", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(
      `${baseUrl}/v1/messages/count_tokens`,
      {
        method: "POST",
        headers: {
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "tabbit/priority",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(typeof body.input_tokens, "number");
    assert.equal(body.input_tokens > 0, true);
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/messages returns Anthropic response body", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.type, "message");
    assert.equal(body.role, "assistant");
    assert.equal(body.content[0].type, "text");
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/messages streams Anthropic SSE events", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /event: message_stop/);
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/responses preserves OpenAI wire shape", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        input: "hello",
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /charset=utf-8/);
    assert.equal(body.object, "response");
    assert.equal(body.output[0].type, "message");
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/responses stream emits OpenAI SDK compatible events", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        input: "hello",
        stream: true,
      }),
    });

    const text = await response.text();
    const eventPayloads = text
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => {
        const dataLine = chunk
          .split("\n")
          .find((line) => line.startsWith("data: "));
        return JSON.parse(dataLine.slice("data: ".length));
      });

    assert.equal(response.status, 200);
    assert.equal(eventPayloads[0].type, "response.created");
    assert.equal(eventPayloads[0].sequence_number, 1);
    assert.equal(eventPayloads[0].response.object, "response");
    assert.equal(eventPayloads[0].response.status, "in_progress");
    assert.equal(eventPayloads[2].type, "response.output_item.added");
    assert.equal(eventPayloads[4].type, "response.output_text.delta");
    assert.equal(eventPayloads[4].logprobs.length, 0);
    assert.equal(eventPayloads.at(-1).type, "response.completed");
    assert.equal(eventPayloads.at(-1).response.status, "completed");
  } finally {
    await stopServer(server);
  }
});

test("OpenAI Responses normalizes input_image data URLs as attachments", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is in this image?" },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
    ],
  });

  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0].kind, "image");
  assert.equal(normalized.attachments[0].filename, "image.png");
  assert.equal(normalized.attachments[0].source, "data");
  assert.equal(normalized.messages[0].content[0].text, "What is in this image?");
  assert.doesNotMatch(buildStructuredPrompt(normalized), /iVBORw0KGgo/);
});

test("OpenAI Responses normalizes Hermes image_url object attachments", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Image test\n\n[Image attached at: /home/ttop5/.hermes/cache/images/img_latest.jpg]",
          },
          { type: "image_url", image_url: { url: tinyPngDataUrl } },
        ],
      },
    ],
  });

  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0].kind, "image");
  assert.equal(normalized.attachments[0].source, "data");

  const prompt = buildStructuredPrompt(normalized);
  assert.doesNotMatch(prompt, /iVBORw0KGgo/);
  assert.doesNotMatch(prompt, /img_latest\.jpg/);
  assert.match(prompt, /Attachment is available as a native Tabbit reference/);
});

test("OpenAI Responses normalizes input_file PDF, HTML, and HTTP URL attachments", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      { type: "input_file", filename: "doc.pdf", file_data: tinyPdfDataUrl },
      { type: "input_file", filename: "page.html", file_data: tinyHtmlDataUrl },
      {
        type: "input_file",
        filename: "remote.pdf",
        file_url: "https://example.test/remote.pdf",
      },
    ],
  });

  assert.equal(normalized.attachments.length, 3);
  assert.deepEqual(
    normalized.attachments.map((attachment) => attachment.kind),
    ["document", "document", "document"],
  );
  assert.deepEqual(
    normalized.attachments.map((attachment) => attachment.filename),
    ["doc.pdf", "page.html", "remote.pdf"],
  );
  assert.equal(normalized.attachments[2].source, "url");
  assert.equal(normalized.messages[0].content[0].text, "Please analyze the attached file(s).");
});

test("OpenAI Responses preserves role history with native attachments", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "图片测试" },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
      {
        role: "assistant",
        content:
          "图片又收到了,但视觉识别这次还是超时了(上游 30s 限制),我这边依然拿不到图像内容描述。\n本地路径:/home/ttop5/.hermes/cache/images/img_old.jpg",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "图片测试\n\n[Image attached at: /home/ttop5/.hermes/cache/images/img_new.jpg]",
          },
          { type: "image_url", image_url: tinyPngDataUrl },
        ],
      },
    ],
  });

  assert.deepEqual(
    normalized.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(normalized.attachments.length, 2);

  const prompt = buildStructuredPrompt(normalized);
  assert.doesNotMatch(prompt, /视觉识别这次还是超时/);
  assert.doesNotMatch(prompt, /img_old\.jpg|img_new\.jpg/);
  assert.match(prompt, /Previous assistant attachment-analysis failure message ignored/);
  assert.match(prompt, /Attachment is available as a native Tabbit reference/);
});

test("OpenAI Responses accepts attachment-only requests", async () => {
  let capturedRequest;
  const { server, baseUrl } = await startServer({
    runGatewaySession: async (normalized) => {
      capturedRequest = normalized;
      return {
        ok: true,
        contentBlocks: [{ type: "text", text: "image accepted" }],
        stopReason: "end_turn",
        selectedModel: "tabbit/priority",
        attemptedModels: ["tabbit/priority"],
        fallbackHappened: false,
        usageEstimate: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  });
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        input: [{ type: "input_image", image_url: tinyPngDataUrl }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.output[0].content[0].text, "image accepted");
    assert.equal(capturedRequest.attachments.length, 1);
    assert.equal(capturedRequest.attachments[0].kind, "image");
  } finally {
    await stopServer(server);
  }
});

test("OpenAI Chat and Anthropic messages preserve image and document attachments", () => {
  const chat = normalizeChatCompletionsRequest({
    model: "tabbit/priority",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these." },
          { type: "image_url", image_url: { url: tinyPngDataUrl } },
          { type: "input_file", filename: "page.html", file_data: tinyHtmlDataUrl },
        ],
      },
    ],
  });

  assert.equal(chat.attachments.length, 2);
  assert.deepEqual(
    chat.attachments.map((attachment) => attachment.kind),
    ["image", "document"],
  );
  assert.equal(chat.messages[0].content[0].text, "Compare these.");

  const anthropic = normalizeAnthropicRequest({
    model: "tabbit/priority",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize both." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: tinyPngDataUrl.split(",")[1],
            },
          },
          {
            type: "document",
            filename: "paper.pdf",
            source: {
              type: "url",
              url: "https://example.test/paper.pdf",
            },
          },
        ],
      },
    ],
  });

  assert.equal(anthropic.attachments.length, 2);
  assert.deepEqual(
    anthropic.attachments.map((attachment) => attachment.kind),
    ["image", "document"],
  );
  assert.equal(anthropic.messages[0].content[0].text, "Summarize both.");
});

test("attachment validation rejects local paths, file_id, unsupported types, and count overflow", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const cases = [
      {
        input: [{ type: "input_image", image_url: "file:///C:/tmp/pic.png" }],
        message: /Local file paths/,
      },
      {
        input: [{ type: "input_file", file_id: "file_123" }],
        message: /file_id/,
      },
      {
        input: [
          {
            type: "input_file",
            filename: "script.exe",
            file_data: "data:application/octet-stream;base64,AAAA",
          },
        ],
        message: /Unsupported attachment type/,
      },
      {
        input: Array.from({ length: 6 }, (_, index) => ({
          type: "input_file",
          filename: `note-${index}.txt`,
          file_data: "data:text/plain;base64,aGk=",
        })),
        message: /Too many attachments/,
      },
    ];

    for (const testCase of cases) {
      const { response, body } = await requestJson(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "tabbit/priority",
          input: testCase.input,
        }),
      });

      assert.equal(response.status, 400);
      assert.equal(body.error.type, "invalid_request_error");
      assert.match(body.error.message, testCase.message);
    }
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/chat/completions returns OpenAI chat completion shape", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hello" },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.role, "assistant");
    assert.equal(body.choices[0].message.content, "hello from tabbit");
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/chat/completions streams chat chunks and DONE", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await stopServer(server);
  }
});

test("POST /v1/chat/completions rejects missing auth and empty messages", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const unauthorized = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.error.type, "authentication_error");

    const empty = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [],
      }),
    });
    assert.equal(empty.response.status, 400);
    assert.equal(empty.body.error.type, "invalid_request_error");
  } finally {
    await stopServer(server);
  }
});

test("OpenAI routes surface Tabbit upstream availability failures as 503", async () => {
  const { server, baseUrl } = await startServer({
    runGatewaySession: async () => ({
      ok: false,
      error: "tabbit_error",
      detail: "Service is busy. Please try again tomorrow.",
      failure_reason: "upstream_unavailable",
      requestedModelAlias: "tabbit/priority",
      attemptedModels: ["tabbit/DeepSeek-V4-Pro"],
      fallbackHappened: true,
    }),
  });
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 503);
    assert.equal(body.error.type, "api_error");
    assert.match(body.error.message, /Service is busy/);
  } finally {
    await stopServer(server);
  }
});

test("Tabbit browser gate messages distinguish preflight login failures from retryable model failures", () => {
  assert.deepEqual(
    classifyAttemptFailure({
      ok: false,
      error: "tabbit_error",
      detail: "[492] 欢迎使用 Tabbit 浏览器（https://www.tabbitbrowser.com/），可免费使用最全最先进的模型。",
    }),
    { retryable: false, reason: "login_required" },
  );

  assert.deepEqual(
    classifyAttemptFailure({
      ok: false,
      error: "model_unavailable",
      detail: "[492] 欢迎使用 Tabbit 浏览器（https://www.tabbitbrowser.com/），可免费使用最全最先进的模型。",
      errorCodes: [492],
    }),
    { retryable: true, reason: "upstream_unavailable" },
  );

  assert.deepEqual(
    classifyAttemptFailure({
      ok: false,
      error: "tabbit_error",
      detail: "Service is busy. Please try again tomorrow.",
    }),
    { retryable: true, reason: "upstream_unavailable" },
  );

  assert.deepEqual(
    classifyAttemptFailure({
      ok: false,
      error: "tabbit_error",
      detail: "AI服务暂时不可用，请稍后重试",
    }),
    { retryable: true, reason: "upstream_unavailable" },
  );
});

test("Tabbit login diagnostics report missing sign-in bridge and prompt size", () => {
  const result = diagnoseLoginState(
    { hasTabSignin: false, hasBrowserGateMessage: false },
    "tabbit/priority",
    "hello",
  );

  assert.equal(result.error, "login_required");
  assert.match(result.detail, /Tabbit sign-in state is not available/);
  assert.match(result.detail, /tabbit2api login --refresh/);
  assert.match(result.detail, /5 characters/);
});

test("Tabbit login diagnostics recommend reducing large Codex prompts", () => {
  const largePrompt = "x".repeat(20_501);
  const result = diagnoseLoginState(
    { hasTabSignin: false, hasBrowserGateMessage: false },
    "tabbit/priority",
    largePrompt,
  );

  assert.equal(result.error, "login_required");
  assert.match(result.detail, /20501 characters/);
  assert.match(result.detail, /observed 20500-character prompt limit/);
  assert.match(result.detail, /minimal `\/v1\/responses` request/);
  assert.match(result.detail, /reduce the current user input/);
});

test("Tabbit login diagnostics report explicit signed-out state", () => {
  const result = diagnoseLoginState(
    {
      hasTabSignin: true,
      hasBrowserGateMessage: false,
      loginState: {
        loginState: {
          isLoggedIn: false,
          hasToken: false,
        },
      },
    },
    "tabbit/priority",
    "hello",
  );

  assert.equal(result.error, "login_required");
  assert.match(result.detail, /runtime profile is not logged in/);
});

test("Tabbit login diagnostics accept flat signed-out state", () => {
  const result = diagnoseLoginState(
    {
      hasTabSignin: true,
      hasBrowserGateMessage: false,
      loginState: {
        isLoggedIn: false,
        hasToken: false,
      },
    },
    "tabbit/priority",
    "hello",
  );

  assert.equal(result.error, "login_required");
});

test("Tabbit login diagnostics reject a login page even when the browser bridge has a stale token", () => {
  const result = diagnoseLoginState(
    {
      hasTabSignin: true,
      hasBrowserGateMessage: false,
      isLoginPage: true,
      loginState: {
        isLoggedIn: true,
        hasToken: true,
      },
      url: "https://web.tabbit.ai/login?callback=%2Fsession%2Fnew",
    },
    "tabbit/priority",
    "hello",
  );

  assert.equal(result.error, "login_required");
  assert.match(result.detail, /login page/);
});

test("Tabbit page evaluation retries once after a navigation destroys the execution context", async () => {
  let attempts = 0;
  let preparations = 0;
  const page = {
    evaluate: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "page.evaluate: Execution context was destroyed, most likely because of a navigation",
        );
      }
      return { models: [{ display_name: "Default" }] };
    },
  };

  const result = await evaluateTabbitPageWithNavigationRetry(
    page,
    () => null,
    "unused",
    {
      preparePage: async () => {
        preparations += 1;
      },
    },
  );

  assert.equal(attempts, 2);
  assert.equal(preparations, 1);
  assert.equal(result.models[0].display_name, "Default");
});

test("Tabbit UI fallback is limited to the removed legacy sendMessage module", () => {
  assert.equal(
    shouldFallbackToTabbitUi({
      ok: false,
      error: "send_threw",
      detail: "page.evaluate: Error: Unable to find Tabbit sendMessage function.",
    }),
    true,
  );
  assert.equal(
    shouldFallbackToTabbitUi({
      ok: false,
      error: "timeout",
      detail: "Timed out waiting for Tabbit.",
    }),
    false,
  );
});

test("Tabbit UI fallback recognizes fixed model-unavailable responses", () => {
  assert.equal(
    isTabbitModelUnavailableText("Unable to process this request at the moment."),
    true,
  );
  assert.equal(
    isTabbitModelUnavailableText("AI服务暂时不可用，请稍后重试"),
    true,
  );
  assert.equal(isTabbitModelUnavailableText("Normal assistant reply"), false);
});

test("OpenAI routes surface Tabbit browser gate failures as auth errors", async () => {
  const { server, baseUrl } = await startServer({
    runGatewaySession: async () => ({
      ok: false,
      error: "login_required",
      detail:
        "Tabbit returned the browser sign-in gate while sending the request.\n\nPrompt diagnostics: 123 characters were sent to Tabbit.",
      failure_reason: "login_required",
      requestedModelAlias: "tabbit/priority",
      attemptedModels: ["tabbit/Claude-Opus-4.7"],
      fallbackHappened: false,
    }),
  });
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        input: "hello",
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /browser sign-in gate/);
    assert.match(body.error.message, /Prompt diagnostics/);
  } finally {
    await stopServer(server);
  }
});

test("Anthropic routes keep error shape for Tabbit login failures", async () => {
  const { server, baseUrl } = await startServer({
    runGatewaySession: async () => ({
      ok: false,
      error: "login_required",
      detail:
        "Tabbit sign-in state is not available in the runtime page.\n\nPrompt diagnostics: 456 characters were sent to Tabbit.",
      failure_reason: "login_required",
      requestedModelAlias: "tabbit/priority",
      attemptedModels: [],
      fallbackHappened: false,
    }),
  });
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /sign-in state/);
  } finally {
    await stopServer(server);
  }
});

test("oversized prompt failures keep OpenAI and Anthropic error shapes", async () => {
  const runGatewaySession = async () => ({
    ok: false,
    error: "invalid_request",
    detail:
      "Structured prompt is 21000 characters after safe compaction, exceeding Tabbit's observed 20500-character limit.",
    requestedModelAlias: "tabbit/priority",
    attemptedModels: [],
    fallbackHappened: false,
  });
  const { server, baseUrl } = await startServer({ runGatewaySession });
  try {
    const openAi = await requestJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "tabbit/priority", input: "hello" }),
    });
    assert.equal(openAi.response.status, 400);
    assert.equal(openAi.body.error.type, "invalid_request_error");
    assert.match(openAi.body.error.message, /20500-character limit/);

    const anthropic = await requestJson(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(anthropic.response.status, 400);
    assert.equal(anthropic.body.type, "error");
    assert.equal(anthropic.body.error.type, "invalid_request_error");
    assert.match(anthropic.body.error.message, /20500-character limit/);
  } finally {
    await stopServer(server);
  }
});

test("bridge core preserves priority route catalog behavior", () => {
  const bundle = buildGatewayCatalogBundle([
    {
      display_name: "GPT-5.5",
      supports_images: true,
      supports_tools: true,
      support_thinking: false,
      model_access_type: "premium",
    },
    {
      display_name: "Custom Model",
      supports_images: false,
      supports_tools: true,
      support_thinking: true,
      model_access_type: "free",
    },
  ]);

  assert.equal(bundle.models[0].id, "tabbit/priority");

  const priority = resolveRoutePlan("priority", bundle);
  assert.equal(priority.ok, true);
  assert.equal(priority.kind, "priority_chain");
  assert.equal(priority.attempts[0].gatewayModelId, "tabbit/GPT-5.5");
  assert.equal(
    priority.attempts.some((attempt) => attempt.gatewayModelId === "tabbit/GPT-5.5"),
    true,
  );

  const direct = resolveRoutePlan("Custom Model", bundle);
  assert.equal(direct.ok, true);
  assert.equal(direct.kind, "direct");
  assert.equal(direct.attempts[0].gatewayModelId, "tabbit/Custom Model");
  assert.equal(direct.attempts[0].selectedModel, "Custom Model");

  const unknown = resolveRoutePlan("missing-model", bundle);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.result.error, "invalid_request");
  assert.deepEqual(unknown.result.attemptedModels, []);
});

test("priority routing appends current free models and keeps Default as the final deduplicated fallback", () => {
  const bundle = buildGatewayCatalogBundle([
    {
      display_name: "GPT-5.5",
      model_access_type: "premium_only",
    },
    {
      display_name: "DeepSeek-V4-Pro",
      model_access_type: "free_metered",
    },
    {
      display_name: "Current Free Model",
      model_access_type: "free_metered",
    },
    {
      display_name: "Default",
      model_access_type: "free_unlimited",
    },
  ]);

  const priority = resolveRoutePlan("tabbit/priority", bundle);
  const ids = priority.attempts.map((attempt) => attempt.gatewayModelId);

  assert.deepEqual(ids, [
    "tabbit/GPT-5.5",
    "tabbit/DeepSeek-V4-Pro",
    "tabbit/Current Free Model",
    "tabbit/Default",
  ]);
  assert.equal(new Set(ids).size, ids.length);
});

test("POST /v1/chat/completions maps client tool calls", async () => {
  const { server, baseUrl } = await startServer({
    runGatewaySession: async () => ({
      ok: true,
      contentBlocks: [
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: { query: "tabbit" },
        },
      ],
      stopReason: "tool_use",
      selectedModel: "tabbit/Claude-Sonnet-4.6",
      attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
      fallbackHappened: false,
      usageEstimate: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    }),
  });
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.content, null);
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "lookup");
    assert.equal(
      body.choices[0].message.tool_calls[0].function.arguments,
      '{"query":"tabbit"}',
    );
  } finally {
    await stopServer(server);
  }
});

test("Assistants text workflow persists assistant, thread, message, and run state", async () => {
  const { statePath, runtime } = await createTempAssistantsRuntime();
  const { server, baseUrl } = await startServer({ assistantsRuntime: runtime });
  try {
    const assistantResult = await requestJson(`${baseUrl}/v1/assistants`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        name: "tester",
        instructions: "Answer briefly.",
      }),
    });
    assert.equal(assistantResult.response.status, 200);
    assert.equal(assistantResult.body.object, "assistant");

    const threadResult = await requestJson(`${baseUrl}/v1/threads`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(threadResult.response.status, 200);
    assert.equal(threadResult.body.object, "thread");

    const runResult = await requestJson(
      `${baseUrl}/v1/threads/${threadResult.body.id}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assistant_id: assistantResult.body.id,
        }),
      },
    );
    assert.equal(runResult.response.status, 200);
    assert.equal(runResult.body.status, "completed");

    const messages = await requestJson(
      `${baseUrl}/v1/threads/${threadResult.body.id}/messages?order=asc`,
      {
        headers: {
          Authorization: "Bearer test-key",
        },
      },
    );
    assert.equal(messages.response.status, 200);
    assert.equal(messages.body.data.at(-1).role, "assistant");
    assert.equal(messages.body.data.at(-1).content[0].text.value, "hello from tabbit");

    const rawState = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(Boolean(rawState.assistants[assistantResult.body.id]), true);
    assert.equal(Boolean(rawState.threads[threadResult.body.id]), true);
    assert.equal(Boolean(rawState.runs[runResult.body.id]), true);
  } finally {
    await stopServer(server);
  }
});

test("Assistants runtime reloads persisted state from disk", async () => {
  const { statePath, runtime } = await createTempAssistantsRuntime();
  const assistant = await runtime.createAssistant({
    model: "tabbit/priority",
    name: "persisted",
  });

  const reloaded = createAssistantsRuntime({
    store: new OpenAiAssistantsStore(statePath),
  });
  const listed = await reloaded.listAssistants();
  assert.equal(listed.data[0].id, assistant.id);
  assert.equal(listed.data[0].name, "persisted");
});

test("Assistants run enters requires_action and resumes after tool outputs", async () => {
  let runCalls = 0;
  const { runtime } = await createTempAssistantsRuntime();
  const { server, baseUrl } = await startServer({
    assistantsRuntime: runtime,
    runGatewaySession: async () => {
      runCalls += 1;
      if (runCalls === 1) {
        return {
          ok: true,
          contentBlocks: [
            {
              type: "tool_use",
              id: "call_1",
              name: "lookup",
              input: { query: "tabbit" },
            },
          ],
          stopReason: "tool_use",
          selectedModel: "tabbit/Claude-Sonnet-4.6",
          attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
          fallbackHappened: false,
          usageEstimate: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
      }

      return {
        ok: true,
        contentBlocks: [{ type: "text", text: "tool result accepted" }],
        stopReason: "end_turn",
        selectedModel: "tabbit/Claude-Sonnet-4.6",
        attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
        fallbackHappened: false,
        usageEstimate: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  });
  try {
    const assistant = await requestJson(`${baseUrl}/v1/assistants`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        tools: [{ type: "function", function: { name: "lookup" } }],
      }),
    });
    const thread = await requestJson(`${baseUrl}/v1/threads`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "lookup" }],
      }),
    });
    const run = await requestJson(`${baseUrl}/v1/threads/${thread.body.id}/runs`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        assistant_id: assistant.body.id,
      }),
    });
    assert.equal(run.body.status, "requires_action");
    assert.equal(
      run.body.required_action.submit_tool_outputs.tool_calls[0].function.name,
      "lookup",
    );

    const resumed = await requestJson(
      `${baseUrl}/v1/threads/${thread.body.id}/runs/${run.body.id}/submit_tool_outputs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool_outputs: [{ tool_call_id: "call_1", output: "found" }],
        }),
      },
    );
    assert.equal(resumed.body.status, "completed");
  } finally {
    await stopServer(server);
  }
});

test("Assistants run streaming returns assistant SSE events", async () => {
  const { runtime } = await createTempAssistantsRuntime();
  const { server, baseUrl } = await startServer({ assistantsRuntime: runtime });
  try {
    const assistant = await requestJson(`${baseUrl}/v1/assistants`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "tabbit/priority" }),
    });
    const thread = await requestJson(`${baseUrl}/v1/threads`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const response = await fetch(`${baseUrl}/v1/threads/${thread.body.id}/runs`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        assistant_id: assistant.body.id,
        stream: true,
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: thread\.run\.created/);
    assert.match(text, /event: thread\.message\.delta/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await stopServer(server);
  }
});

test("Realtime WebSocket text session returns response events", async () => {
  const { server, baseUrl } = await startServer({ realtime: true });
  try {
    const events = await collectRealtimeEvents(
      baseUrl,
      [
        {
          type: "session.update",
          session: { instructions: "Be brief." },
        },
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        { type: "response.create" },
      ],
      { Authorization: "Bearer test-key" },
    );

    assert.equal(events[0].type, "session.created");
    assert.equal(events.some((event) => event.type === "session.updated"), true);
    assert.equal(
      events.some((event) => event.type === "conversation.item.created"),
      true,
    );
    assert.equal(events.some((event) => event.type === "response.text.delta"), true);
    assert.equal(events.at(-1).type, "response.done");
  } finally {
    await stopServer(server);
  }
});

test("startGateway wires Realtime to the configured session runner", async () => {
  let capturedRequest;
  const { server, baseUrl } = await startGatewayForTest({
    runGatewaySession: async (normalized) => {
      capturedRequest = normalized;
      return {
        ok: true,
        contentBlocks: [{ type: "text", text: "hello from real start" }],
        stopReason: "end_turn",
        selectedModel: "tabbit/priority",
        attemptedModels: ["tabbit/priority"],
        fallbackHappened: false,
        usageEstimate: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  });

  try {
    const events = await collectRealtimeEvents(
      baseUrl,
      [
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        { type: "response.create" },
      ],
      { Authorization: "Bearer test-key" },
    );

    assert.equal(capturedRequest.protocol, "openai-chat-completions");
    assert.equal(events.some((event) => event.type === "response.text.delta"), true);
    assert.equal(events.at(-1).type, "response.done");
  } finally {
    await stopServer(server);
  }
});

test("startGateway Realtime rejects missing auth", async () => {
  const { server, baseUrl } = await startGatewayForTest({
    runGatewaySession: async () => {
      throw new Error("unauthorized connection should not invoke runner");
    },
  });

  try {
    const wsUrl = `${baseUrl.replace("http://", "ws://")}/v1/realtime?model=tabbit/priority`;
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("error", reject);
        }),
      /Unexpected server response: 401/,
    );
  } finally {
    await stopServer(server);
  }
});

test("Realtime WebSocket rejects missing auth", async () => {
  const { server, baseUrl } = await startServer({ realtime: true });
  try {
    const wsUrl = `${baseUrl.replace("http://", "ws://")}/v1/realtime?model=tabbit/priority`;
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("error", reject);
        }),
      /Unexpected server response: 401/,
    );
  } finally {
    await stopServer(server);
  }
});

test("Realtime WebSocket returns unsupported error for audio events", async () => {
  const { server, baseUrl } = await startServer({ realtime: true });
  try {
    const events = await collectRealtimeEvents(
      baseUrl,
      [{ type: "input_audio_buffer.append", audio: "AAAA" }],
      { Authorization: "Bearer test-key" },
    );
    assert.equal(events.at(-1).type, "error");
    assert.equal(
      events.at(-1).error.code,
      "unsupported_realtime_audio",
    );
  } finally {
    await stopServer(server);
  }
});

test("normalizeAnthropicRequest separates client and server tools", () => {
  const normalized = normalizeAnthropicRequest(
    {
      model: "tabbit/priority",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { name: "bash", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    },
    {
      normalizeModel: (model) => model,
      normalizeServerTool: normalizeServerToolDefinition,
    },
  );

  assert.equal(normalized.tools.client.length, 1);
  assert.equal(normalized.tools.server.length, 1);
  assert.equal(normalized.tools.server[0].name, "web_search");
});

test("buildStructuredPrompt includes tool contract and conversation", () => {
  const normalized = normalizeAnthropicRequest(
    {
      model: "tabbit/priority",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "bash", input_schema: { type: "object" } }],
    },
    {
      normalizeModel: (model) => model,
      normalizeServerTool: normalizeServerToolDefinition,
    },
  );

  const prompt = buildStructuredPrompt(normalized);
  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /Available client tools/);
  assert.match(prompt, /Conversation state/);
  assert.match(prompt, /Available client tools:\n\[\{"name":"bash"/);
  assert.match(prompt, /Conversation state:\n\[\{"role":"user"/);
  assert.doesNotMatch(prompt, /Available client tools:\n\[\n/);
  assert.doesNotMatch(prompt, /Conversation state:\n\[\n/);
});

test("buildStructuredPrompt keeps Codex-like tool schemas compact", () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({
    type: "function",
    function: {
      name: `tool_${index}`,
      description:
        "Large Codex tool description with enough text to make pretty JSON overhead measurable.",
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 8 }, (_unused, propertyIndex) => [
            `field_${propertyIndex}`,
            {
              type: "string",
              description: `Parameter ${propertyIndex} for tool ${index}.`,
            },
          ]),
        ),
        required: ["field_0", "field_1"],
      },
    },
  }));
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    instructions:
      "You are Codex running with hidden system instructions and tool schemas.",
    input: [
      {
        role: "user",
        content: "hello",
      },
    ],
    tools,
  });

  const prompt = buildStructuredPrompt(normalized);
  const compactSections = [
    "System instructions:",
    "Available client tools:",
    "Available server tools:",
    "Conversation state:",
  ].map((header) => jsonLineAfterHeader(prompt, header));
  const legacyPrettySections = compactSections.map((section) =>
    JSON.stringify(JSON.parse(section), null, 2),
  );

  const compactLength = compactSections.join("").length;
  const legacyPrettyLength = legacyPrettySections.join("").length;

  assert.ok(
    legacyPrettyLength - compactLength > 3_000,
    `expected compact prompt sections to save >3000 characters, saved ${
      legacyPrettyLength - compactLength
    }`,
  );
  assert.match(prompt, /"name":"tool_0"/);
  assert.match(prompt, /"field_7"/);
  assert.match(prompt, /Conversation state:\n\[\{"role":"user"/);
});

test("prepareStructuredPrompt leaves prompts under budget unchanged", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    instructions: "Keep this instruction unchanged.",
    input: "hello",
  });

  const prepared = prepareStructuredPrompt(normalized);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.compacted, false);
  assert.equal(prepared.originalChars, prepared.sentChars);
  assert.equal(prepared.prompt, buildStructuredPrompt(normalized));
});

test("prepareStructuredPrompt compacts Codex system and developer context", () => {
  const system = `SYSTEM_HEAD\n${"s".repeat(21_000)}\nSYSTEM_TAIL`;
  const developer = `DEVELOPER_HEAD\n${"d".repeat(22_000)}\nDEVELOPER_TAIL`;
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    instructions: system,
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: developer }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "LATEST_USER_MESSAGE" }],
      },
    ],
  });

  const prepared = prepareStructuredPrompt(normalized);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.compacted, true);
  assert.ok(prepared.originalChars > TABBIT_PROMPT_MAX_CHARS);
  assert.ok(prepared.sentChars <= TABBIT_PROMPT_TARGET_CHARS);
  assert.match(prepared.prompt, /SYSTEM_HEAD/);
  assert.match(prepared.prompt, /SYSTEM_TAIL/);
  assert.match(prepared.prompt, /DEVELOPER_HEAD/);
  assert.match(prepared.prompt, /DEVELOPER_TAIL/);
  assert.match(prepared.prompt, /LATEST_USER_MESSAGE/);
  assert.match(prepared.prompt, /system instructions omitted/);
  assert.match(prepared.prompt, /developer context omitted/);
});

test("prepareStructuredPrompt omits only old history after context compaction", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    instructions: "i".repeat(8_000),
    input: Array.from({ length: 10 }, (_unused, index) => ({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `MESSAGE_${index}_START_${String(index).repeat(1_450)}_MESSAGE_${index}_END`,
        },
      ],
    })),
  });

  const prepared = prepareStructuredPrompt(normalized);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.compacted, true);
  assert.equal(prepared.omittedMessageCount, 4);
  assert.doesNotMatch(prepared.prompt, /MESSAGE_0_START/);
  assert.doesNotMatch(prepared.prompt, /MESSAGE_3_START/);
  assert.match(prepared.prompt, /MESSAGE_4_START/);
  assert.match(prepared.prompt, /MESSAGE_9_END/);
  assert.match(prepared.prompt, /4 older conversation messages omitted/);
});

test("runGatewaySession rejects an irreducibly large current user message", async () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: `CURRENT_USER_START_${"x".repeat(21_000)}_CURRENT_USER_END`,
  });
  let sendCalls = 0;

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async () => {
      sendCalls += 1;
      throw new Error("should not send an oversized prompt to Tabbit");
    },
    executeServerToolUse: async () => {
      throw new Error("should not execute server tools");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_request");
  assert.match(result.detail, /exceeding Tabbit's observed 20500-character limit/);
  assert.equal(result.attemptedModels.length, 0);
  assert.equal(sendCalls, 0);
});

test("parseStructuredEnvelope accepts fenced JSON", () => {
  const parsed = parseStructuredEnvelope(`
\`\`\`json
{
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_1",
      "name": "bash",
      "input": { "command": "pwd" }
    }
  ]
}
\`\`\`
`);

  assert.equal(parsed.stopReason, "tool_use");
  assert.equal(parsed.contentBlocks[0].type, "tool_use");
});

test("parseStructuredEnvelope unwraps nested JSON text envelopes", () => {
  const nested = JSON.stringify({
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "image was read" }],
        }),
      },
    ],
  });

  const parsed = parseStructuredEnvelope(nested);
  assert.equal(parsed.stopReason, "end_turn");
  assert.deepEqual(parsed.contentBlocks, [
    { type: "text", text: "image was read" },
  ]);
});

test("parseStructuredEnvelope accepts escaped dollar signs from Tabbit JSON", () => {
  const parsed = parseStructuredEnvelope(
    '{"stop_reason":"end_turn","content":[{"type":"text","text":"Cost is \\$1.00"}]}',
  );

  assert.equal(parsed.stopReason, "end_turn");
  assert.deepEqual(parsed.contentBlocks, [
    { type: "text", text: "Cost is $1.00" },
  ]);
});

test("buildStructuredPrompt hides vision_analyze when native attachments exist", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image." },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "vision_analyze",
          description: "Analyze an image using an auxiliary vision service.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "other_tool",
          description: "Another client tool.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  const prompt = buildStructuredPrompt(normalized);
  assert.doesNotMatch(prompt, /"name": "vision_analyze"/);
  assert.match(prompt, /"name":"other_tool"/);
  assert.match(prompt, /Unavailable client tools for this turn/);
  assert.match(prompt, /native attachment directly/);
  assert.doesNotMatch(prompt, /Do not call vision_analyze/);
});

test("buildStructuredPrompt removes Hermes vision helper hints for native attachments", () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "图片测试\n\n[Image attached at: /home/ttop5/.hermes/cache/images/img_abc.jpg]",
          },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description:
            "Read text files. NOTE: Cannot read images or binary files — use vision_analyze for images.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  const prompt = buildStructuredPrompt(normalized);
  assert.doesNotMatch(prompt, /\/home\/ttop5\/\.hermes\/cache\/images/);
  assert.doesNotMatch(prompt, /vision_analyze/);
  assert.match(prompt, /Attachment is available as a native Tabbit reference/);
  assert.match(prompt, /Native attachments in this turn are already available/);
});

test("runGatewaySession retries when Tabbit calls disabled vision tool for attachments", async () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image." },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "vision_analyze",
          description: "Analyze an image using an auxiliary vision service.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  const prompts = [];

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          ok: true,
          text: JSON.stringify({
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "toolu_vision",
                name: "vision_analyze",
                input: { image_url: "/tmp/image.png" },
              },
            ],
          }),
          gatewayModelId: "tabbit/priority",
          attemptedModels: ["tabbit/priority"],
          fallbackHappened: false,
        };
      }

      return {
        ok: true,
        text: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "I can read the native attachment." }],
        }),
        gatewayModelId: "tabbit/priority",
        attemptedModels: ["tabbit/priority"],
        fallbackHappened: false,
      };
    },
    executeServerToolUse: async () => {
      throw new Error("client vision tool must not be executed by the gateway");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.equal(result.contentBlocks.length, 1);
  assert.equal(result.contentBlocks[0].type, "text");
  assert.match(result.contentBlocks[0].text, /native attachment/);
  assert.match(prompts[1], /unavailable for this turn/);
});

test("runGatewaySession retries attachment timeout fallback text", async () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "图片测试" },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
    ],
  });
  const prompts = [];

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          ok: true,
          text: JSON.stringify({
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text:
                  "图片接收到了,但自动分析超时了(30秒上游限制),所以我这边没拿到图像内容描述。",
              },
            ],
          }),
          gatewayModelId: "tabbit/priority",
          attemptedModels: ["tabbit/priority"],
          fallbackHappened: false,
        };
      }

      return {
        ok: true,
        text: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "图中是一张仪表盘截图。" }],
        }),
        gatewayModelId: "tabbit/priority",
        attemptedModels: ["tabbit/priority"],
        fallbackHappened: false,
      };
    },
    executeServerToolUse: async () => {
      throw new Error("should not execute server tools in this test");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous answer incorrectly claimed/);
  assert.equal(result.contentBlocks[0].text, "图中是一张仪表盘截图。");
});

test("runGatewaySession treats disabled vision tool as absent for text fallback", async () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image." },
          { type: "input_image", image_url: tinyPngDataUrl },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "vision_analyze",
          description: "Analyze an image using an auxiliary vision service.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  let calls = 0;

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async () => {
      calls += 1;
      return {
        ok: true,
        text: "### Image content\nThe screenshot contains an error message.",
        gatewayModelId: "tabbit/priority",
        attemptedModels: ["tabbit/priority"],
        fallbackHappened: false,
      };
    },
    executeServerToolUse: async () => {
      throw new Error("should not execute tools in this test");
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.contentBlocks[0].type, "text");
  assert.match(result.contentBlocks[0].text, /screenshot contains/);
});

test("runGatewaySession executes server tool loop and returns final text", async () => {
  let calls = 0;
  const normalized = normalizeAnthropicRequest(
    {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "search now" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    },
    {
      normalizeModel: (model) => model,
      normalizeServerTool: normalizeServerToolDefinition,
    },
  );

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          text: JSON.stringify({
            stop_reason: "tool_use",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_1",
                name: "web_search",
                input: { query: "tabbit2api" },
              },
            ],
          }),
          gatewayModelId: "tabbit/Claude-Sonnet-4.6",
          attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
          fallbackHappened: false,
        };
      }

      return {
        ok: true,
        text: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
        }),
        gatewayModelId: "tabbit/Claude-Sonnet-4.6",
        attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
        fallbackHappened: false,
      };
    },
    executeServerToolUse: async () => ({
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      is_error: false,
      content: [{ type: "web_search_result", title: "A", url: "https://a.test" }],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentBlocks.at(-1).type, "text");
  assert.equal(result.usageEstimate.server_tool_use.web_search_requests, 1);
});

test("runGatewaySession repairs Latin-1 decoded UTF-8 text from Tabbit", async () => {
  const normalized = normalizeOpenAiRequest({
    model: "tabbit/priority",
    input: "图片识别",
  });
  const mojibakeText = Buffer.from("图片识别成功", "utf8").toString("latin1");

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async () => ({
      ok: true,
      text: JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: mojibakeText }],
      }),
      gatewayModelId: "tabbit/priority",
      attemptedModels: ["tabbit/priority"],
      fallbackHappened: false,
    }),
    executeServerToolUse: async () => {
      throw new Error("should not execute server tools in this test");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentBlocks[0].text, "图片识别成功");
});

test("runGatewaySession passes attachments through every Tabbit prompt", async () => {
  const normalized = normalizeAnthropicRequest(
    {
      model: "tabbit/priority",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use the attachment while looping." },
            {
              type: "document",
              filename: "doc.pdf",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: tinyPdfDataUrl.split(",")[1],
              },
            },
          ],
        },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    },
    {
      normalizeModel: (model) => model,
      normalizeServerTool: normalizeServerToolDefinition,
    },
  );
  const seenAttachmentCounts = [];

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async ({ attachments }) => {
      seenAttachmentCounts.push(attachments.length);
      if (seenAttachmentCounts.length === 1) {
        return {
          ok: true,
          text: JSON.stringify({
            stop_reason: "tool_use",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_1",
                name: "web_search",
                input: { query: "tabbit2api" },
              },
            ],
          }),
          gatewayModelId: "tabbit/priority",
          attemptedModels: ["tabbit/priority"],
          fallbackHappened: false,
        };
      }

      return {
        ok: true,
        text: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
        }),
        gatewayModelId: "tabbit/priority",
        attemptedModels: ["tabbit/priority"],
        fallbackHappened: false,
      };
    },
    executeServerToolUse: async () => ({
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      is_error: false,
      content: [{ type: "web_search_result", title: "A", url: "https://a.test" }],
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seenAttachmentCounts, [1, 1]);
});

test("bridge maps uploaded image and document attachments to Tabbit references", () => {
  const imageReference = attachmentUploadResultToReference(
    {
      kind: "image",
      filename: "pic.png",
      sourceUrl: "https://example.test/pic.png",
    },
    {
      success: true,
      fileId: "file-image",
      url: "https://cdn.test/pic.png",
      fileName: "pic.png",
    },
  );
  assert.equal(typeof imageReference.id, "string");
  assert.equal(imageReference.type, "image");
  assert.equal(imageReference.title, "pic.png");
  assert.equal(imageReference.content, "https://cdn.test/pic.png");
  assert.equal(imageReference.favicon, "");
  assert.equal(imageReference.path, "file-image");
  assert.equal(imageReference.sourceUrl, "https://example.test/pic.png");

  const documentReference = attachmentUploadResultToReference(
    { kind: "document", filename: "paper.pdf" },
    {
      success: true,
      fileId: "file-doc",
      fileName: "paper.pdf",
    },
  );
  assert.equal(typeof documentReference.id, "string");
  assert.equal(documentReference.type, "document");
  assert.equal(documentReference.title, "paper.pdf");
  assert.equal(documentReference.content, "");
  assert.equal(documentReference.path, "file-doc");
});

test("bridge prefers Tabbit reference helpers when mapping upload results", () => {
  const imageReference = attachmentUploadResultToReference(
    { kind: "image", filename: "pic.png" },
    {
      success: true,
      fileId: "file-image",
      url: "https://cdn.test/pic.png",
      fileName: "pic.png",
    },
    {
      rf: (title, url, fileId) => ({
        id: "helper-image",
        type: "image",
        title,
        content: url,
        path: fileId,
      }),
    },
  );
  assert.deepEqual(imageReference, {
    id: "helper-image",
    type: "image",
    title: "pic.png",
    content: "https://cdn.test/pic.png",
    path: "file-image",
  });

  const documentReference = attachmentUploadResultToReference(
    { kind: "document", filename: "paper.pdf" },
    {
      success: true,
      fileId: "file-doc",
      fileName: "paper.pdf",
    },
    {
      vT: (title, fileId) => ({
        id: "helper-document",
        type: "document",
        title,
        content: "",
        path: fileId,
      }),
    },
  );
  assert.deepEqual(documentReference, {
    id: "helper-document",
    type: "document",
    title: "paper.pdf",
    content: "",
    path: "file-doc",
  });
});

test("putPresignedUpload uploads base64 bytes with the attachment content type", async () => {
  let captured;
  const result = await putPresignedUpload({
    presignedUrl: "https://cos.test/upload?signature=abc",
    bytes: Buffer.from("hello").toString("base64"),
    mimeType: "text/plain",
    fetchImpl: async (url, options) => {
      captured = {
        url,
        method: options.method,
        contentType: options.headers["Content-Type"],
        body: Buffer.from(options.body).toString("utf8"),
      };
      return new Response("", { status: 200 });
    },
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(captured, {
    url: "https://cos.test/upload?signature=abc",
    method: "PUT",
    contentType: "text/plain",
    body: "hello",
  });
});

test("putPresignedUpload reports failed COS uploads", async () => {
  await assert.rejects(
    () =>
      putPresignedUpload({
        presignedUrl: "https://cos.test/upload?signature=abc",
        bytes: Buffer.from("hello").toString("base64"),
        mimeType: "text/plain",
        fetchImpl: async () => new Response("", { status: 403, statusText: "Forbidden" }),
      }),
    /Tabbit COS upload failed: HTTP 403 Forbidden/,
  );
});

test("executeServerToolUse handles unsupported tools explicitly", async () => {
  const result = await executeServerToolUse({
    id: "srvtoolu_1",
    name: "unknown_tool",
    input: {},
  });

  assert.equal(result.is_error, true);
  assert.match(result.content[0].text, /Unsupported server tool/);
});

test("executeServerToolUse can fetch and extract text", async () => {
  const result = await executeServerToolUse(
    {
      id: "srvtoolu_2",
      name: "web_fetch",
      input: {
        url: "https://example.com",
      },
    },
    {
      fetch: async () =>
        new Response("<html><body><h1>Hello</h1><p>World</p></body></html>", {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        }),
    },
  );

  assert.equal(result.is_error, false);
  assert.equal(result.type, "web_fetch_tool_result");
  assert.match(result.content[0].text, /Hello World/);
});

test("executeServerToolUse can run javascript code", async () => {
  const result = await executeServerToolUse({
    id: "srvtoolu_3",
    name: "code_execution",
    input: {
      language: "javascript",
      code: "console.log(2 + 2)",
    },
  });

  assert.equal(result.is_error, false);
  assert.equal(result.type, "code_execution_tool_result");
  assert.match(result.content[0].text, /4/);
});

test("runGatewaySession repairs malformed structured output once", async () => {
  let calls = 0;
  const normalized = normalizeAnthropicRequest(
    {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "hello" }],
    },
    {
      normalizeModel: (model) => model,
      normalizeServerTool: normalizeServerToolDefinition,
    },
  );

  const result = await runGatewaySession(normalized, {
    sendPromptToTabbit: async ({ prompt }) => {
      calls += 1;
      if (prompt.includes("Repair the following assistant output")) {
        return {
          ok: true,
          text: JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "repaired response" }],
          }),
          gatewayModelId: "tabbit/Claude-Sonnet-4.6",
          attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
          fallbackHappened: false,
        };
      }

      return {
        ok: true,
        text: "```json\n{ not valid json }\n```",
        gatewayModelId: "tabbit/Claude-Sonnet-4.6",
        attemptedModels: ["tabbit/Claude-Sonnet-4.6"],
        fallbackHappened: false,
      };
    },
    executeServerToolUse: async () => {
      throw new Error("should not execute server tools in this test");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentBlocks[0].text, "repaired response");
  assert.equal(calls, 2);
});

test("server tool route returns invalid_request for unknown tool types", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { response, body } = await requestJson(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "future_tool_999", name: "future" }],
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    await stopServer(server);
  }
});
