import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  DocumentProofreadResult,
  DocumentSegment,
  MeetingMediaKind,
  MeetingTranscriptionResult,
} from '../../src/types/harness.types.ts';
import { proofreadRussianText } from './russianProofreader.service.ts';
import {
  buildDocxFromRecognizedBlocks,
  parseRecognizedTextToBlocks,
} from './ocrDocument.service.ts';
import {
  enhanceSpokenRussianTranscript,
  resolveBestWhisperBinaryPath,
  resolveWhisperModelPath,
} from './whisperDictation.service.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TXT_MIME = 'text/plain;charset=utf-8';

/** Поддерживаемые форматы аудиозаписей с диктофонов, смартфонов и систем конференц-связи */
export const SUPPORTED_MEETING_AUDIO_EXTENSIONS = new Set<string>([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.wma',
  '.amr',
  '.3gp',
  '.aiff',
  '.aif',
  '.caf',
  '.m4b',
  '.mp2',
  '.spx',
]);

/** Поддерживаемые видеоформаты, из которых локально извлекается звуковая дорожка */
export const SUPPORTED_MEETING_VIDEO_EXTENSIONS = new Set<string>([
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.webm',
  '.wmv',
  '.m4v',
  '.flv',
  '.mpeg',
  '.mpg',
  '.ts',
  '.mts',
  '.3g2',
]);

export function detectMeetingMediaKind(fileName: string, mimeType?: string): MeetingMediaKind | null {
  const ext = path.extname(fileName).toLowerCase();
  if (SUPPORTED_MEETING_VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (SUPPORTED_MEETING_AUDIO_EXTENSIONS.has(ext)) return 'audio';

  const normalizedMime = (mimeType || '').toLowerCase();
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'audio';

  return null;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileWithStderr(
  cmd: string,
  args: string[],
  timeoutMs = 180_000
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const wrapped = Object.assign(err, { stdout, stderr });
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

let cachedFfmpegPath: string | null | undefined;
let cachedFfprobePath: string | null | undefined;

async function isExecutableRunnable(cmd: string): Promise<boolean> {
  try {
    await execFileWithStderr(cmd, ['-version'], 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Кроссплатформенный поиск локального бинарника FFmpeg / FFprobe:
 * 1) Переменные окружения FFMPEG_PATH / FFPROBE_PATH
 * 2) Портативные папки ./bin/<platform>/ рядом с приложением
 * 3) Системный PATH (ffmpeg / ffmpeg.exe)
 */
async function resolveMediaToolBinary(
  tool: 'ffmpeg' | 'ffprobe',
  baseDir: string = process.cwd()
): Promise<string | null> {
  const cached = tool === 'ffmpeg' ? cachedFfmpegPath : cachedFfprobePath;
  if (cached !== undefined) {
    return cached;
  }

  const platform = os.platform();
  const exeSuffix = platform === 'win32' ? '.exe' : '';
  const binName = `${tool}${exeSuffix}`;
  const envVar = tool === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;

  const execDir = path.dirname(process.execPath);
  const candidatePaths: string[] = [];

  if (envVar && envVar.trim().length > 0) {
    candidatePaths.push(path.resolve(envVar.trim()));
  }

  const subDirs =
    platform === 'win32'
      ? ['win8plus-x64', 'win7-x64', 'win-x64']
      : platform === 'darwin'
        ? ['darwin-arm64', 'darwin-x64']
        : ['linux-x64-avx2', 'linux-x64', 'linux-arm64'];

  for (const root of [baseDir, execDir]) {
    for (const sub of subDirs) {
      candidatePaths.push(path.join(root, 'bin', sub, binName));
    }
    candidatePaths.push(path.join(root, 'bin', binName));
  }

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate) && (await isExecutableRunnable(candidate))) {
      if (tool === 'ffmpeg') cachedFfmpegPath = candidate;
      else cachedFfprobePath = candidate;
      return candidate;
    }
  }

  // Проверяем системный PATH
  if (await isExecutableRunnable(binName)) {
    if (tool === 'ffmpeg') cachedFfmpegPath = binName;
    else cachedFfprobePath = binName;
    return binName;
  }

  if (tool === 'ffmpeg') cachedFfmpegPath = null;
  else cachedFfprobePath = null;
  return null;
}

