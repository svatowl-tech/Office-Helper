import fs from 'fs';
import path from 'path';
import type * as OrtNamespace from 'onnxruntime-web';
import { BBox, importEsmModule, JimpImage, PositionedTextItem } from './ocrTypes.ts';

type OrtModule = typeof OrtNamespace;
type OrtSession = OrtNamespace.InferenceSession;

export interface SlaNetTableCellBox {
  rowIdx: number;
  colIdx: number;
  colSpan: number;
  rowSpan: number;
  bbox: BBox;
}

export interface SlaNetTableStructure {
  numRows: number;
  numCols: number;
  cells: SlaNetTableCellBox[];
}

interface RapidOcrSessions {
  ort: OrtModule;
  det: OrtSession;
  cls: OrtSession | null;
  rec: OrtSession;
  slanet: OrtSession | null;
  recDict: string[];
  modelsDir: string;
}

// Точный словарь токенов SLANet (извлечен из метаданных en_ppstructure_mobile_v2_SLANet.onnx: 1 sos + 28 tokens + 1 eos = 30)
const SLANET_TOKENS: string[] = [
  'sos',
  '<thead>',
  '<tr>',
  '<td>',
  '</td>',
  '</tr>',
  '</thead>',
  '<tbody>',
  '</tbody>',
  '<td',
  ' colspan="5"',
  '>',
  ' colspan="2"',
  ' colspan="3"',
  ' rowspan="2"',
  ' colspan="4"',
  ' colspan="6"',
  ' rowspan="3"',
  ' colspan="9"',
  ' colspan="10"',
  ' colspan="7"',
  ' rowspan="4"',
  ' rowspan="5"',
  ' rowspan="9"',
  ' colspan="8"',
  ' rowspan="8"',
  ' rowspan="6"',
  ' rowspan="7"',
  ' rowspan="10"',
  'eos',
];

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

let cachedSessionsPromise: Promise<RapidOcrSessions | null> | null = null;

export function resolveOcrModelsDir(): string | null {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    process.env.LOCAL_OCR_MODELS_DIR || '',
    path.join(process.cwd(), 'models', 'ocr'),
    path.join(execDir, 'models', 'ocr'),
    path.join(execDir, '..', 'models', 'ocr'),
  ].filter(Boolean);

  for (const dir of candidates) {
    const detPath = path.join(dir, 'ch_PP-OCRv4_det_infer.onnx');
    const recPath = path.join(dir, 'eslav_PP-OCRv5_rec.onnx');
    const dictPath = path.join(dir, 'eslav_dict.txt');
    if (fs.existsSync(detPath) && fs.existsSync(recPath) && fs.existsSync(dictPath)) {
      return dir;
    }
  }
  return null;
}

export async function getRapidOcrSessions(): Promise<RapidOcrSessions | null> {
  if (!cachedSessionsPromise) {
    cachedSessionsPromise = (async () => {
      const modelsDir = resolveOcrModelsDir();
      if (!modelsDir) {
        return null;
      }

      try {
        const ort = await importEsmModule<OrtModule>('onnxruntime-web');
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;

        const sessionOpts: OrtNamespace.InferenceSession.SessionOptions = {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        };

        const detBuf = fs.readFileSync(path.join(modelsDir, 'ch_PP-OCRv4_det_infer.onnx'));
        const recBuf = fs.readFileSync(path.join(modelsDir, 'eslav_PP-OCRv5_rec.onnx'));
        const det = await ort.InferenceSession.create(detBuf, sessionOpts);
        const rec = await ort.InferenceSession.create(recBuf, sessionOpts);

        let cls: OrtSession | null = null;
        const clsPath = path.join(modelsDir, 'ch_ppocr_mobile_v2.0_cls_train.onnx');
        if (fs.existsSync(clsPath)) {
          try {
            cls = await ort.InferenceSession.create(fs.readFileSync(clsPath), sessionOpts);
          } catch (err) {
            console.debug('Не удалось загрузить классификатор угла RapidOCR (продолжаем без него):', err);
          }
        }

        let slanet: OrtSession | null = null;
        const slanetPath = path.join(modelsDir, 'en_slanet.onnx');
        if (fs.existsSync(slanetPath)) {
          try {
            slanet = await ort.InferenceSession.create(fs.readFileSync(slanetPath), sessionOpts);
          } catch (err) {
            console.debug('Не удалось загрузить SLANet ONNX (используем геометрический анализатор таблиц):', err);
          }
        }

        const rawDictLines = fs
          .readFileSync(path.join(modelsDir, 'eslav_dict.txt'), 'utf8')
          .split(/\r?\n/);
        while (rawDictLines.length > 0 && rawDictLines[rawDictLines.length - 1] === '') {
          rawDictLines.pop();
        }
        // Индекс 0 = CTC blank, 1..N = символы словаря, N+1 = пробел (' ')
        const recDict = ['<blank>', ...rawDictLines, ' '];

        return { ort, det, cls, rec, slanet, recDict, modelsDir };
      } catch (err) {
        console.error('Ошибка инициализации RapidOCR ONNX (WASM):', err);
        cachedSessionsPromise = null;
        return null;
      }
    })();
  }
  return cachedSessionsPromise;
}

