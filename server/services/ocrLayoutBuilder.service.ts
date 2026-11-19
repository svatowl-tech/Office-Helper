import {
  BBox,
  ExtractedGraphicRegion,
  PositionedTextItem,
  RecognizedBlock,
  TableCellSpec,
  TableRegionGrid,
} from './ocrTypes.ts';
import { SlaNetTableStructure } from './rapidOcrOnnx.service.ts';

interface OrderedBlockEntry {
  y0: number;
  x0: number;
  block: RecognizedBlock;
}

interface TextSegment {
  text: string;
  bbox: BBox;
  fontSize: number;
  isBold: boolean;
}

interface TextLine {
  y0: number;
  y1: number;
  yCenter: number;
  x0: number;
  x1: number;
  fontSize: number;
  isBold: boolean;
  segments: TextSegment[];
}

function bboxCenter(b: BBox): { cx: number; cy: number } {
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
}

function pointInsideBbox(cx: number, cy: number, box: BBox, margin = 4): boolean {
  return (
    cx >= box.x0 - margin &&
    cx <= box.x1 + margin &&
    cy >= box.y0 - margin &&
    cy <= box.y1 + margin
  );
}

function overlapArea(a: BBox, b: BBox): number {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

/**
 * Бережная техническая очистка OCR-текста БЕЗ автоисправления орфографии и БЕЗ изменения смысла/кодов:
 * только схлопывание двойных пробелов и управляющих символов.
 */
function cleanVerbatimText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Склеивает массив текстовых элементов внутри одной ячейки таблицы с сохранением переносов и порядка чтения.
 */
function joinCellItems(items: PositionedTextItem[]): string {
  if (items.length === 0) return '';
  const sorted = [...items].sort((a, b) => {
    const aH = Math.max(6, a.bbox.y1 - a.bbox.y0);
    const bH = Math.max(6, b.bbox.y1 - b.bbox.y0);
    const aCy = (a.bbox.y0 + a.bbox.y1) / 2;
    const bCy = (b.bbox.y0 + b.bbox.y1) / 2;
    if (Math.abs(aCy - bCy) > Math.min(aH, bH) * 0.55) {
      return aCy - bCy;
    }
    return a.bbox.x0 - b.bbox.x0;
  });

  const lines: string[] = [];
  let currentLineParts: string[] = [];
  let lastCy = (sorted[0].bbox.y0 + sorted[0].bbox.y1) / 2;
  let lastH = Math.max(6, sorted[0].bbox.y1 - sorted[0].bbox.y0);

  for (const item of sorted) {
    const cy = (item.bbox.y0 + item.bbox.y1) / 2;
    const h = Math.max(6, item.bbox.y1 - item.bbox.y0);
    if (currentLineParts.length > 0 && Math.abs(cy - lastCy) > Math.min(h, lastH) * 0.65) {
      lines.push(cleanVerbatimText(currentLineParts.join(' ')));
      currentLineParts = [item.text];
    } else {
      currentLineParts.push(item.text);
    }
    lastCy = cy;
    lastH = h;
  }
  if (currentLineParts.length > 0) {
    lines.push(cleanVerbatimText(currentLineParts.join(' ')));
  }

  // Склеиваем разорванный перенос длинного слова (>=4 букв до дефиса), но сохраняем реальные дефисы (например, «Кол-во»)
  let joined = lines.filter(Boolean).join('\n');
  joined = joined.replace(/([А-Яа-яЁёA-Za-z]{4,})-\n([а-яёa-z]{2,})/g, '$1$2');
  return joined.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Собирает таблицу по физическим линиям сетки (horizontalYs × verticalXs).
 */
function buildTableFromGridLines(
  grid: TableRegionGrid,
  tableItems: PositionedTextItem[]
): RecognizedBlock | null {
  const ys = grid.horizontalYs;
  const xs = grid.verticalXs;
  const numRows = ys.length - 1;
  const numCols = xs.length - 1;
  if (numRows < 1 || numCols < 2) return null;

  const cellBuckets: PositionedTextItem[][][] = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => [])
  );

  for (const item of tableItems) {
    const { cx, cy } = bboxCenter(item.bbox);
    let rIdx = -1;
    for (let r = 0; r < numRows; r++) {
      if (cy >= ys[r] - 4 && cy <= ys[r + 1] + 4) {
        rIdx = r;
        break;
      }
    }
    let cIdx = -1;
    for (let c = 0; c < numCols; c++) {
      if (cx >= xs[c] - 4 && cx <= xs[c + 1] + 4) {
        cIdx = c;
        break;
      }
    }
    if (rIdx >= 0 && cIdx >= 0) {
      cellBuckets[rIdx][cIdx].push(item);
    }
  }

  const rawRows: string[][] = [];
  const rawCellGrid: TableCellSpec[][] = [];

  for (let r = 0; r < numRows; r++) {
    const rowStrings: string[] = [];
    const rowSpecs: TableCellSpec[] = [];
    let hasContent = false;
    for (let c = 0; c < numCols; c++) {
      const txt = joinCellItems(cellBuckets[r][c]);
      if (txt) hasContent = true;
      rowStrings.push(txt);
      rowSpecs.push({ text: txt, colSpan: 1, rowSpan: 1 });
    }
    if (hasContent) {
      rawRows.push(rowStrings);
      rawCellGrid.push(rowSpecs);
    }
  }

  if (rawRows.length === 0) return null;

  // Удаляем полностью пустые столбцы (например, двойную рамку таблицы)
  const nonEmptyCols: number[] = [];
  for (let c = 0; c < numCols; c++) {
    const widthPx = xs[c + 1] - xs[c];
    const hasAny = rawRows.some((r) => (r[c] || '').trim().length > 0);
    if (hasAny || widthPx >= 28) {
      nonEmptyCols.push(c);
    }
  }
  if (nonEmptyCols.length < 2) return null;

  const filteredRows = rawRows.map((r) => nonEmptyCols.map((c) => r[c] || ''));
  const filteredSpecs = rawCellGrid.map((r) => nonEmptyCols.map((c) => r[c]));

  const colWidths = nonEmptyCols.map((c) => Math.max(10, xs[c + 1] - xs[c]));
  const totalW = colWidths.reduce((s, v) => s + v, 0) || 1;
  const columnWidthFractions = colWidths.map((w) => w / totalW);

  return {
    type: 'table',
    rows: filteredRows,
    cellGrid: filteredSpecs,
    columnWidthFractions,
  };
}

