---
name: deepseek-usage-panel
description: 启动、查看和停止本机 DeepSeek 消费面板（Codex 用量状态悬浮小窗），面板显示 DeepSeek 账户余额、今日/本周累计消耗和每条会话的 token 费用估算。当用户说“DeepSeek 消费面板”“用量面板”“DeepSeek 余额”“今日/本周消耗”“打开用量小窗”“面板不见了”或显式调用 $deepseek-usage-panel 时使用；也用于重启消失的小窗、查看面板运行状态或停止面板。
---

# DeepSeek 消费面板

## 概览

本机 DeepSeek 消费面板是常驻置顶悬浮小窗（tkinter），程序位于 `<你的USAGE_DIR>\codex_usage_status.pyw`，已注册随 Codex 自动显示/隐藏。面板底部实时显示 DeepSeek 总余额、今日累计消耗、本周累计消耗（余额每 60 秒从官方接口刷新一次）。

## 操作

一律通过脚本 `scripts/usage-panel.ps1` 执行，不要手写启动命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usage-panel.ps1 -Action start
```

- `start`（默认）：若面板未运行则启动，已运行则保持不动
- `status`：只读查询运行状态、进程 PID、最新余额与今日/本周消耗
- `stop`：仅结束面板自身的 pythonw 进程
- `autostart`：重新注册 HKCU 自启动项并启动面板（修复“不随 Codex 出现”的问题）

## 汇报

脚本输出 `panel=`、`pid=`、`balance_cny=`、`today_usd=`、`week_usd=` 等键值。向用户汇报余额与今日/本周消耗（美元可乘以 6.75 换算人民币），并说明小窗可拖动、双击折叠、右键菜单等用法。

## 边界

- 只操作面板自身的 pythonw 进程，不得结束其他 python 进程。
- 不读取或打印 API 密钥；密钥由面板脚本只读加载。
- 余额来自 DeepSeek 官方余额接口，消耗为基于会话日志 token_count 的估算值，非账单级数字。
