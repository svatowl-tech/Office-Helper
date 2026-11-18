import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execFile, ChildProcess } from 'child_process';
import { proofreadRussianText } from './server/services/russianProofreader.service.ts';
import {
  generateSampleDocxWithErrors,
  generateSampleXlsxWithErrors,
  processDocxBuffer,
  processPptxBuffer,
  processXlsxBuffer,
} from './server/services/documentProcessor.service.ts';
import {
  getLocalModelBenchmarks,
  getSystemAndNetworkTelemetry,
  probeTcpNode,
} from './server/services/networkManager.service.ts';
import {
  generateAstraLinuxLauncherScript,
  generateDeploymentKitZip,
  generateGithubWorkflowYaml,
  generateWindows7LauncherScript,
} from './server/services/githubBundleGenerator.service.ts';
import { GithubBundleConfig } from './src/types/harness.types.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // 30 MB
  },
});

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';

  app.use(express.json({ limit: '15mb' }));

  // 1. Проверка текста на русском языке (инлайн-редактор и постобработка OCR)
  app.post('/api/proofread/text', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      if (typeof text !== 'string') {
        res.status(400).json({ error: 'Поле text обязательно и должно быть строкой.' });
        return;
      }
      const startTime = Date.now();
      const result = await proofreadRussianText(text);
      res.json({
        ...result,
        processingTimeMs: Math.max(4, Date.now() - startTime),
      });
    } catch (err) {
      console.error('Ошибка проверки текста:', err);
      res.status(500).json({ error: 'Внутренняя ошибка модуля лингвистической коррекции.' });
    }
  });

  // 2. Загрузка и коррекция реального файла .docx / .xlsx с сохранением 100% форматирования
  app.post('/api/proofread/document', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Файл не передан.' });
        return;
      }

      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(originalName).toLowerCase();

      if (ext === '.docx') {
        const result = await processDocxBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.xlsx') {
        const result = await processXlsxBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.pptx') {
        const result = await processPptxBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.txt' || ext === '.md') {
        const startTime = Date.now();
        const rawText = file.buffer.toString('utf8');
        const proofread = await proofreadRussianText(rawText);
        const outBuffer = Buffer.from(proofread.correctedText, 'utf8');

        res.json({
          fileName: originalName,
          fileType: 'txt',
          fileSizeBytes: outBuffer.length,
          processingTimeMs: Math.max(5, Date.now() - startTime),
          engineUsed: proofread.engineUsed,
          totalSegments: 1,
          modifiedSegments: proofread.issues.length > 0 ? 1 : 0,
          totalIssuesFixed: proofread.issues.length,
          segments: [
            {
              id: 'txt-seg-1',
              location: 'Текстовый документ (UTF-8)',
              elementType: 'paragraph',
              originalText: rawText,
              correctedText: proofread.correctedText,
              preservedFormattingMeta: 'Кодировка UTF-8, переводы строк сохранены',
              issues: proofread.issues,
              applied: proofread.issues.length > 0,
            },
          ],
          downloadBase64: outBuffer.toString('base64'),
          mimeType: 'text/plain;charset=utf-8',
        });
        return;
      }

      res.status(400).json({
        error: `Формат "${ext}" требует конвертации или поддерживаются контейнеры .docx, .xlsx, .txt.`,
      });
    } catch (err) {
      console.error('Ошибка обработки документа:', err);
      res.status(500).json({
        error: 'Не удалось разобрать структуру документа. Убедитесь, что файл не поврежден.',
      });
    }
  });

  // 3. Генерация и мгновенная проверка эталонного образца .docx или .xlsx со сложной версткой
  app.post('/api/proofread/sample', async (req: Request, res: Response) => {
    try {
      const { type } = req.body as { type?: 'docx' | 'xlsx' };
      if (type === 'xlsx') {
        const sampleBuf = await generateSampleXlsxWithErrors();
        const result = await processXlsxBuffer(sampleBuf, 'Ведомость_узлов_ЗСПД_образец.xlsx');
        res.json({
          ...result,
          originalSampleBase64: sampleBuf.toString('base64'),
        });
        return;
      }

      const sampleBuf = await generateSampleDocxWithErrors();
      const result = await processDocxBuffer(sampleBuf, 'Служебная_записка_АстраЛинукс_образец.docx');
      res.json({
        ...result,
        originalSampleBase64: sampleBuf.toString('base64'),
      });
    } catch (err) {
      console.error('Ошибка генерации образца:', err);
      res.status(500).json({ error: 'Не удалось сформировать демонстрационный документ.' });
    }
  });

  // 4. Получение каталога локальных нейросетей (CPU / No-GPU / Astra Linux 5.3 / Win7)
  app.get('/api/models/catalog', (_req: Request, res: Response) => {
    res.json({
      models: getLocalModelBenchmarks(),
    });
  });

  // 5. Менеджмент локальной сети: системная телеметрия и список сетевых интерфейсов
  app.get('/api/network/telemetry', (_req: Request, res: Response) => {
    try {
      const telemetry = getSystemAndNetworkTelemetry();
      res.json(telemetry);
    } catch (err) {
      console.error('Ошибка чтения сетевых интерфейсов:', err);
      res.status(500).json({ error: 'Не удалось опросить сетевые интерфейсы узла.' });
    }
  });

  // 6. Сканирование TCP-портов и проверка доступности сервисов в локальной подсети
  app.post('/api/network/probe', async (req: Request, res: Response) => {
    try {
      const { host, ports } = req.body as { host?: string; ports?: number[] };
      const targetHost = (host || '127.0.0.1').trim();
      const targetPorts = Array.isArray(ports) && ports.length > 0
        ? ports.slice(0, 15)
        : [22, 80, 443, 445, 631, 3000, 3389, 5432, 8080, 9100];

      const results = await Promise.all(
        targetPorts.map((port) => probeTcpNode(targetHost, Number(port), 1000))
      );

      res.json({
        host: targetHost,
        results,
      });
    } catch (err) {
      console.error('Ошибка TCP-проверки:', err);
      res.status(500).json({ error: 'Сбой при проверке сетевых портов.' });
    }
  });

  // 7. Генерация GitHub Actions Workflow и оффлайн-скриптов запуска под Astra Linux 5.3/5.4 и Windows 7
  app.post('/api/bundle/generate', async (req: Request, res: Response) => {
    try {
      const config: GithubBundleConfig = {
        targetLinux: req.body?.targetLinux || 'astra_1_7_kernel_5_4',
        targetWindows: req.body?.targetWindows || 'win7_sp1_x64',
        primaryModel: req.body?.primaryModel || 'hybrid_sage_qwen',
        includeOcrTessdata: req.body?.includeOcrTessdata ?? true,
        includeLibreOfficeHeadless: req.body?.includeLibreOfficeHeadless ?? true,
        cpuInstructionSet: req.body?.cpuInstructionSet || 'sse4_2_legacy',
      };

      const workflowYaml = generateGithubWorkflowYaml(config);
      const linuxScript = generateAstraLinuxLauncherScript(config);
      const win7Script = generateWindows7LauncherScript(config);
      const zipBuf = await generateDeploymentKitZip(config);

      res.json({
        workflowYaml,
        linuxScript,
        win7Script,
        zipBase64: zipBuf.toString('base64'),
      });
    } catch (err) {
      console.error('Ошибка генерации комплекта сборки:', err);
      res.status(500).json({ error: 'Не удалось сформировать конфигурацию оффлайн-сборки.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Определяем базовую директорию как для обычного запуска, так и для упакованного бинарника
    const baseDir = path.dirname(process.execPath);
    const candidateDistDirs = [
      path.join(process.cwd(), 'dist'),
      path.join(baseDir, 'dist'),
      path.join(baseDir, '..', 'dist'),
    ];
    const resolvedDist = candidateDistDirs.find((d) => fs.existsSync(path.join(d, 'index.html')));

    if (resolvedDist) {
      app.use(express.static(resolvedDist));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(resolvedDist, 'index.html'));
      });
    } else {
      // Встроенный резервный автономный интерфейс (если запущен один голый .exe/.bin файл без папки dist)
      app.get('*', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(EMBEDDED_MINIMAL_HTML);
      });
    }
  }

  // Автоматический старт локального движка llama-server из C++/нативного бинарника (без участия .bat/.sh)
  let llamaProcess: ChildProcess | null = null;
  try {
    const baseDir = process.cwd();
    const llamaBinPath = resolveBestLlamaBinaryPath(baseDir);
    const ggufModelPath = path.join(
      process.env.LOCAL_MODELS_DIR || path.join(baseDir, 'models'),
      'qwen2.5-1.5b-instruct-q4_k_m.gguf'
    );

    if (llamaBinPath && fs.existsSync(llamaBinPath) && fs.existsSync(ggufModelPath)) {
      console.debug(`Запуск локального CPU-движка: ${llamaBinPath}`);
      llamaProcess = spawn(
        llamaBinPath,
        [
          '-m',
          ggufModelPath,
          '--host',
          '127.0.0.1',
          '--port',
          '8080',
          '-c',
          '2048',
          '-t',
          String(Math.max(1, os.cpus().length)),
          '--log-disable',
        ],
        { stdio: 'ignore', windowsHide: true }
      );
      process.on('exit', () => {
        llamaProcess?.kill();
      });
    }
  } catch (err) {
    console.debug('Локальный GGUF-воркер не запущен, используется встроенное ядро коррекции:', err);
  }

  app.listen(PORT, HOST, () => {
    const localUrl = `http://127.0.0.1:${PORT}`;
    console.debug(`Air-Gap Office Harness Server listening on ${localUrl}`);

    // Если запущен в production/portable-режиме напрямую через .exe или бинарник — сами открываем браузер без cmd.exe / bash
    if (process.env.NODE_ENV === 'production' || process.env.AUTO_OPEN_BROWSER === '1') {
      openLocalBrowserSafely(localUrl);
    }
  });
}

