# Codex 官方模型桥 + 统一路由（可分享版）

让 Codex 同时使用 **ChatGPT 官方模型**（gpt-5.6-sol/luna/terra 等）和 **DeepSeek**，通过本地 unified-router 分流。

> 核心：`codex-bridge.mjs`（7.3KB 零依赖独立桥，替代第三方 codex-chatgpt-web 浏览器方案）

## 文件清单

| 文件 | 作用 | 需要改？ |
|---|---|---|
| `codex-bridge.mjs` | 独立桥：转发官方模型到 chatgpt.com backend-api（端口 17841） | ❌ 不用 |
| `server.mjs` | unified-router：按模型名分流（deepseek → DeepSeek API；其他 → 桥） | ❌ 不用 |
| `watchdog.mjs` | 2 秒守护 4791/17841，桥挂自动拉起 | ❌ 不用 |
| `start-all.ps1` | 开机自启（计划任务调用） | ❌ 不用 |
| `router.config.json` | 路由配置 | ✅ **改 auth 路径** |
| `unified-models.json` | 模型目录（9 个模型） | 可选 |
| `config.env.example` | **DeepSeek API Key 填写模板** | ✅ **必填 key** |
| `install.cmd` | **一键安装脚本**（推荐直接用这个） | ❌ 不用 |
| `install-node.ps1` | **Node.js 自动安装器**（无 Node 时自动下载便携版） | ❌ 不用 |
| `skills/deepseek-usage-panel/` | **DeepSeek 消费面板 skill**（查看余额/今日本周消耗） | ❌ 不用 |
| `usage-status/` | 面板程序（tkinter 悬浮小窗，读 `DEEPSEEK_API_KEY`） | ⚠️ 需改占位符路径 |

## 快速开始（推荐：双击 install.cmd）

1. 解压本包，双击 `install.cmd`
2. **没有 Node.js 也不怕**：脚本自动检测，没有（或版本 < 18）会自动下载 Node.js 便携版到 `~\.codex-bridge\nodejs\`（无需管理员权限）
3. 脚本会**自动打开 config.env** 让你粘贴 DeepSeek API Key（获取：https://platform.deepseek.com/api_keys）
4. 脚本自动拷贝文件、追加 Codex 配置、**自动安装 DeepSeek 消费面板 skill**、启动服务
5. 按脚本提示验证 17841/4791

## DeepSeek 消费面板（随包附带）

- 功能：置顶悬浮小窗，实时显示 DeepSeek 账户余额、今日/本周累计消耗、每条会话 token 费用估算
- 依赖：**Python 3 + tkinter**（Windows 官方 Python 自带），需设置 `DEEPSEEK_API_KEY` 环境变量
- 使用：安装后调用 `$deepseek-usage-panel` 技能，或直接运行
  ```powershell
  powershell -File ~\.codex\skills\deepseek-usage-panel\scripts\usage-panel.ps1 -Action start
  ```
- 注意：`usage-panel.ps1` 里的 `<USAGE_DIR>` / `<PYTHONW>` 占位符需改为你本机的实际路径

> 注意：`install.cmd` 里桥的启动路径写的是本包解压目录，如未放在固定位置请手动启动桥：
> ```powershell
> cd 本包目录 && node codex-bridge.mjs
> ```

## 手动安装（可选）

1. **Node.js ≥ 18**（`node --version` 验证）
2. **已登录 Codex**（`~/.codex/auth.json` 存在，含 ChatGPT access_token）
3. **DeepSeek API key**（可选：不用 deepseek 可跳过）

## 安装步骤

### 1. 放置文件

把本目录所有文件放到：`C:\Users\<你的用户名>\.codex\unified-router\`
（`unified-models.json` 放 `~/.codex/` 下）

### 2. 修改配置 `router.config.json`

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 4791,
  "maxBodyBytes": 134217728,
  "openaiBaseUrl": "http://127.0.0.1:17841/v1",
  "deepseekBaseUrl": "https://api.deepseek.com",
  "deepseekEnvFile": "<你的 .env 文件路径，含 DEEPSEEK_API_KEY>",
  "codexAuthFile": "<你的 auth.json 路径，默认 C:/Users/<用户名>/.codex/auth.json>"
}
```

### 3. 修改 Codex 配置 `~/.codex/config.toml`

```toml
model_provider = "unified-router"
model = "gpt-5.6-sol"   # 或 deepseek-v4-flash

[model_providers.unified-router]
name = "unified-router"
base_url = "http://127.0.0.1:4791/v1"
wire_api = "responses"
env_key = "CODEX_UNIFIED_ROUTER_KEY"
```

### 4. 启动

```powershell
# 启动桥 (17841)
cd C:\Users\<用户名>\AppData\Roaming\reasonix\global-workspace\.codex-bridge
node codex-bridge.mjs

# 启动 router (4791)
cd C:\Users\<用户名>\.codex\unified-router
node server.mjs
```

验证：
```powershell
curl http://localhost:17841/healthz     # 应返回 {"service":"codex-bridge"}
curl http://localhost:4791/v1/models    # 应列出 9 个模型
```

### 5. 开机自启（可选）

计划任务 → 创建任务 → 登录时触发：
```
程序: powershell.exe
参数: -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\<用户名>\.codex\unified-router\start-all.ps1
```

## 模型路由规则

| 模型名 | 路由 |
|---|---|
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex-spark` | → 桥 (17841) → chatgpt.com 官方后端 |
| `deepseek-v4-flash` / `deepseek-v4-pro` | → api.deepseek.com |

## 常见问题

- **429 usage_limit_reached**：ChatGPT 账号额度用完，等重置或升级，非桥故障。
- **"Local router authentication failed"**：auth.json 的 token 与请求头不一致，重新登录 Codex。
- **官方模型不显示**：确认 `codex-bridge.mjs` 在运行、`unified-models.json` 存在。
- **deepseek 报错**：检查 `deepseekEnvFile` 指向的 `.env` 里 `DEEPSEEK_API_KEY` 是否有效。

## 安全提示

- **绝不要把 `~/.codex/auth.json`、API key、`.env` 分享给别人**——那是你的登录凭证。
- 本包已脱敏，不含任何个人密钥；分享此包前建议再自查一遍。
