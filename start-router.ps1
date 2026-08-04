$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Root 'router.config.json') | ConvertFrom-Json
$HealthUrl = "http://$($Config.listenHost):$($Config.listenPort)/health"

try {
    $health = Invoke-RestMethod -TimeoutSec 2 -Uri $HealthUrl
    if ($health.status -eq 'ok') {
        Write-Output 'Router is already healthy.'
        exit 0
    }
} catch {}

$Node = (Get-Command node -ErrorAction Stop).Source
$Server = Join-Path $Root 'server.mjs'
$Stdout = Join-Path $Root 'router.log'
$Stderr = Join-Path $Root 'router-error.log'
Start-Process -FilePath $Node -ArgumentList @($Server) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod -TimeoutSec 2 -Uri $HealthUrl
        if ($health.status -eq 'ok') {
            Write-Output "Router started: $HealthUrl"
            exit 0
        }
    } catch {}
}

throw "Router did not become healthy. Check $Stderr"
