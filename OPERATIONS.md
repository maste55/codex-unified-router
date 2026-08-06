# Codex 模型路由体系 · 运维手册（2026-08-07 最终版）

> 本文档记录 Codex 本地模型路由的**最终正确架构**、配置要点、故障排查与运维规范。
> 权威仓库：`https://github.com/maste55/codex-unified-router`（公开）
> **2026-08-07 定稿**：回到最初版软路由（commit `d0e6d77`，server.mjs 381 行），杜绝过度设计。

---

## 〇、最终架构（一句话，2026-08-07 定稿）

**Codex 直连 unified-router（127.0.0.1:4791）软路由**，router 按模型名前缀双路分流：

```
Codex 桌面版
  │  openai_base_url = http://127.0.0.1:4791/v1
  ▼
unified-router (4791)  ← 381 行最初版软路由（唯一入口）
  ├─ deepseek-*   → https://api.deepseek.com        （DeepSeek 官方，AI_API_KEY）
  └─ 其他模型     → openaiBaseUrl（默认官方 / 或 17841 codex-chatgpt-web 桥）
```

**模型总数：9 个**（官方 8 + deepseek-v4-flash/pro；用户明确不要 opencode-go / qwen-dashscope）

**核心原则："
回到最初版软路由，杜绝过度设计"** —— 每个"优化"都可能引入新故障（见 §七 弯路教训）。

---

## 一、关键文件清单

| 文件 | 作用 |
|---|---|
| `~/.codex/config.toml` | Codex 配置（`openai_base_url=4791`、model、features） |
| `~/.codex/unified-models.json` | 模型目录（9 个，router /v1/models 合并用） |
| `~/.codex/unified-router/server.mjs` | **unified-router 本体（381 行最初版 + exec 过滤补丁）** |
| `~/.codex/unified-router/router.config.json` | 路由配置（listenPort/openaiBaseUrl/deepseekBaseUrl/envFile/authFile） |
| `~/.codex/auth.json` | ChatGPT access_token（非 deepseek 路由认证用） |
| `E:/codex-work/cangku/inventory-reconciliation/.env` | DeepSeek `AI_API_KEY` 来源 |
| `~/.codex/codex-chatgpt-web/` | codex-chatgpt-web v2.0.0（可选 GPT 桥，端口 17841） |

> ⚠️ **已废弃组件（勿重新启用）**：`codex-bridge.mjs`（全能网关）、`keyman/`（Key 保险库）、面板/配置器、全部守护进程（UnifiedRouter-Watchdog / CodexUnifiedRouterGuard / CodexUnifiedModelRouter / CodexMemoryVectorIndex）。

---

## 二、配置要点（⚠️ 最重要的坑）

### 2.1 绝对不要设置 `model_provider`

```toml
# ❌ 错误（会导致会话列表"没有聊天"）
model_provider = "unified-router"

# ✅ 正确（默认 provider + base_url 指 unified-router）
openai_base_url = "http://127.0.0.1:4791/v1"
```

**原因**：Codex 会话列表按 `model_provider` 过滤（Issue #24648 类 bug）。
设置自定义 provider 后，`thread/list` 只返回该 provider 的线程，历史会话全部"消失"（数据其实完好）。

### 2.2 绝对不要设置 `model_catalog_json`

```toml
# ❌ 错误（会导致 Codex 界面打不开）
model_catalog_json = "..."
```

**原因**：模型目录缺字段会让 Codex 前端崩溃（2026-08-06 实测）。

### 2.3 config.toml 最终推荐配置（2026-08-07 实测可用）

```toml
disable_response_storage = true
model = "deepseek-v4-flash"          # 默认模型（主模型）
model_reasoning_effort = "high"
openai_base_url = "http://127.0.0.1:4791/v1"   # ← 指向 unified-router

[features]
memories = true
remote_compaction_v2 = false         # 关闭远程压缩 v2（避免触发不兼容路径）

[model_providers.ollama-local]       # 本地模型（可选）
base_url = "http://127.0.0.1:11434/v1"
wire_api = "responses"
```

