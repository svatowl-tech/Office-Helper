import fs from 'fs';
import path from 'path';
import { buildSync } from 'esbuild';

const rootDir = process.cwd();
const entryFile = path.join(rootDir, 'src', 'standaloneFallback.ts');
const outHtmlFile = path.join(rootDir, 'Офисный-Помощник-Автономный.html');

const result = buildSync({
  entryPoints: [entryFile],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome70', 'firefox68', 'es2018'],
  write: false,
});

const bundledJs = result.outputFiles[0].text;

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Офисный помощник — Автономная версия (Без сервера, .bat и .sh)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #020617; color: #f1f5f9; height: 100vh; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; user-select: none; }
    header { padding: 24px; text-align: center; color: #94a3b8; font-size: 14px; font-weight: 500; }
    main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .center-box { width: 100%; max-width: 440px; text-align: center; }
    .main-btn { width: 100%; padding: 28px 32px; border-radius: 16px; border: none; background: #0284c7; color: #fff; cursor: pointer; box-shadow: 0 10px 25px rgba(2,132,199,0.25); transition: background 0.15s; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .main-btn:hover { background: #0ea5e9; }
    .main-btn-title { font-size: 20px; font-weight: 700; }
    .main-btn-sub { font-size: 12px; color: #e0f2fe; }
    .progress-wrap { margin-top: 20px; display: none; }
    .progress-bar-bg { width: 100%; height: 8px; background: #0f172a; border: 1px solid #1e293b; border-radius: 999px; overflow: hidden; margin-top: 6px; }
    .progress-bar-fill { height: 100%; width: 0%; background: #0ea5e9; transition: width 0.15s; }
    .error-box { margin-top: 14px; padding: 10px 14px; border-radius: 10px; background: rgba(127, 29, 29, 0.5); border: 1px solid rgba(185, 28, 28, 0.7); color: #fecaca; font-size: 12px; display: none; }
    footer { padding: 0 24px 24px; }
    .tray { max-width: 560px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; max-height: 190px; overflow-y: auto; }
    .tray-empty { text-align: center; color: #64748b; font-size: 12px; }
    .file-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 4px; border-bottom: 1px solid #1e293b; }
    .file-row:last-child { border-bottom: none; }
    .file-name { font-size: 14px; font-weight: 600; color: #f8fafc; }
    .file-meta { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .dl-btn { background: #059669; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .dl-btn:hover { background: #10b981; }
  </style>
</head>
<body>
  <header>Офисный помощник</header>
  <main>
    <div class="center-box">
      <input type="file" id="fileInput" accept=".docx,.xlsx,.pptx,.txt" style="display:none" />
      <button class="main-btn" onclick="document.getElementById('fileInput').click()">
        <span class="main-btn-title">Исправить русский язык</span>
        <span class="main-btn-sub">Word (.docx) · Excel (.xlsx) · PowerPoint (.pptx)</span>
      </button>
      <div class="progress-wrap" id="progressWrap">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#94a3b8;">
          <span id="progressLabel">Проверка...</span>
          <span id="progressPct">0%</span>
        </div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
      </div>
      <div class="error-box" id="errorBox"></div>
    </div>
  </main>
  <footer>
    <div class="tray">
      <div class="tray-empty" id="trayEmpty">Готовые файлы для скачивания появятся здесь после обработки</div>
      <div id="fileList"></div>
    </div>
  </footer>
  <script>${bundledJs}</script>
</body>
</html>
`;

fs.writeFileSync(outHtmlFile, html, 'utf8');
console.log('Generated standalone fallback HTML:', outHtmlFile);