/**
 * Подготовка CHW float32 тензора (BGR, ImageNet mean/std) для DBNet++ детектора текста.
 */
function buildDetTensorData(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number
): Float32Array {
  const area = width * height;
  const out = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    const p = i * 4;
    const r = rgba[p] / 255;
    const g = rgba[p + 1] / 255;
    const b = rgba[p + 2] / 255;
    // PaddleOCR DBNet++ обучен в BGR-порядке с ImageNet нормализацией
    out[i] = (b - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    out[area + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    out[2 * area + i] = (r - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return out;
}

/**
 * Подготовка CHW float32 тензора (BGR, [-1, 1]) для PP-OCRv5 Rec (height=48) и Cls (48x192).
 */
function buildRecOrClsTensorData(
  rgba: Uint8Array | Buffer,
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number
): Float32Array {
  const area = targetW * targetH;
  const out = new Float32Array(3 * area);
  // Нулевое заполнение (в [-1, 1] это серый/нейтральный паддинг справа, стандарт PaddleOCR)
  const copyW = Math.min(srcW, targetW);
  const copyH = Math.min(srcH, targetH);

  for (let y = 0; y < copyH; y++) {
    const srcRow = y * srcW * 4;
    const dstRow = y * targetW;
    for (let x = 0; x < copyW; x++) {
      const p = srcRow + x * 4;
      const r = (rgba[p] / 255 - 0.5) / 0.5;
      const g = (rgba[p + 1] / 255 - 0.5) / 0.5;
      const b = (rgba[p + 2] / 255 - 0.5) / 0.5;
      const idx = dstRow + x;
      out[idx] = b;
      out[area + idx] = g;
      out[2 * area + idx] = r;
    }
  }
  return out;
}

/**
 * Извлекает прямоугольные текстовые боксы из карты вероятностей DBNet++ (8-связные компоненты + unclip).
 */
function extractBoxesFromProbabilityMap(
  probMap: Float32Array,
  mapW: number,
  mapH: number,
  origW: number,
  origH: number,
  thresh = 0.3,
  boxThresh = 0.48
): BBox[] {
  const total = mapW * mapH;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const boxes: BBox[] = [];

  const scaleX = origW / mapW;
  const scaleY = origH / mapH;

  for (let y = 0; y < mapH; y++) {
    const rowOff = y * mapW;
    for (let x = 0; x < mapW; x++) {
      const startIdx = rowOff + x;
      if (visited[startIdx] || probMap[startIdx] <= thresh) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = startIdx;
      visited[startIdx] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let pixelCount = 0;
      let probSum = 0;

      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % mapW;
        const cy = (idx - cx) / mapW;
        pixelCount++;
        probSum += probMap[idx];

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 8-связность для стабильного объединения штрихов букв
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= mapH) continue;
          const nRow = ny * mapW;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= mapW) continue;
            const nIdx = nRow + nx;
            if (!visited[nIdx] && probMap[nIdx] > thresh) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < 3 || bh < 3 || pixelCount < 8) continue;

      // Проверяем среднюю вероятность внутри прямоугольника (стандарт DBNet box_score_fast)
      const meanCompScore = probSum / pixelCount;
      if (meanCompScore < boxThresh) continue;

      // DBNet unclip: расширяем бокс пропорционально area/perimeter, аккуратно по вертикали чтобы не сливать строки таблицы
      const area = bw * bh;
      const perimeter = 2 * (bw + bh);
      const unclipDist = (area * 1.55) / Math.max(1, perimeter);
      const padX = Math.min(Math.max(2, unclipDist * 1.1), bh * 0.95 + 4);
      const padY = Math.min(Math.max(1.5, unclipDist * 0.8), bh * 0.42 + 2);

      const x0 = Math.max(0, Math.floor((minX - padX) * scaleX));
      const y0 = Math.max(0, Math.floor((minY - padY) * scaleY));
      const x1 = Math.min(origW, Math.ceil((maxX + 1 + padX) * scaleX));
      const y1 = Math.min(origH, Math.ceil((maxY + 1 + padY) * scaleY));

      if (x1 - x0 >= 6 && y1 - y0 >= 6) {
        boxes.push({ x0, y0, x1, y1 });
      }
    }
  }

  // Сортируем сверху вниз, затем слева направо
  boxes.sort((a, b) => {
    const yDiff = a.y0 - b.y0;
    if (Math.abs(yDiff) > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5) {
      return yDiff;
    }
    return a.x0 - b.x0;
  });

  return boxes;
}

