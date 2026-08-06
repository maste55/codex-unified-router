# Codex unified-router · 统一路由（最终版）

让 Codex 同时使用 **DeepSeek**（deepseek-v4-flash/pro）和 **ChatGPT 官方模型**（gpt-5.6-sol/luna/terra 等），通过本地 unified-router（4791）软路由分流。

> 核心：`server.mjs`（381 行最初版软路由 + 唯一补丁 exec 工具过滤）。
> 详细运维手册见 [OPERATIONS.md](OPERATIONS.md)（含 2026-08-07 最终架构与故障根因）。

## 架构（一句话）

```
Codex 桌面版
  │  openai_base_url = http://127.0.0.1:4791/v1
  ▼
unified-router (4791)  ← 381 行最初版软路由
  ├─ deepseek-*   → https://api.deepseek.com        （DeepSeek 官方）
  └─ 其他模型     → openaiBaseUrl（默认官方 / 或 17841 codex-chatgpt-web 桥）
```

**模型总数：9 个**（官方 8 + deepseek-v4-flash/pro）

> ⚠️ **2026-08-07 定稿**：回到最初版软路由，杜绝过度设计。
> `codex-bridge.mjs`、`keyman/`、面板、守护进程均已废弃，勿重新启用。

## 文件清单

| 文件 | 作用 | 需要改？ |
|---|---|---|
| `server.mjs` | **unified-router 本体**（381 行，双路分流 + exec 过滤） | ❌ 不用 |
| `router.config.json` | 路由配置（端口/上游/env/auth 路径） | ✅ **改路径** |
| `unified-models.json` | 模型目录（9 个模型） | 可选 |
| `config.env.example` | DeepSeek API Key 填写模板 | ✅ 参考 |
| `smoke-test.mjs` | 冒烟测试（`node smoke-test.mjs deepseek-v4-flash`） | ❌ 不用 |
| `start-router.ps1` / `stop-router.ps1` | router 启停 | ❌ 不用 |
| `start-all.ps1` | 开机自启（可选） | ❌ 不用 |
| `build-catalog.mjs` | 模型目录生成 | 可选 |
| `guard.ps1` | 守护脚本（已废弃，勿启用） | ❌ 不用 |
| `codex-bridge.mjs` | **已废弃**（旧全能网关，勿启用） | ❌ 不用 |
| `keyman/` | **已废弃**（Key 保险库，勿启用） | ❌ 不用 |

## 快速开始

### 1. 放置文件

```powershell
# 把本目录放到 ~/.codex/unified-router/
# unified-models.json 放 ~/.codex/
```

### 2. 配置 `router.config.json`

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 4791,
  "maxBodyBytes": 134217728,
  "openaiBaseUrl": "http://127.0.0.1:17841/v1",
  "deepseekBaseUrl": "https://api.deepseek.com",
  "deepseekEnvFile": "<你的 .env 路径，含 AI_API_KEY>",
  "codexAuthFile": "C:/Users/<用户名>/.codex/auth.json"
}
```

> ⚠️ `deepseekEnvFile` 里读的是 **`AI_API_KEY`**（不是 `DEEPSEEK_API_KEY`）。

### 3. 配置 `~/.codex/config.toml`

```toml
disable_response_storage = true
model = "deepseek-v4-flash"          # 主模型
model_reasoning_effort = "high"
openai_base_url = "http://127.0.0.1:4791/v1"

[features]
remote_compaction_v2 = false         # 关闭远程压缩 v2（避免不兼容路径）

[model_providers.ollama-local]       # 本地模型（可选）
base_url = "http://127.0.0.1:11434/v1"
wire_api = "responses"
```

> ⚠️ **不要设 `model_provider`**（会话列表会丢，Issue #24648）
> ⚠️ **不要设 `model_catalog_json`**（界面会打不开）

### 4. 启动

```powershell
node ~/.codex/unified-router/server.mjs    # 或 start-router.ps1
```

验证：
```powershell
curl http://127.0.0.1:4791/health          # {"status":"ok","routes":["openai","deepseek"]}
cd ~/.codex/unified-router && node smoke-test.mjs deepseek-v4-flash   # 200 / ROUTER_OK
```

## 模型路由规则

| 模型名 | 路由 |
|---|---|
| `deepseek-v4-flash` / `deepseek-v4-pro` | → `https://api.deepseek.com` |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex-spark` | → `openaiBaseUrl`（官方或 codex-chatgpt-web 桥 17841） |

## 常见问题

- **`Unsupported custom tool: 'exec'`**：deepseek 官方只支持 apply_patch/web_search/function，router 已自动过滤（唯一补丁）。
- **`The 'deepseek-v4-flash' model is not supported...`**：是 **unified-router 接入失效**，不是 deepseek 不合法——恢复 4791 接入，别删 deepseek 配置。
- **`deepseek-v4-pro` 400**：DeepSeek 官方未放开（2026-08 初），等官方，用 flash。
- **`Local router authentication failed`**：auth.json 的 token 与请求头不一致，重新登录 Codex。
- **GPT 桥模型不可用**：17841 桥（codex-chatgpt-web）未运行，或需 Codex 直连 17841（带原生 turn_id）。
- **不再出现上下文压缩？** 见 [OPERATIONS.md §三](OPERATIONS.md)——deepseek 100 万窗口 + remote_compaction_v2=false + router 零 compact 干预。

## 安全提示

- **绝不要把 `~/.codex/auth.json`、API key、`.env` 分享给别人**——那是你的登录凭证。
- 本包已脱敏，不含任何个人密钥；分享此包前建议再自查一遍。
