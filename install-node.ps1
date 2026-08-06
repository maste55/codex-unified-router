# install-node.ps1 — 自动下载/安装 Node.js LTS（便携版，无需管理员权限）
# 安装位置: %USERPROFILE%\.codex-bridge\nodejs\node-vXX-win-x64\
# 输出: 安装后的 node.exe 完整路径（供 install.cmd 捕获）
$ErrorActionPreference = 'Stop'

$destRoot = Join-Path $env:USERPROFILE '.codex-bridge\nodejs'
New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

# 已安装则直接输出路径
$existing = Get-ChildItem -Path $destRoot -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    $nodeExe = Join-Path $existing.FullName 'node.exe'
    if (Test-Path $nodeExe) {
        Write-Output $nodeExe
        exit 0
    }
}

Write-Host '[install-node] 正在下载 Node.js LTS ...' -ForegroundColor Cyan

# 1. 解析 latest-v22.x 目录，取最新版本号
$base = 'https://nodejs.org/dist/latest-v22.x/'
$page = (Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 30).Content
$m = [regex]::Match($page, 'node-v(\d+\.\d+\.\d+)-win-x64\.zip')
if (-not $m.Success) {
    Write-Host '[install-node] 无法获取 Node.js 版本号，请手动安装: https://nodejs.org' -ForegroundColor Red
    exit 1
}
$ver = $m.Groups[1].Value
$zipName = "node-v$ver-win-x64.zip"
$url = "$base$zipName"
$zipPath = Join-Path $env:TEMP $zipName

# 2. 下载 zip（带重试）
for ($i = 1; $i -le 3; $i++) {
    try {
        Write-Host "[install-node] 下载 $url"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
        break
    } catch {
        if ($i -eq 3) {
            Write-Host "[install-node] 下载失败: $_" -ForegroundColor Red
            exit 1
        }
        Write-Host "[install-node] 下载失败，重试 ($i/3) ..."
        Start-Sleep -Seconds 3
    }
}

# 3. 解压
Write-Host '[install-node] 解压中 ...'
Expand-Archive -Path $zipPath -DestinationPath $destRoot -Force

# 4. 输出 node.exe 路径
$nodeExe = Join-Path (Join-Path $destRoot "node-v$ver-win-x64") 'node.exe'
if (-not (Test-Path $nodeExe)) {
    Write-Host '[install-node] 解压后未找到 node.exe' -ForegroundColor Red
    exit 1
}
Write-Host "[install-node] 安装完成: $nodeExe" -ForegroundColor Green
Write-Output $nodeExe
exit 0
