import crypto from "node:crypto";
import { countTokens } from "@anthropic-ai/tokenizer";
import {
  collectAnthropicAttachments,
  collectOpenAiAttachments,
  isAnthropicAttachmentBlock,
  isOpenAiAttachmentPart,
  summarizeAttachmentsForPrompt,
} from "./attachments.js";

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function repairTextEncoding(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) {
    return "";
  }

  try {
    const scoreMojibake = (candidate) => {
      let score = 0;
      for (const char of candidate) {
        const code = char.charCodeAt(0);
        if (code >= 0x80 && code <= 0x9f) {
          score += 4;
        }
      }
      for (const span of candidate.match(/[\u00a0-\u00ff]{2,}/g) || []) {
        score += span.length;
      }
      return score;
    };

    const originalScore = scoreMojibake(text);
    if (originalScore === 0) {
      return text;
    }

    const decoded = Buffer.from(text, "latin1").toString("utf8");
    const decodedScore = scoreMojibake(decoded);
    const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
    return decoded &&
      decodedScore < originalScore &&
      replacementCount <= Math.max(2, Math.floor(originalScore / 8))
      ? decoded
      : text;
  } catch {
    return text;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function promptJson(value) {
  return JSON.stringify(value);
}

export const TABBIT_PROMPT_TARGET_CHARS = 19_000;
export const TABBIT_PROMPT_MAX_CHARS = 20_500;

const PROMPT_CONTEXT_SECTION_CHARS = 8_000;
const PROMPT_RECENT_MESSAGE_COUNT = 6;

function compactPromptText(value, maxChars, label) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxChars) {
    return text;
  }

  const marker = `\n[... ${label} omitted by Tabbit2API prompt compaction ...]\n`;
  if (maxChars <= marker.length) {
    return text.slice(0, maxChars);
  }

  const available = maxChars - marker.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

function allocateTextBudgets(lengths, totalBudget) {
  if (!lengths.length) {
    return [];
  }

  const totalLength = lengths.reduce((total, length) => total + length, 0);
  if (totalLength <= totalBudget) {
    return [...lengths];
  }

  const minimums = lengths.map((length) => Math.min(length, 512));
  const minimumTotal = minimums.reduce((total, length) => total + length, 0);
  if (minimumTotal >= totalBudget) {
    let remainingBudget = totalBudget;
    let remainingLength = totalLength;
    return lengths.map((length, index) => {
      const allocation =
        index === lengths.length - 1
          ? remainingBudget
          : Math.floor((remainingBudget * length) / remainingLength);
      remainingBudget -= allocation;
      remainingLength -= length;
      return allocation;
    });
  }

  const extraLengths = lengths.map((length, index) => length - minimums[index]);
  let remainingBudget = totalBudget - minimumTotal;
  let remainingExtra = extraLengths.reduce((total, length) => total + length, 0);
  return lengths.map((length, index) => {
    if (index === lengths.length - 1) {
      return Math.min(length, minimums[index] + remainingBudget);
    }

    const extraAllocation = remainingExtra
      ? Math.floor((remainingBudget * extraLengths[index]) / remainingExtra)
      : 0;
    remainingBudget -= extraAllocation;
    remainingExtra -= extraLengths[index];
    return Math.min(length, minimums[index] + extraAllocation);
  });
}

function compactSystemInstructions(system) {
  const entries = Array.isArray(system) ? system : [];
  const budgets = allocateTextBudgets(
    entries.map((entry) => entry.length),
    PROMPT_CONTEXT_SECTION_CHARS,
  );
  return entries.map((entry, index) =>
    compactPromptText(entry, budgets[index], "system instructions"),
  );
}

function compactDeveloperMessages(messages) {
  const nextMessages = clone(messages);
  const developerTextBlocks = [];

  for (const message of nextMessages) {
    if (message?.role !== "developer" || !Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        developerTextBlocks.push(block);
      }
    }
  }

  const budgets = allocateTextBudgets(
    developerTextBlocks.map((block) => block.text.length),
    PROMPT_CONTEXT_SECTION_CHARS,
  );
  developerTextBlocks.forEach((block, index) => {
    block.text = compactPromptText(
      block.text,
      budgets[index],
      "developer context",
    );
  });

  return nextMessages;
}

