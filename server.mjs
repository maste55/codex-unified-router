import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, "router.config.json"), "utf8"));
const pidFile = path.join(root, "router.pid");

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function parseEnvFile(filePath) {
  const result = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadCodexAuth() {
  const data = JSON.parse(fs.readFileSync(config.codexAuthFile, "utf8"));
  const accessToken = data?.tokens?.access_token;
  const accountId = data?.tokens?.account_id;
  if (!accessToken) throw new Error("Codex access token is unavailable");
  return { accessToken, accountId };
}

function secureEqual(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticate(req) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const auth = loadCodexAuth();
  return { valid: secureEqual(supplied, auth.accessToken), auth };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new Error("Request body exceeds router limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "accept-encoding",
]);

function copyOpenAIHeaders(source, auth) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value == null || hopByHop.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("authorization", `Bearer ${auth.accessToken}`);
  if (auth.accountId && !headers.has("chatgpt-account-id")) {
    headers.set("chatgpt-account-id", auth.accountId);
  }
  return headers;
}

function deepSeekHeaders(apiKey, source) {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("content-type", source["content-type"] || "application/json");
  headers.set("accept", source.accept || "text/event-stream, application/json");
  headers.set("user-agent", "codex-unified-router/1.0");
  return headers;
}

function normalizedUpstreamPath(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  let pathname = url.pathname;
  if (pathname.startsWith("/v1/")) pathname = pathname.slice(3);
  return `${pathname}${url.search}`;
}

function decodedBody(body, encoding = "") {
  return encoding.toLowerCase() === "zstd" ? zstdDecompressSync(body) : body;
}

function sanitizeDeepSeekBody(body, encoding = "") {
  const value = JSON.parse(decodedBody(body, encoding).toString("utf8"));
  delete value.service_tier;
  // filter exec tool (DeepSeek only supports apply_patch/web_search/function)
  if (Array.isArray(value.tools)) {
    // 保留所有 function 类型工具（shell/bash/apply_patch/web_search 等），只删 DeepSeek 不认的裸 exec 类型
    value.tools = value.tools.filter((tool) => {
      if (tool?.type === "function") return true;
      const name = tool?.type || tool?.name || "";
      return name.toLowerCase() !== "exec";
    }).map((tool) => {
      if (tool?.type === "function") return tool;
      // 非 function 类型（如 shell/exec）转成 function 格式
      const name = tool?.name || tool?.type || "function";
      return { type: "function", function: { name, description: "", parameters: { type: "object", properties: {} } } };
    });
    if (value.tools.length === 0) delete value.tools;
  }
  delete value.tool_choice;
  delete value.parallel_tool_calls;
  return Buffer.from(JSON.stringify(value));
}