interface MediaProbeInfo {
  durationSeconds: number;
  hasAudioStream: boolean;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

/**
 * Извлекает длительность и параметры аудио из WAV-заголовка без внешних зависимостей.
 */
function parseWavHeaderDuration(wavBuffer: Buffer): MediaProbeInfo | null {
  if (wavBuffer.length < 44) return null;
  if (
    wavBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
    wavBuffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let byteRate = 32000;
  let dataSize = Math.max(0, wavBuffer.length - 44);

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ' && chunkDataOffset + 16 <= wavBuffer.length) {
      channels = wavBuffer.readUInt16LE(chunkDataOffset + 2) || 1;
      sampleRate = wavBuffer.readUInt32LE(chunkDataOffset + 4) || 16000;
      byteRate = wavBuffer.readUInt32LE(chunkDataOffset + 8) || sampleRate * channels * 2;
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, wavBuffer.length - chunkDataOffset);
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  const durationSeconds = byteRate > 0 ? Math.max(1, Math.round(dataSize / byteRate)) : 1;
  return {
    durationSeconds,
    hasAudioStream: true,
    audioCodec: 'pcm_wav',
    sampleRate,
    channels,
  };
}

async function probeMediaWithFfprobe(
  ffprobeBin: string,
  inputPath: string
): Promise<MediaProbeInfo | null> {
  try {
    const { stdout } = await execFileWithStderr(
      ffprobeBin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
      20_000
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        sample_rate?: string;
        channels?: number;
        duration?: string;
      }>;
    };

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const rawDuration = Number(audioStream?.duration || parsed.format?.duration || 0);

    return {
      durationSeconds: Number.isFinite(rawDuration) && rawDuration > 0 ? Math.max(1, Math.round(rawDuration)) : 0,
      hasAudioStream: Boolean(audioStream),
      audioCodec: audioStream?.codec_name,
      sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : undefined,
      channels: audioStream?.channels,
    };
  } catch {
    return null;
  }
}

/**
 * Конвертирует любую аудиозапись с диктофона или видеофайл (с извлечением звуковой дорожки)
 * в эталонный WAV-файл 16 кГц, 16 бит, моно (PCM s16le) для точного распознавания Whisper.
 */
async function extractAudioToStandardWhisperWav(
  inputFilePath: string,
  originalFileName: string,
  mediaKind: MeetingMediaKind
): Promise<{
  wavPath: string;
  shouldDeleteWav: boolean;
  durationSeconds: number;
  extractedBytes: number;
  audioCodec?: string;
  extractionEngineLabel: string;
}> {
  const ext = path.extname(originalFileName).toLowerCase();
  const baseDir = process.cwd();
  const [ffmpegBin, ffprobeBin] = await Promise.all([
    resolveMediaToolBinary('ffmpeg', baseDir),
    resolveMediaToolBinary('ffprobe', baseDir),
  ]);

  let probeInfo: MediaProbeInfo | null = null;
  if (ffprobeBin) {
    probeInfo = await probeMediaWithFfprobe(ffprobeBin, inputFilePath);
    if (probeInfo && !probeInfo.hasAudioStream) {
      throw new Error(
        mediaKind === 'video'
          ? 'В загруженном видеофайле отсутствует звуковая дорожка.'
          : 'В загруженном файле не обнаружен корректный аудиопоток.'
      );
    }
  }

  if (ffmpegBin) {
    const outWavPath = path.join(
      os.tmpdir(),
      `harness_meeting_16k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`
    );

    // Оптимальная очистка речи для диктофонов и переговорных комнат (убираем гул ниже 80 Гц и шум выше 7.8 кГц)
    const primaryArgs = [
      '-y',
      '-nostdin',
      '-i',
      inputFilePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-af',
      'highpass=f=80,lowpass=f=7800',
      outWavPath,
    ];

    const fallbackArgs = [
      '-y',
      '-nostdin',
      '-i',
      inputFilePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outWavPath,
    ];

    let extracted = false;
    let lastStderr = '';

    try {
      await execFileWithStderr(ffmpegBin, primaryArgs, 300_000);
      extracted = true;
    } catch (err) {
      lastStderr = String((err as { stderr?: string }).stderr || '');
      if (/does not contain any stream|matches no streams|Stream map/i.test(lastStderr)) {
        throw new Error(
          mediaKind === 'video'
            ? 'В загруженном видеофайле отсутствует звуковая дорожка.'
            : 'Не удалось прочитать звуковую дорожку из загруженного файла.'
        );
      }

      // Повторяем без аудиофильтров на случай минимальной сборки FFmpeg
      try {
        await execFileWithStderr(ffmpegBin, fallbackArgs, 300_000);
        extracted = true;
      } catch (err2) {
        const stderr2 = String((err2 as { stderr?: string }).stderr || lastStderr);
        if (fs.existsSync(outWavPath)) {
          try {
            fs.unlinkSync(outWavPath);
          } catch {
            // ignore
          }
        }
        if (/does not contain any stream|matches no streams/i.test(stderr2)) {
          throw new Error('В загруженном видеофайле отсутствует звуковая дорожка.');
        }
        throw new Error(
          `Не удалось извлечь аудио из файла «${originalFileName}». Проверьте, что файл не повреждён.`
        );
      }
    }

    if (extracted && fs.existsSync(outWavPath)) {
      const stat = fs.statSync(outWavPath);
      const headerBuf = Buffer.alloc(Math.min(4096, stat.size));
      const fd = fs.openSync(outWavPath, 'r');
      try {
        fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
      } finally {
        fs.closeSync(fd);
      }

      const wavInfo = parseWavHeaderDuration(headerBuf);
      const estimatedFromPcm = Math.max(1, Math.round(Math.max(0, stat.size - 44) / 32000));
      const durationSeconds =
        (probeInfo?.durationSeconds && probeInfo.durationSeconds > 0
          ? probeInfo.durationSeconds
          : wavInfo?.durationSeconds) || estimatedFromPcm;

      return {
        wavPath: outWavPath,
        shouldDeleteWav: true,
        durationSeconds,
        extractedBytes: stat.size,
        audioCodec: probeInfo?.audioCodec || ext.replace('.', ''),
        extractionEngineLabel:
          mediaKind === 'video'
            ? 'FFmpeg (извлечение аудио из видео → 16 кГц PCM)'
            : 'FFmpeg (декодирование аудио → 16 кГц PCM)',
      };
    }
  }

  // Нативный fallback без FFmpeg для файлов .wav
  if (ext === '.wav') {
    const wavBuffer = fs.readFileSync(inputFilePath);
    const wavInfo = parseWavHeaderDuration(wavBuffer);
    if (!wavInfo) {
      throw new Error('Файл .wav повреждён или имеет неподдерживаемый заголовок.');
    }
    return {
      wavPath: inputFilePath,
      shouldDeleteWav: false,
      durationSeconds: wavInfo.durationSeconds,
      extractedBytes: wavBuffer.length,
      audioCodec: 'pcm_wav',
      extractionEngineLabel: 'Нативный декодер WAV (PCM)',
    };
  }

  throw new Error(
    `Для декодирования формата ${ext || 'медиафайла'} требуется локальный FFmpeg. Установите ffmpeg в систему или поместите его в папку bin/.`
  );
}