/**
 * Декодирование выхода CTC-головы PP-OCRv5 East-Slavic ([1, seqLen, numClasses]).
 */
const LATIN_TO_CYR_HOMOGLYPH: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
};

const CYR_TO_LATIN_HOMOGLYPH: Record<string, string> = {
  А: 'A',
  В: 'B',
  С: 'C',
  Е: 'E',
  Н: 'H',
  К: 'K',
  М: 'M',
  О: 'O',
  Р: 'P',
  Т: 'T',
  Х: 'X',
  а: 'a',
  с: 'c',
  е: 'e',
  о: 'o',
  р: 'p',
  х: 'x',
  у: 'y',
};

const UNAMBIGUOUS_CYR = /[БГДЁЖЗИЙЛПУФЦЧШЩЪЫЬЭЮЯбвгдёжзийклмнптуфцчшщъыьэюя]/;
const UNAMBIGUOUS_LAT = /[DFGIJLNQRSUVWYZbdfghijklnqrsuvwz]/;

/**
 * Устраняет типичный артефакт мультиязычных моделей PP-OCR (смешивание визуально идентичных
 * букв кириллицы и латиницы в одном слове, например «Сeрвep» → «Сервер» или «Ordеr» → «Order»).
 * НЕ является автокорректором орфографии: меняет только однозначные омоглифы скрипта внутри слова.
 */
function normalizeMixedScriptHomoglyphs(text: string): string {
  return text.replace(/[A-Za-zА-Яа-яЁё]+/g, (word) => {
    const hasCyr = /[А-Яа-яЁё]/.test(word);
    const hasLat = /[A-Za-z]/.test(word);
    if (!hasCyr || !hasLat) return word;

    const cyrStrong = UNAMBIGUOUS_CYR.test(word);
    const latStrong = UNAMBIGUOUS_LAT.test(word);

    if (cyrStrong && !latStrong) {
      return word.replace(/[ABCEHKMOPTXaceopxy]/g, (ch) => LATIN_TO_CYR_HOMOGLYPH[ch] || ch);
    }
    if (latStrong && !cyrStrong) {
      return word.replace(/[АВСЕНКМОРТХасеорху]/g, (ch) => CYR_TO_LATIN_HOMOGLYPH[ch] || ch);
    }

    // Если слово содержит преимущественно кириллицу (например «Кommyтatop» — больше кириллических букв)
    const cyrCount = (word.match(/[А-Яа-яЁё]/g) || []).length;
    const latCount = (word.match(/[A-Za-z]/g) || []).length;
    if (cyrCount >= latCount && cyrStrong) {
      return word.replace(/[ABCEHKMOPTXaceopxy]/g, (ch) => LATIN_TO_CYR_HOMOGLYPH[ch] || ch);
    }
    if (latCount > cyrCount && latStrong) {
      return word.replace(/[АВСЕНКМОРТХасеорху]/g, (ch) => CYR_TO_LATIN_HOMOGLYPH[ch] || ch);
    }
    return word;
  });
}

function decodeCtcGreedy(
  logits: Float32Array,
  seqLen: number,
  numClasses: number,
  dict: string[]
): { text: string; confidence: number } {
  const chars: string[] = [];
  let prevIdx = -1;
  let confSum = 0;
  let confCount = 0;

  for (let t = 0; t < seqLen; t++) {
    const offset = t * numClasses;
    let bestIdx = 0;
    let bestVal = logits[offset];
    for (let c = 1; c < numClasses; c++) {
      const v = logits[offset + c];
      if (v > bestVal) {
        bestVal = v;
        bestIdx = c;
      }
    }

    if (bestIdx !== 0 && bestIdx !== prevIdx) {
      const ch = dict[bestIdx];
      if (ch !== undefined && ch !== '<blank>') {
        chars.push(ch);
        // Выход eslav_PP-OCRv5_rec уже прошел Softmax (0..1), но страхуемся на случай логитов
        const prob = bestVal >= 0 && bestVal <= 1.001 ? bestVal : 1 / (1 + Math.exp(-bestVal));
        confSum += prob;
        confCount++;
      }
    }
    prevIdx = bestIdx;
  }

  const text = normalizeMixedScriptHomoglyphs(chars.join('').trim());
  const confidence = confCount > 0 ? Math.round((confSum / confCount) * 100) : 0;
  return { text, confidence };
}

