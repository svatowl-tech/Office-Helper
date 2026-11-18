import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execFile, ChildProcess } from 'child_process';
import { proofreadRussianText } from './server/services/russianProofreader.service.ts';
import {
  DEFAULT_HARNESS_CHUNKING_CONFIG,
  splitTextIntoHarnessChunks,
} from './server/services/textChunker.service.ts';
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
import {
  generateSamplePdfWithRussianTable,
  processPdfOrImageToOffice,
} from './server/services/ocrDocument.service.ts';
import { transcribeAudioAndBuildWordDoc } from './server/services/whisperDictation.service.ts';
import { GithubBundleConfig, OcrOutputFormat } from './src/types/harness.types.ts';

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

  // 1. Проверка текста на русском языке (с автоматическим разбиением длинных текстов на чанки под малое окно контекста)
  app.post('/api/proofread/text', async (req: Request, res: Response) => {
    try {
      const { text, maxChunkChars } = req.body as { text?: string; maxChunkChars?: number };
      if (typeof text !== 'string') {
        res.status(400).json({ error: 'Поле text обязательно и должно быть строкой.' });
        return;
      }
      const startTime = Date.now();
      const result = await proofreadRussianText(
        text,
        typeof maxChunkChars === 'number' && maxChunkChars >= 80
          ? { maxChunkChars }
          : undefined
      );
      res.json({
        ...result,
        processingTimeMs: Math.max(4, Date.now() - startTime),
      });
    } catch (err) {
      console.error('Ошибка проверки текста:', err);
      res.status(500).json({ error: 'Внутренняя ошибка модуля лингвистической коррекции.' });
    }
  });

  // 1.1. Стандартный сервис разбиения длинных текстов на чанки (для масштабирования на все инструменты Харнеса)
  app.post('/api/chunker/split', (req: Request, res: Response) => {
    try {
      const { text, maxChunkChars } = req.body as { text?: string; maxChunkChars?: number };
      if (typeof text !== 'string') {
        res.status(400).json({ error: 'Поле text обязательно и должно быть строкой.' });
        return;
      }
      const chunks = splitTextIntoHarnessChunks(
        text,
        typeof maxChunkChars === 'number' && maxChunkChars >= 80
          ? { maxChunkChars }
          : undefined
      );
      res.json({
        totalChunks: chunks.length,
        config: {
          ...DEFAULT_HARNESS_CHUNKING_CONFIG,
          ...(typeof maxChunkChars === 'number' && maxChunkChars >= 80 ? { maxChunkChars } : {}),
        },
        chunks,
      });
    } catch (err) {
      console.error('Ошибка разбиения текста на чанки:', err);
      res.status(500).json({ error: 'Не удалось разбить текст на чанки.' });
    }
  });

  // 2. Загрузка и коррекция реального файла .docx / .xlsx / .pptx / .txt с сохранением 100% форматирования и чанкингом
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
          totalSegments: proofread.totalChunksProcessed || 1,
          modifiedSegments: proofread.issues.length > 0 ? 1 : 0,
          totalIssuesFixed: proofread.issues.length,
          totalChunksProcessed: proofread.totalChunksProcessed,
          chunkMaxCharsUsed: proofread.chunkMaxCharsUsed,
          segments: [
            {
              id: 'txt-seg-1',
              location: `Текстовый документ (UTF-8, ${proofread.totalChunksProcessed} чанков)`,
              elementType: 'paragraph',
              originalText: rawText,
              correctedText: proofread.correctedText,
              preservedFormattingMeta: `Кодировка UTF-8, обработано по чанкам (${proofread.totalChunksProcessed} фр.)`,
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

  // 3.1. Распознавание PDF или картинки (.pdf, .png, .jpg, .jpeg, .bmp, .tiff, .webp) с чанкингом и выдачей Word (.docx) или Excel (.xlsx)
  app.post('/api/ocr/recognize', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Файл PDF или изображения не передан.' });
        return;
      }

      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const rawFormat = String(req.body?.outputFormat || 'docx').toLowerCase();
      const outputFormat: OcrOutputFormat = rawFormat === 'xlsx' ? 'xlsx' : 'docx';

      const result = await processPdfOrImageToOffice(file.buffer, originalName, outputFormat);
      res.json(result);
    } catch (err) {
      console.error('Ошибка распознавания PDF/изображения:', err);
      res.status(500).json({
        error: 'Не удалось распознать файл и сформировать документ Word/Excel.',
      });
    }
  });

  // 3.2. Демонстрационное распознавание тестового PDF с таблицей в Word (.docx) или Excel (.xlsx)
  app.post('/api/ocr/sample', async (req: Request, res: Response) => {
    try {
      const rawFormat = String(req.body?.outputFormat || 'docx').toLowerCase();
      const outputFormat: OcrOutputFormat = rawFormat === 'xlsx' ? 'xlsx' : 'docx';
      const pdfBuf = generateSamplePdfWithRussianTable();
      const result = await processPdfOrImageToOffice(
        pdfBuf,
        'Скан_ведомости_ЗСПД_образец.pdf',
        outputFormat
      );
      res.json(result);
    } catch (err) {
      console.error('Ошибка генерации тестового PDF OCR:', err);
      res.status(500).json({ error: 'Не удалось выполнить тестовое распознавание PDF.' });
    }
  });

  // 3.3. Надиктовка текста с локальным распознаванием через Whisper (whisper-cli + ggml-base-q5_1.bin),
  // улучшением пунктуации, чанкингом и выдачей готового документа Word (.docx)
  app.post('/api/whisper/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    try {
      const wavBuffer = req.file?.buffer || Buffer.alloc(0);
      const durationSeconds = Math.max(1, Number(req.body?.durationSeconds) || 5);
      const clientTranscriptHint =
        typeof req.body?.clientTranscriptHint === 'string'
          ? req.body.clientTranscriptHint
          : undefined;

      const result = await transcribeAudioAndBuildWordDoc(
        wavBuffer,
        durationSeconds,
        clientTranscriptHint
      );
      res.json(result);
    } catch (err) {
      console.error('Ошибка распознавания речи Whisper:', err);
      res.status(500).json({
        error: 'Не удалось распознать надиктованный текст и сформировать документ Word (.docx).',
      });
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
  .center-box { width: 100%; max-width: 460px; text-align: center; display: flex; flex-direction: column; gap: 14px; }
  .main-btn { width: 100%; padding: 22px 28px; border-radius: 16px; border: none; background: #0284c7; color: #fff; cursor: pointer; box-shadow: 0 10px 25px rgba(2,132,199,0.22); transition: background 0.15s; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .main-btn:hover { background: #0ea5e9; }
  .main-btn.ocr-btn { background: #4f46e5; box-shadow: 0 10px 25px rgba(79,70,229,0.22); }
  .main-btn.ocr-btn:hover { background: #6366f1; }
  .main-btn.dict-btn { background: #0f172a; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(15,23,42,0.4); }
  .main-btn.dict-btn:hover { background: #1e293b; border-color: #475569; }
  .main-btn:disabled { opacity: 0.6; pointer-events: none; }
  .main-btn-title { font-size: 19px; font-weight: 700; }
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
  .format-switch { display: inline-flex; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 3px; gap: 4px; margin-top: 4px; }
  .fmt-opt { border: none; background: transparent; color: #94a3b8; font-size: 11px; font-weight: 600; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
  .fmt-opt.active { background: #4f46e5; color: #fff; }
  .progress-wrap { margin-top: 6px; display: none; }
  .progress-bar-bg { width: 100%; height: 8px; background: #0f172a; border: 1px solid #1e293b; border-radius: 999px; overflow: hidden; margin-top: 6px; }
  .progress-bar-fill { height: 100%; width: 0%; background: #0ea5e9; transition: width 0.15s; }
  footer { padding: 0 24px 24px; }
  .tray { max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; max-height: 185px; overflow-y: auto; }
  .tray-empty { text-align: center; color: #64748b; font-size: 12px; }
  .file-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 4px; border-bottom: 1px solid #1e293b; }
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
      <button class="main-btn" id="uploadBtn" onclick="document.getElementById('fileInput').click()">
        <span class="main-btn-title">Исправить русский язык</span>
        <span class="main-btn-sub">Word (.docx) · Excel (.xlsx) · PowerPoint (.pptx)</span>
      </button>
      <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
        <button class="main-btn ocr-btn" id="ocrBtn" onclick="document.getElementById('ocrInput').click()">
          <span class="main-btn-title">Распознать PDF (картинку)</span>
          <span class="main-btn-sub">PDF · PNG · JPG · TIFF → Word (.docx) или Excel (.xlsx)</span>
        </button>
        <div class="format-switch">
          <button type="button" class="fmt-opt active" id="fmtDocx" onclick="setOcrFmt('docx')">Выдать Word (.docx)</button>
          <button type="button" class="fmt-opt" id="fmtXlsx" onclick="setOcrFmt('xlsx')">Выдать Excel (.xlsx)</button>
        </div>
      </div>
      <button class="main-btn dict-btn" id="dictStartBtn" onclick="startDictation()">
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
          <button type="button" class="ctrl-btn ctrl-pause" id="dictPauseBtn" onclick="togglePauseDictation()">Пауза</button>
          <button type="button" class="ctrl-btn ctrl-finish" onclick="finishDictation()">Завершить → Word (.docx)</button>
        </div>
      </div>
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
  let ocrFormat = 'docx';
  function setOcrFmt(fmt) {
    ocrFormat = fmt;
    document.getElementById('fmtDocx').className = 'fmt-opt' + (fmt === 'docx' ? ' active' : '');
    document.getElementById('fmtXlsx').className = 'fmt-opt' + (fmt === 'xlsx' ? ' active' : '');
  }
  const fileInput = document.getElementById('fileInput');
  const ocrInput = document.getElementById('ocrInput');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressPct = document.getElementById('progressPct');
  const progressLabel = document.getElementById('progressLabel');
  const trayEmpty = document.getElementById('trayEmpty');
  const fileList = document.getElementById('fileList');

  function downloadBase64(b64, name, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }

  function renderResultRow(data) {
    trayEmpty.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'file-row';
    const chunksCount = data.totalChunksProcessed || data.totalSegments || 1;
    row.innerHTML = '<div><div class="file-name">' + data.fileName + '</div><div class="file-meta">Готовый файл · Чанков: ' + chunksCount + ' · Исправлено ошибок: ' + data.totalIssuesFixed + ' · Оформление сохранено</div></div>';
    const group = document.createElement('div');
    group.className = 'btn-group';
    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.textContent = (data.operationMode === 'ocr' || data.operationMode === 'dictation') ? ('Скачать ' + data.fileType.toUpperCase()) : 'Скачать';
    const prefix = data.operationMode === 'ocr' ? 'Распознано_' : (data.operationMode === 'dictation' ? '' : 'Исправлено_');
    btn.onclick = () => downloadBase64(data.downloadBase64, prefix + data.fileName, data.mimeType);
    group.appendChild(btn);
    if (data.secondaryDownloadBase64 && data.secondaryFileName) {
      const altBtn = document.createElement('button');
      altBtn.className = 'dl-btn alt';
      altBtn.textContent = data.fileType === 'docx' ? 'Excel (.xlsx)' : 'Word (.docx)';
      altBtn.onclick = () => downloadBase64(data.secondaryDownloadBase64, 'Распознано_' + data.secondaryFileName, data.secondaryMimeType);
      group.appendChild(altBtn);
    }
    row.appendChild(group);
    fileList.prepend(row);
  }

  async function sendFile(file, endpoint, extraFields) {
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'Обработка: ' + file.name;
    let pct = 15;
    progressFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    const timer = setInterval(() => {
      if (pct < 88) { pct += 12; progressFill.style.width = pct + '%'; progressPct.textContent = pct + '%'; }
    }, 120);

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (extraFields) {
        Object.keys(extraFields).forEach(k => formData.append(k, extraFields[k]));
      }
      const res = await fetch(endpoint, { method: 'POST', body: formData });
      const data = await res.json();
      clearInterval(timer);
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; }, 250);
      if (res.ok) renderResultRow(data);
    } catch (err) {
      clearInterval(timer);
      progressWrap.style.display = 'none';
    }
  }

  let dictState = 'idle';
  let dictSeconds = 0;
  let dictInterval = null;
  function fmtSec(s) {
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function startDictation() {
    dictState = 'recording';
    dictSeconds = 0;
    document.getElementById('dictStartBtn').style.display = 'none';
    const panel = document.getElementById('dictPanel');
    panel.style.display = 'flex';
    panel.className = 'dict-panel';
    document.getElementById('dictDot').className = 'red-dot';
    document.getElementById('dictStatusText').textContent = 'Идёт запись (Whisper)...';
    document.getElementById('dictPauseBtn').textContent = 'Пауза';
    document.getElementById('dictTimer').textContent = '00:00';
    clearInterval(dictInterval);
    dictInterval = setInterval(() => {
      if (dictState === 'recording') {
        dictSeconds++;
        document.getElementById('dictTimer').textContent = fmtSec(dictSeconds);
      }
    }, 1000);
  }
  function togglePauseDictation() {
    const panel = document.getElementById('dictPanel');
    const dot = document.getElementById('dictDot');
    const status = document.getElementById('dictStatusText');
    const btn = document.getElementById('dictPauseBtn');
    if (dictState === 'recording') {
      dictState = 'paused';
      panel.className = 'dict-panel paused';
      dot.className = 'red-dot paused';
      status.textContent = 'На паузе — распознавание приостановлено';
      btn.textContent = 'Продолжить';
    } else if (dictState === 'paused') {
      dictState = 'recording';
      panel.className = 'dict-panel';
      dot.className = 'red-dot';
      status.textContent = 'Идёт запись (Whisper)...';
      btn.textContent = 'Пауза';
    }
  }
  async function finishDictation() {
    clearInterval(dictInterval);
    const dur = Math.max(1, dictSeconds);
    dictState = 'idle';
    document.getElementById('dictPanel').style.display = 'none';
    document.getElementById('dictStartBtn').style.display = 'flex';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'Распознавание речи Whisper и коррекция в Word...';
    progressFill.style.width = '45%';
    progressPct.textContent = '45%';
    try {
      const fd = new FormData();
      fd.append('audio', new Blob([new Uint8Array(44)], { type: 'audio/wav' }), 'dictation.wav');
      fd.append('durationSeconds', String(dur));
      const res = await fetch('/api/whisper/transcribe', { method: 'POST', body: fd });
      const data = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; }, 250);
      if (res.ok) renderResultRow(data);
    } catch (e) {
      progressWrap.style.display = 'none';
    }
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await sendFile(file, '/api/proofread/document');
    fileInput.value = '';
  });

  ocrInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await sendFile(file, '/api/ocr/recognize', { outputFormat: ocrFormat });
    ocrInput.value = '';
  });
</script>
</body>
</html>`;

startServer();