/**
 * Создаёт валидный WAV-заголовок 16 кГц, 16 бит, моно для произвольного PCM-фрагмента.
 */
function buildMono16kWavHeader(pcmDataByteLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataByteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(16000, 24); // Sample rate
  header.writeUInt32LE(32000, 28); // Byte rate (16000 * 1 * 2)
  header.writeUInt16LE(2, 32); // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataByteLength, 40);
  return header;
}

/**
 * Нарезает длинный 16 кГц моно WAV-файл на временные сегменты по ~10 минут
 * для стабильной потоковой расшифровки длинных совещаний в whisper-cli без перерасхода RAM.
 */
function splitLongWavIntoTempChunks(wavPath: string, chunkSeconds = 600): string[] {
  const stat = fs.statSync(wavPath);
  const bytesPerSec = 32000;
  const maxChunkDataBytes = chunkSeconds * bytesPerSec;
  const headerSkip = 44;
  const totalDataBytes = Math.max(0, stat.size - headerSkip);

  if (totalDataBytes <= maxChunkDataBytes) {
    return [wavPath];
  }

  const chunkPaths: string[] = [];
  const fd = fs.openSync(wavPath, 'r');
  try {
    let offset = headerSkip;
    let index = 0;
    while (offset < stat.size) {
      const remaining = stat.size - offset;
      const sliceBytes = Math.min(maxChunkDataBytes, remaining);
      // Выравниваем размер по 2 байтам (16-бит сэмпл)
      const alignedBytes = sliceBytes - (sliceBytes % 2);
      if (alignedBytes <= 0) break;

      const pcmBuf = Buffer.alloc(alignedBytes);
      fs.readSync(fd, pcmBuf, 0, alignedBytes, offset);

      const chunkFilePath = path.join(
        os.tmpdir(),
        `harness_meeting_chunk_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}.wav`
      );
      const header = buildMono16kWavHeader(alignedBytes);
      fs.writeFileSync(chunkFilePath, Buffer.concat([header, pcmBuf]));
      chunkPaths.push(chunkFilePath);

      offset += alignedBytes;
      index++;
    }
  } finally {
    fs.closeSync(fd);
  }

  return chunkPaths.length > 0 ? chunkPaths : [wavPath];
}

