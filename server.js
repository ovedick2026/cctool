/* ==========================================================================
 *  server.js —— 【通讯骨架层 (支持思考实时流 + 正文工具完整后提取)】
 * ========================================================================== */

import express from "express";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 1. 引入 undici 的 Agent 配置
import { Agent, setGlobalDispatcher } from "undici";

// 2. 调大 Node.js 底层的全局 fetch 超时时间（例如设为 20 分钟）
setGlobalDispatcher(
  new Agent({
    headersTimeout: 1200000,
    bodyTimeout: 1200000,
    connectTimeout: 60000
  })
);

import * as adapt from "./adapt.js";

dns.setDefaultResultOrder("ipv4first");

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT || 7860);
const CONFIG_FILE = process.env.CONFIG_FILE || "/tmp/tool-bridge-config.json";
const ENABLE_DASHBOARD = process.env.ENABLE_DASHBOARD === "true";

const MAX_LOG_ENTRIES = 200;
const MAX_LOG_RAW_CHARS = 20000;

const ALLOW_HTTP = false;
const ALLOWED_HOSTS = [];

const UPSTREAM_MAX_ATTEMPTS = 2;
const UPSTREAM_TIMEOUT_MS = 1200000;
const RETRY_MAX_DELAY_MS = 30000;
const CONNECT_MAX_ATTEMPTS = 3;

// 记忆每个上游 Host 支持的协议类型: "anthropic" | "openai"
const endpointProtocolCache = new Map();

const DUMMY_THINKING_SIGNATURE =
  "ZXhhbXBsZV9zaWduYXR1cmVfZHVtbXlfc3RyaW5nX2Zvcl90aGlua2luZ19ibG9ja192YWxpZGF0aW9u";

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_CONFIG = {
  includeOriginalSystem: false,
  promptId: adapt.DEFAULT_PROMPT_ID,
  toolPrompt: "",
  modelMap: {},
  tuning: { ...adapt.DEFAULT_TUNING },
  upstreamMinIntervalMs: 1500,
  logLevel: "debug",
  logBodies: true
};

/* -------------------------------------------------------------------------- */
/*                                  Log Bus                                   */
/* -------------------------------------------------------------------------- */

class LogBus {
  constructor(maxEntries) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.clients = new Set();
    this.seq = 0;
  }

  get level() {
    return LOG_LEVELS[runtimeConfig?.logLevel] ?? LOG_LEVELS.debug;
  }

  emit(requestId, level, event, data) {
    if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < this.level) return;

    const entry = {
      id: crypto.randomUUID(),
      seq: ++this.seq,
      time: new Date().toISOString(),
      requestId: requestId || "-",
      level,
      event,
      data: capPayload(data)
    };

    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();

    const wire = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(wire);
      } catch {
        this.clients.delete(client);
      }
    }

    if (level === "error" || level === "warn") {
      console.log(`[${level}] ${event} ${JSON.stringify(entry.data).slice(0, 400)}`);
    }
  }

  scoped(requestId) {
    return (level, event, data) => this.emit(requestId, level, event, data);
  }
}

function capPayload(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === "string") return capString(data);
  if (Array.isArray(data)) return data.map(capPayload);

  if (typeof data === "object") {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = typeof value === "string" ? capString(value) : capPayload(value);
    }
    return out;
  }

  return data;
}

function capString(text) {
  return text.length > MAX_LOG_RAW_CHARS
    ? `${text.slice(0, MAX_LOG_RAW_CHARS)}\n…[日志截断，原长 ${text.length} 字符]`
    : text;
}

const logBus = new LogBus(MAX_LOG_ENTRIES);
let runtimeConfig = loadConfig();

/* -------------------------------------------------------------------------- */
/*                                 Middleware                                 */
/* -------------------------------------------------------------------------- */

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Authorization",
      "Content-Type",
      "x-api-key",
      "anthropic-version",
      "anthropic-auth-token",
      "x-tool-bridge-auth-mode"
    ].join(", ")
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({ limit: "50mb" }));

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      error: { type: "invalid_request_error", message: "Invalid JSON request body." }
    });
  }
  next(error);
});

/* -------------------------------------------------------------------------- */
/*                               Dashboard APIs                               */
/* -------------------------------------------------------------------------- */

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "claude-code-tool-bridge",
    dashboardEnabled: ENABLE_DASHBOARD,
    allowedHostsConfigured: ALLOWED_HOSTS.length > 0
  });
});

if (ENABLE_DASHBOARD) {
  console.log("[tool-bridge] 💡 Web 控制台已开启");

  app.get("/api/config", (req, res) => {
    res.json({
      ...runtimeConfig,
      effectiveToolPrompt: currentPromptText()
    });
  });

  app.put("/api/config", (req, res) => {
    try {
      runtimeConfig = sanitizeConfig(req.body);
      saveConfig(runtimeConfig);
      res.json({ ok: true, config: runtimeConfig });
    } catch (error) {
      res.status(400).json({ error: error?.message || "Invalid configuration." });
    }
  });

  app.get("/api/presets", (req, res) => {
    res.json({
      presets: adapt.PROMPT_PRESETS.map(({ id, label, hint, text }) => ({
        id, label, hint, text
      })),
      protocolRules: adapt.PROTOCOL_RULES,
      defaultTuning: adapt.DEFAULT_TUNING,
      logLevels: Object.keys(LOG_LEVELS)
    });
  });

  app.get("/api/logs", (req, res) => {
    setupSSE(res);
    for (const entry of logBus.entries) {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    logBus.clients.add(res);
    req.on("close", () => logBus.clients.delete(res));
  });

  app.delete("/api/logs", (req, res) => {
    logBus.entries = [];
    res.json({ ok: true });
  });

  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));
} else {
  console.log("[tool-bridge] 🔒 Web 控制台已完全关闭 (未设置 ENABLE_DASHBOARD=true)");
}