function compactConversationHistory(messages) {
  if (messages.length <= PROMPT_RECENT_MESSAGE_COUNT) {
    return { messages, omittedMessageCount: 0 };
  }

  const keepIndexes = new Set();
  for (
    let index = Math.max(0, messages.length - PROMPT_RECENT_MESSAGE_COUNT);
    index < messages.length;
    index += 1
  ) {
    keepIndexes.add(index);
  }

  const latestUserIndex = messages.findLastIndex(
    (message) => message?.role === "user",
  );
  if (latestUserIndex >= 0) {
    keepIndexes.add(latestUserIndex);
  }

  const firstDeveloperIndex = messages.findIndex(
    (message) => message?.role === "developer",
  );
  if (firstDeveloperIndex >= 0) {
    keepIndexes.add(firstDeveloperIndex);
  }

  const keptMessages = messages.filter((_message, index) =>
    keepIndexes.has(index),
  );
  const omittedMessageCount = messages.length - keptMessages.length;
  if (!omittedMessageCount) {
    return { messages, omittedMessageCount: 0 };
  }

  const markerMessage = {
    role: "developer",
    content: [
      {
        type: "text",
        text: `[${omittedMessageCount} older conversation messages omitted by Tabbit2API prompt compaction.]`,
      },
    ],
  };
  const insertAt = keptMessages.findIndex(
    (message) => message?.role !== "developer",
  );
  if (insertAt < 0) {
    keptMessages.push(markerMessage);
  } else {
    keptMessages.splice(insertAt, 0, markerMessage);
  }

  return { messages: keptMessages, omittedMessageCount };
}

export function contentBlocksToText(blocks) {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function normalizeSystem(system) {
  if (typeof system === "string") {
    return [system.trim()].filter(Boolean);
  }

  if (Array.isArray(system)) {
    return system
      .flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry.trim()];
        }

        if (entry && typeof entry === "object" && typeof entry.text === "string") {
          return [entry.text.trim()];
        }

        return [];
      })
      .filter(Boolean);
  }

  return [];
}

function normalizeAnthropicBlock(block) {
  if (!block || typeof block !== "object") {
    return [];
  }

  if (block.type === "text" && typeof block.text === "string") {
    return [{ type: "text", text: block.text }];
  }

  if (block.type === "tool_use") {
    return [
      {
        type: "tool_use",
        id: cleanText(block.id) || randomId("toolu"),
        name: cleanText(block.name),
        input:
          block.input && typeof block.input === "object" ? clone(block.input) : {},
      },
    ];
  }

  if (block.type === "tool_result") {
    const toolUseId = cleanText(block.tool_use_id);
    return [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        is_error: Boolean(block.is_error),
        content: normalizeMixedToolResultContent(block.content),
      },
    ];
  }

  if (block.type === "thinking" && typeof block.text === "string") {
    return [{ type: "text", text: block.text }];
  }

  if (isAnthropicAttachmentBlock(block)) {
    return [];
  }

  return [
    {
      type: "text",
      text: JSON.stringify(block),
    },
  ];
}

function normalizeOpenAiInputPart(part) {
  if (typeof part === "string") {
    return [{ type: "text", text: part }];
  }

  if (Array.isArray(part)) {
    return part.flatMap(normalizeOpenAiInputPart);
  }

  if (!part || typeof part !== "object") {
    return [];
  }

  if (isOpenAiAttachmentPart(part)) {
    return [];
  }

  if (typeof part.text === "string") {
    return [{ type: "text", text: part.text }];
  }

  if (typeof part.content === "string") {
    return [{ type: "text", text: part.content }];
  }

  if (Array.isArray(part.content)) {
    return part.content.flatMap(normalizeOpenAiInputPart);
  }

  return [];
}

function isOpenAiMessageInput(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.role === "string" &&
      ("content" in value || "text" in value),
  );
}

function normalizeOpenAiMessageContent(message) {
  const contentValue =
    message?.content ?? (typeof message?.text === "string" ? message.text : null);

  if (typeof contentValue === "string") {
    return [{ type: "text", text: contentValue }];
  }

  return normalizeOpenAiInputPart(contentValue);
}

function normalizeOpenAiInputMessages(input) {
  if (!Array.isArray(input)) {
    const content = normalizeOpenAiInputPart(input);
    return content.length ? [{ role: "user", content }] : [];
  }

  const messages = [];
  const looseContent = [];

  for (const entry of input) {
    if (isOpenAiMessageInput(entry)) {
      const content = normalizeOpenAiMessageContent(entry);
      if (content.length) {
        messages.push({
          role: cleanText(entry.role) || "user",
          content,
        });
      }
      continue;
    }

    looseContent.push(...normalizeOpenAiInputPart(entry));
  }

  if (looseContent.length) {
    messages.push({
      role: "user",
      content: looseContent,
    });
  }

  return messages;
}

