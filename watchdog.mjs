// 看门狗：Codex 模型链路守护（4791 router + 17841 daemon）
// 常驻进程，每 2 秒检测，发现端口无监听立即拉起对应进程。
// 由计划任务 AtLogOn 启动；guard.ps1 每 2 分钟确保本进程存活。
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.USERPROFILE || "C:/Users/<用户名>";
const ROUTER_DIR = path.join(HOME, ".codex", "unified-router");
const BRIDGE_DIR = path.join(HOME, "AppData", "Roaming", "reasonix", "global-workspace", ".codex-bridge");
const LOG = path.join(ROUTER_DIR, "watchdog.log");
const BRIDGE_JS = path.join(BRIDGE_DIR, "codex-bridge.mjs");

function log(msg) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
}
function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1200 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => { s.destroy(); resolve(false); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}
let lastRestart = { 4791: 0, 17841: 0 };
async function ensure(port, args, cwd) {
  const ok = await portListening(port);
  if (!ok && Date.now() - (lastRestart[port] || 0) > 15000) {
    log(`端口 ${port} 无监听，拉起: ${args[0]} ${args[1]}`);
    lastRestart[port] = Date.now();
    const child = spawn(args[0], args.slice(1), { cwd, windowsHide: true, stdio: "ignore", detached: true });
    child.unref();
  }
}
log("看门狗启动，2 秒间隔守护 4791/17841");
setInterval(async () => {
  try {
    await ensure(4791, [process.execPath, path.join(ROUTER_DIR, "server.mjs")], ROUTER_DIR);
    await ensure(17841, [process.execPath, BRIDGE_JS], BRIDGE_DIR);
  } catch (e) {
    log("守护异常: " + (e?.message || e));
  }
}, 2000);
