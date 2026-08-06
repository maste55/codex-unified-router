param(
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"

$base = "<USAGE_DIR>"
$script = Join-Path $base "codex_usage_status.pyw"
$py312 = "<PYTHONW>"
if (Test-Path $py312) {
    $pyw = $py312
} else {
    $pyw = Join-Path (Split-Path (Get-Command python).Source) "pythonw.exe"
}

if (-not (Test-Path $script)) { throw "missing $script" }
python -m py_compile $script
if ($LASTEXITCODE -ne 0) { throw "py_compile failed" }

$run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$cmd = "`"$pyw`" `"$script`""
Set-ItemProperty -Path $run -Name "CodexUsageStatus" -Value $cmd
Write-Host "autostart registered: HKCU Run CodexUsageStatus"

if (-not $NoStart) {
    Start-Process -FilePath $pyw -ArgumentList "`"$script`""
    Write-Host "started: $script"
}
Write-Host "install done"
