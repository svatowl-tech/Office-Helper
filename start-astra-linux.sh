#!/usr/bin/env bash
# ==============================================================================
# ОФИСНЫЙ ПОМОЩНИК (AIR-GAP EDITION) — ПУСКОВОЙ СКРИПТ ASTRA LINUX (ЯДРО 5.3/5.4)
# Не требует интернета, прав администратора (root/sudo) и установки пакетов.
# Запускается прямо из текущей папки или с USB-носителя.
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PORT="${PORT:-3000}"
export HOST="${HOST:-127.0.0.1}"
export LOCAL_MODELS_DIR="$SCRIPT_DIR/models"
export LOCAL_TESSDATA_DIR="$SCRIPT_DIR/tessdata"
export NODE_ENV="production"

echo "=================================================================="
echo " ОФИСНЫЙ ПОМОЩНИК — АВТОНОМНЫЙ РЕЖИМ (БЕЗ ИНТЕРНЕТА И БЕЗ ROOT)"
echo " ОС: $(uname -srm)"
echo " Рабочая директория: $SCRIPT_DIR"
echo "=================================================================="

# 1. Если в пакете присутствует локальный бинарник llama-server и GGUF-модель, поднимаем CPU-инференс в фоне
if [ -x "$SCRIPT_DIR/bin/linux-x64/llama-server" ] && [ -f "$LOCAL_MODELS_DIR/qwen2.5-1.5b-instruct-q4_k_m.gguf" ]; then
  echo "[1/2] Запуск локальной нейросети русского языка на CPU (порт 8080)..."
  "$SCRIPT_DIR/bin/linux-x64/llama-server" \
    -m "$LOCAL_MODELS_DIR/qwen2.5-1.5b-instruct-q4_k_m.gguf" \
    --host 127.0.0.1 \
    --port 8080 \
    -c 2048 \
    -t "$(nproc 2>/dev/null || echo 2)" \
    --log-disable &
  LLAMA_PID=$!
  trap "kill $LLAMA_PID 2>/dev/null || true" EXIT
fi

echo "[2/2] Запуск веб-интерфейса на http://${HOST}:${PORT}"

# Автоматическое открытие браузера пользователя через 1.5 сек (без прав root)
(
  sleep 1.5
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://${HOST}:${PORT}" >/dev/null 2>&1 || true
  elif command -v fly-fm >/dev/null 2>&1; then
    fly-fm "http://${HOST}:${PORT}" >/dev/null 2>&1 || true
  fi
) &

# Запуск вшитого портативного Node.js и предсобранного бандла dist-server/server.cjs
if [ -x "$SCRIPT_DIR/bin/linux-x64/node" ] && [ -f "$SCRIPT_DIR/dist-server/server.cjs" ]; then
  "$SCRIPT_DIR/bin/linux-x64/node" "$SCRIPT_DIR/dist-server/server.cjs"
elif [ -f "$SCRIPT_DIR/dist-server/server.cjs" ]; then
  node "$SCRIPT_DIR/dist-server/server.cjs"
else
  npx tsx "$SCRIPT_DIR/server.ts"
fi