/**
 * Собирает таблицу из предсказания SLANet ONNX (с поддержкой colspan / rowspan).
 */
function buildTableFromSlaNet(
  sla: SlaNetTableStructure,
  tableItems: PositionedTextItem[]
): RecognizedBlock | null {
  const { numRows, numCols, cells } = sla;
  if (numRows < 2 || numCols < 2 || cells.length === 0) return null;

  const gridSpecs: TableCellSpec[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => ({ text: '', colSpan: 1, rowSpan: 1 }))
  );

  // Распределяем каждый текстовый элемент в наиболее подходящую ячейку SLANet
  const buckets = new Map<number, PositionedTextItem[]>();
  for (let i = 0; i < cells.length; i++) buckets.set(i, []);

  for (const item of tableItems) {
    const { cx, cy } = bboxCenter(item.bbox);
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < cells.length; i++) {
      const cb = cells[i].bbox;
      const ov = overlapArea(item.bbox, cb);
      const inside = pointInsideBbox(cx, cy, cb, 6) ? 1 : 0;
      const score = ov + inside * 1000;
      if (score > bestScore && (ov > 0 || inside > 0)) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      buckets.get(bestIdx)!.push(item);
    }
  }

  let matchedTotal = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const items = buckets.get(i) || [];
    matchedTotal += items.length;
    const text = joinCellItems(items);
    if (cell.rowIdx < numRows && cell.colIdx < numCols) {
      gridSpecs[cell.rowIdx][cell.colIdx] = {
        text,
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      };
      // Помечаем перекрытые ячейки span-а
      for (let r = cell.rowIdx; r < Math.min(numRows, cell.rowIdx + cell.rowSpan); r++) {
        for (let c = cell.colIdx; c < Math.min(numCols, cell.colIdx + cell.colSpan); c++) {
          if (r === cell.rowIdx && c === cell.colIdx) continue;
          gridSpecs[r][c] = { text: '', isMergedContinuation: true };
        }
      }
    }
  }

  // Если SLANet сопоставил меньше половины текста таблицы — лучше откатиться к точным физическим линиям сетки
  if (tableItems.length >= 4 && matchedTotal < tableItems.length * 0.5) {
    return null;
  }

  const rows = gridSpecs.map((r) => r.map((c) => c.text));
  const nonEmptyRowsCount = rows.filter((r) => r.some((v) => v.trim().length > 0)).length;
  if (nonEmptyRowsCount < 2) return null;

  return {
    type: 'table',
    rows,
    cellGrid: gridSpecs,
  };
}

