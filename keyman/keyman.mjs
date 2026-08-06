#!/usr/bin/env node
/**
 * keyman.mjs — API Key 管理器（狗主人设计，零依赖）
 *
 * 加密存储所有 API key 到单个 vault（Windows DPAPI CurrentUser 级加密），
 * 提供 CLI 增删查，供 unified-router 统一读取。
 *
 * 用法：
 *   keyman add <name> <key> [--desc "说明"]     添加/更新一个 key
 *   keyman get <name>                           输出明文 key（供脚本捕获）
 *   keyman list                                 列出所有 key（只显示掩码）
 *   keyman remove <name>                        删除
 *   keyman import                               从已知来源批量导入
 *   keyman where <name>                         显示 vault 路径
 *
 * Vault 位置：~/.codex/keyman/vault.json（值经 DPAPI 加密，base64 存储）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const HOME = os.homedir();
const VAULT_DIR = path.join(HOME, ".codex", "keyman");
const VAULT_FILE = path.join(VAULT_DIR, "vault.json");
const LOCK_FILE = path.join(VAULT_DIR, "vault.lock");

// ---------- DPAPI 加解密（经 PowerShell，CurrentUser 级）----------
function dpapiProtect(plain) {
  const ps = `
Add-Type -AssemblyName System.Security;
$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:KM_PLAIN);
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Convert]::ToBase64String($enc)`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    env: { ...process.env, KM_PLAIN: plain },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return out.trim();
}

function dpapiUnprotect(encoded) {
  const ps = `
Add-Type -AssemblyName System.Security;
$enc = [Convert]::FromBase64String($env:KM_ENC);
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[System.Text.Encoding]::UTF8.GetString($bytes)`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    env: { ...process.env, KM_ENC: encoded },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return out.trim();
}

// ---------- Vault 读写 ----------
function loadVault() {
  if (!fs.existsSync(VAULT_FILE)) return { version: 1, keys: {} };
  try {
    return JSON.parse(fs.readFileSync(VAULT_FILE, "utf8"));
  } catch {
    return { version: 1, keys: {} };
  }
}

function saveVault(vault) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2), { mode: 0o600 });
}

function maskKey(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

// ---------- 命令实现 ----------
function cmdAdd(name, key, desc) {
  if (!name || !key) {
    console.error("用法: keyman add <name> <key> [--desc 说明]");
    process.exit(1);
  }
  const vault = loadVault();
  const enc = dpapiProtect(key);
  vault.keys[name] = {
    enc,
    desc: desc || "",
    created: vault.keys[name]?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  saveVault(vault);
  console.log(`[OK] 已保存 ${name} (${maskKey(key)})`);
}

function cmdGet(name) {
  const vault = loadVault();
  const entry = vault.keys?.[name];
  if (!entry) {
    console.error(`[未找到] ${name}（可用 keyman list 查看）`);
    process.exit(1);
  }
  process.stdout.write(dpapiUnprotect(entry.enc) + "\n");
}

function cmdList() {
  const vault = loadVault();
  const keys = Object.keys(vault.keys || {});
  if (keys.length === 0) {
    console.log("(vault 为空)");
    return;
  }
  console.log("名称                     掩码              说明");
  console.log("-".repeat(70));
  for (const name of keys.sort()) {
    const e = vault.keys[name];
    // 解密拿掩码（需要解密，或存掩码副本——这里解密一次）
    let masked = "***";
    try { masked = maskKey(dpapiUnprotect(e.enc)); } catch {}
    console.log(
      `${name.padEnd(24)} ${masked.padEnd(18)} ${(e.desc || "").slice(0, 30)}`
    );
  }
  console.log("-".repeat(70));
  console.log(`共 ${keys.length} 个 key | vault: ${VAULT_FILE}`);
}

function cmdRemove(name) {
  const vault = loadVault();
  if (!vault.keys?.[name]) {
    console.error(`[未找到] ${name}`);
    process.exit(1);
  }
  delete vault.keys[name];
  saveVault(vault);
  console.log(`[OK] 已删除 ${name}`);
}

// ---------- 导入已知来源 ----------
function cmdImport() {
  const vault = loadVault();
  let imported = 0;

  // 1. opencode auth.json
  const ocAuth = path.join(HOME, ".local", "share", "opencode", "auth.json");
  if (fs.existsSync(ocAuth)) {
    try {
      const data = JSON.parse(fs.readFileSync(ocAuth, "utf8"));
      for (const [name, val] of Object.entries(data)) {
        if (val && typeof val === "object" && typeof val.key === "string" && val.key.length > 10) {
          vault.keys[`opencode:${name}`] = {
            enc: dpapiProtect(val.key),
            desc: `opencode auth.json: ${name}`,
            created: vault.keys[`opencode:${name}`]?.created || new Date().toISOString(),
            updated: new Date().toISOString(),
          };
          imported++;
        }
      }
    } catch (e) { console.error(`[跳过] opencode auth.json: ${e.message}`); }
  }

  // 2. ~/.codex/auth.json（ChatGPT access_token）
  const codexAuth = path.join(HOME, ".codex", "auth.json");
  if (fs.existsSync(codexAuth)) {
    try {
      const data = JSON.parse(fs.readFileSync(codexAuth, "utf8"));
      const at = data?.tokens?.access_token;
      const acct = data?.tokens?.account_id;
      if (at) {
        vault.keys["codex:chatgpt-access-token"] = {
          enc: dpapiProtect(at),
          desc: `Codex ChatGPT access_token (account: ${acct})`,
          created: vault.keys["codex:chatgpt-access-token"]?.created || new Date().toISOString(),
          updated: new Date().toISOString(),
        };
        imported++;
      }
    } catch (e) { console.error(`[跳过] codex auth.json: ${e.message}`); }
  }

  // 3. 环境变量
  for (const [name, val] of Object.entries(process.env)) {
    if (val && val.length > 10 && /(API_KEY|TOKEN|SECRET|KEY)/.test(name)) {
      if (vault.keys[`env:${name}`]) continue;
      vault.keys[`env:${name}`] = {
        enc: dpapiProtect(val),
        desc: `环境变量: ${name}`,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      imported++;
    }
  }

  saveVault(vault);
  console.log(`[OK] 导入完成，共新增/更新 ${imported} 个 key`);
}

// ---------- main ----------
const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case "add": {
    const name = args[1];
    const descIdx = args.indexOf("--desc");
    const desc = descIdx > -1 ? args[descIdx + 1] : "";
    // key 可以是第 2 个参数，或 --key 后
    const keyIdx = args.indexOf("--key");
    const key = keyIdx > -1 ? args[keyIdx + 1] : args[2];
    cmdAdd(name, key, desc);
    break;
  }
  case "get":
    cmdGet(args[1]);
    break;
  case "list":
    cmdList();
    break;
  case "remove":
    cmdRemove(args[1]);
    break;
  case "import":
    cmdImport();
    break;
  case "where":
    console.log(VAULT_FILE);
    break;
  default:
    console.log(`
keyman — API Key 管理器（零依赖，DPAPI 加密）

用法:
  keyman add <name> <key> [--desc 说明]   添加/更新
  keyman get <name>                       输出明文（供脚本捕获）
  keyman list                             列出掩码
  keyman remove <name>                    删除
  keyman import                           批量导入已知来源
  keyman where                            显示 vault 路径
`);
    break;
}