function ensureMessageForAttachments(messages, attachments) {
  if (messages.length || !attachments.length) {
    return messages;
  }

  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Please analyze the attached file(s).",
        },
      ],
    },
  ];
}

function normalizeMessageArray(messages, blockNormalizer) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => {
      const role = cleanText(message?.role) || "user";
      const contentValue = message?.content;
      let content = [];

      if (typeof contentValue === "string") {
        content = [{ type: "text", text: contentValue }];
      } else if (Array.isArray(contentValue)) {
        content = contentValue.flatMap(blockNormalizer);
      } else if (contentValue && typeof contentValue === "object") {
        content = blockNormalizer(contentValue);
      }

      return {
        role,
        content: content.filter(Boolean),
      };
    })
    .filter((message) => message.content.length > 0);
}

function normalizeMixedToolResultContent(content) {
  if (typeof content === "string") {
    return [
      {
        type: "text",
        text: content,
      },
    ];
  }

  if (Array.isArray(content)) {
    return content.flatMap((entry) => normalizeMixedToolResultContent(entry));
  }

  if (!content || typeof content !== "object") {
    return [];
  }

  if (content.type === "text" && typeof content.text === "string") {
    return [content];
  }

  return [
    {
      type: "json",
      value: clone(content),
    },
  ];
}

export function normalizeAnthropicRequest(body, helpers = {}) {
  const model =
    typeof helpers.normalizeModel === "function"
      ? helpers.normalizeModel(body?.model)
      : body?.model;
  const clientTools = [];
  const serverTools = [];
  const invalidToolTypes = [];

  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (typeof helpers.normalizeServerTool === "function") {
      const serverTool = helpers.normalizeServerTool(tool);
      if (serverTool) {
        serverTools.push(serverTool);
        continue;
      }
    }

    if (typeof tool?.type === "string" && tool.type.trim()) {
      invalidToolTypes.push(tool.type.trim());
      continue;
    }

    if (tool && typeof tool === "object" && typeof tool.name === "string") {
      clientTools.push({
        kind: "client",
        name: tool.name.trim(),
        description:
          typeof tool.description === "string" ? tool.description.trim() : "",
        inputSchema:
          tool.input_schema && typeof tool.input_schema === "object"
            ? clone(tool.input_schema)
            : {},
      });
    }
  }

  const attachments = collectAnthropicAttachments(body?.messages);
  const messages = ensureMessageForAttachments(
    normalizeMessageArray(body?.messages, normalizeAnthropicBlock),
    attachments,
  );

  return {
    protocol: "anthropic",
    requestedModel: model,
    publicModel: body?.model || null,
    system: normalizeSystem(body?.system),
    messages,
    attachments,
    tools: {
      client: clientTools,
      server: serverTools,
    },
    toolChoice: body?.tool_choice ?? { type: "auto" },
    metadata:
      body?.metadata && typeof body.metadata === "object" ? clone(body.metadata) : {},
    stream: Boolean(body?.stream),
    maxOutputTokens:
      Number.isFinite(Number(body?.max_tokens)) && Number(body.max_tokens) > 0
        ? Number(body.max_tokens)
        : null,
    thinking: body?.thinking ?? null,
    invalidToolTypes,
    rawBody: clone(body),
  };
}

export function normalizeOpenAiRequest(body) {
  const attachments = collectOpenAiAttachments(body?.input);
  const messages = normalizeOpenAiInputMessages(body?.input);
  const clientTools = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (tool?.type === "function" && tool.function?.name) {
      clientTools.push({
        kind: "client",
        name: tool.function.name,
        description:
          typeof tool.function.description === "string"
            ? tool.function.description.trim()
            : "",
        inputSchema:
          tool.function.parameters && typeof tool.function.parameters === "object"
            ? clone(tool.function.parameters)
            : {},
      });
    }
  }

  return {
    protocol: "openai-responses",
    requestedModel:
      typeof body?.model === "string" && body.model.trim()
        ? body.model.trim()
        : "tabbit/priority",
    publicModel: body?.model || "tabbit/priority",
    system: normalizeSystem(body?.instructions),
    messages: ensureMessageForAttachments(messages, attachments),
    attachments,
    tools: {
      client: clientTools,
      server: [],
    },
    toolChoice: body?.tool_choice ?? "auto",
    metadata:
      body?.metadata && typeof body.metadata === "object" ? clone(body.metadata) : {},
    stream: Boolean(body?.stream),
    maxOutputTokens:
      Number.isFinite(Number(body?.max_output_tokens)) &&
      Number(body.max_output_tokens) > 0
        ? Number(body.max_output_tokens)
        : null,
    thinking: body?.reasoning ?? null,
    rawBody: clone(body),
  };
}

