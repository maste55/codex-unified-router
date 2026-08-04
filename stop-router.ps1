$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Root 'router.pid'
if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Output 'Router is not running.'
    exit 0
}

$RouterPid = [int](Get-Content -Raw -LiteralPath $PidFile).Trim()
$Process = Get-CimInstance Win32_Process -Filter "ProcessId = $RouterPid"
if (-not $Process -or $Process.CommandLine -notlike "*$Root*server.mjs*") {
    throw "PID $RouterPid does not belong to this router. No process was stopped."
}

Stop-Process -Id $RouterPid
Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
Write-Output "Router stopped: PID $RouterPid"
