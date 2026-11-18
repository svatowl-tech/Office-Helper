@echo off
chcp 65001 >nul
REM ==============================================================================
REM ОФИСНЫЙ ПОМОЩНИК (AIR-GAP EDITION) — ПУСКОВОЙ СКРИПТ WINDOWS 7 / 8 / 8.1 / 10 / 11
REM Работает БЕЗ прав администратора (UAC не требуется), БЕЗ интернета и БЕЗ установки.
REM Сервер автоматически выбирает немодифицированный llama-server.exe (Win 8+)
REM или патченный llama-server.exe (Windows 7 SP1).
REM ==============================================================================
setlocal
cd /d "%~dp0"

set NODE_SKIP_PLATFORM_CHECK=1
set PORT=3000
set HOST=127.0.0.1
set LOCAL_MODELS_DIR=%~dp0models
set LOCAL_TESSDATA_DIR=%~dp0tessdata
set NODE_ENV=production
set AUTO_OPEN_BROWSER=1

echo ==================================================================
echo  ОФИСНЫЙ ПОМОЩНИК — АВТОНОМНЫЙ РЕЖИМ (БЕЗ ИНТЕРНЕТА И АДМИН-ПРАВ)
echo  Папка запуска: %~dp0
echo ==================================================================
echo Запуск локального сервера и автоматический выбор бинарника под версию Windows...

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