function toolChoiceInstructions(toolChoice) {
  if (!toolChoice || toolChoice === "auto" || toolChoice.type === "auto") {
    return "Tool usage is optional when helpful.";
  }

  if (toolChoice === "none" || toolChoice.type === "none") {
    return "Do not use any tools. Respond with text only.";
  }

  if (toolChoice === "required" || toolChoice.type === "any") {
    return "You must use exactly one tool if any suitable tool exists.";
  }

  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return `You must use the tool named '${toolChoice.name}'.`;
  }

  return "Tool usage is optional when helpful.";
}

function sanitizeTextForNativeAttachments(text, role = "") {
  if (typeof text !== "string" || !text) {
    return text;
  }

  const sanitized = text
    .replace(
      /\s*\[(?:Image|File|Document) attached at:\s*[^\]\r\n]+\]/gi,
      "\n[Attachment is available as a native Tabbit reference]",
    )
    .replace(
      /(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/mnt\/)[^\s'"`)]+\.hermes[^\s'"`)]+/gi,
      "[native attachment path hidden]",
    )
    .replace(/\bvision_analyze\b/gi, "the separate image-analysis helper");

  if (role === "assistant" && attachmentFallbackSignals(sanitized).length) {
    return "[Previous assistant attachment-analysis failure message ignored. Native attachments are available in this turn.]";
  }

  return sanitized;
}

function sanitizeToolDescriptionForNativeAttachments(description) {
  const text = cleanText(description);
  if (!text) {
    return "";
  }

  const sentences = text
    .split(/(?<=[.!?。！？])\s+/)
    .filter((sentence) => !/\bvision_analyze\b/i.test(sentence));
  const sanitized = sentences.join(" ").trim();
  return [
    sanitized,
    "Native attachments in this turn are already available to Tabbit; do not use file-reading or auxiliary image-analysis helpers for attached file contents.",
  ]
    .filter(Boolean)
    .join(" ");
}

function summarizeNormalizedMessages(messages, { hasAttachments = false } = {}) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "text") {
        return {
          ...block,
          text: hasAttachments
            ? sanitizeTextForNativeAttachments(block.text, message.role)
            : block.text,
        };
      }

      if (block.type === "tool_result") {
        return {
          type: block.type,
          tool_use_id: block.tool_use_id,
          is_error: Boolean(block.is_error),
          content: block.content,
        };
      }

      if (block.type === "server_tool_result") {
        return {
          type: block.type,
          tool_use_id: block.tool_use_id,
          name: block.name,
          is_error: Boolean(block.is_error),
          content: block.content,
        };
      }

      return block;
    }),
  }));
}

function summarizeNormalizedAttachments(attachments) {
  return summarizeAttachmentsForPrompt(attachments || []);
}

function blockedClientToolNames(normalizedRequest) {
  const blocked = new Set();
  if (normalizedRequest.attachments?.length) {
    blocked.add("vision_analyze");
  }

  return blocked;
}

function activeClientTools(normalizedRequest) {
  const blocked = blockedClientToolNames(normalizedRequest);
  return normalizedRequest.tools.client.filter((tool) => !blocked.has(tool.name));
}

function unavailableClientToolUses(parsedBlocks, normalizedRequest) {
  const blocked = blockedClientToolNames(normalizedRequest);
  if (!blocked.size) {
    return [];
  }

  return parsedBlocks.filter(
    (block) => block.type === "tool_use" && blocked.has(block.name),
  );
}

