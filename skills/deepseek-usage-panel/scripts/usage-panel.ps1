param(
    [ValidateSet('start', 'status', 'stop', 'autostart')]
    [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'

$base = '<USAGE_DIR>'
$script = Join-Path $base 'codex_usage_status.pyw'
$pyw = '<PYTHONW>'
$log = Join-Path $base 'logs\usage-status.log'
$install = Join-Path $base 'install.ps1'

function Get-PanelProcess {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^pythonw?\.exe$' -and $_.CommandLine -match [regex]::Escape($script) }
}

function Get-LatestNumbers {
    $lines = @()
    if (Test-Path $log) {
        $lines = Get-Content $log -Encoding UTF8 -Tail 300 -ErrorAction SilentlyContinue
    }
    $bal = ''
    $today = ''
    $week = ''
    foreach ($ln in $lines) {
        $m = [regex]::Match($ln, 'balance ok: CNY ([\d.]+)')
        if ($m.Success) { $bal = $m.Groups[1].Value }
        $m = [regex]::Match($ln, 'ledger: today=\$([\d.]+) week=\$([\d.]+)')
        if ($m.Success) {
            $today = $m.Groups[1].Value
            $week = $m.Groups[2].Value
        }
    }
    [PSCustomObject]@{ BalanceCny = $bal; TodayUsd = $today; WeekUsd = $week }
}

$proc = Get-PanelProcess
$nums = Get-LatestNumbers

switch ($Action) {
    'status' {
        if ($proc) {
            Write-Output "panel=running"
            Write-Output "pid=$($proc.ProcessId)"
        } else {
            Write-Output "panel=stopped"
            Write-Output 'pid='
        }
        Write-Output "balance_cny=$($nums.BalanceCny)"
        Write-Output "today_usd=$($nums.TodayUsd)"
        Write-Output "week_usd=$($nums.WeekUsd)"
        break
    }
    'start' {
        if ($proc) {
            Write-Output "panel=already_running"
            Write-Output "pid=$($proc.ProcessId)"
        } else {
            if (-not (Test-Path $script)) { throw "missing $script" }
            if (-not (Test-Path $pyw)) { throw "missing $pyw" }
            Start-Process -FilePath $pyw -ArgumentList "`"$script`""
            Start-Sleep -Seconds 4
            $proc = Get-PanelProcess
            if ($proc) {
                Write-Output "panel=started"
                Write-Output "pid=$($proc.ProcessId)"
            } else {
                Write-Output 'panel=start_failed'
                Write-Output 'pid='
            }
        }
        Write-Output "balance_cny=$($nums.BalanceCny)"
        Write-Output "today_usd=$($nums.TodayUsd)"
        Write-Output "week_usd=$($nums.WeekUsd)"
        break
    }
    'stop' {
        if ($proc) {
            $proc | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
            Start-Sleep -Seconds 2
            if (Get-PanelProcess) { Write-Output 'panel=stop_failed' } else { Write-Output 'panel=stopped' }
        } else {
            Write-Output 'panel=not_running'
        }
        Write-Output 'pid='
        break
    }
    'autostart' {
        if (-not (Test-Path $install)) { throw "missing $install" }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $install
        if ($LASTEXITCODE -ne 0) { throw 'install.ps1 failed' }
        Start-Sleep -Seconds 4
        $proc = Get-PanelProcess
        if ($proc) {
            Write-Output "panel=running"
            Write-Output "pid=$($proc.ProcessId)"
        } else {
            Write-Output 'panel=not_running'
            Write-Output 'pid='
        }
        Write-Output "balance_cny=$($nums.BalanceCny)"
        Write-Output "today_usd=$($nums.TodayUsd)"
        Write-Output "week_usd=$($nums.WeekUsd)"
        break
    }
}
