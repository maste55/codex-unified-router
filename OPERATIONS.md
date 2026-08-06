# Codex 模型路由体系 · 运维手册（2026-08-06 最终版）

> 本文档记录 Codex 本地模型路由的最终架构、配置要点、故障排查与运维规范。
> 权威仓库：`https://github.com/maste55/codex-unified-router`（公开）

---

## 一、最终架构（一句话）

**Codex 直连 `codex-bridge`（127.0.0.1:17841）全能网关**，bridge 按模型名前缀分流到 4 类上游。

```
Codex 桌面版
  │  openai_base_url = http://127.0.0.1:17841/v1
  ▼
codex-bridge (17841)  ← 全能网关（唯一入口）
  ├─ opencode-go/*   → opencode.ai/zen/go/v1        （opencode 订阅）
  ├─ qwen-dashscope/* → dashscope.aliyuncs.com/compatible-mode/v1 （阿里云）
  ├─ deepseek-*      → api.deepseek.com             （DeepSeek 官方）
  └─ gpt-5.6-* 等    → chatgpt.com/backend-api      （ChatGPT 官方）
```

**模型总数：56 个**（opencode-go 25 + dashscope 22 + deepseek 2 + 官方 7）

---

## 二、关键文件清单

| 文件 | 作用 |
|---|---|
| `~/.codex/config.toml` | Codex 配置（base_url、model） |
| `~/.codex/unified-models.json` | 模型目录（56 个，router/bridge 读） |
| `~/.codex/unified-models-catalog.json` | Codex 兼容格式目录（含 shell_type） |
| `~/.codex/keyman/vault.json` | API Key 保险库（DPAPI 加密） |
| `~/.codex/unified-router/model-visibility.json` | 面板模型开关状态 |
| `~/.codex/sessions/` | 会话记录（JSONL，210+ 个） |
| `~/.codex/state_5.sqlite` | 会话索引（SQLite，568 线程） |
| `global-workspace/.codex-bridge/codex-bridge.mjs` | **全能网关本体** |
| `global-workspace/.codex-bridge/keyman/keyman.mjs` | Key 管理器 CLI |

---

## 三、配置要点（⚠️ 最重要的坑）

### 3.1 绝对不要设置 `model_provider`

```toml
# ❌ 错误（会导致会话列表"没有聊天"）
model_provider = "unified-router"

# ✅ 正确（默认 openai provider + base_url 指 bridge）
openai_base_url = "http://127.0.0.1:17841/v1"
```

**原因**：Codex 会话列表按 `model_provider` 过滤（Issue #24648 类 bug）。
设置自定义 provider 后，`thread/list` 只返回该 provider 的线程，历史会话全部"消失"（数据其实完好）。
**症状**：左侧所有项目显示"没有聊天"，但 `~/.codex/sessions` 和 `state_5.sqlite` 数据都在。

### 3.2 config.toml 推荐配置

```toml
disable_response_storage = true
model = "gpt-5.6-sol"              # 默认模型（官方）
model_reasoning_effort = "high"
openai_base_url = "http://127.0.0.1:17841/v1"   # ← 指向 bridge

[model_providers.ollama-local]     # 本地模型（可选）
base_url = "http://127.0.0.1:11434/v1"
wire_api = "responses"
```

---

## 四、codex-bridge 全能网关（17841）

### 4.1 能力

| 能力 | 说明 |
|---|---|
| 模型列表 | `GET /v1/models` 返回可见模型（按面板开关过滤，含 shell_type） |
| 对话 | `POST /v1/responses` 按 model 前缀分流到 4 类上游 |
| zstd 压缩 | 自动解压 `content-encoding: zstd` 请求体（Codex 标准） |
| 工具过滤 | 只保留 `apply_patch`，过滤 exec 等；转 deepseek 兼容格式 |
| 认证 | 校验 `~/.codex/auth.json` 的 access_token |
| 健康检查 | `GET /healthz` |

### 4.2 关键实现细节

- **zstd 解压**：Codex 用 zstd 压缩请求体，bridge 必须 `zstdDecompressSync` 后再 JSON.parse，否则报 `"Request body must be JSON"`
- **工具过滤**：deepseek/dashscope 只支持 `apply_patch`，Codex 的 `exec` 等工具要过滤；apply_patch 需补 `parameters: {type:"object",properties:{}}`
- **模型可见性**：读 `model-visibility.json`，面板关掉的模型 Codex 不显示

---

## 五、配置面板（http://localhost:4791/panel）

> 注意：面板挂在 **router (4791)** 上，不是 bridge。router 仅作面板/备用，不再是 Codex 的 provider。

### 功能

| Tab | 功能 |
|---|---|
| 📦 模型开关 | 56 个模型显示/隐藏（写 model-visibility.json，bridge 读取生效） |
| 🔑 API Key | 四家 provider 的 key 添加/修改/测试/删除（DPAPI 加密） |
| ⚙️ 程序管理 | router/bridge/ollama 状态、重启 router、**修复对话框丢失** |

### 访问

- 地址：`http://localhost:4791/panel`
- 面板 API 需 token（`panel-token.txt`），防 CSRF
- 面板修改模型开关后，**重启 Codex** 生效（bridge 实时读 visibility，但 Codex 缓存模型列表）

---

## 六、Key 管理（keyman）

