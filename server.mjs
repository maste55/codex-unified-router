import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import { zstdDecompressSync } from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
// 面板安全：token 复用已有文件（多进程不互相覆盖）+ 同源校验
const PANEL_TOKEN_FILE = path.join(root, "panel-token.txt");
let PANEL_TOKEN = "";
try { PANEL_TOKEN = fs.readFileSync(PANEL_TOKEN_FILE, "utf8").trim(); } catch {}
if (!PANEL_TOKEN) {
  PANEL_TOKEN = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(PANEL_TOKEN_FILE, PANEL_TOKEN, { mode: 0o600 });
}

function panelAuthOk(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  const origin = req.headers.origin || "";
  // 同源校验：允许无 Origin（同标签页 fetch）或 127.0.0.1:4791
  if (origin && !/^http:\/\/127\.0\.0\.1:4791$/.test(origin)) return false;
  // token 校验：query 参数或 header
  const qToken = url.searchParams.get("token");
  const hToken = req.headers["x-panel-token"];
  return qToken === PANEL_TOKEN || hToken === PANEL_TOKEN;
}

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

// opencode-go 路由辅助：读本地 opencode auth.json 的 key
function extractApiKey(value) {
  // opencode auth.json 格式：{"type":"api","key":"sk-..."} 或直接字符串
  if (typeof value === "string") return value.length > 10 ? value : "";
  if (value && typeof value === "object") {
    const k = value.key || value.apiKey || value.token;
    if (typeof k === "string" && k.length > 10) return k;
  }
  return "";
}

function loadOpencodeGoKey() {
  // 优先 keyman vault
  const k = loadKeymanKey("opencode:opencode-go") || loadKeymanKey("opencode:opencode") || loadKeymanKey("opencode-go");
  if (k) return k;
  const candidates = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), ".config", "opencode", "auth.json"),
  ];
  for (const f of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      const key = extractApiKey(data?.["opencode-go"])
        || extractApiKey(data?.["opencode"])
        || extractApiKey(data?.["opencode_go"]);
      if (key) return key;
    } catch {}
  }
  // 环境变量兜底
  return process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY || "";
}

function opencodeGoHeaders(apiKey, source) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value == null || hopByHop.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.delete("chatgpt-account-id");
  headers.delete("openai-project");
  headers.delete("openai-organization");
  // body 已被 decodedBody 解压成明文，不能再带 content-encoding（否则上游解析失败）
  headers.delete("content-encoding");
  return headers;
}

// keyman vault 读取：~/.codex/keyman/vault.json（DPAPI 加密）
const KEYMAN_VAULT = path.join(os.homedir(), ".codex", "keyman", "vault.json");
function keymanDecrypt(enc) {
  try {
    const ps = `
Add-Type -AssemblyName System.Security;
$enc = [Convert]::FromBase64String($env:KM_ENC);
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[System.Text.Encoding]::UTF8.GetString($bytes)`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      env: { ...process.env, KM_ENC: enc },
      encoding: "utf8", windowsHide: true,
    });
    return out.trim();
  } catch { return ""; }
}
function loadKeymanKey(name) {
  try {
    const vault = JSON.parse(fs.readFileSync(KEYMAN_VAULT, "utf8"));
    const entry = vault?.keys?.[name];
    if (entry?.enc) return keymanDecrypt(entry.enc);
  } catch {}
  return "";
}
// DashScope key：从 opencode auth.json 的 qwen 字段读
function loadDashScopeKey() {
  // 优先 keyman vault
  const k = loadKeymanKey("opencode:qwen") || loadKeymanKey("env:DASHSCOPE_API_KEY") || loadKeymanKey("dashscope");
  if (k) return k;
  const candidates = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), ".config", "opencode", "auth.json"),
  ];
  for (const f of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      const key = extractApiKey(data?.["qwen"]) || extractApiKey(data?.["dashscope"]);
      if (key) return key;
    } catch {}
  }
  return process.env.DASHSCOPE_API_KEY || "";
}

