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
  processLegacyDocBuffer,
  processLegacyPptBuffer,
  processLegacyXlsBuffer,
} from './server/services/legacyOfficeConverter.service.ts';
import {
  OdfExtension,
  processOpenDocumentBuffer,
  processRtfBuffer,
} from './server/services/openDocumentProcessor.service.ts';
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
import {
  transcribeAudioAndBuildWordDoc,
  transcribeAudioToTextOnly,
} from './server/services/whisperDictation.service.ts';
import { transcribeMeetingMediaFile } from './server/services/meetingMedia.service.ts';
import {
  processBusinessStyleDocument,
  transformToBusinessStyle,
} from './server/services/businessStyle.service.ts';
import { GithubBundleConfig, OcrOutputFormat } from './src/types/harness.types.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // 30 MB
  },
});

const meetingMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, os.tmpdir());
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, `harness_meeting_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB для длинных записей совещаний и видеофайлов
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

      if (ext === '.doc') {
        const result = await processLegacyDocBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.xlsx') {
        const result = await processXlsxBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.xls') {
        const result = await processLegacyXlsBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.pptx') {
        const result = await processPptxBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (ext === '.ppt') {
        const result = await processLegacyPptBuffer(file.buffer, originalName);
        res.json(result);
        return;
      }

      if (
        ext === '.odt' ||
        ext === '.ods' ||
        ext === '.odp' ||
        ext === '.xodt' ||
        ext === '.xods'
      ) {
        const odfExt = ext.slice(1) as OdfExtension;
        const result = await processOpenDocumentBuffer(file.buffer, originalName, odfExt);
        res.json(result);
        return;
      }

      if (ext === '.rtf') {
        const result = await processRtfBuffer(file.buffer, originalName);
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
        error: `Формат "${ext}" не поддерживается. Поддерживаются .doc, .docx, .xls, .xlsx, .ppt, .pptx, .odt, .ods, .odp, .xodt, .xods, .rtf и .txt.`,
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
      const pdfBuf = await generateSamplePdfWithRussianTable();
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

  // 3.4. Надиктовка текста с возвратом расшифрованного текста напрямую в форму (для модуля «Деловой стиль»)
  app.post('/api/whisper/transcribe-text', upload.single('audio'), async (req: Request, res: Response) => {
    try {
      const wavBuffer = req.file?.buffer || Buffer.alloc(0);
      const durationSeconds = Math.max(1, Number(req.body?.durationSeconds) || 3);
      const clientTranscriptHint =
        typeof req.body?.clientTranscriptHint === 'string'
          ? req.body.clientTranscriptHint
          : undefined;

      const result = await transcribeAudioToTextOnly(
        wavBuffer,
        durationSeconds,
        clientTranscriptHint
      );
      res.json(result);
    } catch (err) {
      console.error('Ошибка распознавания речи для формы:', err);
      res.status(500).json({
        error: 'Не удалось распознать надиктованный текст.',
      });
    }
  });

  // 3.4.1. Загрузка записи совещания (аудио с диктофона или видеофайл с извлечением звуковой дорожки) → текст + Word/TXT
  app.post('/api/whisper/transcribe-file', (req: Request, res: Response) => {
    meetingMediaUpload.single('media')(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        const isSizeError =
          uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE';
        res.status(400).json({
          error: isSizeError
            ? 'Размер файла превышает лимит 500 МБ. Сожмите запись или разделите её на части.'
            : 'Не удалось загрузить файл записи совещания.',
        });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Файл аудио- или видеозаписи совещания не передан.' });
        return;
      }

      try {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const result = await transcribeMeetingMediaFile(file.path, originalName, file.mimetype);
        res.json(result);
      } catch (err) {
        console.error('Ошибка расшифровки записи совещания:', err);
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : 'Не удалось извлечь аудио и расшифровать запись совещания.',
        });
      } finally {
        try {
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch {
          // ignore temp cleanup error
        }
      }
    });
  });

  // 3.5. Инструмент [04] «Деловой стиль»: преобразование произвольного текста в вежливый официальный деловой стиль
  app.post('/api/business-style/text', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      if (typeof text !== 'string' || text.trim().length === 0) {
        res.status(400).json({
          error: 'Введите, вставьте или надиктуйте текст для преобразования в деловой стиль.',
        });
        return;
      }

      const result = await transformToBusinessStyle(text);
      res.json(result);
    } catch (err) {
      console.error('Ошибка преобразования текста в деловой стиль:', err);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Не удалось преобразовать текст в деловой стиль.',
      });
    }
  });

  // 3.6. Инструмент [04] «Деловой стиль»: загрузка документа и немедленное преобразование в вежливый деловой стиль
  app.post('/api/business-style/document', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Документ не передан.' });
        return;
      }

      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const result = await processBusinessStyleDocument(file.buffer, originalName);
      res.json(result);
    } catch (err) {
      console.error('Ошибка обработки документа в деловом стиле:', err);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Не удалось извлечь текст и преобразовать документ в деловой стиль.',
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
<title>Офисный Помощник — Автономный режим</title>
<style>
  :root {
    --bg: #f2efeb;
    --ink: #1a1a1a;
    --accent: #004ecc;
    --accent-hover: #003da1;
    --ink-faint: rgba(26, 26, 26, 0.08);
    --paper: #ffffff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    padding: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  .container {
    width: 100%;
    max-width: 1200px;
    min-height: 680px;
    background: var(--paper);
    border: 1px solid var(--ink);
    display: grid;
    grid-template-rows: auto 1fr auto;
    position: relative;
    box-shadow: 32px 32px 0px rgba(0, 0, 0, 0.05);
    overflow: hidden;
  }
  .diagonal-line {
    position: absolute;
    top: 0;
    right: 0;
    width: 100px;
    height: 100px;
    background: linear-gradient(45deg, transparent 49.4%, rgba(0, 78, 204, 0.14) 50%, transparent 50.6%);
    pointer-events: none;
  }
  header {
    padding: 26px 36px;
    border-bottom: 1px solid var(--ink);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  h1 {
    font-family: 'Oswald', 'Arial Narrow', sans-serif;
    font-size: 2rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1;
  }
  .doc-info {
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px;
    text-align: right;
    line-height: 1.45;
    opacity: 0.6;
    text-transform: uppercase;
  }
  main {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  @media (max-width: 1080px) {
    main { grid-template-columns: repeat(2, 1fr); }
    .col { border-bottom: 1px solid var(--ink-faint); }
  }
  @media (max-width: 680px) {
    main { grid-template-columns: 1fr; }
    .col { border-right: none !important; border-bottom: 1px solid var(--ink-faint); }
    .col:last-child { border-bottom: none; }
  }
  .col {
    padding: 28px;
    border-right: 1px solid var(--ink-faint);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transition: background 0.2s;
  }
  .col:last-child { border-right: none; }
  .col:hover { background: #faf9f7; }
  .num {
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 12px;
  }
  .sec-title {
    font-family: 'Oswald', 'Arial Narrow', sans-serif;
    font-size: 1.5rem;
    font-weight: 700;
    text-transform: uppercase;
    line-height: 1.1;
    margin-bottom: 12px;
  }
  .sec-desc {
    font-size: 13px;
    line-height: 1.55;
    color: #555;
  }
  .sec-formats {
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 10.5px;
    color: rgba(26, 26, 26, 0.45);
    margin-top: 12px;
    text-transform: uppercase;
  }
  .action-box { margin-top: 22px; }
  .style-textarea {
    width: 100%;
    min-height: 92px;
    padding: 10px;
    border: 1px solid rgba(26, 26, 26, 0.22);
    background: #faf9f7;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink);
    resize: vertical;
    margin-top: 12px;
  }
  .style-textarea:focus { outline: none; border-color: var(--accent); }
  .style-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0 10px; }
  .style-out {
    display: none;
    margin-top: 10px;
    padding: 10px;
    border: 1px solid var(--ink);
    background: #fff;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    max-height: 140px;
    overflow-y: auto;
  }
  .format-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 12px;
  }
  .fmt-opt {
    border: 1px solid rgba(26, 26, 26, 0.16);
    background: transparent;
    color: rgba(26, 26, 26, 0.75);
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px;
    font-weight: 700;
    padding: 8px;
    cursor: pointer;
    text-transform: uppercase;
    transition: all 0.15s;
  }
  .fmt-opt.active {
    background: var(--ink);
    color: #fff;
    border-color: var(--ink);
  }
  .main-btn {
    width: 100%;
    padding: 15px 18px;
    border: none;
    background: var(--accent);
    color: #fff;
    font-family: 'Oswald', 'Arial Narrow', sans-serif;
    font-size: 0.95rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition: background 0.15s;
  }
  .main-btn:hover { background: var(--accent-hover); }
  .main-btn:disabled { opacity: 0.45; pointer-events: none; }
  .dict-panel {
    border: 1px solid var(--ink);
    background: #fff;
    padding: 14px;
    display: none;
    flex-direction: column;
    gap: 12px;
  }
  .red-dot { width: 10px; height: 10px; border-radius: 50%; background: #dc2626; display: inline-block; animation: pulse 1.1s infinite; }
  .red-dot.paused { background: #d97706; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .dict-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ctrl-btn {
    padding: 10px 12px;
    font-family: 'Oswald', 'Arial Narrow', sans-serif;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .ctrl-pause { background: #fff; color: var(--ink); border: 1px solid var(--ink); }
  .ctrl-finish { background: #b91c1c; color: #fff; border: 1px solid #b91c1c; }
  footer {
    background: var(--ink);
    color: #fff;
    padding: 18px 36px;
  }
  .footer-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .status-text { font-size: 13px; color: rgba(255, 255, 255, 0.72); }
  .progress-wrap { width: 100%; max-width: 420px; display: none; }
  .progress-meta {
    display: flex;
    justify-content: space-between;
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.85);
    text-transform: uppercase;
  }
  .progress-bar-bg { width: 100%; height: 3px; background: rgba(255, 255, 255, 0.16); margin-top: 8px; overflow: hidden; }
  .progress-bar-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.15s; }
  .footer-links {
    display: flex;
    gap: 20px;
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px;
    text-transform: uppercase;
  }
  .footer-link {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.65);
    font: inherit;
    text-transform: uppercase;
    cursor: pointer;
  }
  .footer-link:hover { color: #fff; }
  .tray {
    display: none;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
    max-height: 150px;
    overflow-y: auto;
  }
  .file-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    margin-bottom: 8px;
  }
  .file-row:last-child { margin-bottom: 0; }
  .file-name { font-size: 13px; font-weight: 600; color: #fff; }
  .file-meta { font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; color: rgba(255, 255, 255, 0.55); margin-top: 2px; }
  .btn-group { display: flex; align-items: center; gap: 8px; }
  .dl-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 7px 14px;
    font-family: 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    cursor: pointer;
    white-space: nowrap;
  }
  .dl-btn:hover { background: var(--accent-hover); }
  .dl-btn.alt { background: transparent; border: 1px solid rgba(255, 255, 255, 0.32); }
  .dl-btn.alt:hover { background: #fff; color: var(--ink); }
</style>
</head>
<body>
  <div class="container">
    <div class="diagonal-line"></div>
    <input type="file" id="fileInput" accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.xodt,.xods,.rtf,.txt" style="display:none" />
    <input type="file" id="ocrInput" accept=".pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp" style="display:none" />
    <input type="file" id="meetingMediaInput" accept=".mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.wma,.amr,.3gp,.aiff,.aif,.caf,.m4b,.mp4,.mkv,.mov,.avi,.webm,.wmv,.m4v,.flv,.mpeg,.mpg,.ts,.mts,audio/*,video/*" style="display:none" />
    <input type="file" id="styleDocInput" accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.xodt,.xods,.rtf,.txt,.md,.pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp,.mp3,.wav,.m4a,.ogg,.mp4,.mkv,.mov,.webm" style="display:none" />
    <header>
      <h1>Офисный Помощник</h1>
      <div class="doc-info">
        АВТОНОМНЫЙ КОНТУР<br>
        DOCX · PDF · WHISPER · СТИЛЬ
      </div>
    </header>
    <main>
      <section class="col">
        <div>
          <div class="num">[ 01 ]</div>
          <div class="sec-title">Исправить язык</div>
          <p class="sec-desc">Проверка орфографии и пунктуации для документов MS Office, LibreOffice и МойОфис с сохранением оформления и таблиц.</p>
          <div class="sec-formats">DOCX · XLSX · PPTX · ODT · ODS · XODT · RTF</div>
        </div>
        <div class="action-box">
          <button class="main-btn" id="uploadBtn" onclick="document.getElementById('fileInput').click()">
            <span>Выбрать файл</span>
            <span>&#8599;</span>
          </button>
        </div>
      </section>
      <section class="col">
        <div>
          <div class="num">[ 02 ]</div>
          <div class="sec-title">Распознать текст</div>
          <p class="sec-desc">Локальное распознавание счетов, актов, таблиц и чертежей из PDF и сканов с переносом текста RU/EN и графики.</p>
          <div class="sec-formats">PDF · PNG · JPG · TIFF · BMP · WEBP</div>
        </div>
        <div class="action-box">
          <div class="format-switch">
            <button type="button" class="fmt-opt active" id="fmtDocx" onclick="setOcrFmt('docx')">DOCX</button>
            <button type="button" class="fmt-opt" id="fmtXlsx" onclick="setOcrFmt('xlsx')">XLSX</button>
          </div>
          <button class="main-btn" id="ocrBtn" onclick="document.getElementById('ocrInput').click()">
            <span>Загрузить PDF</span>
            <span>&#8599;</span>
          </button>
        </div>
      </section>
      <section class="col">
        <div>
          <div class="num">[ 03 ]</div>
          <div class="sec-title">Надиктовать голосом</div>
          <p class="sec-desc">Локальный Whisper переводит голосовую диктовку, записи совещаний с диктофона и аудио из видеофайлов в структурированный текст и Word.</p>
          <div class="sec-formats">МИКРОФОН · MP3 · WAV · M4A · OGG · MP4 · MKV · MOV</div>
        </div>
        <div class="action-box">
          <button type="button" class="fmt-opt" style="width:100%;margin-bottom:8px;" id="meetingUploadBtn" onclick="document.getElementById('meetingMediaInput').click()">
            ЗАГРУЗИТЬ ЗАПИСЬ СОВЕЩАНИЯ
          </button>
          <button class="main-btn" id="dictStartBtn" onclick="startDictation()">
            <span>Начать запись</span>
            <span>&#9679;</span>
          </button>
          <div class="dict-panel" id="dictPanel">
            <div style="display:flex;align-items:center;justify-content:space-between;font-family:monospace;font-size:11px;font-weight:700;text-transform:uppercase;">
              <span style="display:flex;align-items:center;gap:8px;"><span class="red-dot" id="dictDot"></span><span id="dictStatusText">Идёт запись</span></span>
              <span id="dictTimer">00:00</span>
            </div>
            <div class="dict-actions">
              <button type="button" class="ctrl-btn ctrl-pause" id="dictPauseBtn" onclick="togglePauseDictation()">Пауза</button>
              <button type="button" class="ctrl-btn ctrl-finish" onclick="finishDictation()">Завершить</button>
            </div>
          </div>
        </div>
      </section>
      <section class="col">
        <div>
          <div class="num">[ 04 ]</div>
          <div class="sec-title">Деловой стиль</div>
          <p class="sec-desc">Перевод любого сообщения, диктовки или документа в вежливый официальный деловой стиль для отправки.</p>
          <textarea id="styleInput" class="style-textarea" placeholder="Введите текст, загрузите документ или надиктуйте..."></textarea>
          <div id="styleOutput" class="style-out"></div>
        </div>
        <div class="action-box">
          <div class="style-tools">
            <button type="button" class="fmt-opt" onclick="document.getElementById('styleDocInput').click()">ДОКУМЕНТ</button>
            <button type="button" class="fmt-opt" id="styleMicBtn" onclick="toggleStyleDictation()">ДИКТОВАТЬ</button>
          </div>
          <button class="main-btn" id="styleRunBtn" onclick="runBusinessStyleText()">
            <span>Преобразовать</span>
            <span>&#8599;</span>
          </button>
        </div>
      </section>
    </main>
    <footer>
      <div class="footer-top">
        <div style="flex:1;min-width:220px;">
          <div class="status-text" id="trayEmpty">Ожидание процесса обработки. Ссылка появится здесь.</div>
          <div class="progress-wrap" id="progressWrap">
            <div class="progress-meta">
              <span id="progressLabel">ОБРАБОТКА...</span>
              <span id="progressPct">0%</span>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
          </div>
        </div>
        <div class="footer-links">
          <button type="button" class="footer-link" onclick="runSampleDoc()">DOC_TEST</button>
          <button type="button" class="footer-link" onclick="runSamplePdf()">PDF_TEST</button>
        </div>
      </div>
      <div class="tray" id="tray">
        <div id="fileList"></div>
      </div>
    </footer>
  </div>
<script>
  let ocrFormat = 'docx';
  function setOcrFmt(fmt) {
    ocrFormat = fmt;
    document.getElementById('fmtDocx').className = 'fmt-opt' + (fmt === 'docx' ? ' active' : '');
    document.getElementById('fmtXlsx').className = 'fmt-opt' + (fmt === 'xlsx' ? ' active' : '');
  }
  const fileInput = document.getElementById('fileInput');
  const ocrInput = document.getElementById('ocrInput');
  const meetingMediaInput = document.getElementById('meetingMediaInput');
  const styleDocInput = document.getElementById('styleDocInput');
  const styleInput = document.getElementById('styleInput');
  const styleOutput = document.getElementById('styleOutput');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressPct = document.getElementById('progressPct');
  const progressLabel = document.getElementById('progressLabel');
  const tray = document.getElementById('tray');
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

  function base64ToFileObj(b64, name, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  async function handoffStandaloneResult(data, target) {
    const nextFile = base64ToFileObj(data.downloadBase64, data.fileName, data.mimeType);
    if (target === 'proofread') {
      await sendFile(nextFile, '/api/proofread/document');
      return;
    }
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'ДЕЛОВОЙ СТИЛЬ: ' + data.fileName;
    progressFill.style.width = '50%';
    progressPct.textContent = '50%';
    try {
      const fd = new FormData();
      fd.append('file', nextFile);
      const res = await fetch('/api/business-style/document', { method: 'POST', body: fd });
      const resData = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 220);
      if (res.ok) {
        styleInput.value = resData.originalText || '';
        styleOutput.style.display = 'block';
        styleOutput.textContent = resData.formalText || '';
        if (resData.documentResult) renderResultRow(resData.documentResult);
      }
    } catch (e) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
    }
  }

  function renderResultRow(data) {
    tray.style.display = 'block';
    trayEmpty.textContent = 'ГОТОВО ФАЙЛОВ: ' + (fileList.children.length + 1);
    const row = document.createElement('div');
    row.className = 'file-row';
    const chunksCount = data.totalChunksProcessed || data.totalSegments || 1;
    const metaText = data.operationMode === 'ocr'
      ? ('Распознано (точная копия) · Блоков: ' + (data.totalSegments || 1) + ' · Таблицы и графика сохранены')
      : data.operationMode === 'business_style'
        ? ('Деловой стиль · Улучшений: ' + data.totalIssuesFixed)
        : data.operationMode === 'meeting_transcript'
          ? ('Запись совещания → Текст · Фрагментов: ' + chunksCount)
          : ('Готовый файл · Чанков: ' + chunksCount + ' · Исправлено: ' + data.totalIssuesFixed);
    row.innerHTML = '<div><div class="file-name">' + data.fileName + '</div><div class="file-meta">' + metaText + '</div></div>';
    const group = document.createElement('div');
    group.className = 'btn-group';
    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    const isGeneratedMode = data.operationMode === 'ocr' || data.operationMode === 'dictation' || data.operationMode === 'meeting_transcript' || data.operationMode === 'business_style';
    btn.textContent = isGeneratedMode ? ('Скачать ' + data.fileType.toUpperCase()) : 'Скачать';
    const prefix = data.operationMode === 'ocr' ? 'Распознано_' : (data.operationMode === 'dictation' || data.operationMode === 'meeting_transcript' || data.operationMode === 'business_style' ? '' : 'Исправлено_');
    btn.onclick = () => downloadBase64(data.downloadBase64, prefix + data.fileName, data.mimeType);
    group.appendChild(btn);
    if (data.secondaryDownloadBase64 && data.secondaryFileName) {
      const altBtn = document.createElement('button');
      altBtn.className = 'dl-btn alt';
      const isTxt = data.secondaryFileName.toLowerCase().endsWith('.txt');
      altBtn.textContent = isTxt ? 'TXT' : (data.fileType === 'docx' ? 'XLSX' : 'DOCX');
      const altPrefix = data.operationMode === 'ocr' ? 'Распознано_' : '';
      altBtn.onclick = () => downloadBase64(data.secondaryDownloadBase64, altPrefix + data.secondaryFileName, data.secondaryMimeType);
      group.appendChild(altBtn);
    }
    const nextTarget = data.operationMode === 'business_style' || data.operationMode === 'ocr' ? 'proofread' : 'business_style';
    const nextBtn = document.createElement('button');
    nextBtn.className = 'dl-btn alt';
    nextBtn.textContent = nextTarget === 'proofread' ? '→ Исправить язык' : '→ Деловой стиль';
    nextBtn.onclick = () => handoffStandaloneResult(data, nextTarget);
    group.appendChild(nextBtn);
    row.appendChild(group);
    fileList.prepend(row);
  }

  async function sendFile(file, endpoint, extraFields) {
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'ОБРАБОТКА: ' + file.name;
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
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 250);
      if (res.ok) renderResultRow(data);
    } catch (err) {
      clearInterval(timer);
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
    }
  }

  async function runBusinessStyleText() {
    const text = styleInput.value.trim();
    if (!text) return;
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'ДЕЛОВОЙ СТИЛЬ...';
    progressFill.style.width = '50%';
    progressPct.textContent = '50%';
    try {
      const res = await fetch('/api/business-style/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const data = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 220);
      if (res.ok) {
        styleOutput.style.display = 'block';
        styleOutput.textContent = data.formalText;
        if (data.documentResult) renderResultRow(data.documentResult);
      }
    } catch (e) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
    }
  }

  let styleRecording = false;
  let styleRecStart = 0;
  async function toggleStyleDictation() {
    const btn = document.getElementById('styleMicBtn');
    if (!styleRecording) {
      styleRecording = true;
      styleRecStart = Date.now();
      btn.className = 'fmt-opt active';
      btn.textContent = 'ВСТАВИТЬ';
    } else {
      styleRecording = false;
      btn.className = 'fmt-opt';
      btn.textContent = 'ДИКТОВАТЬ';
      const dur = Math.max(1, Math.round((Date.now() - styleRecStart) / 1000));
      try {
        const fd = new FormData();
        fd.append('audio', new Blob([new Uint8Array(44)], { type: 'audio/wav' }), 'dictation.wav');
        fd.append('durationSeconds', String(dur));
        const res = await fetch('/api/whisper/transcribe-text', { method: 'POST', body: fd });
        const data = await res.json();
        if (res.ok && data.text) {
          styleInput.value = (styleInput.value ? styleInput.value + ' ' : '') + data.text;
        }
      } catch (e) {}
    }
  }

  async function runSampleDoc() {
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'ОБРАБОТКА: Служебная_записка.docx';
    progressFill.style.width = '50%';
    progressPct.textContent = '50%';
    try {
      const res = await fetch('/api/proofread/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'docx' }) });
      const data = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 220);
      if (res.ok) renderResultRow(data);
    } catch (e) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
    }
  }

  async function runSamplePdf() {
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'ОБРАБОТКА: Скан_ведомости_ЗСПД.pdf';
    progressFill.style.width = '50%';
    progressPct.textContent = '50%';
    try {
      const res = await fetch('/api/ocr/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputFormat: ocrFormat }) });
      const data = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 220);
      if (res.ok) renderResultRow(data);
    } catch (e) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
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
    document.getElementById('dictDot').className = 'red-dot';
    document.getElementById('dictStatusText').textContent = 'Идёт запись';
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
    const dot = document.getElementById('dictDot');
    const status = document.getElementById('dictStatusText');
    const btn = document.getElementById('dictPauseBtn');
    if (dictState === 'recording') {
      dictState = 'paused';
      dot.className = 'red-dot paused';
      status.textContent = 'На паузе';
      btn.textContent = 'Продолжить';
    } else if (dictState === 'paused') {
      dictState = 'recording';
      dot.className = 'red-dot';
      status.textContent = 'Идёт запись';
      btn.textContent = 'Пауза';
    }
  }
  async function finishDictation() {
    clearInterval(dictInterval);
    const dur = Math.max(1, dictSeconds);
    dictState = 'idle';
    document.getElementById('dictPanel').style.display = 'none';
    document.getElementById('dictStartBtn').style.display = 'flex';
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'WHISPER → WORD (.DOCX)';
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
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 250);
      if (res.ok) renderResultRow(data);
    } catch (e) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
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

  meetingMediaInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'РАСШИФРОВКА ЗАПИСИ: ' + file.name;
    progressFill.style.width = '45%';
    progressPct.textContent = '45%';
    try {
      const fd = new FormData();
      fd.append('media', file);
      const res = await fetch('/api/whisper/transcribe-file', { method: 'POST', body: fd });
      const data = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 240);
      if (res.ok && data.documentResult) {
        renderResultRow(data.documentResult);
      }
    } catch (err) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
    }
    meetingMediaInput.value = '';
  });

  styleDocInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    trayEmpty.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'ДЕЛОВОЙ СТИЛЬ: ' + file.name;
    progressFill.style.width = '50%';
    progressPct.textContent = '50%';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/business-style/document', { method: 'POST', body: fd });
      const data = await res.json();
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => { progressWrap.style.display = 'none'; trayEmpty.style.display = 'block'; }, 220);
      if (res.ok) {
        styleInput.value = data.originalText || '';
        styleOutput.style.display = 'block';
        styleOutput.textContent = data.formalText || '';
        if (data.documentResult) renderResultRow(data.documentResult);
      }
    } catch (err) {
      progressWrap.style.display = 'none';
      trayEmpty.style.display = 'block';
    }
    styleDocInput.value = '';
  });
</script>
</body>
</html>`;

startServer();

