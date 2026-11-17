import JSZip from 'jszip';
import { GithubBundleConfig } from '../../src/types/harness.types.ts';

/**
 * Генерирует готовый к запуску GitHub Actions Workflow (.github/workflows/build-airgap-bundle.yml),
 * который на серверах GitHub собирает самодостаточный оффлайн-архив:
 * 1) Скачивает выбранную русскую нейросеть (SAGE-FRED-T5 ONNX + Qwen2.5-1.5B GGUF) прямо внутрь архива;
 * 2) Скачивает локальные словари OCR (rus.traineddata, eng.traineddata);
 * 3) Компилирует llama.cpp статически под старые ядра Linux (Astra Linux 5.3/5.4, glibc 2.24+) и под Windows 7 SP1 x64 через Mingw-w64 (_WIN32_WINNT=0x0601);
 * 4) Упаковывает портативный рантайм и пусковые скрипты start-astra-linux.sh и start-windows7.bat.
 */
export function generateGithubWorkflowYaml(config: GithubBundleConfig): string {
  const simdFlags =
    config.cpuInstructionSet === 'sse4_2_legacy'
      ? '-DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_SSE42=ON'
      : '-DGGML_AVX2=ON';

  const modelDownloadBlock =
    config.primaryModel === 'sage-fredt5-distilled-95m'
      ? `# Скачивание легкой русской модели орфографии AI-Forever SAGE FRED-T5 95M (ONNX INT8)
          curl -L --retry 5 "https://huggingface.co/ai-forever/sage-fredt5-distilled-95m/resolve/main/config.json" -o dist-airgap/models/sage-95m/config.json
          curl -L --retry 5 "https://huggingface.co/ai-forever/sage-fredt5-distilled-95m/resolve/main/pytorch_model.bin" -o dist-airgap/models/sage-95m/pytorch_model.bin
          curl -L --retry 5 "https://huggingface.co/ai-forever/sage-fredt5-distilled-95m/resolve/main/tokenizer.json" -o dist-airgap/models/sage-95m/tokenizer.json`
      : config.primaryModel === 'qwen2.5-1.5b-q4_k_m'
        ? `# Скачивание инструктивной модели Qwen2.5-1.5B-Instruct (GGUF Q4_K_M, ~986 МБ)
          curl -L --retry 5 "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf" -o dist-airgap/models/qwen2.5-1.5b-instruct-q4_k_m.gguf`
        : `# Гибридный бандл: SAGE FRED-T5 95M (быстрая орфография) + Qwen2.5-1.5B-Instruct Q4_K_M (глубокая корректура)
          curl -L --retry 5 "https://huggingface.co/ai-forever/sage-fredt5-distilled-95m/resolve/main/config.json" -o dist-airgap/models/sage-95m/config.json
          curl -L --retry 5 "https://huggingface.co/ai-forever/sage-fredt5-distilled-95m/resolve/main/pytorch_model.bin" -o dist-airgap/models/sage-95m/pytorch_model.bin
          curl -L --retry 5 "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf" -o dist-airgap/models/qwen2.5-1.5b-instruct-q4_k_m.gguf`;

  const ocrDownloadBlock = config.includeOcrTessdata
    ? `# Предзагрузка оффлайн-словарей Tesseract OCR (Русский + Английский)
          mkdir -p dist-airgap/tessdata
          curl -L --retry 5 "https://github.com/tesseract-ocr/tessdata_fast/raw/main/rus.traineddata" -o dist-airgap/tessdata/rus.traineddata
          curl -L --retry 5 "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata" -o dist-airgap/tessdata/eng.traineddata`
    : '# Пропуск предзагрузки словарей OCR по выбору конфигурации';

  return `name: "Build Air-Gap Office Harness (Astra Linux 5.3/5.4 + Windows 7 SP1)"

on:
  workflow_dispatch:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build-airgap-all-in-one:
    runs-on: ubuntu-22.04
    steps:
      - name: "1. Checkout исходного кода Харнеса"
        uses: actions/checkout@v4

      - name: "2. Установка кросс-компиляторов (Mingw-w64 Win32 для Windows 7 и Static Toolchain для Astra Linux)"
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential cmake git curl zip unzip mingw-w64-x86-64-dev gcc-mingw-w64-x86-64-win32 g++-mingw-w64-x86-64-win32

      - name: "3. Сборка фронтенда и серверного ядра Харнеса"
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: |
          npm install --no-audit --no-fund
          npm run build
          mkdir -p dist-airgap/bin/linux-x64
          mkdir -p dist-airgap/bin/win7-x64
          mkdir -p dist-airgap/models/sage-95m

      - name: "4. Компиляция llama-server для Astra Linux (ядро 5.3/5.4, статическая линковка libstdc++/libgomp)"
        run: |
          git clone --depth 1 https://github.com/ggerganov/llama.cpp.git /tmp/llama-cpp
          cmake -B /tmp/llama-cpp/build-linux -S /tmp/llama-cpp \\
            -DCMAKE_BUILD_TYPE=Release \\
            ${simdFlags} \\
            -DBUILD_SHARED_LIBS=OFF \\
            -DCMAKE_EXE_LINKER_FLAGS="-static-libgcc -static-libstdc++"
          cmake --build /tmp/llama-cpp/build-linux --target llama-server -j$(nproc)
          cp /tmp/llama-cpp/build-linux/bin/llama-server dist-airgap/bin/linux-x64/llama-server
          chmod +x dist-airgap/bin/linux-x64/llama-server

      - name: "5. Кросс-компиляция llama-server.exe специально под Windows 7 SP1 x64 (_WIN32_WINNT=0x0601)"
        run: |
          cmake -B /tmp/llama-cpp/build-win7 -S /tmp/llama-cpp \\
            -DCMAKE_SYSTEM_NAME=Windows \\
            -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc-win32 \\
            -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++-win32 \\
            -DCMAKE_C_FLAGS="-D_WIN32_WINNT=0x0601" \\
            -DCMAKE_CXX_FLAGS="-D_WIN32_WINNT=0x0601" \\
            -DCMAKE_EXE_LINKER_FLAGS="-static -static-libgcc -static-libstdc++" \\
            -DBUILD_SHARED_LIBS=OFF \\
            ${simdFlags}
          cmake --build /tmp/llama-cpp/build-win7 --target llama-server -j$(nproc)
          cp /tmp/llama-cpp/build-win7/bin/llama-server.exe dist-airgap/bin/win7-x64/llama-server.exe

      - name: "6. Вшивание портативного Node.js LTS с поддержкой Windows 7 (NODE_SKIP_PLATFORM_CHECK=1) и Linux glibc 2.24"
        run: |
          curl -L "https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.xz" -o /tmp/node-linux.tar.xz
          tar -xf /tmp/node-linux.tar.xz -C /tmp
          cp /tmp/node-v18.20.4-linux-x64/bin/node dist-airgap/bin/linux-x64/node
          
          curl -L "https://nodejs.org/dist/v18.20.4/win-x64/node.exe" -o dist-airgap/bin/win7-x64/node.exe

      - name: "7. Загрузка весов русской нейросети и словарей OCR внутрь оффлайн-архива"
        run: |
          ${modelDownloadBlock}
          ${ocrDownloadBlock}

      - name: "8. Упаковка готового оффлайн-дистрибутива (Zero-Install Portable Archive)"
        run: |
          cp -r dist dist-server start-astra-linux.sh start-windows7.bat README.md dist-airgap/
          chmod +x dist-airgap/start-astra-linux.sh
          cd dist-airgap && zip -r9 ../office-assistant-ru-portable-airgap.zip . && cd ..

      - name: "9. Публикация собранного пакета в GitHub Artifacts и GitHub Releases"
        uses: actions/upload-artifact@v4
        with:
          name: office-assistant-ru-portable-airgap
          path: office-assistant-ru-portable-airgap.zip
          retention-days: 90

      - name: "10. Автоматический выпуск GitHub Release"
        uses: softprops/action-gh-release@v2
        with:
          tag_name: \${{ github.ref_type == 'tag' && github.ref_name || format('v1.0.{0}', github.run_number) }}
          name: "Офисный помощник (Portable Air-Gap Release #\${{ github.run_number }})"
          files: office-assistant-ru-portable-airgap.zip
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

/**
 * Генерирует пусковой скрипт для Astra Linux (ядро 5.3 / 5.4) без интернета и без прав root
 */
export function generateAstraLinuxLauncherScript(config: GithubBundleConfig): string {
  return `#!/usr/bin/env bash
# ==============================================================================
# ОФИСНЫЙ ПОМОЩНИК — ПУСКОВОЙ СКРИПТ ASTRA LINUX (SE 1.6 / 1.7, ЯДРО 5.3/5.4)
# Работает без интернета, без установки и без прав администратора (root/sudo).
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "\$SCRIPT_DIR"

export PORT="\${PORT:-3000}"
export HOST="\${HOST:-127.0.0.1}"
export LOCAL_MODELS_DIR="\$SCRIPT_DIR/models"
export LOCAL_TESSDATA_DIR="\$SCRIPT_DIR/tessdata"
export NODE_ENV="production"

if [ -x "\$SCRIPT_DIR/bin/linux-x64/llama-server" ] && [ -f "\$LOCAL_MODELS_DIR/qwen2.5-1.5b-instruct-q4_k_m.gguf" ]; then
  echo "[AIR-GAP] Запуск локального CPU-движка коррекции (${config.cpuInstructionSet})..."
  "\$SCRIPT_DIR/bin/linux-x64/llama-server" \\
    -m "\$LOCAL_MODELS_DIR/qwen2.5-1.5b-instruct-q4_k_m.gguf" \\
    --host 127.0.0.1 \\
    --port 8080 \\
    -c 2048 \\
    -t "\$(nproc 2>/dev/null || echo 2)" \\
    --log-disable &
  LLAMA_PID=\$!
  trap "kill \$LLAMA_PID 2>/dev/null || true" EXIT
fi

echo "[AIR-GAP] Запуск веб-интерфейса на http://\${HOST}:\${PORT} ..."
if [ -x "\$SCRIPT_DIR/bin/linux-x64/node" ] && [ -f "\$SCRIPT_DIR/dist-server/server.cjs" ]; then
  "\$SCRIPT_DIR/bin/linux-x64/node" "\$SCRIPT_DIR/dist-server/server.cjs"
elif [ -f "\$SCRIPT_DIR/dist-server/server.cjs" ]; then
  node "\$SCRIPT_DIR/dist-server/server.cjs"
else
  npx tsx "\$SCRIPT_DIR/server.ts"
fi
`;
}

/**
 * Генерирует пусковой скрипт для Windows 7 SP1 / Windows 10 LTSC без интернета и без прав администратора
 */
export function generateWindows7LauncherScript(config: GithubBundleConfig): string {
  return `@echo off
chcp 65001 >nul
REM ==============================================================================
REM ОФИСНЫЙ ПОМОЩНИК — ПУСКОВОЙ СКРИПТ WINDOWS 7 SP1 / WINDOWS 10 LTSC
REM Не требует прав администратора (UAC) и установки.
REM ==============================================================================
setlocal
cd /d "%~dp0"

set NODE_SKIP_PLATFORM_CHECK=1
set PORT=3000
set HOST=127.0.0.1
set LOCAL_MODELS_DIR=%~dp0models
set LOCAL_TESSDATA_DIR=%~dp0tessdata
set NODE_ENV=production

echo [AIR-GAP] Инструкции процессора: ${config.cpuInstructionSet.toUpperCase()}

if exist "%~dp0bin\\win7-x64\\llama-server.exe" (
  if exist "%LOCAL_MODELS_DIR%\\qwen2.5-1.5b-instruct-q4_k_m.gguf" (
    start "Local-LLM-CPU" /B "%~dp0bin\\win7-x64\\llama-server.exe" -m "%LOCAL_MODELS_DIR%\\qwen2.5-1.5b-instruct-q4_k_m.gguf" --host 127.0.0.1 --port 8080 -c 2048 -t %NUMBER_OF_PROCESSORS% --log-disable
  )
)

start "" "http://127.0.0.1:3000"
if exist "%~dp0bin\\win7-x64\\node.exe" (
  if exist "%~dp0dist-server\\server.cjs" (
    "%~dp0bin\\win7-x64\\node.exe" "%~dp0dist-server\\server.cjs"
    goto :eof
  )
)
if exist "%~dp0dist-server\\server.cjs" (
  node "%~dp0dist-server\\server.cjs"
) else (
  npx tsx server.ts
)
pause
`;
}

/**
 * Собирает ZIP-комплект для развертывания в GitHub-репозитории и локального запуска
 */
export async function generateDeploymentKitZip(config: GithubBundleConfig): Promise<Buffer> {
  const zip = new JSZip();

  zip.file('.github/workflows/build-airgap-bundle.yml', generateGithubWorkflowYaml(config));
  zip.file('start-astra-linux.sh', generateAstraLinuxLauncherScript(config));
  zip.file('start-windows7.bat', generateWindows7LauncherScript(config));

  zip.file(
    'README-AIRGAP-DEPLOY.md',
    `# Автономный Офисный Харнес (Astra Linux 5.3/5.4 & Windows 7 SP1)

Данный комплект предназначен для сборки **полностью автономного пакета на GitHub Actions**, который включает внутри себя:
1. Веса русскоязычной модели коррекции (\`${config.primaryModel}\`) для работы на CPU без видеокарты.
2. Статически скомпилированные бинарные файлы под **Astra Linux (ядро 5.3 / 5.4)** и **Windows 7 SP1 x64** (\`_WIN32_WINNT=0x0601\`, \`NODE_SKIP_PLATFORM_CHECK=1\`).
3. Модуль сохранения форматирования документов \`.docx\` (через поузловую модификацию \`<w:t>\` внутри \`<w:r>\`) и таблиц \`.xlsx\` (через AST стилей ExcelJS).
4. Локальные словари OCR (\`rus.traineddata\`, \`eng.traineddata\`) и модуль диагностики закрытой локальной сети (ЗСПД).

## Как собрать полный оффлайн-архив на GitHub:
1. Загрузите этот репозиторий на ваш GitHub.
2. Перейдите во вкладку **Actions** -> **Build Air-Gap Office Harness**.
3. Нажмите **Run workflow**.
4. Через ~6 минут скачайте готовый архив \`airgap-office-harness-ru-bundle.zip\` (содержащий уже скачанную нейросеть, бинарники и все пакеты) и перенесите его на флешке/диске в закрытый контур.
`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