/**
 * Основной конвейер RapidOCR ONNX (PP-OCRv4 Det + PP-OCRv3 Cls + PP-OCRv5 East-Slavic Rec).
 * Распознаёт русский и английский текст, цифры, спецсимволы и реквизиты с точными координатами.
 */
export async function runRapidOcrOnImage(
  image: JimpImage
): Promise<{ items: PositionedTextItem[]; engineName: string } | null> {
  const sessions = await getRapidOcrSessions();
  if (!sessions) return null;

  const origW = image.bitmap.width;
  const origH = image.bitmap.height;
  if (origW < 10 || origH < 10) {
    return { items: [], engineName: 'RapidOCR ONNX (PP-OCRv4 Det + PP-OCRv5 East-Slavic)' };
  }

  // 1. Масштабирование под DBNet++ (кратность 32, длинная сторона <= 1536 для чётких мелких шрифтов в счетах)
  const maxSide = 1536;
  const minSide = 480;
  let ratio = 1;
  const longest = Math.max(origW, origH);
  if (longest > maxSide) {
    ratio = maxSide / longest;
  } else if (longest < minSide) {
    ratio = Math.min(2, minSide / longest);
  }

  const detW = Math.max(32, Math.round((origW * ratio) / 32) * 32);
  const detH = Math.max(32, Math.round((origH * ratio) / 32) * 32);

  const detImg = image.clone().resize({ w: detW, h: detH });
  const detData = buildDetTensorData(detImg.bitmap.data, detW, detH);
  const detTensor = new sessions.ort.Tensor('float32', detData, [1, 3, detH, detW]);

  const detInputName = sessions.det.inputNames[0];
  const detOutputName = sessions.det.outputNames[0];
  const detOut = await sessions.det.run({ [detInputName]: detTensor });
  const probTensor = detOut[detOutputName];
  const probMap = probTensor.data as Float32Array;
  const outH = Number(probTensor.dims[2] ?? detH);
  const outW = Number(probTensor.dims[3] ?? detW);

  const rawBoxes = extractBoxesFromProbabilityMap(probMap, outW, outH, origW, origH);
  if (rawBoxes.length === 0) {
    return { items: [], engineName: 'RapidOCR ONNX (PP-OCRv4 Det + PP-OCRv5 East-Slavic)' };
  }

  // 2. Распознавание каждого текстового фрагмента (с опциональным переворотом 180° через Cls)
  const items: PositionedTextItem[] = [];
  const recInputName = sessions.rec.inputNames[0];
  const recOutputName = sessions.rec.outputNames[0];
  const clsInputName = sessions.cls?.inputNames[0];
  const clsOutputName = sessions.cls?.outputNames[0];

  const maxBoxes = Math.min(rawBoxes.length, 450);

  for (let i = 0; i < maxBoxes; i++) {
    const box = rawBoxes[i];
    const padX = 3;
    const padY = 2;
    const cx0 = Math.max(0, box.x0 - padX);
    const cy0 = Math.max(0, box.y0 - padY);
    const cw = Math.max(1, Math.min(origW - cx0, box.x1 - cx0 + padX));
    const ch = Math.max(1, Math.min(origH - cy0, box.y1 - cy0 + padY));
    if (cw < 4 || ch < 4) continue;

    let crop = image.clone().crop({ x: cx0, y: cy0, w: cw, h: ch });

    // Вертикальные надписи (высота >> ширины) поворачиваем на 90° для корректного чтения
    if (ch > cw * 1.8 && ch > 40) {
      crop.rotate(90);
    }

    // Проверка ориентации 0° / 180° через Cls
    if (sessions.cls && clsInputName && clsOutputName && crop.bitmap.width > crop.bitmap.height * 1.4) {
      try {
        const clsRatio = crop.bitmap.width / Math.max(1, crop.bitmap.height);
        const clsW = Math.min(192, Math.max(16, Math.round(48 * clsRatio)));
        const clsResized = crop.clone().resize({ w: clsW, h: 48 });
        const clsData = buildRecOrClsTensorData(clsResized.bitmap.data, clsW, 48, 192, 48);
        const clsTensor = new sessions.ort.Tensor('float32', clsData, [1, 3, 48, 192]);
        const clsOut = await sessions.cls.run({ [clsInputName]: clsTensor });
        const probs = clsOut[clsOutputName].data as Float32Array;
        if (probs.length >= 2 && probs[1] > 0.92 && probs[1] > probs[0]) {
          crop = crop.rotate(180);
        }
      } catch {
        // Игнорируем сбой классификатора для отдельного фрагмента
      }
    }

    // Распознавание PP-OCRv5 East-Slavic (высота строго 48 px)
    const recH = 48;
    const aspect = crop.bitmap.width / Math.max(1, crop.bitmap.height);
    const scaledW = Math.min(1536, Math.max(24, Math.ceil(recH * aspect)));
    const paddedW = Math.min(1600, Math.max(48, Math.ceil((scaledW + 8) / 8) * 8));

    const recResized = crop.resize({ w: scaledW, h: recH });
    const recData = buildRecOrClsTensorData(recResized.bitmap.data, scaledW, recH, paddedW, recH);
    const recTensor = new sessions.ort.Tensor('float32', recData, [1, 3, recH, paddedW]);

    const recOut = await sessions.rec.run({ [recInputName]: recTensor });
    const outTensor = recOut[recOutputName];
    const seqLen = Number(outTensor.dims[1] ?? 0);
    const numClasses = Number(outTensor.dims[2] ?? sessions.recDict.length);
    if (seqLen <= 0 || numClasses <= 0) continue;

    const decoded = decodeCtcGreedy(
      outTensor.data as Float32Array,
      seqLen,
      numClasses,
      sessions.recDict
    );

    if (decoded.text.length > 0 && decoded.confidence >= 38) {
      items.push({
        text: decoded.text,
        bbox: box,
        confidence: decoded.confidence,
        fontSize: Math.max(8, Math.round(ch * 0.72)),
        source: 'rapidocr',
      });
    }
  }

  return {
    items,
    engineName: 'RapidOCR ONNX (PP-OCRv4 Det + PP-OCRv5 East-Slavic RU/EN)',
  };
}