/* -------------------------------------------------------------------------- */
/*                              Main Proxy Router                             */
/* -------------------------------------------------------------------------- */

app.use(async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);

  try {
    const targetUrl = parseTargetFromPath(req);

    if (!targetUrl) {
      return res.status(404).json({
        error: {
          type: "invalid_request_error",
          message: "Expected target URL path, e.g. /https://target.example.com/v1/messages"
        }
      });
    }

    await validateTargetUrl(targetUrl, req);

    const pathname = targetUrl.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathname.endsWith("/v1/models")) {
      return await passthroughRequest(req, res, requestId, targetUrl);
    }

    if (req.method === "POST" && pathname.endsWith("/v1/messages/count_tokens")) {
      return res.json({ input_tokens: estimateTokens(req.body) });
    }

    if (req.method === "POST" && (pathname.endsWith("/v1/messages") || pathname.endsWith("/v1/message"))) {
      return await handleAnthropicMessages(req, res, requestId, targetUrl);
    }

    if (req.method === "POST" && pathname.endsWith("/v1/chat/completions")) {
      return await handleOpenAIChat(req, res, requestId, targetUrl);
    }

    return await passthroughRequest(req, res, requestId, targetUrl);
  } catch (error) {
    const status = Number(error?.status) || 502;

    logBus.emit(requestId, "error", "request.failed", {
      status,
      message: error?.message,
      stack: error?.stack
    });

    if (res.headersSent) {
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: errorTypeForStatus(status), message: error?.message }
          })}\n\n`
        );
        res.end();
      } catch {
        /* Connection closed */
      }
      return;
    }

    return res.status(status).json({
      error: {
        type: errorTypeForStatus(status),
        message: error?.message || "Bridge request failed."
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                         Anthropic Messages Handler                         */
/* -------------------------------------------------------------------------- */

async function handleAnthropicMessages(req, res, requestId, originalTargetUrl) {
  const log = logBus.scoped(requestId);
  const body = req.body || {};
  const tuning = runtimeConfig.tuning;
  const tools = normalizeAnthropicTools(body.tools || []);
  const hostOrigin = originalTargetUrl.origin;
  const isClientStream = body.stream === true;

  log("info", "request.in", {
    entry: "anthropic",
    model: body.model,
    mappedModel: resolveModel(body.model),
    clientStream: isClientStream,
    messageCount: (body.messages || []).length,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    toolChoice: body.tool_choice,
    estimatedInputTokens: estimateTokens(body)
  });

  const conversation = anthropicToConversation(body);
  const compressed = adapt.compressHistory(conversation, tuning, log);
  const renderedMessages = adapt.renderConversation(compressed, tuning, log);

  const toolPrompt = adapt.renderToolPrompt(tools, body.tool_choice, {
    promptText: currentPromptText(),
    tuning
  });

  const repeatWarning = adapt.detectRepeatedToolCall(compressed, tuning);
  if (repeatWarning) {
    log("warn", "loop.repeat_detected", { injected: repeatWarning });
    renderedMessages.push({ role: "user", content: repeatWarning });
  }

  // 状态跟踪对象：用来支持边推思考流，边缓冲正文
  const streamState = {
    started: false,
    thinkingBlockStarted: false,
    thinkingBlockClosed: false,
    nextBlockIndex: 0,
    fullThinkingText: "",
    bufferedContentText: "",
    nativeToolCalls: []
  };

  // 思考块启动回调
  const onThinkingStart = () => {
    if (!isClientStream || streamState.thinkingBlockStarted) return;
    if (!streamState.started) {
      setupSSE(res);
      sseSend(res, "message_start", {
        type: "message_start",
        message: {
          id: `msg_${uuid()}`,
          type: "message",
          role: "assistant",
          model: body.model || "claude-sonnet-x",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimateTokens(body), output_tokens: 1 }
        }
      });
      streamState.started = true;
    }
    sseSend(res, "content_block_start", {
      type: "content_block_start",
      index: streamState.nextBlockIndex,
      content_block: { type: "thinking", thinking: "" }
    });
    streamState.thinkingBlockStarted = true;
  };

  // 思考内容增量回调
  const onThinkingDelta = (chunk) => {
    if (!chunk) return;
    streamState.fullThinkingText += chunk;
    if (!isClientStream) return;
    onThinkingStart();
    sseSend(res, "content_block_delta", {
      type: "content_block_delta",
      index: streamState.nextBlockIndex,
      delta: { type: "thinking_delta", thinking: chunk }
    });
  };

  // 思考块结束回调
  const closeThinkingBlockIfNeeded = () => {
    if (!streamState.thinkingBlockStarted || streamState.thinkingBlockClosed) return;
    if (isClientStream) {
      sseSend(res, "content_block_delta", {
        type: "content_block_delta",
        index: streamState.nextBlockIndex,
        delta: { type: "signature_delta", signature: DUMMY_THINKING_SIGNATURE }
      });
      sseSend(res, "content_block_stop", {
        type: "content_block_stop",
        index: streamState.nextBlockIndex
      });
    }
    streamState.thinkingBlockClosed = true;
    streamState.nextBlockIndex++;
  };

  let success = false;
  const cachedProtocol = endpointProtocolCache.get(hostOrigin);

  // 1. 尝试 Anthropic 协议
  if (cachedProtocol !== "openai") {
    try {
      log("info", "upstream.attempt", { mode: "anthropic_messages_stream", url: String(originalTargetUrl) });

      const systemParts = [];
      if (runtimeConfig.includeOriginalSystem && compressed.system) {
        systemParts.push(compressed.system);
      }
      if (toolPrompt) systemParts.push(toolPrompt);

      const anthropicBody = cleanUndefined({
        model: resolveModel(body.model),
        messages: renderedMessages,
        system: systemParts.join("\n\n") || undefined,
        max_tokens: body.max_tokens || 4096,
        temperature: body.temperature,
        top_p: body.top_p,
        stream: true // 向上游开启流式
      });

      const probeTimeout = cachedProtocol === "anthropic" ? UPSTREAM_TIMEOUT_MS : 60000;
      await callUpstreamSSE(
        req,
        requestId,
        originalTargetUrl,
        anthropicBody,
        (event, data) => {
          if (data?.type === "content_block_start" && data?.content_block?.type === "thinking") {
            onThinkingStart();
          } else if (data?.type === "content_block_delta") {
            if (data.delta?.type === "thinking_delta") {
              onThinkingDelta(data.delta.thinking || "");
            } else if (data.delta?.type === "text_delta") {
              closeThinkingBlockIfNeeded();
              streamState.bufferedContentText += data.delta.text || "";
            }
          } else if (data?.type === "content_block_stop") {
            if (streamState.thinkingBlockStarted && !streamState.thinkingBlockClosed) {
              closeThinkingBlockIfNeeded();
            }
          }
        },
        probeTimeout
      );

      success = true;
      endpointProtocolCache.set(hostOrigin, "anthropic");
    } catch (messagesError) {
      if (messagesError?.status && messagesError.status !== 404) {
        throw messagesError;
      }
      log("warn", "upstream.messages_failed", {
        message: messagesError?.message || String(messagesError),
        hint: "Anthropic /v1/messages 失败，自动切换上游为 OpenAI /v1/chat/completions 接口"
      });
      endpointProtocolCache.set(hostOrigin, "openai");
    }
  }

  // 2. Fallback / 直接使用 OpenAI 接口
  if (!success) {
    log("info", "upstream.attempt", { mode: "openai_chat_stream_fallback" });

    const messages = [];
    if (runtimeConfig.includeOriginalSystem && compressed.system) {
      messages.push({ role: "system", content: compressed.system });
    }
    if (toolPrompt) messages.push({ role: "system", content: toolPrompt });
    messages.push(...renderedMessages);

    const openAIBody = cleanUndefined({
      model: resolveModel(body.model),
      messages,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: orUndefined(adapt.buildStopSequences(body.stop_sequences || body.stop, tools, tuning)),
      stream: true // 向上游开启流式
    });

    const upstreamUrl = rewriteAnthropicMessagesToOpenAI(originalTargetUrl);

    // 针对带<think>标签的流式状态解析器
    let inThinkTag = false;

    await callUpstreamSSE(req, requestId, upstreamUrl, openAIBody, (event, data) => {
      const choice = data?.choices?.[0];
      if (!choice) return;

      const delta = choice.delta || {};
      const reasoningChunk = delta.reasoning_content || delta.reasoning;

      // A. 上游通过专门的 reasoning_content 字段返回思考
      if (reasoningChunk) {
        onThinkingDelta(reasoningChunk);
      }

      // B. 接收普通内容流
      if (delta.content) {
        let contentChunk = delta.content;

        // 处理混在 content 里的  标签
        if (!inThinkTag && contentChunk.includes("")) {
          inThinkTag = true;
          const [before, after] = contentChunk.split("");
          if (before) streamState.bufferedContentText += before;
          contentChunk = after || "";
        }

        if (inThinkTag) {
          if (contentChunk.includes("</think>")) {
            const [thinkPart, after] = contentChunk.split("</think>");
            onThinkingDelta(thinkPart);
            closeThinkingBlockIfNeeded();
            inThinkTag = false;
            if (after) streamState.bufferedContentText += after;
          } else {
            onThinkingDelta(contentChunk);
          }
        } else {
          // 正式正文：思考块必须关闭，开始积攒正文
          closeThinkingBlockIfNeeded();
          streamState.bufferedContentText += contentChunk;
        }
      }

      // C. 原生 tool_calls 增量聚合
      if (Array.isArray(delta.tool_calls)) {
        closeThinkingBlockIfNeeded();
        accumulateOpenAIToolCalls(streamState.nativeToolCalls, delta.tool_calls);
      }
    });
  }

  // 保证思考块已被正常关闭
  closeThinkingBlockIfNeeded();

  // 上游流完全接收完毕，现在进行完整的正文与工具解析提取
  let rawText = streamState.bufferedContentText;
  let reasoningText = streamState.fullThinkingText;

  const { text: cleanText, thinking } = adapt.splitThinking(rawText);
  if (!reasoningText && thinking) reasoningText = thinking;

  // 使用 adapt 统一提取可能嵌在文本中的工具调用
  const extracted = adapt.extractToolCalls(cleanText, tools, tuning, log, () => `toolu_${uuid()}`);

  const toolCalls = mergeToolCalls(
    [
      extractNativeOpenAIToolCalls({ tool_calls: streamState.nativeToolCalls }, tools, tuning),
      extracted.toolCalls
    ],
    tuning
  );

  const text = ensureVisibleAssistantText(
    extracted.content,
    toolCalls,
    "上游模型返回了空内容，未生成可执行的工具调用。"
  );

  const response = buildAnthropicResponse({
    requestModel: body.model,
    text,
    reasoningText,
    toolCalls,
    inputTokens: estimateTokens(body),
    outputTokens: estimateTokens(rawText + reasoningText)
  });

  log("info", "response.out", {
    stopReason: response.stop_reason,
    toolCalls: toolCalls.map((call) => ({
      name: call.name,
      args: Object.keys(call.arguments || {})
    })),
    textLength: text.length,
    thinkingLength: reasoningText.length,
    rejectedCandidates: extracted.rejected.length
  });

  // 如果下游要求 stream（Claude Code 默认模式）
  if (isClientStream) {
    if (!streamState.started) {
      setupSSE(res);
      sseSend(res, "message_start", {
        type: "message_start",
        message: {
          id: response.id,
          type: "message",
          role: "assistant",
          model: response.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: response.usage.input_tokens, output_tokens: 1 }
        }
      });
      streamState.started = true;
    }

    // 补发适配好的 Text Block
    if (text) {
      const textIndex = streamState.nextBlockIndex++;
      sseSend(res, "content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" }
      });
      sseSend(res, "content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text }
      });
      sseSend(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
    }

    // 补发适配好的 Tool Call Blocks
    for (const call of toolCalls) {
      const toolIndex = streamState.nextBlockIndex++;
      sseSend(res, "content_block_start", {
        type: "content_block_start",
        index: toolIndex,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} }
      });
      sseSend(res, "content_block_delta", {
        type: "content_block_delta",
        index: toolIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) }
      });
      sseSend(res, "content_block_stop", { type: "content_block_stop", index: toolIndex });
    }

    sseSend(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage
    });
    sseSend(res, "message_stop", { type: "message_stop" });
    return res.end();
  }

  // 非流模式下游直接返回 JSON
  return res.json(response);
}

/* -------------------------------------------------------------------------- */
/*                       OpenAI Chat Completions Handler                      */
/* -------------------------------------------------------------------------- */

async function handleOpenAIChat(req, res, requestId, targetUrl) {
  const log = logBus.scoped(requestId);
  const body = req.body || {};
  const tuning = runtimeConfig.tuning;
  const tools = normalizeOpenAITools(body);

  log("info", "request.in", {
    entry: "openai",
    model: body.model,
    mappedModel: resolveModel(body.model),
    stream: body.stream === true,
    messageCount: (body.messages || []).length,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    toolChoice: body.tool_choice
  });

  const conversation = openaiToConversation(body, tools, tuning, log);
  const compressed = adapt.compressHistory(conversation, tuning, log);
  const messages = [];

  if (runtimeConfig.includeOriginalSystem && compressed.system) {
    messages.push({ role: "system", content: compressed.system });
  }

  const toolPrompt = adapt.renderToolPrompt(tools, body.tool_choice, {
    promptText: currentPromptText(),
    tuning
  });

  if (toolPrompt) messages.push({ role: "system", content: toolPrompt });
  messages.push(...adapt.renderConversation(compressed, tuning, log));

  const repeatWarning = adapt.detectRepeatedToolCall(compressed, tuning);
  if (repeatWarning) {
    log("warn", "loop.repeat_detected", { injected: repeatWarning });
    messages.push({ role: "user", content: repeatWarning });
  }

  let bufferedContent = "";
  let bufferedReasoning = "";
  const nativeToolCalls = [];

  const upstreamBody = cleanUndefined({
    model: resolveModel(body.model),
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: orUndefined(adapt.buildStopSequences(body.stop, tools, tuning)),
    seed: body.seed,
    response_format: body.response_format,
    stream: true
  });

  await callUpstreamSSE(req, requestId, targetUrl, upstreamBody, (event, data) => {
    const choice = data?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.reasoning_content || delta.reasoning) {
      bufferedReasoning += delta.reasoning_content || delta.reasoning;
    }
    if (delta.content) {
      bufferedContent += delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      accumulateOpenAIToolCalls(nativeToolCalls, delta.tool_calls);
    }
  });

  const { text: cleanText, thinking } = adapt.splitThinking(bufferedContent);
  const reasoningText = bufferedReasoning || thinking || "";

  const extracted = adapt.extractToolCalls(cleanText, tools, tuning, log, () => `toolu_${uuid()}`);
  const toolCalls = mergeToolCalls(
    [extractNativeOpenAIToolCalls({ tool_calls: nativeToolCalls }, tools, tuning), extracted.toolCalls],
    tuning
  );

  const text = ensureVisibleAssistantText(
    extracted.content,
    toolCalls,
    "上游模型返回了空内容，未生成可执行的工具调用。"
  );

  const response = buildOpenAIResponse({
    model: body.model,
    text,
    reasoningText,
    toolCalls
  });

  log("info", "response.out", {
    finishReason: response.choices[0].finish_reason,
    toolCalls: toolCalls.map((call) => call.name),
    textLength: text.length,
    rejectedCandidates: extracted.rejected.length
  });

  if (body.stream === true) return sendOpenAISSE(res, response);
  return res.json(response);
}

/* -------------------------------------------------------------------------- */
/*        协议层：客户端报文 → Conversation 中间表示                              */
/* -------------------------------------------------------------------------- */

function anthropicToConversation(body) {
  const messages = [];

  for (const message of body.messages || []) {
    const parts = [];
    const content = message?.content;

    if (typeof content === "string") {
      parts.push({ kind: "text", text: adapt.stripClientNoise(content) });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;

        switch (block.type) {
          case "text":
            parts.push({ kind: "text", text: adapt.stripClientNoise(block.text || "") });
            break;

          case "thinking":
            parts.push({ kind: "thinking", text: block.thinking || "" });
            break;

          case "redacted_thinking":
            parts.push({ kind: "thinking", text: "" });
            break;

          case "tool_use":
            parts.push({
              kind: "tool_call",
              id: block.id,
              name: block.name,
              args: block.input || {}
            });
            break;

          case "tool_result":
            parts.push({
              kind: "tool_result",
              id: block.tool_use_id || "",
              text: contentToText(block.content)
            });
            break;

          case "image":
            parts.push({ kind: "image" });
            break;

          default:
            parts.push({ kind: "text", text: contentToText(block) });
        }
      }
    } else if (content) {
      parts.push({ kind: "text", text: adapt.stripClientNoise(contentToText(content)) });
    }

    const kept = parts.filter((part) => part.kind !== "text" || part.text);
    if (!kept.length) continue;

    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      parts: kept
    });
  }

  return { system: anthropicSystemToText(body.system), messages };
}

function openaiToConversation(body, tools, tuning, log) {
  const systemChunks = [];
  const messages = [];

  for (const message of body.messages || []) {
    if (!message) continue;

    if (message.role === "system" || message.role === "developer") {
      const text = contentToText(message.content).trim();
      if (text) systemChunks.push(text);
      continue;
    }

    const parts = [];

    if (message.role === "tool") {
      parts.push({
        kind: "tool_result",
        id: message.tool_call_id || "",
        text: contentToText(message.content)
      });
    } else {
      const text = adapt.stripClientNoise(contentToText(message.content));

      if (message.role === "assistant" && text) {
        const recovered = adapt.extractToolCalls(text, tools, tuning, () => {});

        if (recovered.toolCalls.length) {
          if (recovered.content) parts.push({ kind: "text", text: recovered.content });

          for (const call of recovered.toolCalls) {
            parts.push({
              kind: "tool_call",
              id: call.id,
              name: call.name,
              args: call.arguments
            });
          }
        } else if (text) {
          parts.push({ kind: "text", text });
        }
      } else if (text) {
        parts.push({ kind: "text", text });
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        const native = extractNativeOpenAIToolCalls(
          { tool_calls: message.tool_calls },
          tools,
          tuning
        );

        for (const call of native) {
          const duplicate = parts.some(
            (part) =>
              part.kind === "tool_call" &&
              part.name === call.name &&
              JSON.stringify(part.args) === JSON.stringify(call.arguments)
          );

          if (!duplicate) {
            parts.push({
              kind: "tool_call",
              id: call.id,
              name: call.name,
              args: call.arguments
            });
          }
        }
      }
    }

    if (!parts.length) continue;

    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      parts
    });
  }

  return { system: systemChunks.join("\n").trim(), messages };
}

function anthropicSystemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system.trim();

  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (!block) return "";
        if (typeof block === "string") return block;
        if (block.type === "text") return block.text || "";
        return contentToText(block);
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return contentToText(system).trim();
}

/* -------------------------------------------------------------------------- */
/*                        协议层：工具定义归一化                                */
/* -------------------------------------------------------------------------- */

function normalizeAnthropicTools(tools) {
  return dedupeTools(
    tools
      .filter((tool) => tool?.name)
      .map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} }
      }))
  );
}

function normalizeOpenAITools(body) {
  const tools = [];

  for (const tool of body.tools || []) {
    if (tool?.type !== "function" || !tool.function?.name) continue;

    tools.push({
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters || { type: "object", properties: {} }
    });
  }

  for (const tool of body.functions || []) {
    if (!tool?.name) continue;

    tools.push({
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} }
    });
  }

  return dedupeTools(tools);
}

function dedupeTools(tools) {
  const seen = new Set();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

function accumulateOpenAIToolCalls(target, incoming) {
  for (const item of incoming) {
    const idx = item.index ?? 0;
    if (!target[idx]) {
      target[idx] = {
        id: item.id || "",
        type: "function",
        function: { name: "", arguments: "" }
      };
    }
    if (item.id) target[idx].id = item.id;
    if (item.function?.name) target[idx].function.name += item.function.name;
    if (item.function?.arguments) target[idx].function.arguments += item.function.arguments;
  }
}

function extractNativeOpenAIToolCalls(message, tools, tuning = adapt.DEFAULT_TUNING) {
  const candidates = [];

  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    candidates.push({
      id: call?.id,
      name: call?.function?.name,
      arguments: call?.function?.arguments
    });
  }

  if (message?.function_call?.name) {
    candidates.push({
      id: null,
      name: message.function_call.name,
      arguments: message.function_call.arguments
    });
  }

  const result = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const canonicalName = adapt.resolveToolName(candidate?.name, tools);
    const tool = adapt.getToolByName(canonicalName, tools);

    if (!canonicalName || !tool) continue;

    let args = candidate.arguments;
    if (typeof args === "string") args = adapt.parseLooseJson(args);
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;

    const normalized = { name: canonicalName, arguments: adapt.sanitizeToolArguments(args) };

    if (
      !tuning.emitIncompleteToolCalls &&
      adapt.missingRequiredArguments(normalized, tool).length
    ) {
      continue;
    }

    const key = `${normalized.name}:${JSON.stringify(normalized.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      id: candidate.id || `toolu_${uuid()}`,
      name: normalized.name,
      arguments: normalized.arguments
    });
  }

  return result;
}

