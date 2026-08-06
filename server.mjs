import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
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
    const out = _execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
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
  const value = JSON.parse(decodedBody(body, encoding).toString("utf8"));
  delete value.service_tier;
  return Buffer.from(JSON.stringify(value));
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
    input_modalities: ["text"],
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

// 面板 HTML：读取独立文件 panel.html（与 server.mjs 同目录）
const PANEL_FILE = path.join(root, "panel.html");
function servePanel(res) {
  try {
    const html = fs.readFileSync(PANEL_FILE, "utf8");
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
  // 面板端点
  if (req.method === "GET" && url.pathname === "/panel/api/models") {
    return handlePanelModels(req, res);
  }
  if (req.method === "POST" && url.pathname === "/panel/api/toggle") {
    return handlePanelToggle(req, res);
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
