# Codex 服务自启脚本（2026-08-07）
# 作用：开机后启动 unified-router(4791) + Codex Web GPT launcher（GPT 桥依赖）
# 用法：注册为开机计划任务（schtasks / HKCU Run）
# 注意：不要手动启动 17841 serve（会与 launcher 冲突导致 launcher 退出）

$ErrorActionPreference = 'SilentlyContinue'

$logDir = "$env:USERPROFILE\.codex\usage-status\logs"
$logFile = Join-Path $logDir "autostart.log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding UTF8
}

Log "=== autostart begin ==="

# ---------- 1. unified-router (4791) ----------
$routerRunning = $false
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4791/health' -TimeoutSec 3
    if ($r.status -eq 'ok') { $routerRunning = $true }
} catch {}
if ($routerRunning) {
    Log "router(4791) already running"
} else {
    Log "starting router(4791)..."
    $routerDir = "$env:USERPROFILE\.codex\unified-router"
    if (Test-Path (Join-Path $routerDir 'server.mjs')) {
        Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory $routerDir -WindowStyle Hidden
        Start-Sleep -Seconds 3
        try {
            $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4791/health' -TimeoutSec 3
            Log "router(4791) started: status=$($r.status) routes=$($r.routes -join ',')"
        } catch { Log "router(4791) start failed: $_" }
    } else {
        Log "router script not found: $routerDir\server.mjs"
    }
}

# ---------- 2. Codex Web GPT launcher（GPT 桥依赖） ----------
$launcherExe = "$env:LOCALAPPDATA\Programs\codex-web-gpt-launcher\Codex Web GPT.exe"
$launcherCount = (Get-Process -Name 'Codex Web GPT' -ErrorAction SilentlyContinue | Measure-Object).Count
if ($launcherCount -gt 0) {
    Log "launcher already running ($launcherCount procs)"
} else {
    if (Test-Path $launcherExe) {
        Log "starting launcher..."
        Start-Process $launcherExe
        Start-Sleep -Seconds 5
        $c2 = (Get-Process -Name 'Codex Web GPT' -ErrorAction SilentlyContinue | Measure-Object).Count
        Log "launcher started: $c2 procs"
    } else {
        Log "launcher not found: $launcherExe"
    }
}

# ---------- 3. 等待 launcher 就绪后，确保 17841 桥（不主动 serve，避免冲突） ----------
# 说明：launcher GUI 就绪后，用户可在界面点启动桥；或 launcher 自动管理。
# 这里只做健康检查记录，不手动 serve（手动 serve 会导致 launcher 退出）。

Start-Sleep -Seconds 5
try {
    $m = Invoke-RestMethod -Uri 'http://127.0.0.1:4791/v1/models' -TimeoutSec 5 -Headers @{ Authorization = 'Bearer check' }
    Log "models endpoint ok: $($m.models.Count) models"
} catch {
    Log "models endpoint check: $_"
}

Log "=== autostart done ==="