/**
 * Анализ сложной структуры таблицы через RapidTable SLANet ONNX (`en_slanet.onnx`).
 * Возвращает матрицу ячеек (с поддержкой colspan / rowspan и координатами каждой ячейки в пикселях исходной страницы).
 */
export async function analyzeTableRegionWithSlaNet(
  pageImage: JimpImage,
  tableBbox: BBox
): Promise<SlaNetTableStructure | null> {
  const sessions = await getRapidOcrSessions();
  if (!sessions || !sessions.slanet) return null;

  const origW = pageImage.bitmap.width;
  const origH = pageImage.bitmap.height;
  const x0 = Math.max(0, Math.floor(tableBbox.x0));
  const y0 = Math.max(0, Math.floor(tableBbox.y0));
  const cw = Math.min(origW - x0, Math.ceil(tableBbox.x1 - x0));
  const ch = Math.min(origH - y0, Math.ceil(tableBbox.y1 - y0));
  if (cw < 40 || ch < 30) return null;

  try {
    const maxLen = 488;
    const scale = maxLen / Math.max(cw, ch);
    const resizedW = Math.max(1, Math.min(maxLen, Math.round(cw * scale)));
    const resizedH = Math.max(1, Math.min(maxLen, Math.round(ch * scale)));

    const crop = pageImage.clone();
    crop.crop({ x: x0, y: y0, w: cw, h: ch });
    crop.resize({ w: resizedW, h: resizedH });

    // Вставляем в верхний левый угол 488x488 тензора с нулевым паддингом (стандарт TableResizeImg)
    const area = maxLen * maxLen;
    const tensorData = new Float32Array(3 * area);
    const rgba = crop.bitmap.data;

    for (let y = 0; y < resizedH; y++) {
      const srcRow = y * resizedW * 4;
      const dstRow = y * maxLen;
      for (let x = 0; x < resizedW; x++) {
        const p = srcRow + x * 4;
        const r = rgba[p] / 255;
        const g = rgba[p + 1] / 255;
        const b = rgba[p + 2] / 255;
        const idx = dstRow + x;
        tensorData[idx] = (b - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
        tensorData[area + idx] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
        tensorData[2 * area + idx] = (r - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
      }
    }

    const inputName = sessions.slanet.inputNames[0];
    const inputTensor = new sessions.ort.Tensor('float32', tensorData, [1, 3, maxLen, maxLen]);
    const outputs = await sessions.slanet.run({ [inputName]: inputTensor });

    let locTensor: OrtNamespace.Tensor | null = null;
    let structTensor: OrtNamespace.Tensor | null = null;
    for (const key of sessions.slanet.outputNames) {
      const t = outputs[key];
      const lastDim = Number(t.dims[t.dims.length - 1] ?? 0);
      if (lastDim === 4) locTensor = t;
      else if (lastDim === SLANET_TOKENS.length) structTensor = t;
    }

    if (!locTensor || !structTensor) return null;

    const seqLen = Number(structTensor.dims[1] ?? 0);
    const vocabSize = Number(structTensor.dims[2] ?? SLANET_TOKENS.length);
    const structData = structTensor.data as Float32Array;
    const locData = locTensor.data as Float32Array;

    const tokens: { token: string; step: number }[] = [];
    for (let t = 0; t < seqLen; t++) {
      const base = t * vocabSize;
      let bestIdx = 0;
      let bestVal = structData[base];
      for (let c = 1; c < vocabSize; c++) {
        if (structData[base + c] > bestVal) {
          bestVal = structData[base + c];
          bestIdx = c;
        }
      }
      const tok = SLANET_TOKENS[bestIdx] || '';
      if (tok === 'eos') break;
      if (tok === 'sos') continue;
      tokens.push({ token: tok, step: t });
    }

    // Разбираем последовательность HTML-токенов в ячейки с (rowIdx, colIdx, colSpan, rowSpan, bbox)
    const cells: SlaNetTableCellBox[] = [];
    const occupied = new Set<string>();
    let currentRow = -1;
    let currentCol = 0;
    let maxCols = 0;

    const findNextFreeCol = (r: number, startC: number): number => {
      let c = startC;
      while (occupied.has(`${r}:${c}`)) c++;
      return c;
    };

    for (let i = 0; i < tokens.length; i++) {
      const { token, step } = tokens[i];
      if (token === '<tr>') {
        currentRow++;
        currentCol = 0;
        continue;
      }

      if (token === '<td>' || token === '<td') {
        if (currentRow < 0) currentRow = 0;
        let colSpan = 1;
        let rowSpan = 1;

        if (token === '<td') {
          let j = i + 1;
          while (j < tokens.length && tokens[j].token !== '>') {
            const attr = tokens[j].token;
            const csMatch = attr.match(/colspan="(\d+)"/);
            const rsMatch = attr.match(/rowspan="(\d+)"/);
            if (csMatch) colSpan = Math.max(1, parseInt(csMatch[1], 10));
            if (rsMatch) rowSpan = Math.max(1, parseInt(rsMatch[1], 10));
            j++;
          }
          i = j;
        }

        const colIdx = findNextFreeCol(currentRow, currentCol);
        currentCol = colIdx + colSpan;
        if (currentCol > maxCols) maxCols = currentCol;

        for (let r = currentRow; r < currentRow + rowSpan; r++) {
          for (let c = colIdx; c < colIdx + colSpan; c++) {
            occupied.add(`${r}:${c}`);
          }
        }

        // SLANet возвращает нормализованные [cx, cy, w, h] относительно 488x488 (padding снизу/справа)
        const lb = step * 4;
        const cx = locData[lb] * maxLen;
        const cy = locData[lb + 1] * maxLen;
        const bw = Math.abs(locData[lb + 2]) * maxLen;
        const bh = Math.abs(locData[lb + 3]) * maxLen;

        const bx0 = x0 + Math.max(0, (cx - bw / 2) / scale);
        const by0 = y0 + Math.max(0, (cy - bh / 2) / scale);
        const bx1 = x0 + Math.min(cw, (cx + bw / 2) / scale);
        const by1 = y0 + Math.min(ch, (cy + bh / 2) / scale);

        cells.push({
          rowIdx: currentRow,
          colIdx,
          colSpan,
          rowSpan,
          bbox: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
        });
      }
    }

    const numRows = currentRow + 1;
    if (numRows < 2 || maxCols < 2 || cells.length < 4) {
      return null;
    }

    return { numRows, numCols: maxCols, cells };
  } catch (err) {
    console.debug('SLANet ONNX не смог разобрать таблицу, переходим к геометрической сетке:', err);
    return null;
  }
}