function renderStructuredPrompt(normalizedRequest) {
  const blockedTools = [...blockedClientToolNames(normalizedRequest)];
  const hasAttachments = Boolean(normalizedRequest.attachments?.length);
  const clientTools = activeClientTools(normalizedRequest).map((tool) => ({
    name: tool.name,
    description: hasAttachments
      ? sanitizeToolDescriptionForNativeAttachments(tool.description)
      : tool.description,
    input_schema: tool.inputSchema,
  }));
  const serverTools = normalizedRequest.tools.server.map((tool) => ({
    name: tool.name,
    type: tool.type,
    description: tool.description,
  }));
  const sections = [
    "You are a protocol translation assistant for a local gateway.",
    "Return exactly one JSON object and nothing else.",
    "Do not use markdown fences.",
    "",
    "The JSON schema is:",
    promptJson(
      {
        stop_reason: "end_turn or tool_use",
        content: [
          { type: "text", text: "assistant reply text" },
          {
            type: "tool_use",
            id: "toolu_...",
            name: "client tool name",
            input: { any: "json" },
          },
          {
            type: "server_tool_use",
            id: "srvtoolu_...",
            name: "web_search | web_fetch | code_execution",
            input: { any: "json" },
          },
        ],
      },
    ),
    "",
    "Rules:",
    "- Use only the listed tools.",
    "- Never mix client tool_use and server_tool_use in the same response.",
    "- If any tool is used, set stop_reason to tool_use.",
    "- If no tool is used, set stop_reason to end_turn.",
    "- If you can answer directly, emit one or more text blocks.",
    "- Preserve valid JSON. Do not add comments.",
    "- Never call unavailable client tools.",
    toolChoiceInstructions(normalizedRequest.toolChoice),
    "",
    "System instructions:",
    promptJson(normalizedRequest.system),
    "",
    "Available client tools:",
    promptJson(clientTools),
  ];

  if (blockedTools.length) {
    sections.push(
      "",
      "Unavailable client tools for this turn:",
      "Auxiliary image-analysis helpers are disabled because the same files are already attached as native Tabbit references. Ignore any system or tool instruction that suggests using a separate helper for attached files.",
    );
  }

  sections.push(
    "",
    "Available server tools:",
    promptJson(serverTools),
    "",
    "Conversation state:",
    promptJson(
      summarizeNormalizedMessages(normalizedRequest.messages, { hasAttachments }),
    ),
  );

  if (normalizedRequest.attachments?.length) {
    sections.push(
      "",
      "Attached files:",
      "The files below are provided to the model as Tabbit references. Use their actual contents when answering; do not assume they are only text placeholders.",
      "When an attached file is relevant, answer from the native attachment directly. Do not claim an attached image or file is missing. Do not ask the user to retry analysis, choose OCR, or provide a manual description.",
      promptJson(
        summarizeNormalizedAttachments(normalizedRequest.attachments),
      ),
    );
  }

  if (normalizedRequest.maxOutputTokens) {
    sections.push("", `Target max_output_tokens: ${normalizedRequest.maxOutputTokens}`);
  }

  return sections.join("\n");
}

export function prepareStructuredPrompt(normalizedRequest) {
  const originalPrompt = renderStructuredPrompt(normalizedRequest);
  if (originalPrompt.length <= TABBIT_PROMPT_TARGET_CHARS) {
    return {
      ok: true,
      prompt: originalPrompt,
      originalChars: originalPrompt.length,
      sentChars: originalPrompt.length,
      compacted: false,
      omittedMessageCount: 0,
    };
  }

  const compactedRequest = {
    ...normalizedRequest,
    system: compactSystemInstructions(normalizedRequest.system),
    messages: compactDeveloperMessages(normalizedRequest.messages),
  };
  let prompt = renderStructuredPrompt(compactedRequest);
  let omittedMessageCount = 0;

  if (prompt.length > TABBIT_PROMPT_TARGET_CHARS) {
    const compactedHistory = compactConversationHistory(compactedRequest.messages);
    compactedRequest.messages = compactedHistory.messages;
    omittedMessageCount = compactedHistory.omittedMessageCount;
    prompt = renderStructuredPrompt(compactedRequest);
  }

  return {
    ok: prompt.length <= TABBIT_PROMPT_MAX_CHARS,
    prompt,
    originalChars: originalPrompt.length,
    sentChars: prompt.length,
    compacted: prompt !== originalPrompt,
    omittedMessageCount,
  };
}

export function buildStructuredPrompt(normalizedRequest) {
  return prepareStructuredPrompt(normalizedRequest).prompt;
}

function stripJsonFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeEnvelopeBlock(block) {
  if (!block || typeof block !== "object") {
    throw new Error("Envelope content blocks must be objects.");
  }

  if (block.type === "text") {
    if (typeof block.text !== "string") {
      throw new Error("Text blocks require a text string.");
    }

    return {
      type: "text",
      text: repairTextEncoding(block.text),
    };
  }

  if (block.type === "tool_use") {
    if (typeof block.name !== "string" || !block.name.trim()) {
      throw new Error("tool_use blocks require a name.");
    }

    return {
      type: "tool_use",
      id: cleanText(block.id) || randomId("toolu"),
      name: block.name.trim(),
      input: block.input && typeof block.input === "object" ? clone(block.input) : {},
    };
  }

  if (block.type === "server_tool_use") {
    if (typeof block.name !== "string" || !block.name.trim()) {
      throw new Error("server_tool_use blocks require a name.");
    }

    return {
      type: "server_tool_use",
      id: cleanText(block.id) || randomId("srvtoolu"),
      name: block.name.trim(),
      input: block.input && typeof block.input === "object" ? clone(block.input) : {},
    };
  }

  throw new Error(`Unsupported envelope block type '${block.type}'.`);
}

function parseStructuredEnvelopeOnce(text) {
  const candidate = stripJsonFences(text);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    if (!candidate.includes("\\$")) {
      throw error;
    }
    parsed = JSON.parse(candidate.replace(/\\\$/g, "$"));
  }
  const stopReason =
    parsed?.stop_reason === "tool_use" ? "tool_use" : "end_turn";
  const blocks = Array.isArray(parsed?.content)
    ? parsed.content.map(normalizeEnvelopeBlock)
    : [];

  if (blocks.length === 0) {
    throw new Error("Envelope content array is empty.");
  }

  const hasClientTool = blocks.some((block) => block.type === "tool_use");
  const hasServerTool = blocks.some((block) => block.type === "server_tool_use");
  if (hasClientTool && hasServerTool) {
    throw new Error("Do not mix tool_use and server_tool_use in one response.");
  }

  return {
    stopReason:
      hasClientTool || hasServerTool ? "tool_use" : stopReason,
    contentBlocks: blocks,
  };
}

export function parseStructuredEnvelope(text) {
  let envelope = parseStructuredEnvelopeOnce(text);

  for (let depth = 0; depth < 2; depth += 1) {
    if (envelope.contentBlocks.length !== 1) {
      break;
    }

    const [onlyBlock] = envelope.contentBlocks;
    if (onlyBlock.type !== "text" || typeof onlyBlock.text !== "string") {
      break;
    }

    try {
      envelope = parseStructuredEnvelopeOnce(onlyBlock.text);
    } catch {
      break;
    }
  }

  return envelope;
}

async function repairStructuredEnvelope(rawText, normalizedRequest, deps) {
  const repairPrompt = [
    "Repair the following assistant output into valid JSON only.",
    "Preserve the original meaning. Do not add new tool calls.",
    "Use the exact schema below:",
    promptJson(
      {
        stop_reason: "end_turn or tool_use",
        content: [
          { type: "text", text: "assistant reply text" },
          {
            type: "tool_use",
            id: "toolu_...",
            name: "client tool name",
            input: {},
          },
          {
            type: "server_tool_use",
            id: "srvtoolu_...",
            name: "web_search | web_fetch | code_execution",
            input: {},
          },
        ],
      },
    ),
    "",
    "Original output:",
    rawText,
  ].join("\n");

  const repairResult = await deps.sendPromptToTabbit({
    prompt: repairPrompt,
    model: normalizedRequest.requestedModel,
    attachments: normalizedRequest.attachments || [],
  });

  if (!repairResult.ok) {
    return repairResult;
  }

  return {
    ok: true,
    ...repairResult,
  };
}

function incrementUsage(usageEstimate, block) {
  if (block.type === "server_tool_use") {
    if (block.name === "web_search") {
      usageEstimate.server_tool_use.web_search_requests += 1;
    }

    if (block.name === "web_fetch") {
      usageEstimate.server_tool_use.web_fetch_requests += 1;
    }

    if (block.name === "code_execution") {
      usageEstimate.server_tool_use.code_execution_requests += 1;
    }
  }
}

function validateSelectedTools(parsedBlocks, normalizedRequest) {
  const allowedClientTools = new Set(
    activeClientTools(normalizedRequest).map((tool) => tool.name),
  );
  const allowedServerTools = new Set(
    normalizedRequest.tools.server.map((tool) => tool.name),
  );

  for (const block of parsedBlocks) {
    if (block.type === "tool_use" && !allowedClientTools.has(block.name)) {
      throw new Error(`Unknown client tool '${block.name}'.`);
    }

    if (
      block.type === "server_tool_use" &&
      !allowedServerTools.has(block.name)
    ) {
      throw new Error(`Unknown server tool '${block.name}'.`);
    }
  }
}