function mergeToolCalls(lists, tuning = adapt.DEFAULT_TUNING) {
  const result = [];
  const seen = new Set();

  for (const list of lists) {
    for (const call of list || []) {
      if (!call?.name) continue;

      const key = `${call.name}:${JSON.stringify(call.arguments || {})}`;
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(call);
    }
  }

  return result.slice(0, Math.max(1, tuning.maxToolCallsPerTurn));
}

/* -------------------------------------------------------------------------- */
/*                            Upstream Request Logic                          */
/* -------------------------------------------------------------------------- */

const rateLimitState = new Map();
const outboundTimestamps = new Map();
const nextSlotAt = new Map();

async function throttleOutbound(origin, minIntervalMs) {
  if (!minIntervalMs || minIntervalMs <= 0) return 0;

  const now = Date.now();
  const earliest = Math.max(now, nextSlotAt.get(origin) || 0);

  nextSlotAt.set(origin, earliest + minIntervalMs);

  const waitMs = earliest - now;
  if (waitMs > 0) await sleep(waitMs);

  return waitMs;
}

function recordOutbound(origin) {
  const now = Date.now();
  const recent = (outboundTimestamps.get(origin) || []).filter((at) => now - at < 60000);

  recent.push(now);
  outboundTimestamps.set(origin, recent);

  return recent.length;
}

