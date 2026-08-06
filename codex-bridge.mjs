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

const HOME = os.homedir();
const CODEX_HOME = path.join(HOME, ".codex");
const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
const UNIFIED_MODELS = path.join(CODEX_HOME, "unified-models.json");
const UPSTREAM = "https://chatgpt.com";
const PORT = Number(process.env.BRIDGE_PORT || 17841);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";

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

function officialModels() {
  // 从 unified-models.json 取非 deepseek 模型（官方模型列表）
  try {
    const unified = JSON.parse(fs.readFileSync(UNIFIED_MODELS, "utf8"));
    const models = (unified.models || []).filter(
      (m) => m.slug && !m.slug.startsWith("deepseek-")
    );
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
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return json(res, 400, { error: "Request body must be JSON" });
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