function addTokenEstimate(usageEstimate, text) {
  const tokens = countTokens(typeof text === "string" ? text : JSON.stringify(text));
  usageEstimate.input_tokens += tokens;
  usageEstimate.total_tokens += tokens;
}

function addOutputTokenEstimate(usageEstimate, text) {
  const tokens = countTokens(typeof text === "string" ? text : JSON.stringify(text));
  usageEstimate.output_tokens += tokens;
  usageEstimate.total_tokens += tokens;
}

function normalizeServerToolResultBlock(serverToolUse, resultBlock) {
  return {
    type: "server_tool_result",
    name: serverToolUse.name,
    tool_use_id: resultBlock.tool_use_id,
    result_type: resultBlock.type,
    is_error: Boolean(resultBlock.is_error),
    content: clone(resultBlock.content),
    extra: Object.fromEntries(
      Object.entries(resultBlock).filter(
        ([key]) => !["type", "tool_use_id", "is_error", "content"].includes(key),
      ),
    ),
  };
}

function attachmentFallbackSignals(text) {
  const value = typeof text === "string" ? text : "";
  if (!value) {
    return [];
  }

  const patterns = [
    /自动分析超时/,
    /视觉识别.{0,20}超时/,
    /视觉通道.{0,20}(?:坏|挂|不可用|不稳定)/,
    /上游.{0,20}(?:30\s*s|30\s*秒).{0,20}(?:限制|超时|timeout)/i,
    /上游.{0,10}限制/,
    /没拿到图像内容/,
    /没拿到(?:图片|图像|文件)(?:内容|描述)?/,
    /未(?:拿到|获取到)(?:图片|图像|文件)(?:内容|描述)?/,
    /(?:还是|依然|仍然|依旧).{0,20}(?:拿不到|没拿到).{0,20}(?:图像|图片|附件|文件)/,
    /无法(?:查看|看到|读取|分析)(?:这张|该)?(?:图片|图像|附件|文件)/,
    /no image (?:attached|provided|available)/i,
    /image (?:analysis|analy[sz]e) (?:timed out|timeout)/i,
    /can't (?:see|access|view|read) (?:the )?(?:image|attachment|file)/i,
    /cannot (?:see|access|view|read) (?:the )?(?:image|attachment|file)/i,
  ];

  return patterns.filter((pattern) => pattern.test(value));
}

function shouldRetryNativeAttachmentAnswer(parsedBlocks, normalizedRequest) {
  if (!normalizedRequest.attachments?.length) {
    return false;
  }

  const text = parsedBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");

  return attachmentFallbackSignals(text).length > 0;
}

function nativeAttachmentRetryMessage() {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "The previous answer incorrectly claimed that image or file analysis was unavailable or timed out. The attachment is available in this same Tabbit request as a native reference. Answer the user's request directly from the attached content. Do not mention auxiliary analysis, timeout, OCR, local paths, or retry options.",
      },
    ],
  };
}