/**
 * Группирует свободные текстовые элементы (вне расчерченных таблиц) в визуальные строки и сегменты.
 */
function groupItemsIntoLines(items: PositionedTextItem[]): TextLine[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => {
    const aCy = (a.bbox.y0 + a.bbox.y1) / 2;
    const bCy = (b.bbox.y0 + b.bbox.y1) / 2;
    return aCy - bCy || a.bbox.x0 - b.bbox.x0;
  });

  const lineGroups: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const itemCy = (item.bbox.y0 + item.bbox.y1) / 2;
    const itemH = Math.max(6, item.bbox.y1 - item.bbox.y0);

    let placed = false;
    for (let i = lineGroups.length - 1; i >= Math.max(0, lineGroups.length - 4); i--) {
      const grp = lineGroups[i];
      const grpCy = grp.reduce((s, it) => s + (it.bbox.y0 + it.bbox.y1) / 2, 0) / grp.length;
      const grpH = grp.reduce((s, it) => s + Math.max(6, it.bbox.y1 - it.bbox.y0), 0) / grp.length;
      if (Math.abs(itemCy - grpCy) <= Math.min(itemH, grpH) * 0.55) {
        grp.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lineGroups.push([item]);
    }
  }

  const lines: TextLine[] = [];
  for (const grp of lineGroups) {
    grp.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const segments: TextSegment[] = [];

    for (const item of grp) {
      const clean = cleanVerbatimText(item.text);
      if (!clean) continue;
      const itemH = Math.max(6, item.bbox.y1 - item.bbox.y0);
      const itemFont = item.fontSize ?? Math.round(itemH * 0.75);

      const prev = segments[segments.length - 1];
      if (prev) {
        const gap = item.bbox.x0 - prev.bbox.x1;
        const avgCharW = Math.max(
          4,
          (prev.bbox.x1 - prev.bbox.x0) / Math.max(1, prev.text.length)
        );
        // Разрыв > ~2.4 ширины символа (и >= 1.3 высоты шрифта) считаем разделителем колонок!
        const columnGapThreshold = Math.max(itemH * 1.35, avgCharW * 2.5, 16);
        if (gap <= columnGapThreshold) {
          const needsSpace = gap > avgCharW * 0.22 && !prev.text.endsWith(' ');
          prev.text = cleanVerbatimText(prev.text + (needsSpace ? ' ' : '') + clean);
          prev.bbox = {
            x0: Math.min(prev.bbox.x0, item.bbox.x0),
            y0: Math.min(prev.bbox.y0, item.bbox.y0),
            x1: Math.max(prev.bbox.x1, item.bbox.x1),
            y1: Math.max(prev.bbox.y1, item.bbox.y1),
          };
          prev.fontSize = Math.max(prev.fontSize, itemFont);
          prev.isBold = prev.isBold || Boolean(item.isBold);
          continue;
        }
      }

      segments.push({
        text: clean,
        bbox: { ...item.bbox },
        fontSize: itemFont,
        isBold: Boolean(item.isBold),
      });
    }

    if (segments.length === 0) continue;

    const y0 = Math.min(...segments.map((s) => s.bbox.y0));
    const y1 = Math.max(...segments.map((s) => s.bbox.y1));
    const x0 = Math.min(...segments.map((s) => s.bbox.x0));
    const x1 = Math.max(...segments.map((s) => s.bbox.x1));
    const fontSize = Math.max(...segments.map((s) => s.fontSize));
    const isBold = segments.every((s) => s.isBold);

    lines.push({
      y0,
      y1,
      yCenter: (y0 + y1) / 2,
      x0,
      x1,
      fontSize,
      isBold,
      segments,
    });
  }

  lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return lines;
}

/**
 * Превращает подряд идущие многоколоночные строки (без нарисованной рамки) в выровненную таблицу.
 */
