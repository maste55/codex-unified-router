# 模板化 start-all.ps1（用 $HOME 代替本机绝对路径）

$ErrorActionPreference = 'SilentlyContinue'
$homeDir = $env:USERPROFILE

# 1. 启动 chatgpt-web 代理 daemon（17841）——Codex 桌面版 ChatGPT 会话桥
$chatgptWeb = Join-Path $homeDir '.codex-chatgpt-web\versions\1.1.2-win32-x64\runtime\bun.exe'
$cliJs = Join-Path $homeDir '.codex-chatgpt-web\versions\1.1.2-win32-x64\app\cli.js'
$listening = Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Start-Process -FilePath $chatgptWeb -ArgumentList @($cliJs, 'serve') -WorkingDirectory (Join-Path $homeDir '.codex-chatgpt-web') -WindowStyle Hidden
    Write-Output 'chatgpt-web daemon 已启动 (17841)'
} else {
    Write-Output 'chatgpt-web daemon 已在运行 (17841)'
}

# 2. 启动 unified-router（4791）——模型网关：合并模型列表 + 分流 openai/deepseek
$routerDir = Join-Path $homeDir '.codex\unified-router'
$routerListening = Get-NetTCPConnection -LocalPort 4791 -State Listen -ErrorAction SilentlyContinue
if (-not $routerListening) {
    Start-Process -FilePath 'node' -ArgumentList @('server.mjs') -WorkingDirectory $routerDir -WindowStyle Hidden
    Write-Output 'unified-router 已启动 (4791)'
} else {
    Write-Output 'unified-router 已在运行 (4791)'
}