### 2.4 unified-router 路由配置 `router.config.json`

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 4791,
  "maxBodyBytes": 134217728,
  "openaiBaseUrl": "http://127.0.0.1:17841/v1",
  "deepseekBaseUrl": "https://api.deepseek.com",
  "deepseekEnvFile": "E:/codex-work/cangku/inventory-reconciliation/.env",
  "codexAuthFile": "C:/Users/linjin/.codex/auth.json"
}
```

- `openaiBaseUrl`：非 deepseek 模型的转发目标（默认官方，或 codex-chatgpt-web 桥 17841）
- `deepseekEnvFile`：DeepSeek key 文件（读 `AI_API_KEY`，注意不是 `DEEPSEEK_API_KEY`）

---

## 三、为什么现在不再出现上下文压缩（compaction）问题

> 2026-08-07 用户实测确认：现在**不再出现上下文压缩**。本文档固化根因。

### 3.1 直接原因：上下文窗口变大 + 压缩功能关闭

| 因素 | 之前（出问题时代） | 现在 |
|---|---|---|
| 模型 | gpt-5.6-sol（272K 窗口） | deepseek-v4-flash（**1048K 窗口**） |
| 路由 | 直连官方 / bridge 网关 | unified-router(4791) 原样透传 |
| 压缩开关 | 官方默认 compact | `remote_compaction_v2 = false` |
| 网关干预 | bridge 曾做 compact 本地模拟 | **router 零 compact 处理** |

- `deepseek-v4-flash` context = **1,048,576 tokens**（100 万），是 GPT-5.6（272K）的 3.86 倍
- 普通对话**物理上很难达到压缩阈值** → 压缩流程不再触发
- `remote_compaction_v2 = false` 显式关闭远程压缩 v2 → 避免 Codex 侧不兼容路径

### 3.2 根本原因：不再有"网关模拟压缩"这个故障源

unified-router（381 行最初版）对 compact 请求**零处理、原样透传**，不存在"模拟压缩格式不认"的问题。

### 3.3 关键保护（三重保险）

1. `remote_compaction_v2 = false` —— 关闭远程压缩 v2
2. 100 万 context window —— 物理上难触发压缩
3. unified-router 无 compact 逻辑 —— 无故障源

> **一句话：不是"压缩被修好了"，而是"压缩被绕开了"。**

---

## 四、codex-chatgpt-web（可选 GPT 桥，17841）

### 4.1 定位

codex-chatgpt-web v2.0.0（`miuuyy/codex-chatgpt-web`）是 **ChatGPT Web 官方模型桥**（browser-only 模式），提供 `ChatGPT Web — Instant/High/Pro` 模型。

### 4.2 与 unified-router 的关系（⚠️ 互斥）

- `config.toml` 的 `openai_base_url` **只能有一个**
- **4791（unified-router/deepseek）与 17841（GPT 桥）是互斥入口**，不能串联转发 GPT 模型
- codex-chatgpt-web 的 `/responses` 需要 Codex 原生 `turn_id` 元数据（浏览器会话回放），unified-router 转发时不带 → **GPT 桥模型必须 Codex 直连 17841**
- **默认路由 = 4791**（deepseek 主模型）；要用 GPT 官方模型时把 `openai_base_url` 切到 `http://127.0.0.1:17841/v1` 并重启 Codex

### 4.3 安装要点（排障记录）

- GUI 的 setup-core **不支持** `--replace-codex-route` → 必须用 CLI：
  ```
  bun cli.js setup --browser-only --browser-host-descriptor <launcher-browser.json> --replace-codex-route --acknowledge-unofficial --auto-approve-tool-calls
  ```
- 报 `ChatGPT effort menu did not expose item index 0 (open=false; itemCount=0)` = ChatGPT 页面模型菜单未渲染。解法：先手动点击模型按钮（`button[aria-haspopup="menu"][data-tone="neutral"]`）弹出菜单，再立即跑 setup
- 安装后 `openai_base_url` 会被改成 17841 → 手动改回 4791 即恢复 deepseek（launcher 报 "changed after setup" 警告，无害）
- 17841 服务无 Windows daemon（service status: supported=false），靠 launcher GUI 常驻或手动 `bun cli.js serve` 后台启动

---

## 五、故障排查手册

### 5.1 左侧"没有聊天"（会话列表空）

| 排查 | 处理 |
|---|---|
| config.toml 是否设了 `model_provider` | **删除它**，恢复默认 provider |
| `openai_base_url` 是否 4791 | 改回 `http://127.0.0.1:4791/v1` |
| 数据是否还在 | `~/.codex/sessions` 文件数 + `state_5.sqlite` threads 数 |

### 5.2 `Unsupported custom tool: 'exec'`

**原因**：Codex 带 exec 工具，deepseek 只支持 apply_patch/web_search/function。
**修复**：router `sanitizeDeepSeekBody` 过滤工具（已实现，唯一补丁）。