// ===== Responses -> DeepSeek Chat 转换层 (v1.0) =====
function convertResponsesToChat(responsesBody) {
  const msgs = [];
  const input = Array.isArray(responsesBody.input) ? responsesBody.input : [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const role = item.role || "user";
    if (role === "system") { const txt = extractItemText(item); if (txt) msgs.push({ role: "system", content: txt }); continue; }
    if (role === "user") {
      const ctype = item.type || (Array.isArray(item.content) ? item.content[0]?.type : "");
      if (ctype === "function_call_output" || item.type === "function_call_output") {
        let cid = item.call_id || ""; let cval = item.output;
        if (!cval && Array.isArray(item.content) && item.content[0]) cval = item.content[0].output || item.content[0].text || "";
        msgs.push({ role: "tool", tool_call_id: cid, content: String(cval ?? "") });
      } else { const txt = extractItemText(item); msgs.push({ role: "user", content: txt || "" }); }
      continue;
    }
    if (role === "assistant") {
      const msg = { role: "assistant" };
      const txt = extractItemText(item);
      msg.content = txt || "";
      if (Array.isArray(item.reasoning) && item.reasoning.length > 0) { const rtxt = extractReasoningText(item.reasoning); if (rtxt) msg.reasoning_content = rtxt; }
      else if (item.reasoning_content) msg.reasoning_content = String(item.reasoning_content);
      const toolCalls = [];
      if (Array.isArray(item.output)) for (const o of item.output) {
        if (o?.type === "function_call") toolCalls.push({ id: o.call_id || ("call_" + Date.now()), type: "function", function: { name: o.name || "function", arguments: typeof o.arguments === "string" ? o.arguments : JSON.stringify(o.arguments || {}) } });
      }
      if (toolCalls.length) msg.tool_calls = toolCalls;
      msgs.push(msg); continue;
    }
    const txt = extractItemText(item);
    msgs.push({ role: "user", content: txt || "" });
  }
  return msgs;
}
function extractItemText(item) {
  if (!item) return "";
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) return item.content.map((c) => {
    if (typeof c === "string") return c;
    if (c?.type === "input_text" || c?.type === "output_text" || c?.type === "text") return c.text || "";
    if (c?.type === "input_image") return "[image]";
    return "";
  }).join("");
  return "";
}
function extractReasoningText(reasoning) {
  if (!Array.isArray(reasoning)) return "";
  const parts = [];
  for (const r of reasoning) {
    if (typeof r === "string") { parts.push(r); continue; }
    if (r?.content && Array.isArray(r.content)) for (const c of r.content) { if (c?.type === "reasoning_text" || c?.type === "summary_text" || c?.type === "text") parts.push(c.text || ""); }
    if (r?.summary && Array.isArray(r.summary)) for (const s of r.summary) parts.push(s?.text || "");
    if (r?.text) parts.push(r.text);
  }
  return parts.join("");
}
function convertChatToResponses(chatBody, model) {
  const choices = chatBody?.choices || [];
  const output = [];
  if (choices.length > 0) {
    const m = choices[0]?.message || {};
    if (m.reasoning_content) output.push({ type: "reasoning", id: "rs_" + Date.now(), status: "completed", summary: [{ type: "summary_text", text: String(m.reasoning_content) }], content: [{ type: "reasoning_text", text: String(m.reasoning_content) }] });
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) output.push({ type: "function_call", id: tc.id || ("call_" + Date.now()), call_id: tc.id || ("call_" + Date.now()), name: tc.function?.name || "function", arguments: tc.function?.arguments || "{}", status: "completed" });
    const contentText = typeof m.content === "string" ? m.content : "";
    if (contentText) output.push({ type: "message", id: "msg_" + Date.now(), role: "assistant", status: "completed", content: [{ type: "output_text", text: contentText, annotations: [] }] });
  }
  const rawUsage = chatBody?.usage || {};
  // 映射 deepseek chat usage → Responses 格式（Codex 要求 input_tokens/output_tokens）
  const usage = {
    input_tokens: rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0,
    output_tokens: rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0,
    total_tokens: rawUsage.total_tokens ?? 0,
    input_tokens_details: {
      cached_tokens: rawUsage.prompt_cache_hit_tokens ?? (rawUsage.prompt_tokens_details?.cached_tokens ?? 0),
    },
    output_tokens_details: {
      reasoning_tokens: rawUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
  return { id: chatBody?.id || ("resp_" + Date.now()), object: "response", created_at: chatBody?.created || Math.floor(Date.now() / 1000), status: "completed", model: model || chatBody?.model || "", output, usage };
}

function aggregateDeepSeekSSE(sseText) {
  // deepseek SSE -> chat.completions JSON
  const lines = String(sseText).split(/\r?\n/);
  let model = "", created = Math.floor(Date.now() / 1000), id = "chatcmpl_" + Date.now();
  let content = "", reasoning = "", finish = null;
  let usage = null;
  const toolCallsMap = new Map(); // index -> {id, name, arguments}
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;
      if (chunk.created) created = chunk.created;
      const delta = chunk.choices?.[0]?.delta || {};
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof delta.content === "string") content += delta.content;
      // 聚合 tool_calls（deepseek 流式分片：{index, id, function:{name, arguments}}）
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const entry = toolCallsMap.get(idx) || { id: "", name: "", arguments: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          toolCallsMap.set(idx, entry);
        }
      }
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      if (chunk.usage) usage = chunk.usage;
    } catch {}
  }
  const choice = { index: 0, message: { role: "assistant", content }, finish_reason: finish || "stop" };
  if (reasoning) choice.message.reasoning_content = reasoning;
  if (toolCallsMap.size > 0) {
    choice.message.tool_calls = [...toolCallsMap.values()].map((tc) => ({
      id: tc.id || ("call_" + Date.now()),
      type: "function",
      function: { name: tc.name || "function", arguments: tc.arguments || "{}" },
    }));
  }
  return { id, object: "chat.completion", created, model, choices: [choice], usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

function serializeResponsesSSE(resp, requestId) {
  // 将 Responses JSON 转成 OpenAI 兼容 SSE 事件流（Codex 期望的格式）
  const events = [];
  const outEvents = resp.output || [];
  // 1. response.created
  events.push({ type: "response.created", response: { id: resp.id, object: "response", created_at: resp.created_at, status: "in_progress", model: resp.model, output: [], usage: null } });
  // 2. output_item.added + content 增量（reasoning 和 message 分事件）
  for (const item of outEvents) {
    // 关键：item 必须有稳定的 id，后续事件 item_id 必须与此一致（Codex TUI 依赖关联）
    const stableId = item.id || (item.type === "reasoning" ? "rs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6) : "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
    const copy = { ...item, id: stableId };
    events.push({ type: "response.output_item.added", output_index: events.filter(e => e.type === "response.output_item.added").length, item: copy });
    if (item.type === "reasoning") {
      // 思考过程专用事件：完整文本(reasoning_text) + 摘要(summary_text) 双通道
      const rid = copy.id || ("rs_" + Date.now());
      const full = (item.content && item.content[0]?.text) || (item.summary && item.summary[0]?.text) || "";
      const summ = (item.summary && item.summary[0]?.text) || full;
      const outIdx = events.filter(e => e.type === "response.output_item.added").length - 1;
      // A. 完整思考文本事件（Codex 折叠块显示完整思考）
      events.push({ type: "response.reasoning_text.delta", item_id: rid, output_index: outIdx, content_index: 0, delta: full });
      events.push({ type: "response.reasoning_text.done", item_id: rid, output_index: outIdx, content_index: 0, text: full });
      // B. 摘要事件（官方标准格式）
      events.push({ type: "response.reasoning_summary_part.added", item_id: rid, output_index: outIdx, content_index: 0, summary: [{ type: "summary_text", text: summ }] });
      events.push({ type: "response.reasoning_summary_text.delta", item_id: rid, output_index: outIdx, content_index: 0, delta: summ });
      events.push({ type: "response.reasoning_summary_part.done", item_id: rid, output_index: outIdx, content_index: 0, summary: [{ type: "summary_text", text: summ }] });
    }
    if (item.type === "message") {
      const textParts = (item.content || []).filter(c => c.type === "output_text" || c.type === "text");
      for (const tp of textParts) {
        events.push({ type: "response.content_part.added", item_id: copy.id, output_index: events.filter(e => e.type === "response.output_item.added").length - 1, content_index: 0, part: { type: "output_text", text: tp.text || "", annotations: [] } });
        events.push({ type: "response.output_text.delta", item_id: copy.id, output_index: events.filter(e => e.type === "response.output_item.added").length - 1, content_index: 0, delta: tp.text || "" });
        events.push({ type: "response.output_text.done", item_id: copy.id, output_index: events.filter(e => e.type === "response.output_item.added").length - 1, content_index: 0, text: tp.text || "" });
      }
      events.push({ type: "response.content_part.done", item_id: copy.id, output_index: events.filter(e => e.type === "response.output_item.added").length - 1, content_index: 0, part: { type: "output_text", text: textParts.map(t => t.text || "").join(""), annotations: [] } });
    }
    events.push({ type: "response.output_item.done", output_index: events.filter(e => e.type === "response.output_item.added").length - 1, item: copy });
  }
  // 3. response.completed（Codex 等待的结束事件）
  events.push({ type: "response.completed", response: resp });
  return events.map(ev => "data: " + JSON.stringify(ev) + "\n\n").join("") + "data: [DONE]\n\n";
}


function safeModel(body, encoding = "") {
  try {
    const value = JSON.parse(decodedBody(body, encoding).toString("utf8"));
    return typeof value.model === "string" ? value.model : "";
  } catch {
    return "";
  }
}

function copyResponseHeaders(upstream, res) {
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (hopByHop.has(lower) || lower === "content-encoding") continue;
    res.setHeader(name, value);
  }
}

function safeHeaderLines(headers) {
  const lines = [];
  for (const [name, value] of headers) {
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(value)) {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

function parseCurlHeaders(text) {
  const blocks = text.split(/\r?\n\r?\n/).filter(Boolean);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const lines = blocks[index].split(/\r?\n/);
    const match = lines[0]?.match(/^HTTP\/\S+\s+(\d{3})/i);
    if (!match || Number(match[1]) < 200) continue;
    const headers = [];
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
    }
    return { status: Number(match[1]), headers };
  }
  return null;
}

async function proxyOpenAIWithNativeClient(upstreamUrl, headers, body, res) {
  const requestDir = fs.mkdtempSync(path.join(root, ".request-"));
  const headerInput = path.join(requestDir, "request.headers");
  const bodyInput = path.join(requestDir, "request.body");
  const headerOutput = path.join(requestDir, "response.headers");
  fs.writeFileSync(headerInput, safeHeaderLines(headers), { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(bodyInput, body, { mode: 0o600 });

  const forwarder = path.join(root, "rust-forwarder", "target", "release", "codex-openai-forwarder.exe");
  const args = [upstreamUrl.toString(), headerInput, bodyInput, headerOutput];
  const child = spawn(forwarder, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
  const cleanup = () => {
    try { fs.rmSync(requestDir, { recursive: true, force: true }); } catch {}
  };
  res.on("close", () => { if (!child.killed) child.kill(); });

  return await new Promise((resolve, reject) => {
    let connected = false;
    const connectResponse = () => {
      if (connected) return true;
      let parsed = null;
      try { parsed = parseCurlHeaders(fs.readFileSync(headerOutput, "utf8")); } catch {}
      if (!parsed) return false;
      connected = true;
      res.statusCode = parsed.status;
      if (parsed.status >= 300 && parsed.status < 400) {
        const location = parsed.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
        if (location) {
          const target = new URL(location, upstreamUrl);
          console.error(JSON.stringify({ event: "openai_redirect", target: `${target.origin}${target.pathname}` }));
        }
      }
      for (const [name, value] of parsed.headers) {
        const lower = name.toLowerCase();
        if (hopByHop.has(lower) || lower === "content-encoding" || lower === "content-length") continue;
        res.setHeader(name, value);
      }
      child.stdout.pipe(res);
      return true;
    };
    const timer = setInterval(connectResponse, 10);
    child.on("error", (error) => {
      clearInterval(timer); cleanup(); reject(error);
    });
    child.on("close", (code) => {
      clearInterval(timer);
      const didConnect = connectResponse();
      cleanup();
      if (code !== 0) reject(new Error(`OpenAI upstream transport failed (${code}): ${stderr.trim()}`));
      else if (!didConnect) reject(new Error("OpenAI upstream returned no HTTP response"));
      else resolve(res.statusCode);
    });
  });
}

async function proxy(req, res) {
  const started = Date.now();
  let route = "unknown";
  let model = "";
  try {
    const { valid, auth } = authenticate(req);
    if (!valid) return json(res, 401, { error: "Local router authentication failed" });

    const incomingBody = await readBody(req);
    const incomingEncoding = req.headers["content-encoding"] || "";
    model = safeModel(incomingBody, incomingEncoding);
    try {
      const dbg = JSON.parse(decodedBody(incomingBody, incomingEncoding).toString("utf8"));
      console.error(JSON.stringify({ event: "req_dump", model, keys: Object.keys(dbg), reasoning: dbg.reasoning, reasoning_effort: dbg.reasoning_effort, stream: dbg.stream, has_input: Array.isArray(dbg.input) ? dbg.input.length : typeof dbg.input }));
      if (Array.isArray(dbg.tools)) console.error(JSON.stringify({ event: "tools_dump", tools: JSON.stringify(dbg.tools).slice(0, 1500) }));
    } catch {}
    if (model && !model.startsWith("deepseek-")) {
      console.error(JSON.stringify({ event: "openai_request_headers", names: Object.keys(req.headers).sort() }));
    }
    if (!model) {
      let keys = [];
      try { keys = Object.keys(JSON.parse(decodedBody(incomingBody, incomingEncoding).toString("utf8"))); } catch {}
      console.error(JSON.stringify({
        event: "missing_model", method: req.method, path: req.url, keys,
        contentType: req.headers["content-type"] || "",
        contentEncoding: req.headers["content-encoding"] || "",
        bytes: incomingBody.length,
        prefixHex: incomingBody.subarray(0, 8).toString("hex"),
      }));
      return json(res, 400, { error: "Request model is missing" });
    }

    const isDeepSeek = model.startsWith("deepseek-");
    route = isDeepSeek ? "deepseek" : "openai";
    let body = incomingBody;
    let headers;
    let baseUrl;

    if (isDeepSeek) {
      const env = parseEnvFile(config.deepseekEnvFile);
      if (!env.AI_API_KEY) throw new Error("DeepSeek API key is unavailable");
      let parsed = {};
      try { parsed = JSON.parse(decodedBody(incomingBody, incomingEncoding).toString("utf8")); } catch {}
      const messages = convertResponsesToChat(parsed);
      // 透传 Codex 的 reasoning 参数；deepseek 需显式 thinking enabled 才有思考内容
      let reasoningEffort = parsed.reasoning?.effort || "high";
      if (reasoningEffort === "minimal") reasoningEffort = "low";
      const chatBody = {
        model: parsed.model || model,
        messages,
        stream: true,
        temperature: parsed.temperature,
        max_tokens: parsed.max_output_tokens || parsed.max_tokens,
        reasoning_effort: reasoningEffort,
        thinking: { type: "enabled" },
      };
      if (Array.isArray(parsed.tools)) {
        const tools = parsed.tools.filter((tt) => {
          if (tt?.type === "function") return true;
          const name = tt?.type || tt?.name || "";
          return name.toLowerCase() !== "exec";
        }).map((tt) => { if (tt?.type === "function") return tt; return { type: "function", function: { name: tt?.name || tt?.type || "function", description: "", parameters: { type: "object", properties: {} } } }; });
        if (tools.length) chatBody.tools = tools;
      }
      body = Buffer.from(JSON.stringify(chatBody));
      console.error(JSON.stringify({ event: "chat_body_dump", body: JSON.stringify(chatBody).slice(0, 1500) }));
      headers = deepSeekHeaders(env.AI_API_KEY, req.headers);
      baseUrl = "https://api.deepseek.com";
      req.url = "/v1/chat/completions";
      headers["content-type"] = "application/json";
      delete headers["openai-beta"];
    } else {
      headers = copyOpenAIHeaders(req.headers, auth);
      baseUrl = config.openaiBaseUrl;
    }

    const upstreamUrl = new URL(`${baseUrl.replace(/\/$/, "")}/${normalizedUpstreamPath(req.url).replace(/^\//, "")}`);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
    const status = upstream.status;
    if (route === "deepseek" && (status === 400 || status === 422)) {
      console.error(JSON.stringify({ event: "deepseek_error_body", status, body: body.toString("utf8").slice(0, 4000) }));
    }
    res.statusCode = upstream.status;
    if (route === "deepseek") {
      // deepseek 现在 stream:true（返回 SSE），需聚合为完整 JSON
      let rawText;
      try {
        const upstreamText = await upstream.text();
        const ctype = upstream.headers.get("content-type") || "";
        if (ctype.includes("text/event-stream") || upstreamText.includes("data: [DONE]") || upstreamText.includes("data: {") ) {
          // 聚合 SSE chunks → 完整 chat 响应
          rawText = JSON.stringify(aggregateDeepSeekSSE(upstreamText));
        } else {
          rawText = upstreamText;
        }
      } catch (e) {
        rawText = "{}";
        console.error(JSON.stringify({ event: "deepseek_stream_read_fail", error: e?.message || String(e) }));
      }
      try {
        const chatResp = JSON.parse(rawText);
        const resp = convertChatToResponses(chatResp, model);
        // 检测 Codex 是否请求流式（SSE）；是则返回 SSE 事件流
        let wantStream = false;
        try {
          const reqParsed = JSON.parse(decodedBody(incomingBody, incomingEncoding).toString("utf8"));
          wantStream = reqParsed.stream === true || reqParsed.stream === "true";
        } catch {}
        if (wantStream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(serializeResponsesSSE(resp, model));
          res.end();
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(resp));
        }
        console.log(JSON.stringify({ time: new Date().toISOString(), route, model, status, durationMs: Date.now() - started, converted: true, stream: wantStream }));
        return;
      } catch (e) {
        console.error(JSON.stringify({ event: "chat_convert_fail", error: e?.message || String(e) }));
        res.setHeader("content-type", "application/json");
        res.end(rawText);
        console.log(JSON.stringify({ time: new Date().toISOString(), route, model, status, durationMs: Date.now() - started, converted: false }));
        return;
      }
    }
    copyResponseHeaders(upstream, res);
    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body);
      stream.on("error", (err) => {
        console.error(JSON.stringify({ event: "upstream_stream_error", route, model, error: err?.message || String(err) }));
        if (!res.headersSent) res.destroy(err);
      });
      stream.pipe(res);
    } else {
      res.end();
    }
    console.log(JSON.stringify({
      time: new Date().toISOString(), route, model,
      status, durationMs: Date.now() - started,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      time: new Date().toISOString(), route, model,
      error: error?.message || "router failure", durationMs: Date.now() - started,
    }));
    if (!res.headersSent) json(res, 502, { error: "Unified model router failed" });
    else res.destroy();
  }
}

async function handleListModels(req, res, url) {
  try {
    const { valid, auth } = authenticate(req);
    if (!valid) return json(res, 401, { error: "Local router authentication failed" });
    const clientVersion = url.searchParams.get("client_version") || "0.146.0";
    // 本地 unified-models.json 是模型权威源（含官方 + deepseek，9 个）
    let localModels = [];
    try {
      const unifiedPath = path.join(root, "..", "unified-models.json");
      const unified = JSON.parse(fs.readFileSync(unifiedPath, "utf8"));
      localModels = Array.isArray(unified.models) ? unified.models : [];
    } catch {}
    const localSlugs = new Set(localModels.map((m) => m.slug));
    let merged = [...localModels];
    // 17841 桥在线时补充实时官方模型（去重）
    try {
      const upstreamUrl = new URL(`/v1/models?client_version=${encodeURIComponent(clientVersion)}`, `${config.openaiBaseUrl.replace(/\/$/, "")}/`);
      const upstream = await fetch(upstreamUrl, {
        headers: { authorization: `Bearer ${auth.accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (upstream.ok) {
        const data = await upstream.json();
        const openaiModels = Array.isArray(data?.models) ? data.models : [];
        const seen = new Set(localSlugs);
        merged = [...merged, ...openaiModels.filter((m) => !seen.has(m.slug))];
      }
    } catch (err) {
      // 17841 桥不可用：降级返回本地模型（deepseek 始终可见），不整体 502
      console.error(JSON.stringify({ event: "list_models_upstream_degraded", error: err?.message || "upstream unavailable" }));
    }
    return json(res, 200, { models: merged });
  } catch (error) {
    console.error(JSON.stringify({ event: "list_models_error", error: error?.message || "failed" }));
    return json(res, 502, { error: "Unified model router failed to list models" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { status: "ok", version: 1, routes: ["openai", "deepseek"] });
  }
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return handleListModels(req, res, url);
  }
  if (req.method === "GET" && url.pathname === "/routes") {
    return json(res, 200, {
      openai: "all non-deepseek model ids",
      deepseek: "deepseek-* model ids",
    });
  }
  if (req.method === "GET") return proxy(req, res);
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  // compact 本地模拟：返回合法 compaction 流（Codex 期待 SSE 流 + response.completed）
  if (url.pathname === "/v1/responses/compact" || url.pathname === "/responses/compact") {
    console.error(JSON.stringify({ event: "compact_request", url: req.url }));
    let reqBody = {};
    try { reqBody = JSON.parse((await readBody(req)).toString("utf8")); } catch {}
    const input = Array.isArray(reqBody.input) ? reqBody.input : [];
    const lastUser = [...input].reverse().find((it) => it?.role === "user");
    const retained = [];
    if (lastUser) {
      retained.push({ id: "msg_keep_" + Date.now(), type: "message", role: "user", status: "completed", content: lastUser.content || [{ type: "input_text", text: "（对话已压缩）" }] });
    }
    retained.push({ id: "cmp_" + Date.now(), type: "compaction", encrypted_content: Buffer.from("local-compaction-" + Date.now()).toString("base64") });
    const resp = { id: "resp_compact_" + Date.now(), object: "response.compaction", created_at: Math.floor(Date.now() / 1000), output: retained, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("data: " + JSON.stringify({ type: "response.completed", response: resp }) + "\n\n");
    res.write("data: [DONE]\n\n");
    return res.end();
  }
    return proxy(req, res);
});

server.on("upgrade", (req, socket) => {
  console.error(JSON.stringify({
    event: "websocket_upgrade", path: req.url,
    names: Object.keys(req.headers).sort(),
  }));
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
});

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.listen(config.listenPort, config.listenHost, () => {
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
  console.log(JSON.stringify({
    time: new Date().toISOString(), event: "started",
    host: config.listenHost, port: config.listenPort,
  }));
});

function shutdown() {
  server.close(() => {
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