/**
 * 专门用于向上游发起 SSE 流式请求并逐行解析的通用处理函数
 */
async function callUpstreamSSE(
  incomingReq,
  requestId,
  targetUrl,
  body,
  onEvent,
  customTimeout = UPSTREAM_TIMEOUT_MS
) {
  const log = logBus.scoped(requestId);
  const payload = JSON.stringify(cleanUndefined(body));

  log("debug", "upstream.request_stream", {
    url: String(targetUrl),
    model: body.model,
    messageCount: body.messages?.length,
    payloadChars: payload.length
  });

  const response = await safeFetch(
    targetUrl,
    {
      method: "POST",
      headers: {
        ...buildUpstreamHeaders(incomingReq),
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json"
      },
      body: payload
    },
    customTimeout
  );

  if (!response.ok) {
    const raw = await response.text();
    throw httpError(response.status, `Upstream stream error ${response.status}: ${raw.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = "message";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        const rawData = line.slice(5).trim();
        if (rawData === "[DONE]") continue;

        try {
          const parsed = JSON.parse(rawData);
          onEvent(currentEvent, parsed);
        } catch {
          // 忽略非 JSON 数据行
        }
      }
    }
  }
}

async function passthroughRequest(req, res, requestId, targetUrl) {
  const hasBody = !["GET", "HEAD"].includes(req.method);

  const upstream = await fetchUpstreamWithRetry(requestId, targetUrl, {
    method: req.method,
    headers: {
      ...buildUpstreamHeaders(req),
      ...(hasBody ? { "Content-Type": "application/json" } : {})
    },
    body: hasBody ? JSON.stringify(req.body || {}) : undefined
  });

  res.status(upstream.response.status);
  res.setHeader(
    "Content-Type",
    upstream.response.headers.get("content-type") || "application/json"
  );
  res.send(upstream.raw);
}

async function fetchUpstreamWithRetry(requestId, targetUrl, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const log = logBus.scoped(requestId);
  const targetKey = new URL(targetUrl).origin;

  const cooldown = rateLimitState.get(targetKey);

  if (cooldown && cooldown.until > Date.now()) {
    const remaining = Math.ceil((cooldown.until - Date.now()) / 1000);
    throw httpError(
      429,
      `Upstream rate-limit cooldown is active for ${remaining}s.`
    );
  }

  if (cooldown) rateLimitState.delete(targetKey);

  let last = null;

  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt++) {
    const throttledMs = await throttleOutbound(
      targetKey,
      runtimeConfig.upstreamMinIntervalMs
    );

    const startedAt = Date.now();
    const outboundLast60s = recordOutbound(targetKey);
    const response = await safeFetch(targetUrl, options, timeoutMs);

    if (!response || !response.headers) {
      throw httpError(502, "Bridge did not receive a valid Response object.");
    }

    let raw;

    try {
      raw = await response.text();
    } catch (error) {
      throw httpError(
        502,
        `Cannot read upstream response body: ${error?.message || String(error)}`
      );
    }

    const durationMs = Date.now() - startedAt;
    last = { response, raw };

    log(response.ok ? "info" : "error", "upstream.response", {
      attempt,
      status: response.status,
      statusText: response.statusText || "",
      contentType: response.headers.get("content-type") || "",
      durationMs,
      throttledMs,
      outboundLast60s,
      rawChars: raw.length,
      headers: Object.fromEntries(response.headers.entries()),
      raw: runtimeConfig.logBodies ? raw : "[logBodies=false]"
    });

    if (response.status === 429) {
      if (!rateLimitState.has(targetKey)) {
        rateLimitState.set(targetKey, {
          until: Date.now() + 15000,
          sourceStatus: 429
        });
      }
    } else if (response.ok) {
      rateLimitState.delete(targetKey);
    }

    if (!isRetryableStatus(response.status) || attempt >= UPSTREAM_MAX_ATTEMPTS) {
      return last;
    }

    await sleep(1500);
  }

  return last;
}

function isRetryableStatus(status) {
  return [502, 503, 504].includes(status);
}

function buildUpstreamHeaders(req) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "application/json, */*"
  };

  const passHeaders = [
    "authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "anthropic-version",
    "anthropic-auth-token",
    "idempotency-key"
  ];

  for (const key of passHeaders) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }

  if (!headers.authorization) {
    if (req.headers["x-api-key"]) {
      headers.authorization = `Bearer ${req.headers["x-api-key"]}`;
    } else if (req.headers["anthropic-auth-token"]) {
      headers.authorization = `Bearer ${req.headers["anthropic-auth-token"]}`;
    }
  }

  return headers;
}

/* -------------------------------------------------------------------------- */
/*                          Response Format Conversion                        */
/* -------------------------------------------------------------------------- */

function buildAnthropicResponse({
  id,
  requestModel,
  text,
  reasoningText,
  toolCalls,
  inputTokens,
  outputTokens
}) {
  const content = [];

  if (reasoningText) {
    content.push({
      type: "thinking",
      thinking: reasoningText,
      signature: DUMMY_THINKING_SIGNATURE
    });
  }

  if (text) content.push({ type: "text", text });

  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.arguments
    });
  }

  return {
    id: id || `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    model: requestModel || "claude-sonnet-x",
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  };
}

function buildOpenAIResponse({ model, text, reasoningText, toolCalls }) {
  const message = { role: "assistant", content: text || null };

  if (reasoningText) message.reasoning_content = reasoningText;

  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: `call_${call.id}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }));
  }

  return {
    id: `chatcmpl_${uuid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "tool-bridge-model",
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop"
      }
    ]
  };
}

