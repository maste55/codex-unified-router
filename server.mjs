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
    const allowed = new Set(["apply_patch", "web_search", "function"]);
    value.tools = value.tools.filter((tool) => {
      const name = tool?.type === "function" ? tool?.function?.name : tool?.type || tool?.name;
      return name && allowed.has(String(name).toLowerCase());
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
    if (m.reasoning_content) output.push({ type: "reasoning", id: "rs_" + Date.now(), status: "completed", summary: [{ type: "summary_text", text: String(m.reasoning_content).slice(0, 500) }], content: [{ type: "reasoning_text", text: String(m.reasoning_content) }] });
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) output.push({ type: "function_call", id: tc.id || ("call_" + Date.now()), call_id: tc.id || ("call_" + Date.now()), name: tc.function?.name || "function", arguments: tc.function?.arguments || "{}", status: "completed" });
    const contentText = typeof m.content === "string" ? m.content : "";
    if (contentText) output.push({ type: "message", id: "msg_" + Date.now(), role: "assistant", status: "completed", content: [{ type: "output_text", text: contentText, annotations: [] }] });
  }
  return { id: chatBody?.id || ("resp_" + Date.now()), object: "response", created_at: chatBody?.created || Math.floor(Date.now() / 1000), status: "completed", model: model || chatBody?.model || "", output, usage: chatBody?.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
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
      const chatBody = { model: parsed.model || model, messages, stream: false, temperature: parsed.temperature, max_tokens: parsed.max_output_tokens || parsed.max_tokens };
      if (Array.isArray(parsed.tools)) {
        const allowed = new Set(["apply_patch", "web_search", "function"]);
        const tools = parsed.tools.filter((tt) => { const name = tt?.type === "function" ? tt?.function?.name : tt?.type || tt?.name; return name && allowed.has(String(name).toLowerCase()); }).map((tt) => { if (tt?.type === "function") return tt; return { type: "function", function: { name: tt?.name || tt?.type || "function", description: "", parameters: { type: "object", properties: {} } } }; });
        if (tools.length) chatBody.tools = tools;
      }
      body = Buffer.from(JSON.stringify(chatBody));
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
      const rawText = await upstream.text();
      try {
        const chatResp = JSON.parse(rawText);
        const resp = convertChatToResponses(chatResp, model);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(resp));
        console.log(JSON.stringify({ time: new Date().toISOString(), route, model, status, durationMs: Date.now() - started, converted: true }));
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
