param(
    [switch]$RemoveFiles
)
$ErrorActionPreference = "Stop"

# 停止正在运行的小窗实例（仅匹配本脚本）
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*codex_usage_status.pyw*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "stopped pid $($_.ProcessId)" }

# 移除自启动
$run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $run -Name "CodexUsageStatus" -ErrorAction SilentlyContinue
Write-Host "autostart removed"

if ($RemoveFiles) {
    $base = "<USAGE_DIR>"
    if (Test-Path $base) {
        $ans = Read-Host "确认删除整个目录 $base ? (y/N)"
        if ($ans -eq "y" -or $ans -eq "Y") {
            Remove-Item -LiteralPath $base -Recurse -Force
            Write-Host "files removed"
        } else {
            Write-Host "skipped file deletion"
        }
    }
}
Write-Host "uninstall done"