/* -------------------------------------------------------------------------- */
/*                                    SSE                                     */
/* -------------------------------------------------------------------------- */

function setupSSE(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendOpenAISSE(res, response) {
  setupSSE(res);

  const choice = response.choices[0];
  const message = choice.message;
  const base = {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model
  };

  const send = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      })}\n\n`
    );
  };

  send({ role: "assistant" });

  if (message.reasoning_content) send({ reasoning_content: message.reasoning_content });
  if (message.content) send({ content: message.content });

  for (let index = 0; index < (message.tool_calls?.length || 0); index++) {
    const call = message.tool_calls[index];

    send({
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: "" }
        }
      ]
    });

    send({
      tool_calls: [{ index, function: { arguments: call.function.arguments } }]
    });
  }

  send({}, message.tool_calls?.length ? "tool_calls" : "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

/* -------------------------------------------------------------------------- */
/*                                URL Security                                */
/* -------------------------------------------------------------------------- */

function parseTargetFromPath(req) {
  let raw = req.originalUrl.startsWith("/")
    ? req.originalUrl.slice(1)
    : req.originalUrl;

  if (!/^https?:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* Keep original */
    }
  }

  if (!/^https?:\/\//i.test(raw)) return null;

  try {
    return new URL(raw);
  } catch {
    throw httpError(400, "Invalid target URL.");
  }
}

function rewriteAnthropicMessagesToOpenAI(targetUrl) {
  const url = new URL(targetUrl);
  if (/\/v1\/messages?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/messages?$/i, "/v1/chat/completions");
  }
  return url;
}

async function validateTargetUrl(url, req = null) {
  if (!["https:", "http:"].includes(url.protocol)) {
    throw httpError(400, "Only http(s) target URLs are supported.");
  }

  if (url.protocol === "http:" && !ALLOW_HTTP) {
    throw httpError(400, "HTTP targets are disabled. Use HTTPS.");
  }

  if (url.username || url.password) {
    throw httpError(400, "Target URL must not include username/password.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (!hostname || hostname === "localhost") {
    throw httpError(403, "localhost target is forbidden.");
  }

  const incomingHost = getIncomingPublicHost(req);

  if (incomingHost && hostname === incomingHost) {
    throw httpError(400, "Target host is this bridge itself. Recursive self-proxy is blocked.");
  }

  if (ALLOWED_HOSTS.length && !hostAllowed(hostname)) {
    throw httpError(403, `Target host '${hostname}' is not in ALLOWED_HOSTS.`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw httpError(403, "Private IP target is forbidden.");
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw httpError(400, `Cannot resolve target hostname: ${hostname}`);
  }

  if (!records.length) {
    throw httpError(400, `Cannot resolve target hostname: ${hostname}`);
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw httpError(
        403,
        `Target hostname resolves to forbidden private address: ${record.address}`
      );
    }
  }
}

function getIncomingPublicHost(req) {
  if (!req?.headers) return "";
  const forwarded = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwarded || String(req.headers.host || "").trim();
  if (!host) return "";
  return host.replace(/:\d+$/, "").toLowerCase().replace(/\.$/, "");
}

async function safeFetch(initialUrl, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  let current = new URL(initialUrl);

  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    await validateTargetUrl(current);

    let response = null;
    let lastError = null;

    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        response = await fetch(current, {
          ...options,
          redirect: "manual",
          signal: controller.signal
        });

        clearTimeout(timer);
        break;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;

        if (error?.name === "AbortError") {
          throw httpError(504, `Upstream request timed out after ${timeoutMs}ms.`);
        }

        const isConnectIssue =
          error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ||
          error?.message?.includes("fetch failed");

        if (isConnectIssue && attempt < CONNECT_MAX_ATTEMPTS) {
          await sleep(500);
          continue;
        }

        const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
        throw httpError(
          502,
          `Upstream network error: ${error?.message || String(error)}${cause}`
        );
      }
    }

    if (!response) {
      const cause = lastError?.cause?.message ? ` (${lastError.cause.message})` : "";
      throw httpError(
        502,
        `Upstream network error after retries: ${lastError?.message || "Failed to fetch"}${cause}`
      );
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) throw httpError(502, "Upstream redirect has no Location header.");

    const next = new URL(location, current);
    if (next.host !== current.host) {
      throw httpError(502, "Cross-host redirect is blocked to avoid credential leakage.");
    }

    current = next;
  }

  throw httpError(502, "Too many upstream redirects.");
}

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.some((rule) =>
    rule.startsWith(".") ? hostname.endsWith(rule) : hostname === rule
  );
}

function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const normalized = ip.toLowerCase();
    if (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    ) {
      return true;
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }

  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

function currentPromptText() {
  const override = String(runtimeConfig?.toolPrompt || "").trim();
  return override || adapt.getPreset(runtimeConfig?.promptId).text;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return structuredClone(DEFAULT_CONFIG);
    const config = sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
    config.toolPrompt = "";
    return config;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ ...config, toolPrompt: "" }, null, 2)
    );
  } catch (error) {
    process.stderr.write(`[config] Cannot persist config: ${error?.message || error}\n`);
  }
}

function sanitizeConfig(input) {
  const toolPrompt = String(input?.toolPrompt ?? "").trim();
  if (toolPrompt.length > 100000) throw new Error("toolPrompt is too large.");

  const promptId = adapt.getPreset(input?.promptId).id;

  const modelMap =
    input?.modelMap && typeof input.modelMap === "object" && !Array.isArray(input.modelMap)
      ? Object.fromEntries(
          Object.entries(input.modelMap)
            .filter(([key, value]) => typeof key === "string" && typeof value === "string")
            .map(([key, value]) => [key.trim(), value.trim()])
            .filter(([key, value]) => key && value)
        )
      : {};

  const logLevel = LOG_LEVELS[input?.logLevel] ? input.logLevel : DEFAULT_CONFIG.logLevel;

  return {
    includeOriginalSystem: input?.includeOriginalSystem === true,
    promptId,
    toolPrompt,
    modelMap,
    tuning: adapt.normalizeTuning(input?.tuning),
    upstreamMinIntervalMs: clampNumber(
      input?.upstreamMinIntervalMs,
      DEFAULT_CONFIG.upstreamMinIntervalMs,
      0,
      60000
    ),
    logLevel,
    logBodies: input?.logBodies !== false
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/* -------------------------------------------------------------------------- */
/*                                Small Helpers                               */
/* -------------------------------------------------------------------------- */

function ensureVisibleAssistantText(text, toolCalls, fallback) {
  const normalized = String(text || "").trim();
  return toolCalls.length ? normalized : normalized || fallback;
}

function contentToText(content) {
  if (content === null || content === undefined) return "";
  if (
    typeof content === "string" ||
    typeof content === "number" ||
    typeof content === "boolean"
  ) {
    return String(content);
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (item.type === "text" || item.type === "input_text") return item.text || "";
        if (item.text) return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof content === "object") return content.text || JSON.stringify(content);
  return String(content);
}

function resolveModel(model) {
  const requested = String(model || "").trim();
  if (!requested) return requested;

  const map = runtimeConfig.modelMap || {};
  if (map[requested]) return map[requested];

  for (const [pattern, mapped] of Object.entries(map)) {
    if (!pattern.includes("*")) continue;

    const regex = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
      "i"
    );

    if (regex.test(requested)) return mapped;
  }

  return requested;
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return Math.max(1, Math.ceil(text.length / 4));
}

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, cleanUndefined(item)])
    );
  }
  return value;
}

function orUndefined(list) {
  return Array.isArray(list) && list.length ? list : undefined;
}

function uuid() {
  return crypto.randomUUID().replaceAll("-", "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorTypeForStatus(status) {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 启动服务，并修复原本未保存 server 实例的问题
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[tool-bridge] listening on port ${PORT}`);
});

server.requestTimeout = 1200000; // 20 分钟
server.headersTimeout = 1200000;
server.keepAliveTimeout = 60000;
