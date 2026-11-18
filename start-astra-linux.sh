#!/usr/bin/env bash
# ==============================================================================
# ОФИСНЫЙ ПОМОЩНИК (AIR-GAP EDITION) — ПУСКОВОЙ СКРИПТ ASTRA LINUX (1.6 / 1.7.11)
# Не требует интернета, прав администратора (root/sudo) и установки пакетов.
# Работает на ядрах 5.3, 5.4 и 6.1.188-1-generic (Astra Linux SE Усиленный/Воронеж).
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PORT="${PORT:-3000}"
export HOST="${HOST:-127.0.0.1}"
export LOCAL_MODELS_DIR="$SCRIPT_DIR/models"
export LOCAL_TESSDATA_DIR="$SCRIPT_DIR/tessdata"
export NODE_ENV="production"
export AUTO_OPEN_BROWSER="1"

echo "=================================================================="
echo " ОФИСНЫЙ ПОМОЩНИК — АВТОНОМНЫЙ РЕЖИМ (БЕЗ ИНТЕРНЕТА И БЕЗ ROOT)"
echo " ОС: $(uname -srm)"
echo " Рабочая директория: $SCRIPT_DIR"
echo "=================================================================="
echo "Запуск веб-интерфейса и локального CPU-движка на http://${HOST}:${PORT}"

# Запуск вшитого портативного Node.js (glibc 2.28 — полная совместимость с Astra Linux 1.7.11)
if [ -x "$SCRIPT_DIR/bin/linux-x64/node" ] && [ -f "$SCRIPT_DIR/dist-server/server.cjs" ]; then
  "$SCRIPT_DIR/bin/linux-x64/node" "$SCRIPT_DIR/dist-server/server.cjs"
elif [ -f "$SCRIPT_DIR/dist-server/server.cjs" ]; then
  node "$SCRIPT_DIR/dist-server/server.cjs"
else
  npx tsx "$SCRIPT_DIR/server.ts"
fi
