@echo off
chcp 65001 >nul
REM ==============================================================================
REM ОФИСНЫЙ ПОМОЩНИК (AIR-GAP EDITION) — ПУСКОВОЙ СКРИПТ WINDOWS 7 / 8.1 / 10 / 11
REM Работает БЕЗ прав администратора (UAC не требуется), БЕЗ интернета и БЕЗ установки.
REM Флаг NODE_SKIP_PLATFORM_CHECK=1 обеспечивает работу на ядре Windows 7 SP1 (NT 6.1).
REM ==============================================================================
setlocal
cd /d "%~dp0"

set NODE_SKIP_PLATFORM_CHECK=1
set PORT=3000
set HOST=127.0.0.1
set LOCAL_MODELS_DIR=%~dp0models
set LOCAL_TESSDATA_DIR=%~dp0tessdata
set NODE_ENV=production

echo ==================================================================
echo  ОФИСНЫЙ ПОМОЩНИК — АВТОНОМНЫЙ РЕЖИМ (БЕЗ ИНТЕРНЕТА И АДМИН-ПРАВ)
echo  Папка запуска: %~dp0
echo ==================================================================

if exist "%~dp0bin\win7-x64\llama-server.exe" (
  if exist "%LOCAL_MODELS_DIR%\qwen2.5-1.5b-instruct-q4_k_m.gguf" (
    echo [1/2] Старт локальной нейросети русского языка на CPU (127.0.0.1:8080)...
    start "Local-LLM-CPU" /B "%~dp0bin\win7-x64\llama-server.exe" -m "%LOCAL_MODELS_DIR%\qwen2.5-1.5b-instruct-q4_k_m.gguf" --host 127.0.0.1 --port 8080 -c 2048 -t %NUMBER_OF_PROCESSORS% --log-disable
  )
)

echo [2/2] Открытие интерфейса в браузере: http://127.0.0.1:3000 ...
start "" "http://127.0.0.1:3000"

if exist "%~dp0bin\win7-x64\node.exe" (
  if exist "%~dp0dist-server\server.cjs" (
    "%~dp0bin\win7-x64\node.exe" "%~dp0dist-server\server.cjs"
    goto :eof
  )
)

if exist "%~dp0dist-server\server.cjs" (
  node "%~dp0dist-server\server.cjs"
) else (
  npx tsx server.ts
)
pause
