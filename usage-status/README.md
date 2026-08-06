# Codex 用量状态小窗（方案 A）

独立置顶悬浮小窗，跟随 Codex 启动/关闭自动显示/隐藏，实时展示每个问题的
token 消耗、缓存命中率和估算费用；面板底部显示 DeepSeek 账户总余额、
今日累计消耗和本周累计消耗。不修改 Codex 应用本体。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装后自动注册开机自启（HKCU Run: CodexUsageStatus）并立即启动。

## 使用

- 左键拖动：移动小窗位置
- 双击：折叠/展开
- 右键：定位到输入框上方 / 打开会话目录 / 退出
- 顶部按钮：`顶` 置顶开关，`−`/`+` 折叠，`✕` 退出（不卸载）

数据口径：token 来自本机 `<你的会话目录>` 会话日志的
`token_count` 计量；费用按官方单价估算（每 1M token）：

- deepseek-v4-flash：输入 $0.14 / 缓存命中 $0.0028 / 输出 $0.28
- deepseek-v4-pro：输入 $0.435 / 缓存命中 $0.003625 / 输出 $0.87

总余额来自 DeepSeek 官方余额接口（实时，每 60 秒刷新）；今日/本周消耗只统计
DeepSeek 计费会话。若期间存在其他模型会话（如 gpt-5.6、GLM、chatgpt-web），
数字后会带 `*` 标记，表示“另有未计价模型会话未计入”。费用均为估算值，
非账单级数字。

密钥读取顺序：环境变量 `DEEPSEEK_API_KEY` → `%APPDATA%\reasonix\.env` →
`E:\codex-work\cangku\inventory-reconciliation\.env`（只读，不落日志）。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1          # 停止并移除自启动
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveFiles  # 同时删除文件（需确认）
```

## 日志

`logs\usage-status.log`
