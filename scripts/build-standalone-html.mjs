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
    header { padding: 20px 24px; text-align: center; color: #94a3b8; font-size: 14px; font-weight: 500; }
    main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .center-box { width: 100%; max-width: 480px; text-align: center; display: flex; flex-direction: column; gap: 12px; }
    .main-btn { width: 100%; padding: 20px 24px; border-radius: 16px; border: none; background: #0284c7; color: #fff; cursor: pointer; box-shadow: 0 10px 25px rgba(2,132,199,0.25); transition: background 0.15s; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .main-btn:hover { background: #0ea5e9; }
    .main-btn.ocr-btn { background: #4f46e5; box-shadow: 0 10px 25px rgba(79,70,229,0.25); }
    .main-btn.ocr-btn:hover { background: #6366f1; }
    .main-btn.dict-btn { background: #0f172a; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(15,23,42,0.4); }
    .main-btn.dict-btn:hover { background: #1e293b; border-color: #f43f5e; }
    .main-btn-title { font-size: 18px; font-weight: 700; }
    .main-btn-sub { font-size: 12px; color: #e0f2fe; }
    .dict-panel { background: #0f172a; border: 1px solid #ef4444; border-radius: 16px; padding: 16px; display: none; flex-direction: column; align-items: center; gap: 10px; }
    .dict-panel.paused { border-color: #f59e0b; }
    .red-dot { width: 12px; height: 12px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 12px #ef4444; display: inline-block; animation: pulse 1.1s infinite; }
    .red-dot.paused { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.88); } }
    .dict-actions { display: flex; gap: 8px; width: 100%; justify-content: center; }
    .ctrl-btn { padding: 9px 16px; border-radius: 10px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; }
    .ctrl-pause { background: #334155; color: #f8fafc; }
    .ctrl-finish { background: #dc2626; color: #fff; }
    .format-switch { display: inline-flex; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 3px; gap: 4px; margin-top: 2px; }
    .fmt-opt { border: none; background: transparent; color: #94a3b8; font-size: 11px; font-weight: 600; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
    .fmt-opt.active { background: #4f46e5; color: #fff; }
    .progress-wrap { margin-top: 6px; display: none; }
    .progress-bar-bg { width: 100%; height: 8px; background: #0f172a; border: 1px solid #1e293b; border-radius: 999px; overflow: hidden; margin-top: 6px; }
    .progress-bar-fill { height: 100%; width: 0%; background: #0ea5e9; transition: width 0.15s; }
    .error-box { margin-top: 8px; padding: 10px 14px; border-radius: 10px; background: rgba(127, 29, 29, 0.5); border: 1px solid rgba(185, 28, 28, 0.7); color: #fecaca; font-size: 12px; display: none; }
    footer { padding: 0 24px 20px; }
    .tray { max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; max-height: 180px; overflow-y: auto; }
    .tray-empty { text-align: center; color: #64748b; font-size: 12px; }
    .file-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 4px; border-bottom: 1px solid #1e293b; }
    .file-row:last-child { border-bottom: none; }
    .file-name { font-size: 14px; font-weight: 600; color: #f8fafc; }
    .file-meta { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .btn-group { display: flex; align-items: center; gap: 6px; }
    .dl-btn { background: #059669; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .dl-btn:hover { background: #10b981; }
    .dl-btn.alt { background: #334155; color: #e2e8f0; }
    .dl-btn.alt:hover { background: #475569; }
  </style>
</head>
<body>
  <header>Офисный помощник</header>
  <main>
    <div class="center-box">
      <input type="file" id="fileInput" accept=".docx,.xlsx,.pptx,.txt" style="display:none" />
      <input type="file" id="ocrInput" accept=".pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp" style="display:none" />
      <button class="main-btn" onclick="document.getElementById('fileInput').click()">
        <span class="main-btn-title">Исправить русский язык</span>
        <span class="main-btn-sub">Word (.docx) · Excel (.xlsx) · PowerPoint (.pptx)</span>
      </button>
      <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
        <button class="main-btn ocr-btn" onclick="document.getElementById('ocrInput').click()">
          <span class="main-btn-title">Распознать PDF (картинку)</span>
          <span class="main-btn-sub" id="ocrBtnSub">PDF · PNG · JPG · TIFF → Word (.docx) или Excel (.xlsx)</span>
        </button>
        <div class="format-switch">
          <button type="button" class="fmt-opt active" id="fmtDocx">Выдать Word (.docx)</button>
          <button type="button" class="fmt-opt" id="fmtXlsx">Выдать Excel (.xlsx)</button>
        </div>
      </div>
      <button class="main-btn dict-btn" id="dictStartBtn">
        <span class="main-btn-title">Надиктовать текст</span>
        <span class="main-btn-sub">Локальный Whisper (CPU) → Улучшение и исправление → Word (.docx)</span>
      </button>
      <div class="dict-panel" id="dictPanel">
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;">
          <span class="red-dot" id="dictDot"></span>
          <span id="dictStatusText">Идёт запись (Whisper)...</span>
          <span id="dictTimer" style="font-family:monospace;color:#cbd5e1;">00:00</span>
        </div>
        <div class="dict-actions">
          <button type="button" class="ctrl-btn ctrl-pause" id="dictPauseBtn">На паузу</button>
          <button type="button" class="ctrl-btn ctrl-finish" id="dictFinishBtn">Завершить → Word (.docx)</button>
        </div>
      </div>
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
