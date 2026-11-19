import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type Tesseract from 'tesseract.js';
import { PositionedTextItem } from './ocrTypes.ts';

let cachedWorkerPromise: Promise<Tesseract.Worker | null> | null = null;

export function resolveLocalTessdataDir(): string | null {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    process.env.TESSDATA_PREFIX || '',
    path.join(process.cwd(), 'tessdata'),
    path.join(execDir, 'tessdata'),
    path.join(execDir, '..', 'tessdata'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'rus.traineddata')) &&
      fs.existsSync(path.join(dir, 'eng.traineddata'))
    ) {
      return dir;
    }
  }
  return null;
}

async function getOfflineTesseractWorker(): Promise<Tesseract.Worker | null> {
  if (!cachedWorkerPromise) {
    cachedWorkerPromise = (async () => {
      const langPath = resolveLocalTessdataDir();
      if (!langPath) return null;

      try {
        const tesseractMod = await import('tesseract.js');
        const createWorker =
          tesseractMod.createWorker || (tesseractMod.default && tesseractMod.default.createWorker);
        if (!createWorker) return null;

        const worker = await createWorker(['rus', 'eng'], 1, {
          langPath,
          gzip: false,
          cacheMethod: 'none',
        });

        await worker.setParameters({
          tessedit_pageseg_mode: '3' as Tesseract.PSM,
          preserve_interword_spaces: '1',
        });

        return worker;
      } catch (err) {
        console.debug('Не удалось инициализировать локальный Tesseract WASM:', err);
        cachedWorkerPromise = null;
        return null;
      }
    })();
  }
  return cachedWorkerPromise;
}

function execFileAsync(cmd: string, args: string[], timeoutMs = 25000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 25 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function parseTesseractTsv(tsv: string): PositionedTextItem[] {
  const lines = tsv.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Группируем слова уровня 5 по строкам (page_num, block_num, par_num, line_num) или оставляем слова с координатами
  const items: PositionedTextItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) continue;
    const level = Number(cols[0]);
    if (level !== 5) continue; // word level
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join('\t').trim();
    if (!text || conf < 25 || width <= 0 || height <= 0) continue;

    items.push({
      text,
      bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
      confidence: Math.round(conf),
      fontSize: Math.max(8, Math.round(height * 0.72)),
      source: 'tesseract',
    });
  }
  return items;
}

/**
 * Резервный локальный OCR на базе Tesseract 5 (`rus+eng`, строго из локальной папки tessdata, без интернета).
 * Используется только если ONNX-веса RapidOCR отсутствуют или не смогли распознать изображение.
 */
export async function runTesseractFallbackOnPng(
  pngBuffer: Buffer
): Promise<{ items: PositionedTextItem[]; engineName: string }> {
  // 1. Встроенный кроссплатформенный Tesseract 5 WASM (оффлайн tessdata)
  const worker = await getOfflineTesseractWorker();
  if (worker) {
    try {
      const res = await worker.recognize(pngBuffer, {}, { blocks: true, tsv: true, text: true });
      const items: PositionedTextItem[] = [];

      if (res.data.tsv) {
        items.push(...parseTesseractTsv(res.data.tsv));
      } else if (res.data.blocks) {
        for (const blk of res.data.blocks) {
          for (const par of blk.paragraphs || []) {
            for (const line of par.lines || []) {
              for (const word of line.words || []) {
                const txt = (word.text || '').trim();
                if (!txt || word.confidence < 25) continue;
                items.push({
                  text: txt,
                  bbox: {
                    x0: word.bbox.x0,
                    y0: word.bbox.y0,
                    x1: word.bbox.x1,
                    y1: word.bbox.y1,
                  },
                  confidence: Math.round(word.confidence),
                  fontSize: Math.max(8, Math.round((word.bbox.y1 - word.bbox.y0) * 0.72)),
                  source: 'tesseract',
                });
              }
            }
          }
        }
      }

      if (items.length > 0) {
        return {
          items,
          engineName: 'Tesseract 5 WASM (rus+eng, оффлайн резерв)',
        };
      }
    } catch (err) {
      console.debug('Ошибка Tesseract WASM:', err);
    }
  }

  // 2. Системный бинарник tesseract (если установлен в Astra Linux / Windows)
  const localTessdata = resolveLocalTessdataDir();
  const candidateBins = [
    path.join(process.cwd(), 'bin', 'win7-x64', 'tesseract.exe'),
    path.join(process.cwd(), 'bin', 'linux-x64', 'tesseract'),
    'tesseract',
  ];

  const tmpImg = path.join(
    os.tmpdir(),
    `harness_tess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`
  );
  try {
    fs.writeFileSync(tmpImg, pngBuffer);
    for (const bin of candidateBins) {
      if (bin.includes(path.sep) && !fs.existsSync(bin)) continue;
      try {
        const args = [tmpImg, 'stdout', '-l', 'rus+eng', '--oem', '1', '--psm', '3', 'tsv'];
        if (localTessdata) {
          args.unshift('--tessdata-dir', localTessdata);
        }
        const tsv = await execFileAsync(bin, args, 25000);
        const items = parseTesseractTsv(tsv);
        if (items.length > 0) {
          return {
            items,
            engineName: 'Tesseract 5 CLI (rus+eng, локальный)',
          };
        }
      } catch {
        // try next binary
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg);
    } catch {
      // ignore cleanup error
    }
  }

  return { items: [], engineName: 'Локальный OCR (текстовых областей не обнаружено)' };
}