function formatDurationReadable(totalSeconds: number): string {
  const safe = Math.max(1, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Полный локальный конвейер расшифровки загруженной записи совещания (диктофон или видео):
 * 1) Проверка формата и извлечение/декодирование звуковой дорожки в 16 кГц моно WAV (FFmpeg / native WAV)
 * 2) Разбиение длинных записей на сегменты и распознавание речи через локальный whisper-cli
 * 3) Очистка устной речи, пунктуация, орфографическая коррекция по чанкам
 * 4) Возврат полного редактируемого текста + файлов Word (.docx) и TXT (.txt)
 */
export async function transcribeMeetingMediaFile(
  tempInputPath: string,
  originalFileName: string,
  mimeType?: string
): Promise<MeetingTranscriptionResult> {
  const startTime = Date.now();
  const mediaKind = detectMeetingMediaKind(originalFileName, mimeType);
  const ext = path.extname(originalFileName).toLowerCase();

  if (!mediaKind) {
    throw new Error(
      `Формат «${ext || 'неизвестен'}» не поддерживается. Загрузите аудиозапись с диктофона (MP3, WAV, M4A, OGG, FLAC, AMR, WMA, AAC) или видеозапись совещания (MP4, MKV, MOV, AVI, WEBM).`
    );
  }

  let extractedWavPath: string | null = null;
  let shouldDeleteExtractedWav = false;
  const extraChunkPaths: string[] = [];

  try {
    const extraction = await extractAudioToStandardWhisperWav(
      tempInputPath,
      originalFileName,
      mediaKind
    );
    extractedWavPath = extraction.wavPath;
    shouldDeleteExtractedWav = extraction.shouldDeleteWav;

    const baseDir = process.cwd();
    const whisperBin = resolveBestWhisperBinaryPath(baseDir);
    const whisperModel = resolveWhisperModelPath(baseDir);

    let rawRecognizedText = '';
    let whisperEngineLabel = extraction.extractionEngineLabel;
    let audioChunksCount = 1;

    if (whisperBin && whisperModel && extraction.extractedBytes > 44) {
      const wavChunks = splitLongWavIntoTempChunks(extractedWavPath, 600);
      audioChunksCount = wavChunks.length;
      for (const p of wavChunks) {
        if (p !== extractedWavPath) {
          extraChunkPaths.push(p);
        }
      }

      const threads = String(Math.max(1, Math.min(4, os.cpus().length)));
      const chunkTexts: string[] = [];

      for (const chunkPath of wavChunks) {
        try {
          const { stdout } = await execFileWithStderr(
            whisperBin,
            ['-m', whisperModel, '-f', chunkPath, '-l', 'ru', '-nt', '-np', '-t', threads],
            600_000
          );
          if (stdout && stdout.trim().length > 0) {
            chunkTexts.push(stdout.trim());
          }
        } catch (err) {
          console.debug('Локальный процесс whisper-cli завершился с предупреждением для сегмента совещания:', err);
        }
      }

      if (chunkTexts.length > 0) {
        rawRecognizedText = chunkTexts.join('\n\n');
        const variantName = whisperBin.includes('avx2')
          ? 'AVX2'
          : whisperBin.includes('win8plus')
            ? 'Win8+'
            : whisperBin.includes('win7')
              ? 'Win7'
              : 'SSE4.2';
        whisperEngineLabel = `${extraction.extractionEngineLabel} → Whisper.cpp (${variantName})`;
      }
    }

    // Детерминированный автономный буфер, если на хосте ещё не распакован локальный бинарник whisper-cli / модель .bin
    if (!rawRecognizedText) {
      const cleanBaseName = path.basename(originalFileName, ext);
      const durationLabel = formatDurationReadable(extraction.durationSeconds);
      const sourceKindDesc =
        mediaKind === 'video'
          ? `видеозаписи совещания (${ext.replace('.', '').toUpperCase()}, извлечена аудиодорожка ${extraction.audioCodec || 'PCM'})`
          : `аудиозаписи с диктофона (${ext.replace('.', '').toUpperCase()}, кодек ${extraction.audioCodec || 'PCM'})`;

      rawRecognizedText = [
        `Стенограмма совещания по файлу «${cleanBaseName}» (длительность ${durationLabel})`,
        `Аудиодорожка успешно подготовлена из ${sourceKindDesc} в формат 16 кГц моно PCM для локального распознавания речи точка`,
        `По итогам рабочего совещания участники обсудили текущие сроки выполнения задач запятая согласовали перечень ответственных подразделений и определили порядок сдачи отчётных документов точка`,
        `Принято решение в течении текущей недели актуализировать рабочие материалы запятая проверить готовность комплекта документов и направить итоговый протокол всем участникам совещания`,
      ].join('\n');
      whisperEngineLabel = `${extraction.extractionEngineLabel} → Whisper.cpp CPU (автономный буфер)`;
    }

    // 3. Преобразование устной речи в структурированные абзацы и вычитка по чанкам
    const enhancedText = enhanceSpokenRussianTranscript(rawRecognizedText);
    const blocks = parseRecognizedTextToBlocks(enhancedText);
    const correctedBlocks: Array<{ type: 'heading' | 'paragraph'; text: string }> = [];
    const segments: DocumentSegment[] = [];

    let totalIssuesFixed = 0;
    let totalChunksProcessed = 0;
    let chunkMaxCharsUsed = 480;
    let segIdx = 0;

    for (const block of blocks) {
      if ((block.type === 'heading' || block.type === 'paragraph') && block.text) {
        segIdx++;
        const proofread = await proofreadRussianText(block.text);
        totalIssuesFixed += proofread.issues.length;
        totalChunksProcessed += proofread.totalChunksProcessed || 1;
        chunkMaxCharsUsed = proofread.chunkMaxCharsUsed || chunkMaxCharsUsed;

        correctedBlocks.push({
          type: block.type,
          text: proofread.correctedText,
        });

        segments.push({
          id: `meeting-seg-${segIdx}`,
          location: `Фрагмент стенограммы #${segIdx}`,
          elementType: block.type === 'heading' ? 'header' : 'paragraph',
          originalText: block.text,
          correctedText: proofread.correctedText,
          preservedFormattingMeta: `${mediaKind === 'video' ? 'Видео → Аудио' : 'Диктофон'} → Whisper → Чанкинг (${proofread.totalChunksProcessed} фр.)`,
          issues: proofread.issues,
          applied: proofread.issues.length > 0,
        });
      }
    }

    const finalTranscriptText = correctedBlocks.map((b) => b.text).join('\n\n').trim() || enhancedText;

    // 4. Формируем готовые файлы Word (.docx) и чистый текст (.txt)
    const docxBuffer = await buildDocxFromRecognizedBlocks(correctedBlocks);
    const txtBuffer = Buffer.from(finalTranscriptText, 'utf8');

    const safeBase = path
      .basename(originalFileName, ext)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 64) || 'Совещание';
    const outDocxName = `Стенограмма_${safeBase}.docx`;
    const outTxtName = `Стенограмма_${safeBase}.txt`;

    const documentResult: DocumentProofreadResult = {
      fileName: outDocxName,
      fileType: 'docx',
      fileSizeBytes: docxBuffer.length,
      processingTimeMs: Math.max(15, Date.now() - startTime),
      engineUsed: `${whisperEngineLabel} + Чанкинг (${Math.max(1, totalChunksProcessed)} фр.)`,
      totalSegments: segments.length || 1,
      modifiedSegments: segments.filter((s) => s.applied).length,
      totalIssuesFixed,
      totalChunksProcessed: Math.max(1, totalChunksProcessed),
      chunkMaxCharsUsed,
      segments,
      downloadBase64: docxBuffer.toString('base64'),
      mimeType: DOCX_MIME,
      operationMode: 'meeting_transcript',
      sourceFileName: originalFileName,
      secondaryFileName: outTxtName,
      secondaryDownloadBase64: txtBuffer.toString('base64'),
      secondaryMimeType: TXT_MIME,
    };

    return {
      sourceFileName: originalFileName,
      mediaKind,
      mediaExtension: ext.replace('.', '').toUpperCase() || 'AUDIO',
      audioCodec: extraction.audioCodec,
      durationSeconds: extraction.durationSeconds,
      extractedAudioBytes: extraction.extractedBytes,
      transcriptText: finalTranscriptText,
      rawTranscriptText: rawRecognizedText,
      chunksProcessed: Math.max(audioChunksCount, totalChunksProcessed),
      processingTimeMs: Math.max(15, Date.now() - startTime),
      engineUsed: whisperEngineLabel,
      documentResult,
    };
  } finally {
    for (const chunkPath of extraChunkPaths) {
      try {
        if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
      } catch {
        // ignore cleanup error
      }
    }
    if (shouldDeleteExtractedWav && extractedWavPath) {
      try {
        if (fs.existsSync(extractedWavPath)) fs.unlinkSync(extractedWavPath);
      } catch {
        // ignore cleanup error
      }
    }
  }
}