### 6.1 已存 Key（10 个）

| 名称 | 用途 |
|---|---|
| `opencode:opencode-go` | opencode 订阅 |
| `opencode:qwen` | 阿里云 DashScope |
| `opencode:deepseek` / `opencode:deepseek1` | DeepSeek |
| `codex:chatgpt-access-token` | ChatGPT 官方 |
| `env:DASHSCOPE_API_KEY` / `env:GLM_API_KEY` / 等 | 环境变量导入 |

### 6.2 命令

```bash
keyman list                 # 列出（掩码）
keyman get <name>           # 取明文（脚本用）
keyman add <name> <key>     # 添加/更新
keyman remove <name>        # 删除
keyman import               # 批量导入已知来源
```

- Skill：说"存个 key / 查 key / 删 key"自动触发 `keyman`
- 存储：`~/.codex/keyman/vault.json`（Windows DPAPI CurrentUser 加密，仅本用户可解）

---

## 七、故障排查手册

### 7.1 左侧"没有聊天"（会话列表空）

| 排查 | 处理 |
|---|---|
| config.toml 是否设了 `model_provider` | **删除它**，恢复默认 provider |
| `openai_base_url` 是否 17841 | 改回 `http://127.0.0.1:17841/v1` |
| 数据是否还在 | `~/.codex/sessions` 文件数 + `state_5.sqlite` threads 数 |
| 面板"修复对话框丢失"按钮 | 一键设 CODEX_HOME + 检查会话健康 |

### 7.2 `Request body must be JSON`

**原因**：Codex 用 zstd 压缩请求体，bridge 没解压。
**修复**：bridge 加 zstd 解压（已实现）。

### 7.3 `Unsupported custom tool: 'exec'`

**原因**：Codex 带 exec 工具，deepseek 只支持 apply_patch。
**修复**：bridge 过滤工具（已实现）。

### 7.4 模型下拉少/缺模型

| 排查 | 处理 |
|---|---|
| bridge 是否返回完整 catalog | `curl localhost:17841/v1/models` 看模型数 |
| 面板是否关了模型 | `model-visibility.json` 检查 false 项 |
| catalog 是否含 shell_type | `unified-models-catalog.json` 检查 |

### 7.5 官方模型 429

**原因**：ChatGPT 账号额度用完（8月8日 12:55 重置）。
**处理**：用 deepseek/opencode/dashscope 通道（不受官方额度限制）。

### 7.6 remote compact 报错（deepseek 对话过长时）

**报错**：`remote compaction v2 expected exactly one compaction output item, got 0 from 2 output items`
**原因**：deepseek 响应带 `<think>` 推理，Codex 的 remote_compaction_v2 解析器拆成 2 个 output，找不到 compact 项（官方已知 bug Issue #179/#28592）。
**最终结论（2026-08-06 实测）**：compact 报错根因是 **config.toml 的 `service_tier = "default"`**（社区 Issue #24648 验证），移除后 compact 恢复正常！`Unsupported custom tool: exec` 是 deepseek 官方限制（只支持 apply_patch）。会话列表丢失是 model_provider 设置导致（Issue #24648），移除 model_provider 恢复。（返回含 message + compaction 项的合法 `response.compaction`），不再依赖上游 compact 端点（deepseek 无此端点、官方受额度限制）。已验证 compact 请求与后续对话均 200。

### 7.7 opencode-go 503

**原因**：opencode.ai 上游临时故障（直接调官方也 503，非本地问题）。
**处理**：等待恢复，或切换 deepseek/dashscope 通道。

---

## 八、同步规范

1. **改 bridge**：编辑 `global-workspace/.codex-bridge/codex-bridge.mjs` → 重启 bridge → 验证
2. **同步分享包**：复制到 `share/codex-bridge.mjs` → 重新打包 zip
3. **推送 GitHub**：`cd /tmp/codex-unified-router && git pull && cp ... && git commit/push`
4. **脱敏**：分享包里的 `linjin` 路径、真实 key 打包前必须清除（server.mjs 的 vlm-vision 路径泛化为 `<你的技能目录>`）

---

## 九、已解决问题记录（2026-08-06）

| 问题 | 根因 | 修复 |
|---|---|---|
| 对话框全丢 | model_provider=unified-router 过滤会话 | 删除 model_provider，走 bridge |
| 模型只剩官方 | bridge /v1/models 返回简化格式 | 改用 catalog 完整格式 |
| 面板开关无效 | bridge 不读 visibility | bridge 读 model-visibility.json |
| Request body must be JSON | zstd 压缩未解压 | bridge 加 zstd 解压 |
| Unsupported tool exec | 工具未过滤 | bridge 过滤只留 apply_patch |

---

## 十、免责与提醒

- **数据安全**：会话数据在 `~/.codex/sessions` + `state_5.sqlite`，备份在 `~/.codex/backup-*`
- **key 安全**：vault DPAPI 加密，仅当前 Windows 用户可解；不要复制 vault 到其他机器
- **官方额度**：ChatGPT 官方模型受账号额度限制（429），deepseek/opencode/dashscope 是用户自有 key/订阅不受影响

### exec 工具报错修复（2026-08-06）
router sanitizeDeepSeekBody 加 filterDeepSeekTools，过滤 exec 保留 apply_patch/web_search/function，已验证 200。
