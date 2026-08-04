import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, "router.config.json"), "utf8"));
const auth = JSON.parse(fs.readFileSync(config.codexAuthFile, "utf8"));
const token = auth?.tokens?.access_token;
if (!token) throw new Error("Codex access token is unavailable");

const model = process.argv[2] || "deepseek-v4-flash";
const response = await fetch(`http://${config.listenHost}:${config.listenPort}/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model,
    input: "Reply with exactly ROUTER_OK",
    stream: false,
  }),
  signal: AbortSignal.timeout(120000),
});

const text = await response.text();
let responseModel = "";
let hasExpectedText = text.includes("ROUTER_OK");
try {
  const parsed = JSON.parse(text);
  responseModel = parsed.model || "";
} catch {}

console.log(JSON.stringify({
  requestedModel: model,
  status: response.status,
  responseModel,
  hasExpectedText,
  bodyBytes: Buffer.byteLength(text),
}));
if (!response.ok) process.exit(1);
