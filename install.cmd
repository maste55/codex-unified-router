@echo off
chcp 65001 >nul
title Codex 官方模型桥 + 统一路由 - 一键安装
echo ============================================================
echo   Codex 官方模型桥 + DeepSeek 统一路由 - 一键安装
echo ============================================================
echo.

rem ---- 0. 检查 Node.js（缺失/过旧则自动安装）----
set "NODE_EXE=node"
set "HAVE_NODE=0"
where node >nul 2>nul
if not errorlevel 1 (
    for /f "tokens=1 delims=." %%a in ('node --version 2^>nul') do set "NODE_MAJOR=%%a"
    set "NODE_MAJOR=%NODE_MAJOR:v=%"
    if not "%NODE_MAJOR%"=="" (
        if %NODE_MAJOR% GEQ 18 (
            set "HAVE_NODE=1"
        )
    )
)
if "%HAVE_NODE%"=="1" (
    echo [OK] 检测到 Node.js：
    node --version
) else (
    echo [提示] 未检测到可用的 Node.js（需要 ≥ 18），正在自动安装...
    echo    （若已有 Node 但版本过旧，也会被替换为便携版）
    for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"`) do set "NODE_EXE=%%p"
    if not exist "%NODE_EXE%" (
        echo [错误] Node.js 自动安装失败，请手动安装: https://nodejs.org ^(版本 ≥ 18^)
        pause
        exit /b 1
    )
    echo [OK] 便携版 Node.js 已就绪：
    "%NODE_EXE%" --version
)
echo.

rem ---- 1. 填写 DeepSeek API Key ----
echo.
echo [第 1 步] 配置 DeepSeek API Key
echo    请打开 https://platform.deepseek.com/api_keys 获取你的 Key
if not exist config.env (
    copy config.env.example config.env >nul
    echo    已创建 config.env，请用记事本打开填写你的 Key
    echo    按任意键打开 config.env...
    pause >nul
    notepad config.env
) else (
    echo    检测到 config.env 已存在，跳过
)

rem ---- 2. 拷贝文件到 ~/.codex/unified-router ----
echo.
echo [第 2 步] 拷贝文件到 %USERPROFILE%\.codex\unified-router
if not exist "%USERPROFILE%\.codex\unified-router" mkdir "%USERPROFILE%\.codex\unified-router"
copy /y codex-bridge.mjs "%USERPROFILE%\.codex\unified-router\" >nul
copy /y server.mjs        "%USERPROFILE%\.codex\unified-router\" >nul
copy /y watchdog.mjs      "%USERPROFILE%\.codex\unified-router\" >nul
copy /y start-all.ps1     "%USERPROFILE%\.codex\unified-router\" >nul
copy /y router.config.json "%USERPROFILE%\.codex\unified-router\" >nul
copy /y config.env        "%USERPROFILE%\.codex\unified-router\" >nul
if not exist "%USERPROFILE%\.codex\unified-models.json" (
    copy /y unified-models.json "%USERPROFILE%\.codex\" >nul
    echo    [OK] unified-models.json 已拷贝到 ~/.codex
) else (
    echo    [跳过] unified-models.json 已存在
)
echo [OK] 文件拷贝完成

rem ---- 3. 检查 auth.json（Codex 登录）----
echo.
echo [第 3 步] 检查 Codex 登录状态
if exist "%USERPROFILE%\.codex\auth.json" (
    echo [OK] 检测到 auth.json（已登录 Codex）
) else (
    echo [警告] 未找到 auth.json！
    echo    请先运行 codex 登录一次，或确认 ~/.codex/auth.json 存在
)

rem ---- 4. 配置 Codex config.toml（追加模型供应商）----
echo.
echo [第 4 步] 配置 Codex config.toml
set "CFG=%USERPROFILE%\.codex\config.toml"
findstr /c:"model_provider = \"unified-router\"" "%CFG%" >nul 2>nul
if errorlevel 1 (
    (
        echo.
        echo # ---- unified-router 配置（自动添加）----
        echo model_provider = "unified-router"
        echo model = "gpt-5.6-sol"
        echo.
        echo [model_providers.unified-router]
        echo name = "unified-router"
        echo base_url = "http://127.0.0.1:4791/v1"
        echo wire_api = "responses"
    ) >> "%CFG%"
    echo [OK] 已追加 unified-router 配置到 config.toml
    echo [注意] 如你的 config.toml 已有 model_provider 设置，请手动检查合并
) else (
    echo [跳过] unified-router 已配置
)

rem ---- 5. 安装 DeepSeek 消费面板（可选）----
echo.
echo [第 5 步] 安装 DeepSeek 消费面板
set "SKILL_DST=%USERPROFILE%\.codex\skills\deepseek-usage-panel"
set "USAGE_DST=%USERPROFILE%\.codex\usage-status"
if not exist "%SKILL_DST%" (
    mkdir "%SKILL_DST%" 2>nul
    xcopy /e /y /q "%~dp0skills\deepseek-usage-panel" "%SKILL_DST%\" >nul
    echo    [OK] 已安装 skill 到 %SKILL_DST%
) else (
    echo    [跳过] skill 已存在: %SKILL_DST%
)
if not exist "%USAGE_DST%" (
    mkdir "%USAGE_DST%" 2>nul
    xcopy /e /y /q "%~dp0usage-status" "%USAGE_DST%\" >nul
    echo    [OK] 已安装面板程序到 %USAGE_DST%
) else (
    echo    [跳过] 面板程序已存在: %USAGE_DST%
)
echo    [提示] 面板程序需要 Python 3 + tkinter（Windows 官方 Python 自带）
echo    [提示] 首次使用请编辑 %USAGE_DST%\usage-panel.ps1 中的占位符路径

rem ---- 6. 启动桥 + 路由 ----
echo.
echo [第 6 步] 启动服务
start "" /min cmd /c "cd /d "%USERPROFILE%\AppData\Roaming\reasonix\global-workspace\.codex-bridge" 2>nul || cd /d "%USERPROFILE%\.codex\unified-router" && "%NODE_EXE%" codex-bridge.mjs"
start "" /min cmd /c "cd /d "%USERPROFILE%\.codex\unified-router" && "%NODE_EXE%" server.mjs"

echo.
echo ============================================================
echo   安装完成！请按以下步骤验证：
echo   1. 浏览器打开 http://localhost:17841/healthz
echo      应返回 {"service":"codex-bridge",...}
echo   2. 浏览器打开 http://localhost:4791/v1/models
echo      应列出 9 个模型（含 gpt-5.6-sol / deepseek-v4-flash 等）
echo   3. 启动 codex，在模型选择器里选 gpt-5.6-sol 或 deepseek
echo   4. 面板：调用 \$deepseek-usage-panel 或运行
echo      powershell -File %USAGE_DST%\..\skills\deepseek-usage-panel\scripts\usage-panel.ps1 -Action start
echo ============================================================
echo.
echo 可选：配置开机自启（计划任务）请参考 README.md 第 5 步
pause