/**
 * Автоматически выбирает оптимальный бинарник llama-server:
 * - Windows 8 / 8.1 / 10 / 11 -> немодифицированный bin/win8plus-x64/llama-server.exe (с fallback на win7-x64)
 * - Windows 7 SP1 (NT 6.1)      -> патченный под Win7 bin/win7-x64/llama-server.exe
 * - Astra Linux (i3-9100 и др.) -> bin/linux-x64-avx2/llama-server если CPU поддерживает AVX2, иначе универсальный SSE4.2
 */
function resolveBestLlamaBinaryPath(baseDir: string): string | null {
  const platform = os.platform();
  const forced = process.env.LLAMA_VARIANT;

  if (platform === 'win32') {
    const win8PlusBin = path.join(baseDir, 'bin', 'win8plus-x64', 'llama-server.exe');
    const win7Bin = path.join(baseDir, 'bin', 'win7-x64', 'llama-server.exe');

    if (forced === 'win7' && fs.existsSync(win7Bin)) return win7Bin;
    if (forced === 'win8plus' && fs.existsSync(win8PlusBin)) return win8PlusBin;

    const parts = os.release().split('.').map(Number);
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    const isWin8Plus = major >= 10 || (major === 6 && minor >= 2);

    if (isWin8Plus && fs.existsSync(win8PlusBin)) return win8PlusBin;
    if (fs.existsSync(win7Bin)) return win7Bin;
    if (fs.existsSync(win8PlusBin)) return win8PlusBin;
    return null;
  }

  const linuxAvx2Bin = path.join(baseDir, 'bin', 'linux-x64-avx2', 'llama-server');
  const linuxSseBin = path.join(baseDir, 'bin', 'linux-x64', 'llama-server');

  if (forced === 'sse42' && fs.existsSync(linuxSseBin)) return linuxSseBin;
  if (forced === 'avx2' && fs.existsSync(linuxAvx2Bin)) return linuxAvx2Bin;

  try {
    const cpuInfo = fs.existsSync('/proc/cpuinfo') ? fs.readFileSync('/proc/cpuinfo', 'utf8') : '';
    const hasAvx2 = /\bavx2\b/i.test(cpuInfo);
    if (hasAvx2 && fs.existsSync(linuxAvx2Bin)) return linuxAvx2Bin;
  } catch {
    // fallback to SSE4.2
  }

  return fs.existsSync(linuxSseBin) ? linuxSseBin : null;
}

