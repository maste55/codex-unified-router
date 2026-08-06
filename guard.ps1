$ErrorActionPreference = "SilentlyContinue"
# 1) 确保 watchdog 常驻（秒级守护）
$wd = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine -match 'watchdog\.mjs' }
if (-not $wd) {
    Start-Process node -ArgumentList "$env:USERPROFILE\.codex\unified-router\watchdog.mjs" -WorkingDirectory "$env:USERPROFILE\.codex\unified-router" -WindowStyle Hidden
}
# 2) 兜底：端口检测（watchdog 失效时）
$r = netstat -ano | Select-String ":4791" | Select-String "LISTENING"
if (-not $r) { Start-Process node -ArgumentList "server.mjs" -WorkingDirectory "$env:USERPROFILE\.codex\unified-router" -WindowStyle Hidden }
$d = netstat -ano | Select-String ":17841" | Select-String "LISTENING"
if (-not $d) { Start-Process node -ArgumentList "codex-bridge.mjs" -WorkingDirectory "$env:USERPROFILE\AppData\Roaming\reasonix\global-workspace\.codex-bridge" -WindowStyle Hidden }
