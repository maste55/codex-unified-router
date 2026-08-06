#!/usr/bin/env node
/**
 * codex-bridge.mjs — 狗主人独立桥（替代 codex-chatgpt-web）
 *
 * 功能：OpenAI 兼容代理，转发 Codex 官方模型请求到 ChatGPT backend-api。
 * - GET  /v1/models            → 从 unified-models.json 返回官方模型列表
 * - POST /v1/responses         → 转发到 chatgpt.com/backend-api/codex/responses（SSE 透传）
 * - POST /v1/responses/compact → 转发压缩请求
 * - GET  /healthz              → 健康检查
 *
 * 鉴权：读 ~/.codex/auth.json 的 access_token + account_id。
 * 零第三方依赖，仅用 Node 内置 http/fetch（Node ≥ 18）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const CODEX_HOME = path.join(HOME, ".codex");
const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
const UNIFIED_MODELS = path.join(CODEX_HOME, "unified-models.json");
const UPSTREAM = "https://chatgpt.com";
const PORT = Number(process.env.BRIDGE_PORT || 17841);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";

// 多模型辅助：responses input 转 chat messages
function convertInputToMessages(body) {
  const msgs = [];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.role === "user") {
        const text = (item.content || []).map((c) => c?.text || "").join("") || String(item.content || "");
        msgs.push({ role: "user", content: text });
      } else if (item?.role === "assistant") {
        const text = (item.content || []).map((c) => c?.text || "").join("") || "";
        if (text) msgs.push({ role: "assistant", content: text });
      }
    }
  }
  return msgs;
}
// 过滤工具：只保留 apply_patch（deepseek/dashscope 等上游不支持 exec/web_search 等自定义工具）
function filterTools(body) {
  if (Array.isArray(body.tools)) {
    // 只保留 apply_patch，并转成 deepseek/OpenAI responses 兼容格式（name 在顶层）
    const kept = body.tools.filter((tool) => {
      const name = typeof tool === "string" ? tool : (tool?.function?.name || tool?.name || "");
      return name === "apply_patch";
    });
    body.tools = kept.map((tool) => {
      if (typeof tool === "string") return { type: "function", name: tool, parameters: { type: "object", properties: {} } };
      if (tool?.function?.name) {
        return { type: "function", name: tool.function.name, parameters: tool.function.parameters || { type: "object", properties: {} } };
      }
      return tool;
    });
  }
  if (body.tool_choice && (!body.tools || body.tools.length === 0)) {
    delete body.tool_choice;
  }
  return body;
}

function loadOpencodeGoKey() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
    const v = data?.["opencode-go"] || data?.["opencode"];
    if (v && typeof v === "object" && v.key) return v.key;
    if (typeof v === "string") return v;
  } catch {}
  return process.env.OPENCODE_GO_API_KEY || "";
}
function loadDashScopeKey() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
    const v = data?.["qwen"];
    if (v && typeof v === "object" && v.key) return v.key;
    if (typeof v === "string") return v;
  } catch {}
  return process.env.DASHSCOPE_API_KEY || "";
}
function loadKeymanKey(name) {
  try {
    const vault = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "keyman", "vault.json"), "utf8"));
    const entry = vault?.keys?.[name];
    if (entry?.enc) {
      const ps = `
Add-Type -AssemblyName System.Security;
$enc = [Convert]::FromBase64String($env:KM_ENC);
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[System.Text.Encoding]::UTF8.GetString($bytes)`;
      return execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { env: { ...process.env, KM_ENC: entry.enc }, encoding: "utf8" }).trim();
    }
  } catch {}
  return "";
}

function loadAuth() {
  const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  const at = data?.tokens?.access_token;
  const acct = data?.tokens?.account_id;
  if (!at) throw new Error("Codex access token is unavailable");
  return { accessToken: at, accountId: acct };
}

function secureEqual(a, b) {
  const L = Buffer.from(a || "");
  const R = Buffer.from(b || "");
  return L.length === R.length && crypto.timingSafeEqual(L, R);
}

function authenticate(req) {
  try {
    const header = req.headers.authorization || "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    const { accessToken } = loadAuth();
    return secureEqual(supplied, accessToken);
  } catch {
    return false;
  }
}

// 面板可见性：读取 model-visibility.json（与 unified-router 共用）
const VISIBILITY_FILE = path.join(os.homedir(), ".codex", "unified-router", "model-visibility.json");
function loadVisibility() {
  try { return JSON.parse(fs.readFileSync(VISIBILITY_FILE, "utf8")); }
  catch { return {}; }
}
function isModelVisible(slug) {
  const v = loadVisibility();
  return v[slug] !== false; // 默认可见
}

function officialModels() {
  // 优先用 unified-models-catalog.json（Codex 兼容完整格式，含 shell_type），按面板可见性过滤
  const catalogPath = path.join(os.homedir(), ".codex", "unified-models-catalog.json");
  try {
    const cat = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const models = (cat.models || []).filter((m) => m.slug && isModelVisible(m.slug));
    if (models.length > 0) return models;
  } catch (e) {
    console.error(`[bridge] read catalog failed: ${e.message}`);
  }
  // 回退：unified-models.json（简化格式）
  try {
    const unified = JSON.parse(fs.readFileSync(UNIFIED_MODELS, "utf8"));
    const models = (unified.models || []).filter((m) => m.slug);
    if (models.length > 0) return models;
  } catch (e) {
    console.error(`[bridge] read unified-models.json failed: ${e.message}`);
  }
  // 兜底：已知官方模型
  return [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balanced speed and depth" },
        { effort: "high", description: "Greater reasoning depth" },
        { effort: "xhigh", description: "Maximum reasoning depth" },
      ],
      model_default_reasoning_efforts: { "gpt-5.6-sol": "high" },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_window: 256000,
    },
  ];
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    // 健康检查
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, {
        status: "ok",
        service: "codex-bridge",
        pid: process.pid,
        port: PORT,
      });
    }

    // 模型列表（不需要鉴权，router 会合并）
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return json(res, 200, { models: officialModels() });
    }

    // 其余端点需要鉴权（与 auth.json 比对）
    if (!authenticate(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }

    const { accessToken, accountId } = loadAuth();

    // POST /v1/responses — 转发到 chatgpt backend-api
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const raw = await readBody(req);
      let body;
      try {
        // 处理 zstd 压缩的请求体（Codex 标准压缩方式）
        const enc = (req.headers["content-encoding"] || "").toLowerCase();
        const decoded = enc === "zstd" ? zstdDecompressSync(raw) : raw;
        body = JSON.parse(decoded.toString("utf8"));
      } catch (e) {
        return json(res, 400, { error: "Request body must be JSON (zstd handled): " + (e?.message || "") });
      }

      // 多模型路由：按 model 前缀分流
      const reqModel = String(body.model || "");
      const isOpencode = reqModel.startsWith("opencode-go/");
      const isDash = reqModel.startsWith("qwen-dashscope/");
      const isDeep = reqModel.startsWith("deepseek-");
      let upstreamBase = UPSTREAM;
      let upstreamPath = "/backend-api/codex/responses";
      if (isOpencode) {
        upstreamBase = "https://opencode.ai/zen/go/v1";
        upstreamPath = "/chat/completions";
        const goKey = loadOpencodeGoKey();
        if (!goKey) return json(res, 500, { error: "opencode-go key unavailable" });
        body.model = reqModel.replace("opencode-go/", "");
        body.messages = convertInputToMessages(body);
        body.stream = true;
        delete body.store; delete body.instructions; delete body.max_output_tokens;
        filterTools(body);
        const up = await fetch(upstreamBase + upstreamPath, {
          method: "POST",
          headers: { authorization: "Bearer " + goKey, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!up.ok) { const t = await up.text().catch(() => ""); return json(res, up.status, { error: t.slice(0, 300) }); }
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
        const rd = up.body.getReader();
        try { for (;;) { const { done, value } = await rd.read(); if (done) break; res.write(value); } } finally { rd.releaseLock(); }
        return res.end();
      }
      if (isDash) {
        upstreamBase = "https://dashscope.aliyuncs.com/compatible-mode/v1";
        upstreamPath = "/chat/completions";
        const dsKey = loadDashScopeKey();
        if (!dsKey) return json(res, 500, { error: "dashscope key unavailable" });
        body.model = reqModel.replace("qwen-dashscope/", "");
        body.messages = convertInputToMessages(body);
        body.stream = true;
        delete body.store; delete body.instructions; delete body.max_output_tokens;
        filterTools(body);
        const up = await fetch(upstreamBase + upstreamPath, {
          method: "POST",
          headers: { authorization: "Bearer " + dsKey, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!up.ok) { const t = await up.text().catch(() => ""); return json(res, up.status, { error: t.slice(0, 300) }); }
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
        const rd = up.body.getReader();
        try { for (;;) { const { done, value } = await rd.read(); if (done) break; res.write(value); } } finally { rd.releaseLock(); }
        return res.end();
      }
      if (isDeep) {
        upstreamBase = "https://api.deepseek.com";
        upstreamPath = "/responses";
        const dsKey = loadKeymanKey("opencode:deepseek") || loadKeymanKey("env:DEEPSEEK_API_KEY") || loadKeymanKey("deepseek");
        if (!dsKey) return json(res, 500, { error: "deepseek key unavailable" });
        filterTools(body);
        const up = await fetch(upstreamBase + upstreamPath, {
          method: "POST",
          headers: { authorization: "Bearer " + dsKey, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!up.ok) { const t = await up.text().catch(() => ""); return json(res, up.status, { error: t.slice(0, 300) }); }
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
        const rd = up.body.getReader();
        try { for (;;) { const { done, value } = await rd.read(); if (done) break; res.write(value); } } finally { rd.releaseLock(); }
        return res.end();
      }

      // 协议适配：backend-api 要求 stream=true + store=false
      body.stream = true;
      body.store = false;
      delete body.max_output_tokens;

      const upstream = await fetch(`${UPSTREAM}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": accountId,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        return json(res, upstream.status, { error: text || `upstream ${upstream.status}` });
      }

      // SSE 透传
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      return res.end();
    }

    // POST /v1/responses/compact — 转发压缩
    if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
      const raw = await readBody(req);
      const upstream = await fetch(`${UPSTREAM}/backend-api/codex/responses/compact`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": accountId,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: raw,
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        return json(res, upstream.status, { error: text || `upstream ${upstream.status}` });
      }
      res.writeHead(upstream.status, { "content-type": "application/json" });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      return res.end();
    }

    return json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(`[bridge] error: ${e?.stack || e}`);
    if (!res.headersSent) return json(res, 500, { error: e?.message || "Internal error" });
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codex-bridge] listening on http://${HOST}:${PORT}/v1`);
  console.log(`[codex-bridge] upstream: ${UPSTREAM}/backend-api/codex`);
  console.log(`[codex-bridge] auth: ${AUTH_FILE}`);
  console.log(`[codex-bridge] models source: ${UNIFIED_MODELS}`);
});