export async function runGatewaySession(normalizedRequest, deps) {
  const workingRequest = clone(normalizedRequest);
  const workingMessages = clone(normalizedRequest.messages);
  const transcriptBlocks = [];
  const usageEstimate = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
      code_execution_requests: 0,
    },
  };

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const preparedPrompt = prepareStructuredPrompt({
      ...workingRequest,
      messages: workingMessages,
    });
    if (preparedPrompt.compacted) {
      console.log(
        `[tabbit-prompt] original=${preparedPrompt.originalChars} sent=${preparedPrompt.sentChars} compacted=true omitted_messages=${preparedPrompt.omittedMessageCount}`,
      );
    }

    if (!preparedPrompt.ok) {
      return {
        ok: false,
        error: "invalid_request",
        detail: `Structured prompt is ${preparedPrompt.sentChars} characters after safe compaction, exceeding Tabbit's observed ${TABBIT_PROMPT_MAX_CHARS}-character limit. Reduce the current user input, attachment metadata, tool schemas, or recent conversation context.`,
        requestedModelAlias: workingRequest.requestedModel,
        attemptedModels: [],
        fallbackHappened: false,
        promptCompaction: {
          originalChars: preparedPrompt.originalChars,
          sentChars: preparedPrompt.sentChars,
          compacted: preparedPrompt.compacted,
          omittedMessageCount: preparedPrompt.omittedMessageCount,
        },
      };
    }

    const prompt = preparedPrompt.prompt;
    addTokenEstimate(usageEstimate, prompt);

    const tabbitResult = await deps.sendPromptToTabbit({
      prompt,
      model: workingRequest.requestedModel,
      attachments: workingRequest.attachments || [],
    });

    if (!tabbitResult.ok) {
      return tabbitResult;
    }

    const tabbitText = repairTextEncoding(tabbitResult.text || "");
    addOutputTokenEstimate(usageEstimate, tabbitText);

    let parsed;
    try {
      parsed = parseStructuredEnvelope(tabbitText);
    } catch (parseError) {
      const repaired = await repairStructuredEnvelope(
        tabbitText,
        workingRequest,
        deps,
      );

      if (!repaired.ok) {
        return repaired;
      }

      try {
        parsed = parseStructuredEnvelope(repairTextEncoding(repaired.text || ""));
      } catch {
        const hasAnyTools =
          activeClientTools(workingRequest).length > 0 ||
          workingRequest.tools.server.length > 0;
        if (!hasAnyTools) {
          const fallbackText = repairTextEncoding(cleanText(tabbitText));
          return {
            ok: true,
            contentBlocks: [
              {
                type: "text",
                text: fallbackText,
              },
            ],
            stopReason: "end_turn",
            selectedModel: tabbitResult.gatewayModelId,
            attemptedModels: tabbitResult.attemptedModels || [],
            fallbackHappened: Boolean(tabbitResult.fallbackHappened),
            usageEstimate,
            rawText: tabbitText,
          };
        }

        return {
          ok: false,
          error: "invalid_request",
          detail:
            parseError instanceof Error
              ? parseError.message
              : "The Tabbit reply could not be converted into a structured response.",
        };
      }
    }

    const hasServerTool = parsed.contentBlocks.some(
      (block) => block.type === "server_tool_use",
    );
    const hasClientTool = parsed.contentBlocks.some(
      (block) => block.type === "tool_use",
    );

    const unavailableTools = unavailableClientToolUses(
      parsed.contentBlocks,
      workingRequest,
    );
    if (unavailableTools.length) {
      workingMessages.push({
        role: "assistant",
        content: clone(parsed.contentBlocks),
      });
      workingMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: unavailableTools[0].id,
            is_error: true,
            content: [
              {
                type: "text",
                text:
                  `The client tool '${unavailableTools[0].name}' is unavailable for this turn because the image or file is already attached as a native Tabbit reference. Answer directly from the attached Tabbit reference instead. Return end_turn text only.`,
              },
            ],
          },
        ],
      });
      continue;
    }

    if (shouldRetryNativeAttachmentAnswer(parsed.contentBlocks, workingRequest)) {
      workingMessages.push({
        role: "assistant",
        content: clone(parsed.contentBlocks),
      });
      workingMessages.push(nativeAttachmentRetryMessage());
      continue;
    }

    try {
      validateSelectedTools(parsed.contentBlocks, workingRequest);
    } catch (error) {
      return {
        ok: false,
        error: "invalid_request",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (hasServerTool && hasClientTool) {
      return {
        ok: false,
        error: "invalid_request",
        detail: "Structured response mixed client tool_use and server_tool_use blocks.",
      };
    }

    transcriptBlocks.push(...clone(parsed.contentBlocks));
    workingMessages.push({
      role: "assistant",
      content: clone(parsed.contentBlocks),
    });

    if (!hasServerTool) {
      return {
        ok: true,
        contentBlocks: transcriptBlocks,
        stopReason: parsed.stopReason,
        selectedModel: tabbitResult.gatewayModelId,
        attemptedModels: tabbitResult.attemptedModels || [],
        fallbackHappened: Boolean(tabbitResult.fallbackHappened),
        usageEstimate,
        rawText: tabbitText,
      };
    }

    const serverResults = [];
    for (const block of parsed.contentBlocks.filter(
      (entry) => entry.type === "server_tool_use",
    )) {
      incrementUsage(usageEstimate, block);
      const resultBlock = await deps.executeServerToolUse(block);
      const normalizedResult = normalizeServerToolResultBlock(block, resultBlock);
      transcriptBlocks.push(normalizedResult);
      serverResults.push(normalizedResult);
    }

    workingMessages.push({
      role: "user",
      content: serverResults,
    });
  }

  return {
    ok: false,
    error: "invalid_request",
    detail: "Exceeded the server tool loop limit of 8 iterations.",
  };
}
