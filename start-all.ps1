# 看门狗共存方案：开机自启脚本（router + chatgpt-web 代理）
# 用法：放入启动目录或计划任务
$ErrorActionPreference = 'SilentlyContinue'

# 1. 启动 codex-bridge 独立桥（17841，替代 codex-chatgpt-web）
$bridgeDir = "C:\Users\<用户名>\AppData\Roaming\reasonix\global-workspace\.codex-bridge"
$bridgeListening = Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue
if (-not $bridgeListening) {
    Start-Process -FilePath 'node' -ArgumentList @('codex-bridge.mjs') -WorkingDirectory $bridgeDir -WindowStyle Hidden
    Write-Output 'codex-bridge 独立桥已启动 (17841)'
} else {
    Write-Output 'codex-bridge 独立桥已在运行 (17841)'
}

# 2. 启动 unified-router（4791）
$routerDir = "C:\Users\<用户名>\.codex\unified-router"
$routerListening = Get-NetTCPConnection -LocalPort 4791 -State Listen -ErrorAction SilentlyContinue
if (-not $routerListening) {
    Start-Process -FilePath 'node' -ArgumentList @('server.mjs') -WorkingDirectory $routerDir -WindowStyle Hidden
    Write-Output 'unified-router 已启动 (4791)'
} else {
    Write-Output 'unified-router 已在运行 (4791)'
}

# 3. 启动 agent-browser MCP 服务器（12347）
$abmListening = Get-NetTCPConnection -LocalPort 12347 -State Listen -ErrorAction SilentlyContinue
if (-not $abmListening) {
    Start-Process -FilePath 'agent-browser-mcp' -WindowStyle Hidden
    Write-Output 'agent-browser-mcp 已启动 (12347)'
} else {
    Write-Output 'agent-browser-mcp 已在运行 (12347)'
}

# 4. ollama serve 守护（11434）
$ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
if (Test-Path $ollamaExe) {
    $ollamaListening = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
    if (-not $ollamaListening) {
        $env:OLLAMA_MODELS = 'D:\ollama\models'
        Start-Process -FilePath $ollamaExe -ArgumentList @('serve') -WindowStyle Hidden
        Write-Output 'ollama serve 已启动 (11434, OLLAMA_MODELS=D:)'
    } else {
        Write-Output 'ollama serve 已在运行 (11434)'
    }
    # 5. model pull watchdog (resume): trigger when nomic missing and no live pull process
    $hasNomic = & $ollamaExe list 2>$null | Select-String 'nomic-embed-text'
    $pullProc = Get-CimInstance Win32_Process -Filter "Name='ollama.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match ' pull ' }
    if (-not $hasNomic -and -not $pullProc) {
        Start-Process -FilePath $ollamaExe -ArgumentList @('pull','nomic-embed-text') -WindowStyle Hidden
        Write-Output 'nomic pull triggered (resume)'
    } elseif (-not $hasNomic) {
        Write-Output 'nomic download in progress (pull alive)'
    } else {
        Write-Output 'nomic-embed-text ready'
    }
} else {
    Write-Output 'ollama 未安装，跳过'
}