### 5.3 `The 'deepseek-v4-flash' model is not supported when using Codex with a ChatGPT account`

**正确判断**：这是 **unified-router 接入失效**，不是 deepseek 不合法。
**修复方向**：恢复/修正 unified-router 接入（4791），**绝不能移除 deepseek 配置**。

### 5.4 `deepseek-v4-pro` 返回 400

**原因**：DeepSeek 官方限制（"available starting early August 2026"）。
**处理**：等官方放开，无需操作；用 `deepseek-v4-flash`。

### 5.5 官方模型 429 / GPT 桥模型不可用

**原因**：ChatGPT 账号额度限制，或 17841 桥未运行（launcher GUI 关闭）。
**处理**：用 deepseek 通道；或重开 launcher / 手动 `bun cli.js serve`。

---

## 六、启动/验证命令

```bash
# 启动 unified-router
node ~/.codex/unified-router/server.mjs        # 或 start-router.ps1

# 健康检查
curl http://127.0.0.1:4791/health              # {"status":"ok","routes":["openai","deepseek"]}

# 冒烟测试（deepseek）
cd ~/.codex/unified-router && node smoke-test.mjs deepseek-v4-flash

# 启动 GPT 桥（可选，codex-chatgpt-web）
cd ~/.codex-chatgpt-web/versions/2.0.0-win32-x64 && \
  runtime/bun.exe app/cli.js serve
```

---

## 七、弯路教训（2026-08-06 一整天故障复盘）

| # | 弯路 | 为什么错 | 正确做法 |
|---|---|---|---|
| 1 | 加 codex-bridge 全能网关（17841） | 过度设计，引入多重故障源 | 回到 381 行最初版软路由 |
| 2 | WS 转发（deepseek 官方不支持 WS） | router 崩溃 → 无限重连 | router 拒绝 WS 升级（426） |
| 3 | compact 本地模拟 | Codex 解析器不认格式 → compact 报错 | router 对 compact 零处理、原样透传 |
| 4 | 设 `model_provider` | 会话列表全丢（Issue #24648） | 不设，默认 provider |
| 5 | 设 `model_catalog_json` | 界面打不开 | 不设 |
| 6 | 模型目录塞 opencode-go/qwen-dashscope | 用户明确不要，徒增复杂度 | 只要官方 8 + deepseek 2 |
| 7 | keyman/面板/配置器 | 过度设计 | 全部回撤，不重新加 |
| 8 | 守护进程全家桶 | 与路由冲突/噪音 | 全部 Disabled，勿重启 |

**核心教训**：用户说"能用"的状态**不要再动**——每个"优化"都可能引入新故障。涉及 router 修改：以本仓库（`maste55/codex-unified-router`）为权威，先验证再改。

---

## 八、网络要求

**Clash Verge 服务 + 系统代理 7897 必须保持启用**（Codex 访问官方拉头像/用户名必需）；不要禁用（之前误禁导致头像/名字空白）。

---

## 九、同步规范

1. **改 router**：编辑 `~/.codex/unified-router/server.mjs` → 重启 router → 验证（smoke-test）
2. **推送 GitHub**：`cd /tmp/codex-unified-router && git pull && cp ... && git commit/push`
3. **脱敏**：分享包里的 `linjin` 路径、真实 key 打包前必须清除

---

## 十、免责与提醒

- **数据安全**：会话数据在 `~/.codex/sessions` + `state_5.sqlite`，备份在 `~/.codex/backup-*`
- **key 安全**：DeepSeek key 在 `E:/codex-work/cangku/inventory-reconciliation/.env`，不要提交到仓库
- **官方额度**：ChatGPT 官方模型受账号额度限制（429），deepseek 是用户自有 key 不受影响

---

## 十一、思考显示配置（2026-08-07 新增，最终根因）

**"无法思考/思考不显示"的最终根因：`model_reasoning_summary` 未设置 = 默认 `none`（禁用思考显示）**

```toml
model_reasoning_effort = "high"
model_reasoning_summary = "auto"   # auto | concise | detailed | none（none=不显示思考）
```

- 官方配置（Issue #2760）：`model_reasoning_summary = "auto"` 默认推荐
- 之前修的 SSE 事件/reasoning 格式都是**必要但不充分**——数据全对但配置层禁用显示
- CLI 验证：`reasoning summaries: auto` 后思考正常显示