/**
 * Открывает браузер напрямую через системный вызов без привязки к .bat/.sh
 */
function openLocalBrowserSafely(url: string): void {
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      // rundll32 url.dll,FileProtocolHandler работает даже когда cmd.exe и .bat полностью заблокированы политиками GPO!
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true });
    } else if (platform === 'linux') {
      execFile('xdg-open', [url]);
    } else if (platform === 'darwin') {
      execFile('open', [url]);
    }
  } catch {
    // Игнорируем ошибку, если запуск происходит на сервере без графической оболочки
  }
}

/**
 * Автономный HTML-интерфейс, вшитый прямо внутрь бинарного кода сервера.
 * Позволяет работать даже в том случае, если пользователь скопировал только 1 исполняемый файл
 * или если браузер блокирует внешние ресурсы.
 */
const EMBEDDED_MINIMAL_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Офисный помощник — Автономный режим</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: #020617; color: #f1f5f9; height: 100vh; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; user-select: none; }
  header { padding: 24px; text-align: center; color: #94a3b8; font-size: 14px; font-weight: 500; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .center-box { width: 100%; max-width: 440px; text-align: center; }
  .main-btn { width: 100%; padding: 28px 32px; border-radius: 16px; border: none; background: #0284c7; color: #fff; cursor: pointer; box-shadow: 0 10px 25px rgba(2,132,199,0.25); transition: background 0.15s; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .main-btn:hover { background: #0ea5e9; }
  .main-btn:disabled { opacity: 0.6; pointer-events: none; }
  .main-btn-title { font-size: 20px; font-weight: 700; }
  .main-btn-sub { font-size: 12px; color: #e0f2fe; }
  .progress-wrap { margin-top: 20px; display: none; }
  .progress-bar-bg { width: 100%; height: 8px; background: #0f172a; border: 1px solid #1e293b; border-radius: 999px; overflow: hidden; margin-top: 6px; }
  .progress-bar-fill { height: 100%; width: 0%; background: #0ea5e9; transition: width 0.15s; }
  footer { padding: 0 24px 24px; }
  .tray { max-width: 560px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; max-height: 180px; overflow-y: auto; }
  .tray-empty { text-align: center; color: #64748b; font-size: 12px; }
  .file-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 4px; border-bottom: 1px solid #1e293b; }
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
      <button class="main-btn" id="uploadBtn" onclick="document.getElementById('fileInput').click()">
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
    </div>
  </main>
  <footer>
    <div class="tray" id="tray">
      <div class="tray-empty" id="trayEmpty">Готовые файлы для скачивания появятся здесь после обработки</div>
      <div id="fileList"></div>
    </div>
  </footer>
<script>
  const fileInput = document.getElementById('fileInput');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressPct = document.getElementById('progressPct');
  const progressLabel = document.getElementById('progressLabel');
  const trayEmpty = document.getElementById('trayEmpty');
  const fileList = document.getElementById('fileList');

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'Проверка: ' + file.name;
    let pct = 15;
    progressFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    const timer = setInterval(() => {
      if (pct < 88) { pct += 12; progressFill.style.width = pct + '%'; progressPct.textContent = pct + '%'; }
    }, 120);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/proofread/document', { method: 'POST', body: formData });
      const data = await res.json();
      clearInterval(timer);
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; }, 250);

      if (res.ok) {
        trayEmpty.style.display = 'none';
        const row = document.createElement('div');
        row.className = 'file-row';
        row.innerHTML = '<div><div class="file-name">' + data.fileName + '</div><div class="file-meta">Готовый файл · Исправлено ошибок: ' + data.totalIssuesFixed + ' · Оформление сохранено</div></div>';
        const btn = document.createElement('button');
        btn.className = 'dl-btn';
        btn.textContent = 'Скачать';
        btn.onclick = () => {
          const bin = atob(data.downloadBase64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const blob = new Blob([arr], { type: data.mimeType });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'Исправлено_' + data.fileName;
          a.click();
        };
        row.appendChild(btn);
        fileList.prepend(row);
      }
    } catch (err) {
      clearInterval(timer);
      progressWrap.style.display = 'none';
    }
    fileInput.value = '';
  });
</script>
</body>
</html>`;

startServer();