function buildBorderlessTableFromLines(
  lines: TextLine[],
  pageWidth: number
): RecognizedBlock {
  // Находим кластеры X-начал колонок по всем сегментам таблицы
  const allXStarts = lines.flatMap((l) => l.segments.map((s) => s.bbox.x0)).sort((a, b) => a - b);
  const colTol = Math.max(18, pageWidth * 0.035);
  const colAnchors: number[] = [];

  for (const x of allXStarts) {
    const existing = colAnchors.findIndex((a) => Math.abs(a - x) <= colTol);
    if (existing === -1) {
      colAnchors.push(x);
    } else {
      colAnchors[existing] = (colAnchors[existing] + x) / 2;
    }
  }
  colAnchors.sort((a, b) => a - b);

  // Гарантируем, что число колонок не меньше максимума сегментов в одной строке
  const maxSegs = Math.max(...lines.map((l) => l.segments.length));
  const numCols = Math.max(colAnchors.length, maxSegs);

  const rows: string[][] = lines.map((line) => {
    const row = new Array<string>(numCols).fill('');
    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si];
      let bestCol = si;
      if (colAnchors.length >= maxSegs) {
        let bestDist = Infinity;
        for (let ci = 0; ci < colAnchors.length; ci++) {
          const d = Math.abs(seg.bbox.x0 - colAnchors[ci]);
          if (d < bestDist) {
            bestDist = d;
            bestCol = ci;
          }
        }
      }
      bestCol = Math.min(numCols - 1, Math.max(0, bestCol));
      row[bestCol] = row[bestCol] ? `${row[bestCol]} ${seg.text}` : seg.text;
    }
    return row;
  });

  // Вычисляем пропорциональную ширину колонок по реальной протяжённости текста
  const colMaxEnds = new Array<number>(numCols).fill(0);
  const colMinStarts = new Array<number>(numCols).fill(Infinity);
  for (const line of lines) {
    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si];
      let col = Math.min(numCols - 1, si);
      if (colAnchors.length >= maxSegs) {
        let bestDist = Infinity;
        for (let ci = 0; ci < colAnchors.length; ci++) {
          const d = Math.abs(seg.bbox.x0 - colAnchors[ci]);
          if (d < bestDist) {
            bestDist = d;
            col = ci;
          }
        }
      }
      colMinStarts[col] = Math.min(colMinStarts[col], seg.bbox.x0);
      colMaxEnds[col] = Math.max(colMaxEnds[col], seg.bbox.x1);
    }
  }

  const rawWidths = colMaxEnds.map((end, idx) => {
    const start = colMinStarts[idx];
    if (!Number.isFinite(start) || end <= start) return 60;
    return Math.max(40, end - start);
  });
  const totalW = rawWidths.reduce((s, v) => s + v, 0) || 1;

  return {
    type: 'table',
    rows,
    columnWidthFractions: rawWidths.map((w) => w / totalW),
  };
}

/**
 * Главный реконструктор макета страницы:
 * объединяет распознанный текст (без автоисправления!), расчерченные/SLANet таблицы,
 * безрамочные таблицы и графические области (логотипы, печати, чертежи) в единый поток
 * блоков строго в порядке чтения сверху вниз.
 */
