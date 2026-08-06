# DeepSeek 消费面板 · Codex 调用约定（可分享版）

## 背景

本机 DeepSeek 消费面板（tkinter 置顶悬浮小窗，pinned=true 置顶）。

## Codex 全局指令（追加到 `~/.codex/AGENTS.md`）

当用户提到"DeepSeek 消费面板"、"用量面板"、"DeepSeek 余额"、"今日/本周消耗"、
"打开用量小窗"、"面板不见了"或显式要求启动/查看面板时：

1. **调用脚本**（不要手写启动命令）：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.codex\skills\deepseek-usage-panel\scripts\usage-panel.ps1" -Action start
   ```

   > 启动内部使用 `explorer.exe` 方式，确保面板进入用户桌面会话（Session 1），窗口正常显示。
   > 不要用 `Start-Process pythonw` 直接启动（会进入非交互上下文，面板不定时静默退出）。
   - `-Action start`：启动（若未运行）
   - `-Action status`：只读查询状态（panel/pid/balance_cny/today_usd/week_usd）
   - `-Action stop`：停止面板
   - `-Action autostart`：重新注册自启动并启动

2. **汇报格式**：向用户汇报余额（`balance_cny`，人民币）、今日/本周消耗
   （`today_usd`/`week_usd`，可乘 6.75 换人民币），并说明悬浮窗可拖动、双击折叠、右键菜单。

3. **边界**：只操作面板自身的 pythonw 进程（PID 从 status 读），不得结束其他 python 进程；
   不读取或打印 API 密钥；消耗为基于会话日志 token_count 的估算值，非账单级数字。

## ⚠️ 已知限制（重要）

**deepseek 模型路由下 Codex 无法执行 PowerShell/bash**：
unified-router 的 `sanitizeDeepSeekBody` 按 DeepSeek 官方能力过滤工具，
只保留 `apply_patch` / `web_search` / `function`，**`exec`（shell 执行）被过滤**。
因此通过 Codex 对话（deepseek 模型）调用面板**会失败**。

### 替代方案
1. **无需手动调用**：面板已注册 HKCU 自启动 + 跟随 Codex 进程自动显示/隐藏，开机即用
2. **Reasonix 侧调用**：本机 Reasonix（狗系技能）可正常执行 PowerShell 调用面板
3. **GPT 桥模型**：切换 `openai_base_url=17841`（codex-chatgpt-web）后 Codex 有完整工具链，可执行
4. **直接命令**：手动运行脚本（见上）

## 文件清单

| 文件 | 作用 |
|---|---|
| `usage-status/codex_usage_status.pyw` | 面板程序（含 HWND_TOPMOST 强制置顶强化） |
| `usage-status/config.json` | 面板配置（pinned=true） |
| `skills/deepseek-usage-panel/scripts/usage-panel.ps1` | 调用脚本（start/status/stop/autostart） |