// opencode-go body 清洗：模型名去前缀 + 转换 responses 格式为 chat/completions
function sanitizeOpencodeGoBody(body, encoding = "") {
  try {
    const parsed = JSON.parse(decodedBody(body, encoding).toString("utf8"));
    if (parsed.model) {
      // 去掉所有网关前缀（opencode-go/、qwen-dashscope/、dashscope/ 等）
      parsed.model = String(parsed.model)
        .replace(/^opencode-go\//, "")
        .replace(/^opencode-go:/, "")
        .replace(/^qwen-dashscope\//, "")
        .replace(/^qwen-dashscope:/, "")
        .replace(/^dashscope\//, "");
    }
    // 若请求是 responses 格式，转成 chat/completions 格式
    if (Array.isArray(parsed.input) && !parsed.messages) {
      const messages = [];
      for (const item of parsed.input) {
        if (item?.role === "user") {
          const text = (item.content || []).map((c) => c?.text || "").join("") || String(item.content || "");
          messages.push({ role: "user", content: text });
        } else if (item?.role === "assistant") {
          messages.push({ role: "assistant", content: (item.content || []).map((c) => c?.text || "").join("") || "" });
        }
      }
      if (messages.length) {
        parsed.messages = messages;
        parsed.stream = parsed.stream === true;
        delete parsed.input;
        delete parsed.instructions;
        delete parsed.tools;
        delete parsed.tool_choice;
        delete parsed.parallel_tool_calls;
        delete parsed.reasoning;
        delete parsed.store;
        if (!parsed.max_tokens) delete parsed.max_output_tokens;
      }
    }
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return body;
  }
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
  try {
    const value = JSON.parse(decodedBody(body, encoding).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      delete value.service_tier;
    }
    return Buffer.from(JSON.stringify(value));
  } catch {
    return body;
  }
}

function imageToText(imagePath) {
  const script = "<你的技能目录>/scripts/vlm-vision.ps1";
  const prompt =
    "请完整、逐行描述这张图片的内容：包括所有文字（逐字提取）、数字、表格、图表、界面元素、布局与颜色，按从上到下、从左到右的顺序输出，不要遗漏，不要解读，只输出观察到的内容。";
  // 优先本地视觉（Ollama qwen2.5vl，离线可用），失败再降级 GLM 云端
  const attempts = [
    { channel: "local", apiKey: "ollama", timeoutMs: 200000 },
    { channel: "glm", apiKey: "", timeoutMs: 120000 },
  ];
  let lastErr = "";
  for (const a of attempts) {
    try {
      const args = [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
        "-ImagePath", imagePath, "-Prompt", prompt,
        "-Channel", a.channel, "-Json", "-TimeoutSec", String(Math.floor(a.timeoutMs / 1000)),
      ];
      if (a.apiKey) args.push("-ApiKey", a.apiKey);
      const out = execFileSync("powershell.exe", args, {
        encoding: "utf8", timeout: a.timeoutMs + 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      });
      const j = JSON.parse(out);
      const text = j && (j.result || j.content);
      if (text && String(text).trim()) return String(text).trim();
      lastErr = `${a.channel}: empty result`;
    } catch (e) {
      lastErr = `${a.channel}: ${String((e && e.message) || e).slice(0, 160)}`;
    }
  }
  return `[图片读取失败: ${lastErr}]`;
}

function convertImagesToText(bodyBuffer) {
  let value;
  try {
    value = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return bodyBuffer;
  }
  let changed = false;
  const convertItem = (item) => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "input_image" || item.type === "image_url") {
      const dataUrl = typeof item.image_url === "string" ? item.image_url : (item.image_url && item.image_url.url);
      let desc = "[图片无法读取：不是本地 base64 图片]";
      let file = null;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image")) {
        const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
        if (m) {
          const ext = m[1] === "jpeg" ? "jpg" : m[1];
          file = path.join(os.tmpdir(), `router-vision-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
          fs.writeFileSync(file, Buffer.from(m[2], "base64"));
        }
      }
      if (file) {
        try {
          desc = imageToText(file);
        } catch (e) {
          desc = `[图片读取失败: ${String((e && e.message) || e).slice(0, 200)}]`;
        } finally {
          try { fs.unlinkSync(file); } catch {}
        }
      }
      changed = true;
      return { type: "input_text", text: `[用户附带的图片，已由视觉模型(GLM-4V)转为文字]
${desc}` };
    }
    if (Array.isArray(item.content)) {
      item.content = item.content.map(convertItem);
    }
    return item;
  };
  if (Array.isArray(value.input)) value.input = value.input.map(convertItem);
  if (Array.isArray(value.messages)) value.messages = value.messages.map(convertItem);
  if (!changed) return bodyBuffer;
  return Buffer.from(JSON.stringify(value));
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
    const isOpencodeGo = model.startsWith("opencode-go/") || model.startsWith("opencode-go:") || model.startsWith("opencode-");
    const isDashScope = model.startsWith("qwen-dashscope/") || model.startsWith("qwen-dashscope:");
    route = isDeepSeek ? "deepseek" : (isOpencodeGo ? "opencode-go" : (isDashScope ? "dashscope" : "openai"));
    let body = incomingBody;
    let headers;
    let baseUrl;

    if (isDeepSeek) {
      let dsKey = loadKeymanKey("opencode:deepseek") || loadKeymanKey("env:DEEPSEEK_API_KEY") || loadKeymanKey("deepseek");
      if (!dsKey) {
        const env = parseEnvFile(config.deepseekEnvFile);
        dsKey = env.AI_API_KEY || "";
      }
      if (!dsKey) throw new Error("DeepSeek API key is unavailable");
      body = sanitizeDeepSeekBody(incomingBody, incomingEncoding);
      body = convertImagesToText(body);
      headers = deepSeekHeaders(dsKey, req.headers);
      baseUrl = config.deepseekBaseUrl;
    } else if (isOpencodeGo) {
      const goKey = loadOpencodeGoKey();
      if (!goKey) throw new Error("Opencode Go API key is unavailable (check ~/.local/share/opencode/auth.json)");
      headers = opencodeGoHeaders(goKey, req.headers);
      baseUrl = config.opencodeGoBaseUrl || "https://opencode.ai/zen/go/v1";
      // opencode-go 端点只接受 chat/completions + 无前缀模型名
      body = sanitizeOpencodeGoBody(incomingBody, incomingEncoding);
      req.routerPathOverride = "chat/completions";
    } else if (isDashScope) {
      const dsKey = loadDashScopeKey();
      if (!dsKey) throw new Error("DashScope API key is unavailable (check ~/.local/share/opencode/auth.json qwen)");
      headers = opencodeGoHeaders(dsKey, req.headers);
      baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
      body = sanitizeOpencodeGoBody(incomingBody, incomingEncoding);
      req.routerPathOverride = "chat/completions";
    } else {
      headers = copyOpenAIHeaders(req.headers, auth);
      baseUrl = config.openaiBaseUrl;
    }

    const upstreamPath = req.routerPathOverride || normalizedUpstreamPath(req.url).replace(/^\//, "");
    const upstreamUrl = new URL(`${baseUrl.replace(/\/$/, "")}/${upstreamPath}`);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
    const status = upstream.status;
    res.statusCode = upstream.status;
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

// ===== 模型可见性面板 + Codex catalog 生成 =====
const VISIBILITY_FILE = path.join(root, "model-visibility.json");
const CATALOG_FILE = path.join(os.homedir(), ".codex", "unified-models-catalog.json");

function loadVisibility() {
  try { return JSON.parse(fs.readFileSync(VISIBILITY_FILE, "utf8")); }
  catch { return {}; }
}
function saveVisibility(v) {
  fs.mkdirSync(path.dirname(VISIBILITY_FILE), { recursive: true });
  fs.writeFileSync(VISIBILITY_FILE, JSON.stringify(v, null, 2));
}
function isVisible(slug) {
  const v = loadVisibility();
  if (slug in v) return v[slug] !== false;
  return true; // 默认可见
}

// 判断模型是否支持图片输入（视觉能力）
function modelSupportsImage(slug) {
  // 官方 ChatGPT 模型：sol/terra/luna/5.5/5.4 全系支持图片（models_cache 确认）
  if (/^gpt-5\./.test(slug)) return true;
  // DashScope 多模态：qwen3.x 全系（官方文档：文本+图像+视频）
  if (slug.startsWith("qwen-dashscope/") && /qwen3[.\d-]/.test(slug)) return true;
  // DashScope 聚合的多模态模型
  if (slug.startsWith("qwen-dashscope/kimi/kimi-k3")) return true;
  if (slug.startsWith("qwen-dashscope/glm-5")) return true;
  if (slug.startsWith("qwen-dashscope/MiniMax/MiniMax-M3")) return true;
  // opencode-go 明确 multimodal 的模型
  if (slug.startsWith("opencode-go/grok-4.5")) return true;
  if (slug.startsWith("opencode-go/gpt-5.6-luna")) return true;
  if (slug.startsWith("opencode-go/qwen3")) return true;
  if (slug.startsWith("opencode-go/kimi-k3")) return true;
  if (slug.startsWith("opencode-go/kimi-k2.7-code")) return true;
  if (slug.startsWith("opencode-go/glm-5")) return true;
  if (slug.startsWith("opencode-go/mimo-v2.5")) return true;
  // 其他默认文本
  return false;
}

// 生成 Codex 兼容格式 catalog（unified-models-catalog.json）
function buildCatalogModel(slug, um, ctx) {
  return {
    slug,
    display_name: um.display_name || slug,
    description: um.description || "",
    default_reasoning_level: um.default_reasoning_level || "medium",
    supported_reasoning_levels: um.supported_reasoning_levels || [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 10,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    model_messages: {},
    include_skills_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: ctx,
    max_context_window: ctx,
    comp_hash: "3000",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: modelSupportsImage(slug) ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
  };
}

// 从 unified-models.json 生成 catalog（仅可见模型）
function regenerateCatalog() {
  try {
    const unifiedPath = path.join(root, "..", "unified-models.json");
    const unified = JSON.parse(fs.readFileSync(unifiedPath, "utf8"));
    const models = (unified.models || []).filter((m) => m.slug && isVisible(m.slug));
    const catalog = models.map((m) => {
      const ctx = m.slug.startsWith("opencode-go") ? 128000 : 64000;
      return buildCatalogModel(m.slug, m, ctx);
    });
    const out = { fetched_at: Date.now(), client_version: "0.146.0", models: catalog };
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ event: "catalog_regenerated", models: catalog.length, file: CATALOG_FILE }));
    return catalog.length;
  } catch (e) {
    console.error(JSON.stringify({ event: "catalog_generate_error", error: e?.message || String(e) }));
    return 0;
  }
}

// 面板 API：模型列表 + 开关状态
async function handlePanelModels(req, res) {
  try {
    const unifiedPath = path.join(root, "..", "unified-models.json");
    const unified = JSON.parse(fs.readFileSync(unifiedPath, "utf8"));
    const vis = loadVisibility();
    const models = (unified.models || []).map((m) => ({
      slug: m.slug,
      display_name: m.display_name || m.slug,
      description: m.description || "",
      enabled: vis[m.slug] !== false,
      vision: modelSupportsImage(m.slug),
    }));
    return json(res, 200, { models });
  } catch (e) {
    return json(res, 500, { error: e?.message || "failed" });
  }
}

async function handlePanelToggle(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const { slug, enabled } = body;
    if (!slug) return json(res, 400, { error: "slug required" });
    const vis = loadVisibility();
    vis[slug] = enabled === true;
    saveVisibility(vis);
    const count = regenerateCatalog(); // 自动重新生成 Codex catalog
    return json(res, 200, { slug, enabled: vis[slug], catalog_models: count });
  } catch (e) {
    return json(res, 500, { error: e?.message || "failed" });
  }
}

// ===== Key 管理 API（复用 keyman vault，DPAPI 加密）=====
const KEYMAN_VAULT_FILE = path.join(os.homedir(), ".codex", "keyman", "vault.json");

function loadKeyVault() {
  try { return JSON.parse(fs.readFileSync(KEYMAN_VAULT_FILE, "utf8")); }
  catch { return { version: 1, keys: {} }; }
}
function saveKeyVault(v) {
  fs.mkdirSync(path.dirname(KEYMAN_VAULT_FILE), { recursive: true });
  fs.writeFileSync(KEYMAN_VAULT_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function dpapiProtectForPanel(plain) {
  try {
    const ps = `
Add-Type -AssemblyName System.Security;
$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:KM_PLAIN);
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Convert]::ToBase64String($enc)`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      env: { ...process.env, KM_PLAIN: plain }, encoding: "utf8", windowsHide: true,
    });
    return out.trim();
  } catch { return ""; }
}
// DPAPI 加密且校验非空（返回 true 表示成功）
function dpapiProtectChecked(plain) {
  const enc = dpapiProtectForPanel(plain);
  return enc && enc.length > 10 ? enc : "";
}
function maskKeyForPanel(k) {
  if (!k || k.length < 8) return "***";
  return k.slice(0, 6) + "..." + k.slice(-4);
}

// Key 友好名称与分组（人性化）
const KEY_GROUPS = [
  { id: "opencode-go", label: "opencode-go 订阅", icon: "🚀", match: ["opencode:opencode-go", "opencode:opencode"], renewUrl: "https://opencode.ai/go", renewLabel: "续费/订阅", typeNote: "按月订阅" },
  { id: "dashscope", label: "阿里云 DashScope", icon: "☁️", match: ["opencode:qwen", "env:DASHSCOPE_API_KEY"], renewUrl: "https://bailian.console.aliyun.com/", renewLabel: "百炼控制台", typeNote: "百炼 token / 普通" },
  { id: "deepseek", label: "DeepSeek", icon: "🧠", match: ["opencode:deepseek", "opencode:deepseek1", "env:DEEPSEEK_API_KEY"], renewUrl: "https://platform.deepseek.com/top_up", renewLabel: "充值", typeNote: "按量付费" },
  { id: "chatgpt", label: "ChatGPT 官方", icon: "💬", match: ["codex:chatgpt-access-token"], renewUrl: "https://chatgpt.com/", renewLabel: "登录", typeNote: "账号登录" },
  { id: "other", label: "其他", icon: "🔧", match: [], renewUrl: "", renewLabel: "", typeNote: "" },
];
function friendlyKeyName(name) {
  const map = {
    "opencode:opencode-go": "opencode-go 订阅",
    "opencode:opencode": "opencode-go 订阅",
    "opencode:qwen": "阿里云 DashScope",
    "env:DASHSCOPE_API_KEY": "阿里云 DashScope",
    "opencode:deepseek": "DeepSeek",
    "opencode:deepseek1": "DeepSeek",
    "env:DEEPSEEK_API_KEY": "DeepSeek",
    "codex:chatgpt-access-token": "ChatGPT 官方",
  };
  return map[name] || name;
}
function keyGroupOf(name) {
  for (const g of KEY_GROUPS) {
    if (g.match.includes(name)) return g.id;
  }
  return "other";
}

async function handleKeysList(req, res) {
  try {
    const vault = loadKeyVault();
    const keys = Object.keys(vault.keys || {}).sort().map((name) => {
      const e = vault.keys[name];
      let masked = "***";
      try { masked = maskKeyForPanel(keymanDecrypt(e.enc)); } catch {}
      let typeTag = "";
      if (name === "opencode:qwen") typeTag = "百炼 token";
      else if (name === "env:DASHSCOPE_API_KEY") typeTag = "环境变量";
      else if (name === "opencode:deepseek" || name === "opencode:deepseek1") typeTag = "API key";
      return { name, display: friendlyKeyName(name), group: keyGroupOf(name), desc: e.desc || "", masked, typeTag, updated: e.updated || e.created || "" };
    });
    return json(res, 200, { keys, groups: KEY_GROUPS });
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

async function handleKeysAdd(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const { name, key, desc, keepKey } = body;
    if (!name) return json(res, 400, { error: "name required" });
    const vault = loadKeyVault();
    const existing = vault.keys?.[name];
    // 编辑模式：keepKey=true 且 key 为空 → 保留原 key 只更新 desc
    if (keepKey && !key && existing) {
      existing.desc = desc || existing.desc || "";
      existing.updated = new Date().toISOString();
      saveKeyVault(vault);
      console.log(JSON.stringify({ event: "key_updated_desc", name }));
      return json(res, 200, { ok: true, name, masked: maskKeyForPanel(keymanDecrypt(existing.enc)) });
    }
    if (!key) return json(res, 400, { error: "key required (or use keepKey to update desc only)" });
    const enc = dpapiProtectChecked(key);
    if (!enc) return json(res, 500, { error: "DPAPI encryption failed" });
    vault.keys[name] = {
      enc: enc,
      desc: desc || "",
      created: existing?.created || new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    saveKeyVault(vault);
    console.log(JSON.stringify({ event: "key_added", name }));
    return json(res, 200, { ok: true, name, masked: maskKeyForPanel(key) });
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

// 测试 key：根据名称推断 provider 并实际调端点验证
async function handleKeysTest(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const name = body.name || "";
    const vault = loadKeyVault();
    const entry = vault.keys?.[name];
    if (!entry) return json(res, 404, { error: "key not found" });
    const key = keymanDecrypt(entry.enc);
    let url = "", headers = { authorization: "Bearer " + key }, label = "";
    if (name === "opencode:opencode-go" || name === "opencode:opencode") {
      url = "https://opencode.ai/zen/go/v1/models";
      label = "opencode-go";
    } else if (name === "opencode:qwen" || name === "env:DASHSCOPE_API_KEY") {
      url = "https://dashscope.aliyuncs.com/compatible-mode/v1/models";
      label = "DashScope";
    } else if (name.startsWith("opencode:deepseek")) {
      url = "https://api.deepseek.com/models";
      label = "DeepSeek";
    } else if (name.startsWith("codex:")) {
      url = "https://chatgpt.com/backend-api/codex/models?client_version=0.146.0";
      label = "ChatGPT";
      const acct = key.startsWith("eyJ") ? "1033af47-f84a-4c91-9094-e5eb3148ba32" : "";
      if (acct) headers["chatgpt-account-id"] = acct;
    } else {
      // 其他（GLM/NOCOBASE/TAVILY 等）默认测试 dashscope 端点
      url = "https://dashscope.aliyuncs.com/compatible-mode/v1/models";
      label = "unknown";
    }
    const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    let detail = "";
    if (upstream.ok) detail = "连通正常";
    else { try { const t = await upstream.text(); detail = t.slice(0, 120); } catch {} }
    return json(res, upstream.ok ? 200 : 502, { ok: upstream.ok, label, status: upstream.status, detail });
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

async function handleKeysRemove(req, res) {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const name = url.searchParams.get("name");
    if (!name) return json(res, 400, { error: "name required" });
    const vault = loadKeyVault();
    if (vault.keys?.[name]) {
      delete vault.keys[name];
      saveKeyVault(vault);
      console.log(JSON.stringify({ event: "key_removed", name }));
      return json(res, 200, { ok: true, name });
    }
    return json(res, 404, { error: "key not found: " + name });
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

// ===== 程序状态 API =====
function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1000 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

async function handleSystemStatus(req, res) {
  try {
    const [bridge, ollama] = await Promise.all([portListening(17841), portListening(11434)]);
    const vault = loadKeyVault();
    const vis = loadVisibility();
    const unified = JSON.parse(fs.readFileSync(path.join(root, "..", "unified-models.json"), "utf8"));
    const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")).models || [];
    return json(res, 200, {
      router: { port: config.listenPort, pid: process.pid, up: true },
      bridge: { port: 17841, up: bridge },
      ollama: { port: 11434, up: ollama },
      keys: Object.keys(vault.keys || {}).length,
      models: { total: (unified.models || []).length, visible: (unified.models || []).filter((m) => vis[m.slug] !== false).length, catalog: catalog.length },
      pid_file: pidFile,
    });
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

// 修复 Codex 对话框丢失：确保 CODEX_HOME 指向真实 ~/.codex + 报告会话健康
async function handleFixSessions(req, res) {
  try {
    const realHome = path.join(os.homedir(), ".codex");
    const results = {};
    // 1. 设置用户级 CODEX_HOME（持久化）
    try {
      const ps = `[System.Environment]::SetEnvironmentVariable('CODEX_HOME', '${realHome.replace(/\\/g, "\\\\")}', 'User')`;
      execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true });
      results.codex_home_set = true;
      results.codex_home = realHome;
    } catch (e) {
      results.codex_home_set = false;
      results.codex_home_error = e?.message || String(e);
    }
    // 2. 检查会话文件与索引健康
    const sessionsDir = path.join(realHome, "sessions");
    let sessionFiles = 0;
    try {
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) walk(fp);
          else if (f.name.endsWith(".jsonl")) sessionFiles++;
        }
      };
      walk(sessionsDir);
      results.session_files = sessionFiles;
    } catch (e) { results.session_files = -1; results.session_error = e?.message; }
    // 3. 索引行数
    try {
      const idx = path.join(realHome, "session_index.jsonl");
      results.session_index = fs.existsSync(idx) ? fs.readFileSync(idx, "utf8").split("\n").filter(Boolean).length : 0;
    } catch { results.session_index = 0; }
    results.healthy = results.session_files > 0 && results.codex_home_set;
    return json(res, 200, results);
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

async function handleSystemRestart(req, res) {
  try {
    json(res, 200, { ok: true, message: "restarting router..." });
    setTimeout(() => {
      try { fs.unlinkSync(pidFile); } catch {}
      process.exit(0);
    }, 300);
    // watchdog 会在 2 秒内自动拉起新进程
  } catch (e) { return json(res, 500, { error: e?.message || "failed" }); }
}

// 面板 HTML：读取独立文件 panel.html（与 server.mjs 同目录）
const PANEL_FILE = path.join(root, "panel.html");
function servePanel(res) {
  try {
    const html = fs.readFileSync(PANEL_FILE, "utf8")
      .replace("__PANEL_TOKEN__", PANEL_TOKEN);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("panel.html 未找到: " + e.message);
  }
}

async function handleListModels(req, res, url) {
  try {
    const { valid, auth } = authenticate(req);
    if (!valid) return json(res, 401, { error: "Local router authentication failed" });
    const clientVersion = url.searchParams.get("client_version") || "0.146.0";
    const upstreamUrl = new URL(`/v1/models?client_version=${encodeURIComponent(clientVersion)}`, `${config.openaiBaseUrl.replace(/\/$/, "")}/`);
    let openaiModels = [];
    try {
      const upstream = await fetch(upstreamUrl, {
        headers: { authorization: `Bearer ${auth.accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(60000),
      });
      if (upstream.ok) {
        const data = await upstream.json();
        openaiModels = Array.isArray(data?.models) ? data.models : [];
      } else {
        console.error(JSON.stringify({ event: "list_models_upstream_unavailable", status: upstream.status }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "list_models_upstream_unavailable", error: error?.message || "failed" }));
    }
    // 合并 deepseek + opencode-go 模型（从 unified-models.json 读取）
    let extraModels = [];
    try {
      const unifiedPath = path.join(root, "..", "unified-models.json");
      const unified = JSON.parse(fs.readFileSync(unifiedPath, "utf8"));
      extraModels = (unified.models || []).filter(
        (m) => m.slug && (
          m.slug.startsWith("deepseek-")
          || m.slug.startsWith("opencode-")
          || m.slug.startsWith("qwen-dashscope")
        )
      );
    } catch {}
    const seen = new Set(openaiModels.map((m) => m.slug));
    const merged = [...openaiModels.filter((m) => isVisible(m.slug)), ...extraModels.filter((m) => !seen.has(m.slug) && isVisible(m.slug))];
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
  // 面板端点（全部需要 token 认证）
  if (req.method === "GET" && (url.pathname === "/panel/api/models" || url.pathname === "/panel/api/keys" || url.pathname === "/panel/api/system")) {
    if (!panelAuthOk(req)) return json(res, 401, { error: "Unauthorized" });
  }
  if (req.method === "POST" && (url.pathname === "/panel/api/toggle" || url.pathname === "/panel/api/keys" || url.pathname === "/panel/api/keys/test" || url.pathname === "/panel/api/system/restart" || url.pathname === "/panel/api/fix-sessions")) {
    if (!panelAuthOk(req)) return json(res, 401, { error: "Unauthorized" });
  }
  if (req.method === "DELETE" && url.pathname === "/panel/api/keys") {
    if (!panelAuthOk(req)) return json(res, 401, { error: "Unauthorized" });
  }
  // 面板端点
  if (req.method === "GET" && url.pathname === "/panel/api/models") {
    return handlePanelModels(req, res);
  }
  if (req.method === "POST" && url.pathname === "/panel/api/toggle") {
    return handlePanelToggle(req, res);
  }
  // Key 管理端点
  if (req.method === "GET" && url.pathname === "/panel/api/keys") {
    return handleKeysList(req, res);
  }
  if (req.method === "POST" && url.pathname === "/panel/api/keys") {
    return handleKeysAdd(req, res);
  }
  if (req.method === "DELETE" && url.pathname === "/panel/api/keys") {
    return handleKeysRemove(req, res);
  }
  if (req.method === "POST" && url.pathname === "/panel/api/keys/test") {
    return handleKeysTest(req, res);
  }
  // 程序状态端点
  if (req.method === "GET" && url.pathname === "/panel/api/system") {
    return handleSystemStatus(req, res);
  }
  if (req.method === "POST" && url.pathname === "/panel/api/system/restart") {
    return handleSystemRestart(req, res);
  }
  if (req.method === "POST" && url.pathname === "/panel/api/fix-sessions") {
    return handleFixSessions(req, res);
  }
  if (req.method === "GET" && url.pathname === "/panel" || req.method === "GET" && url.pathname === "/panel/") {
    return servePanel(res);
  }
  if (req.method === "GET" && url.pathname === "/routes") {
    return json(res, 200, {
      openai: "all non-deepseek model ids",
      deepseek: "deepseek-* model ids",
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
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
  try { regenerateCatalog(); } catch {}
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