export function buildPageLayoutBlocks(params: {
  textItems: PositionedTextItem[];
  graphics: ExtractedGraphicRegion[];
  tableGrids: TableRegionGrid[];
  slaNetTables: Map<number, SlaNetTableStructure>;
  pageWidth: number;
  pageHeight: number;
}): { blocks: RecognizedBlock[]; tablesDetected: number; imagesDetected: number } {
  const { textItems, graphics, tableGrids, slaNetTables, pageWidth } = params;

  // 1. Отсеиваем низкоуверенный мусор OCR, попавший ровно внутрь вырезанных логотипов/печатей/чертежей
  const filteredText = textItems.filter((item) => {
    if (item.source === 'pdf') return true;
    const insideGraphic = graphics.some((g) => {
      const ov = overlapArea(item.bbox, g.bbox);
      const itemA = Math.max(1, (item.bbox.x1 - item.bbox.x0) * (item.bbox.y1 - item.bbox.y0));
      return ov / itemA > 0.7;
    });
    if (insideGraphic && (item.confidence < 72 || item.text.length <= 3)) {
      return false;
    }
    return true;
  });

  const orderedEntries: OrderedBlockEntry[] = [];
  const consumedItemIndices = new Set<number>();
  let tablesDetected = 0;

  // 2. Сначала собираем все расчерченные таблицы (счета, акты, ведомости с рамками)
  for (let gIdx = 0; gIdx < tableGrids.length; gIdx++) {
    const grid = tableGrids[gIdx];
    const itemsInTable: PositionedTextItem[] = [];
    const matchedIndices: number[] = [];

    for (let i = 0; i < filteredText.length; i++) {
      if (consumedItemIndices.has(i)) continue;
      const { cx, cy } = bboxCenter(filteredText[i].bbox);
      if (pointInsideBbox(cx, cy, grid.bbox, 6)) {
        itemsInTable.push(filteredText[i]);
        matchedIndices.push(i);
      }
    }

    if (itemsInTable.length === 0) continue;

    // Пробуем SLANet ONNX (для объединённых ячеек colspan/rowspan) и проверяем против физической сетки
    const slaStruct = slaNetTables.get(gIdx);
    const gridBlock = buildTableFromGridLines(grid, itemsInTable);
    const slaBlock = slaStruct ? buildTableFromSlaNet(slaStruct, itemsInTable) : null;

    // Выбираем вариант с наиболее полным сохранением текста и структуры (SLANet предпочтителен при наличии span-ов)
    let chosenTable: RecognizedBlock | null = gridBlock;
    if (slaBlock) {
      const hasSpans = slaBlock.cellGrid?.some((r) =>
        r.some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1)
      );
      if (!gridBlock || hasSpans) {
        chosenTable = slaBlock;
      }
    }

    if (chosenTable) {
      matchedIndices.forEach((idx) => consumedItemIndices.add(idx));
      orderedEntries.push({
        y0: grid.bbox.y0,
        x0: grid.bbox.x0,
        block: chosenTable,
      });
      tablesDetected++;
    }
  }

  // 3. Оставшийся текст группируем в строки, выделяем безрамочные таблицы, заголовки и абзацы
  const remainingItems = filteredText.filter((_, idx) => !consumedItemIndices.has(idx));
  const lines = groupItemsIntoLines(remainingItems);

  const fontSizes = lines.map((l) => l.fontSize).sort((a, b) => a - b);
  const medianFont = fontSizes.length > 0 ? fontSizes[Math.floor(fontSizes.length / 2)] : 12;
  const lineHeights = lines.map((l) => Math.max(8, l.y1 - l.y0)).sort((a, b) => a - b);
  const medianLineH = lineHeights.length > 0 ? lineHeights[Math.floor(lineHeights.length / 2)] : 14;

  let i = 0;
  while (i < lines.length) {
    // Проверяем серию многоколоночных строк (безрамочная таблица или выровненный прайс/спецификация)
    if (lines[i].segments.length >= 2) {
      let j = i;
      while (
        j < lines.length &&
        lines[j].segments.length >= 2 &&
        (j === i || lines[j].y0 - lines[j - 1].y1 <= medianLineH * 2.4)
      ) {
        j++;
      }

      if (j - i >= 2) {
        const tableLines = lines.slice(i, j);
        const tableBlock = buildBorderlessTableFromLines(tableLines, pageWidth);
        orderedEntries.push({
          y0: tableLines[0].y0,
          x0: tableLines[0].x0,
          block: tableBlock,
        });
        tablesDetected++;
        i = j;
        continue;
      }
    }

    // Одиночная строка или абзац
    const line = lines[i];
    const lineText = line.segments.map((s) => s.text).join('  ').trim();
    if (!lineText) {
      i++;
      continue;
    }

    const lineCenter = (line.x0 + line.x1) / 2;
    const isCentered =
      Math.abs(lineCenter - pageWidth / 2) < pageWidth * 0.14 &&
      line.x1 - line.x0 < pageWidth * 0.78;
    const isRightAligned = line.x0 > pageWidth * 0.52;

    const isHeading =
      lineText.length <= 130 &&
      (line.fontSize >= medianFont * 1.18 ||
        (line.isBold && lineText.length <= 95 && line.segments.length === 1) ||
        (isCentered &&
          lineText.length <= 90 &&
          /^(СЧ[ЕЁ]Т|АКТ|ДОГОВОР|НАКЛАДНАЯ|СПЕЦИФИКАЦИЯ|ВЕДОМОСТЬ|ПРИКАЗ|ПРОТОКОЛ|ОТЧ[ЕЁ]Т|INVOICE|ACT|CONTRACT|SPECIFICATION|REPORT)\b/i.test(
            lineText
          )));

    if (isHeading) {
      orderedEntries.push({
        y0: line.y0,
        x0: line.x0,
        block: {
          type: 'heading',
          text: lineText,
          align: isCentered ? 'center' : isRightAligned ? 'right' : 'left',
          fontSizePt: Math.min(18, Math.max(12, Math.round(line.fontSize))),
        },
      });
      i++;
      continue;
    }

    // Объединяем подряд идущие строки одного абзаца (если нет разрыва по Y, смены отступа или ключевых реквизитов)
    const isKeyValueOrList = (t: string): boolean =>
      /^([А-ЯЁA-Z][^:]{1,42}:\s|\d+[.)]\s|[-•—]\s|ИНН\b|КПП\b|БИК\b|Итого\b|Всего\b|В том числе\b|НДС\b|Total\b|Subtotal\b)/i.test(
        t
      );

    let combined = lineText;
    const paraY0 = line.y0;
    const paraX0 = line.x0;
    let prevLine = line;
    let k = i + 1;

    while (k < lines.length && lines[k].segments.length === 1) {
      const next = lines[k];
      const nextText = next.segments[0].text;
      const vGap = next.y0 - prevLine.y1;
      const leftDiff = Math.abs(next.x0 - prevLine.x0);
      const nextIsHeading = next.fontSize >= medianFont * 1.18 || (next.isBold && nextText.length <= 90);
      const prevEndsSentence = /[.!?;:]$/.test(combined) && prevLine.x1 < pageWidth * 0.72;

      // Проверяем, не вставлена ли картинка ровно между этими двумя строками
      const graphicBetween = graphics.some(
        (g) => g.bbox.y0 >= prevLine.y1 - 4 && g.bbox.y0 <= next.y0 + 4
      );

      if (
        graphicBetween ||
        nextIsHeading ||
        vGap > medianLineH * 1.35 ||
        leftDiff > Math.max(24, pageWidth * 0.04) ||
        prevEndsSentence ||
        isKeyValueOrList(nextText) ||
        isKeyValueOrList(lineText)
      ) {
        break;
      }

      if (/[А-Яа-яЁёA-Za-z]-$/.test(combined) && /^[а-яёa-z]/.test(nextText)) {
        combined = combined.slice(0, -1) + nextText;
      } else {
        combined = `${combined} ${nextText}`;
      }
      prevLine = next;
      k++;
    }

    orderedEntries.push({
      y0: paraY0,
      x0: paraX0,
      block: {
        type: 'paragraph',
        text: cleanVerbatimText(combined),
        align: isRightAligned ? 'right' : isCentered ? 'center' : 'left',
      },
    });
    i = k;
  }

  // 4. Вставляем все извлечённые картинки (логотипы, печати, чертежи) строго на их исходные координаты Y!
  for (const g of graphics) {
    const center = (g.bbox.x0 + g.bbox.x1) / 2;
    const align: 'left' | 'center' | 'right' =
      Math.abs(center - pageWidth / 2) < pageWidth * 0.16
        ? 'center'
        : g.bbox.x0 > pageWidth * 0.5
          ? 'right'
          : 'left';

    orderedEntries.push({
      y0: g.bbox.y0,
      x0: g.bbox.x0,
      block: {
        type: 'image',
        pngBuffer: g.pngBuffer,
        widthPx: g.widthPx,
        heightPx: g.heightPx,
        altText: g.altText,
        align,
      },
    });
  }

  // 5. Итоговая сортировка сверху вниз (с небольшим допуском для элементов на одной горизонтали)
  orderedEntries.sort((a, b) => {
    if (Math.abs(a.y0 - b.y0) > 12) return a.y0 - b.y0;
    return a.x0 - b.x0;
  });

  return {
    blocks: orderedEntries.map((e) => e.block),
    tablesDetected,
    imagesDetected: graphics.length,
  };
}
