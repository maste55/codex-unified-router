# Codex Unified Router（模型网关）

让 **Codex 桌面版**的模型选择器同时显示 **ChatGPT 模型 + DeepSeek（flash）模型**，并按模型自动分流请求的本地轻量网关。

```
Codex 桌面版 → unified-router(127.0.0.1:4791)
                ├─ gpt-5.6-sol 等 → chatgpt-web daemon(17841) → ChatGPT 会话
                └─ deepseek-v4-flash / deepseek-v4-pro → api.deepseek.com（你的 API Key）
```

## 解决的问题

- Codex 桌面版的模型选择器默认只显示它连接的后端提供的模型。
- 本网关把 **ChatGPT 的模型目录** 与 **DeepSeek 模型目录** 合并返回（12 个模型，含 `deepseek-v4-flash`），并让 `/v1/responses` 按模型名分流到对应后端。
- 额外收益：`deepseek-*` 请求走**你自己的 DeepSeek API 额度**，不受 ChatGPT Plus 用量限制。

## 组件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 网关核心（Node.js，无需依赖，`node server.mjs` 即跑） |
| `router.config.json` | 网关配置（端口、上游地址、key 文件路径） |
| `unified-models.json` | 模型目录（含 deepseek 模型，供网关合并） |
| `start-all.ps1` / `start-router.ps1` / `stop-router.ps1` | 启停脚本 |
| `smoke-test.mjs` | 连通性自检 |
| `build-catalog.mjs` | 从 DeepSeek 官方 models 接口重建模型目录 |

## 安装步骤

### 1. 前置条件

- Windows + **Codex 桌面版**（已登录）
- **codex-chatgpt-web launcher**（>= 1.1.2，提供 17841 daemon 和 ChatGPT 浏览器会话）
- **Node.js**（>= 18）
- **DeepSeek 开放平台账号**（有 API Key）

### 2. 放置文件

```powershell
# 把本仓库内容放到：
mkdir $env:USERPROFILE\.codex\unified-router
# 复制 server.mjs、unified-models.json、*.ps1、router.config.json 到该目录
```

### 3. 配置

复制模板并编辑：

```powershell
Copy-Item router.config.json.example router.config.json
```

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 4791,
  "maxBodyBytes": 134217728,
  "openaiBaseUrl": "http://127.0.0.1:17841/v1",
  "deepseekBaseUrl": "https://api.deepseek.com",
  "deepseekEnvFile": "./.env.deepseek",
  "codexAuthFile": "C:/Users/<你的用户名>/.codex/auth.json"
}
```

创建 `.env.deepseek`（放 DeepSeek Key，**不要提交到 git**）：

```ini
AI_API_KEY=sk-你的DeepSeek密钥
```

`codexAuthFile` 指向 Codex 的 `auth.json`（网关用它读取 ChatGPT 登录 token 做本地鉴权与转发）。

### 4. 指向网关

编辑 `C:\Users\<你>\.codex\config.toml`：

```toml
openai_base_url = "http://127.0.0.1:4791/v1"
model = "gpt-5.6-sol"
```

> 若使用 codex-chatgpt-web launcher 管理配置，需同步更新它的集成日志
> `~/.codex-chatgpt-web/codex/integration-journal.json` 中 `installed.openai_base_url` 为同一地址，否则 launcher 会报 "openai_base_url changed after setup"。

### 5. 启动

```powershell
powershell -ExecutionPolicy Bypass -File start-all.ps1
```

检查：

```powershell
curl http://127.0.0.1:4791/health
# → {"status":"ok","version":1,"routes":["openai","deepseek"]}
```

### 6. 开机自启（可选）

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<你的目录>\start-all.ps1"'
Register-ScheduledTask -TaskName 'CodexUnifiedModelRouter' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force
```

### 7. 重启 Codex

模型选择器将出现 `deepseek-v4-flash` / `deepseek-v4-pro`（与 ChatGPT 模型并列）。

## 鉴权说明

- 网关本身要求 `Authorization: Bearer <auth.json 里的 access_token>`（Codex 桌面版会自动携带）。
- 转发 ChatGPT 请求时复用该 token；转发 DeepSeek 请求时改用 `.env.deepseek` 里的 `AI_API_KEY`。

## 故障排查

| 症状 | 排查 |
|---|---|
| `502 Unified model router failed` | 17841 daemon 没起来：`start-all.ps1` 起它；或 `curl http://127.0.0.1:17841/v1/models` 看 daemon |
| `426 Upgrade Required` | 网关不支持 websocket——Codex 桌面版走 HTTP 流不受影响；CLI 直连会报此错 |
| 模型列表无 deepseek | 确认 `.env.deepseek` 存在且 `unified-models.json` 含 `deepseek-*` |
| launcher 报 "openai_base_url changed after setup" | 同步 journal 的 `installed.openai_base_url` 为 4791 |
| DeepSeek 请求失败 | 检查 `.env.deepseek` 的 `AI_API_KEY` 是否有效（DeepSeek 控制台） |

## 安全

- 本仓库**不含任何密钥**：DeepSeek Key 在 `.env.deepseek`、ChatGPT token 在 Codex 的 `auth.json`，均被 `.gitignore` 排除，请勿提交。
