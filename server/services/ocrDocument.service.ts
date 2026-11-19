import path from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { Jimp } from 'jimp';
import {
  DocumentProofreadResult,
  DocumentSegment,
  OcrOutputFormat,
} from '../../src/types/harness.types.ts';
import type * as MuPdfNamespace from 'mupdf';
import {
  importEsmModule,
  PageRecognitionResult,
  RecognizedBlock,
  TableCellSpec,
} from './ocrTypes.ts';
import {
  extractPagesFromPdfWithMuPdf,
  recognizeRasterImagePage,
} from './pdfExtractor.service.ts';

export type { RecognizedBlock } from './ocrTypes.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Разбивает простой распознанный текст (например, после голосовой диктовки Whisper)
 * на структурные блоки (заголовки, абзацы и таблицы).
 * Сохраняется для полной совместимости с модулем диктовки Whisper.
 */
export function parseRecognizedTextToBlocks(cleanedText: string): RecognizedBlock[] {
  const rawLines = cleanedText
    .replace(/\r\n/g, '\n')
    .replace(/([а-яёА-ЯЁ])-\n\s*([а-яёА-ЯЁ])/g, '$1$2')
    .split('\n');

  const blocks: RecognizedBlock[] = [];
  let pendingTableRows: string[][] = [];

  const flushTable = () => {
    if (pendingTableRows.length > 0) {
      const maxCols = Math.max(...pendingTableRows.map((r) => r.length));
      const normalized = pendingTableRows.map((r) => {
        const copy = [...r];
        while (copy.length < maxCols) copy.push('');
        return copy;
      });
      blocks.push({ type: 'table', rows: normalized });
      pendingTableRows = [];
    }
  };

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      flushTable();
      continue;
    }

    let cells: string[] | null = null;
    if (line.includes('\t')) {
      cells = line.split('\t').map((c) => c.trim());
    } else if (line.includes('|')) {
      const splitPipe = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      if (splitPipe.length >= 2) cells = splitPipe;
    } else if (/\s{3,}/.test(line)) {
      const splitSpaces = line.split(/\s{3,}/).map((c) => c.trim());
      if (splitSpaces.length >= 2) cells = splitSpaces;
    }

    if (cells && cells.length >= 2) {
      pendingTableRows.push(cells);
      continue;
    }

    flushTable();

    const isHeading =
      line.length <= 110 &&
      (line === line.toUpperCase() ||
        /^(АКТ|ПРИКАЗ|ДОГОВОР|СЛУЖЕБНАЯ ЗАПИСКА|ВЕДОМОСТЬ|ОТЧЕТ|РАЗДЕЛ|СЧЕТ|СЧЁТ)\b/i.test(line));

    blocks.push({
      type: isHeading ? 'heading' : 'paragraph',
      text: line,
    });
  }

  flushTable();
  return blocks;
}

/**
 * Вычисляет габариты картинки в EMU (English Metric Units) для Word:
 * 1 px (при 96 DPI) = 9525 EMU. Масштабирует пропорционально, чтобы не вылезать за поля листа A4.
 */
function computeWordImageEmu(widthPx: number, heightPx: number): { cx: number; cy: number } {
  const safeW = Math.max(16, widthPx || 200);
  const safeH = Math.max(16, heightPx || 120);

  // Доступная ширина A4 (с полями 2.0 см слева и 1.5 см справа) = 17.5 см ≈ 6 300 000 EMU
  // Безопасный максимум = 5 800 000 EMU (~16.1 см), максимальная высота = 7 400 000 EMU (~20.5 см)
  const maxCx = 5800000;
  const maxCy = 7400000;

  // При рендере ~180-220 DPI переводим пиксели в натуральный физический размер на бумаге (~4800 EMU/px)
  const emuPerPx = safeW > 900 ? 4572 : 6800;
  let cx = Math.round(safeW * emuPerPx);
  let cy = Math.round(safeH * emuPerPx);

  if (cx > maxCx) {
    const ratio = maxCx / cx;
    cx = maxCx;
    cy = Math.round(cy * ratio);
  }
  if (cy > maxCy) {
    const ratio = maxCy / cy;
    cy = maxCy;
    cx = Math.round(cx * ratio);
  }

  return { cx: Math.max(250000, cx), cy: Math.max(180000, cy) };
}

/**
 * Собирает полноценный редактируемый документ Word (.docx) из распознанных блоков:
 * - Заголовки и абзацы с сохранением исходного выравнивания
 * - Настоящие таблицы <w:tbl> с пропорциональными ширинами колонок и объединёнными ячейками (colSpan / rowSpan)
 * - Встроенные PNG-изображения (логотипы, печати, чертежи) через <w:drawing> + word/media/image*.png
 * - Разрывы страниц для многостраничных PDF
 */
export async function buildDocxFromRecognizedBlocks(blocks: RecognizedBlock[]): Promise<Buffer> {
  const zip = new JSZip();

  const imageRels: string[] = [];
  let imageCounter = 0;
  let docPrIdCounter = 1;
  const bodyElements: string[] = [];

  // Полезная ширина страницы A4 в dxa (11906 - 1134 - 850 = 9922 dxa)
  const PAGE_CONTENT_WIDTH_DXA = 9922;

  for (const block of blocks) {
    if (block.type === 'page_break') {
      bodyElements.push(`
    <w:p>
      <w:r><w:br w:type="page"/></w:r>
    </w:p>`);
      continue;
    }

    if (block.type === 'image' && block.pngBuffer && block.pngBuffer.length > 0) {
      imageCounter++;
      const rId = `rIdImg${imageCounter}`;
      const mediaFile = `image${imageCounter}.png`;
      zip.file(`word/media/${mediaFile}`, block.pngBuffer);
      imageRels.push(
        `  <Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaFile}"/>`
      );

      const { cx, cy } = computeWordImageEmu(block.widthPx || 240, block.heightPx || 140);
      const docPrId = docPrIdCounter++;
      const alt = escapeXml(block.altText || `Графика ${imageCounter}`);
      const jcVal = block.align === 'right' ? 'right' : block.align === 'center' ? 'center' : 'left';

      bodyElements.push(`
    <w:p>
      <w:pPr>
        <w:jc w:val="${jcVal}"/>
        <w:spacing w:before="80" w:after="100"/>
      </w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="${cx}" cy="${cy}"/>
            <wp:effectExtent l="0" t="0" r="0" b="0"/>
            <wp:docPr id="${docPrId}" name="Picture ${imageCounter}" descr="${alt}"/>
            <wp:cNvGraphicFramePr>
              <a:graphicFrameLocks noChangeAspect="1"/>
            </wp:cNvGraphicFramePr>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr>
                    <pic:cNvPr id="${docPrId}" name="${mediaFile}" descr="${alt}"/>
                    <pic:cNvPicPr/>
                  </pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip r:embed="${rId}"/>
                    <a:stretch><a:fillRect/></a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm>
                      <a:off x="0" y="0"/>
                      <a:ext cx="${cx}" cy="${cy}"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`);
      continue;
    }

    if (block.type === 'heading' && block.text) {
      const jcVal = block.align || 'center';
      const szHalfPt = Math.min(36, Math.max(24, (block.fontSizePt || 13) * 2));
      bodyElements.push(`
    <w:p>
      <w:pPr>
        <w:jc w:val="${jcVal}"/>
        <w:spacing w:before="120" w:after="120" w:line="260" w:lineRule="auto"/>
      </w:pPr>
      <w:r>
        <w:rPr><w:b/><w:sz w:val="${szHalfPt}"/><w:szCs w:val="${szHalfPt}"/></w:rPr>
        <w:t xml:space="preserve">${escapeXml(block.text)}</w:t>
      </w:r>
    </w:p>`);
      continue;
    }

    if (block.type === 'paragraph' && block.text) {
      const jcVal = block.align || 'left';
      bodyElements.push(`
    <w:p>
      <w:pPr>
        <w:jc w:val="${jcVal}"/>
        <w:spacing w:after="80" w:line="252" w:lineRule="auto"/>
      </w:pPr>
      <w:r>
        <w:t xml:space="preserve">${escapeXml(block.text)}</w:t>
      </w:r>
    </w:p>`);
      continue;
    }

    if (block.type === 'table' && block.rows && block.rows.length > 0) {
      const numCols = Math.max(
        1,
        ...block.rows.map((r) => r.length),
        ...(block.cellGrid ? block.cellGrid.map((r) => r.length) : [1])
      );

      // Пропорциональные ширины столбцов в dxa
      let colWidthsDxa: number[];
      if (block.columnWidthFractions && block.columnWidthFractions.length === numCols) {
        const sum = block.columnWidthFractions.reduce((s, v) => s + Math.max(0.04, v), 0);
        colWidthsDxa = block.columnWidthFractions.map((v) =>
          Math.max(420, Math.round((Math.max(0.04, v) / sum) * PAGE_CONTENT_WIDTH_DXA))
        );
      } else {
        const evenW = Math.floor(PAGE_CONTENT_WIDTH_DXA / numCols);
        colWidthsDxa = new Array<number>(numCols).fill(evenW);
      }

      const tblGridXml = colWidthsDxa.map((w) => `<w:gridCol w:w="${w}"/>`).join('');

      // Строим матрицу ячеек (используем cellGrid с colspan/rowspan при наличии)
      const grid: TableCellSpec[][] =
        block.cellGrid && block.cellGrid.length > 0
          ? block.cellGrid
          : block.rows.map((row) =>
              Array.from({ length: numCols }, (_, ci) => ({
                text: row[ci] ?? '',
                colSpan: 1,
                rowSpan: 1,
              }))
            );

      // Отслеживаем активные вертикальные объединения (vMerge) для каждой колонки
      const remainingRowSpan = new Array<number>(numCols).fill(0);

      const trXml = grid
        .map((row, rIdx) => {
          const isHeader = rIdx === 0;
          const cellsXml: string[] = [];

          for (let c = 0; c < numCols; c++) {
            const spec = row[c] || { text: '', colSpan: 1, rowSpan: 1 };

            // Если ячейка является продолжением вертикального объединения сверху — пишем <w:vMerge/>
            if (remainingRowSpan[c] > 0) {
              remainingRowSpan[c]--;
              const wDxa = colWidthsDxa[c] || 1200;
              cellsXml.push(`
          <w:tc>
            <w:tcPr>
              <w:tcW w:w="${wDxa}" w:type="dxa"/>
              <w:vMerge/>
            </w:tcPr>
            <w:p/>
          </w:tc>`);
              continue;
            }

            // Горизонтально поглощённые ячейки (от gridSpan слева) пропускаем
            if (spec.isMergedContinuation) {
              continue;
            }

            const colSpan = Math.max(1, Math.min(numCols - c, spec.colSpan || 1));
            const rowSpan = Math.max(1, spec.rowSpan || 1);

            if (rowSpan > 1) {
              for (let sc = c; sc < c + colSpan; sc++) {
                remainingRowSpan[sc] = rowSpan - 1;
              }
            }

            let spanWidthDxa = 0;
            for (let sc = c; sc < c + colSpan; sc++) {
              spanWidthDxa += colWidthsDxa[sc] || 1200;
            }

            const gridSpanTag = colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : '';
            const vMergeTag = rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '';
            const shdTag = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2F6"/>' : '';

            cellsXml.push(`
          <w:tc>
            <w:tcPr>
              <w:tcW w:w="${spanWidthDxa}" w:type="dxa"/>
              ${gridSpanTag}
              ${vMergeTag}
              ${shdTag}
            </w:tcPr>
            <w:p>
              <w:pPr><w:spacing w:before="20" w:after="40"/></w:pPr>
              <w:r>
                <w:rPr>${isHeader ? '<w:b/>' : ''}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
                <w:t xml:space="preserve">${escapeXml(spec.text || '')}</w:t>
              </w:r>
            </w:p>
          </w:tc>`);

            if (colSpan > 1) {
              c += colSpan - 1;
            }
          }

          return `<w:tr>${cellsXml.join('')}</w:tr>`;
        })
        .join('');

      bodyElements.push(`
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="${PAGE_CONTENT_WIDTH_DXA}" w:type="dxa"/>
        <w:tblLayout w:type="fixed"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:space="0" w:color="334155"/>
          <w:left w:val="single" w:sz="4" w:space="0" w:color="334155"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="334155"/>
          <w:right w:val="single" w:sz="4" w:space="0" w:color="334155"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="64748B"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="64748B"/>
        </w:tblBorders>
        <w:tblCellMar>
          <w:top w:w="55" w:type="dxa"/>
          <w:left w:w="90" w:type="dxa"/>
          <w:bottom w:w="55" w:type="dxa"/>
          <w:right w:w="90" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
      <w:tblGrid>${tblGridXml}</w:tblGrid>
      ${trXml}
    </w:tbl>
    <w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>`);
    }
  }

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${imageRels.join('\n')}
</Relationships>`
  );

  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:lang w:val="ru-RU"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
</w:styles>`
  );

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${bodyElements.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Собирает полноценную книгу Excel (.xlsx) из распознанных блоков:
 * - Таблицы с границами, пропорциональными ширинами, переносом текста и объединёнными ячейками (colSpan / rowSpan)
 * - Встроенные PNG-изображения (логотипы, печати, чертежи) строго на их исходных строках листа!
 * - Исходные заголовки и абзацы без автоискажений
 */
export async function buildXlsxFromRecognizedBlocks(
  blocks: RecognizedBlock[],
  sourceFileName: string,
  meta?: { pages?: number; tables?: number; images?: number; engine?: string }
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Офисный помощник (Локальный MuPDF + RapidOCR ONNX)';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Распознанный документ');
  let currentRowIdx = 1;
  let maxColsUsed = 4;
  const colMaxChars = new Map<number, number>();

  const trackColWidth = (col1Based: number, text: string) => {
    const len = Math.min(62, Math.max(8, text.length + 3));
    const prev = colMaxChars.get(col1Based) || 12;
    if (len > prev) colMaxChars.set(col1Based, len);
  };

  for (const block of blocks) {
    if (block.type === 'page_break') {
      currentRowIdx++;
      const sepRow = sheet.getRow(currentRowIdx++);
      sepRow.getCell(1).value = `— Страница ${block.pageNumber || ''} —`;
      sepRow.getCell(1).font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF64748B' } };
      continue;
    }

    if (block.type === 'image' && block.pngBuffer && block.pngBuffer.length > 0) {
      const imgId = workbook.addImage({
        // ExcelJS expects Node Buffer / ArrayBuffer at runtime
        buffer: block.pngBuffer as unknown as ExcelJS.Buffer,
        extension: 'png',
      });

      const origW = Math.max(24, block.widthPx || 240);
      const origH = Math.max(24, block.heightPx || 140);
      const maxDisplayW = 520;
      const maxDisplayH = 380;
      const scale = Math.min(1, maxDisplayW / origW, maxDisplayH / origH);
      const displayW = Math.max(48, Math.round(origW * scale));
      const displayH = Math.max(36, Math.round(origH * scale));

      const anchorRow0 = currentRowIdx - 1;
      const anchorCol0 = block.align === 'right' ? Math.max(1, maxColsUsed - 2) : 0;

      sheet.addImage(imgId, {
        tl: { col: anchorCol0, row: anchorRow0 },
        ext: { width: displayW, height: displayH },
      });

      // Резервируем достаточное число строк под картинку (20px на строку Excel по умолчанию), чтобы таблицы ниже не перекрыли графику
      const rowsNeeded = Math.max(2, Math.ceil(displayH / 20) + 1);
      for (let r = 0; r < rowsNeeded; r++) {
        const spacer = sheet.getRow(currentRowIdx++);
        spacer.height = 18;
      }
      continue;
    }

    if (block.type === 'heading' && block.text) {
      const row = sheet.getRow(currentRowIdx++);
      row.getCell(1).value = block.text;
      row.getCell(1).font = { name: 'Arial', size: 12, bold: true };
      row.getCell(1).alignment = { wrapText: true, vertical: 'middle' };
      row.height = 24;
      trackColWidth(1, block.text);
      continue;
    }

    if (block.type === 'paragraph' && block.text) {
      const kvMatch = block.text.match(/^([^:]{2,42}):\s+(.+)$/);
      const row = sheet.getRow(currentRowIdx++);
      if (kvMatch) {
        row.getCell(1).value = kvMatch[1].trim();
        row.getCell(1).font = { name: 'Arial', size: 10, bold: true };
        row.getCell(2).value = kvMatch[2].trim();
        row.getCell(2).font = { name: 'Arial', size: 10 };
        trackColWidth(1, kvMatch[1]);
        trackColWidth(2, kvMatch[2]);
      } else {
        row.getCell(1).value = block.text;
        row.getCell(1).font = { name: 'Arial', size: 10 };
        trackColWidth(1, block.text);
      }
      row.alignment = { wrapText: true, vertical: 'top' };
      continue;
    }

    if (block.type === 'table' && block.rows && block.rows.length > 0) {
      const startRow = currentRowIdx;
      const numCols = Math.max(
        1,
        ...block.rows.map((r) => r.length),
        ...(block.cellGrid ? block.cellGrid.map((r) => r.length) : [1])
      );
      if (numCols > maxColsUsed) maxColsUsed = numCols;

      const grid: TableCellSpec[][] =
        block.cellGrid && block.cellGrid.length > 0
          ? block.cellGrid
          : block.rows.map((r) =>
              Array.from({ length: numCols }, (_, ci) => ({
                text: r[ci] ?? '',
                colSpan: 1,
                rowSpan: 1,
              }))
            );

      const mergesToApply: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];

      for (let r = 0; r < grid.length; r++) {
        const rowSpecs = grid[r];
        const excelRowIdx = currentRowIdx++;
        const row = sheet.getRow(excelRowIdx);
        const isHeader = r === 0;
        let maxLinesInRow = 1;

        for (let c = 0; c < numCols; c++) {
          const spec = rowSpecs[c] || { text: '', colSpan: 1, rowSpan: 1 };
          const cell = row.getCell(c + 1);
          if (!spec.isMergedContinuation) {
            cell.value = spec.text || '';
            trackColWidth(c + 1, spec.text || '');
            const estLines = Math.max(1, Math.ceil((spec.text || '').length / 36));
            if (estLines > maxLinesInRow) maxLinesInRow = estLines;
          }

          cell.font = { name: 'Arial', size: 10, bold: isHeader };
          cell.alignment = { wrapText: true, vertical: 'middle' };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF94A3B8' } },
            left: { style: 'thin', color: { argb: 'FF94A3B8' } },
            bottom: { style: 'thin', color: { argb: 'FF94A3B8' } },
            right: { style: 'thin', color: { argb: 'FF94A3B8' } },
          };
          if (isHeader) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFEEF2F6' },
            };
          }

          const cs = spec.colSpan || 1;
          const rs = spec.rowSpan || 1;
          if (!spec.isMergedContinuation && (cs > 1 || rs > 1)) {
            mergesToApply.push({
              r1: excelRowIdx,
              c1: c + 1,
              r2: Math.min(startRow + grid.length - 1, excelRowIdx + rs - 1),
              c2: Math.min(numCols, c + cs),
            });
          }
        }
        row.height = Math.min(120, Math.max(20, maxLinesInRow * 16));
      }

      for (const m of mergesToApply) {
        try {
          sheet.mergeCells(m.r1, m.c1, m.r2, m.c2);
        } catch {
          // Игнорируем конфликтующие перекрытия mergeCells
        }
      }

      currentRowIdx++;
    }
  }

  for (let c = 1; c <= Math.max(maxColsUsed, 5); c++) {
    const col = sheet.getColumn(c);
    col.width = Math.min(54, Math.max(14, colMaxChars.get(c) || 18));
  }

  const metaSheet = workbook.addWorksheet('Сводка распознавания');
  metaSheet.columns = [
    { header: 'Параметр', key: 'param', width: 32 },
    { header: 'Значение', key: 'val', width: 62 },
  ];
  metaSheet.addRow({ param: 'Исходный файл', val: sourceFileName });
  metaSheet.addRow({ param: 'Движок распознавания', val: meta?.engine || 'MuPDF + RapidOCR ONNX' });
  metaSheet.addRow({ param: 'Обработано страниц', val: String(meta?.pages ?? 1) });
  metaSheet.addRow({ param: 'Распознано таблиц', val: String(meta?.tables ?? 0) });
  metaSheet.addRow({ param: 'Извлечено изображений / логотипов / чертежей', val: String(meta?.images ?? 0) });
  metaSheet.addRow({ param: 'Всего структурных блоков', val: String(blocks.length) });
  metaSheet.addRow({ param: 'Режим передачи текста', val: 'Точная копия оригинала (без автоисправлений)' });
  metaSheet.getRow(1).font = { bold: true };

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Главный конвейер кнопки «Распознать PDF (картинку)»:
 * 1. Для PDF — MuPDF WASM (точный Unicode RU+EN + встроенные/векторные картинки + рендер скан-страниц 250-300 DPI).
 * 2. Для изображений и скан-страниц — локальный RapidOCR ONNX (PP-OCRv4 Det + Cls + PP-OCRv5 East-Slavic RU/EN + SLANet Table) + детектор графики (логотипы, печати, чертежи) с оффлайн-резервом Tesseract 5.
 * 3. Текст сохраняется ДОСЛОВНО (без автоисправления орфографии/кодов), таблицы и картинки ставятся на исходные места.
 * 4. Формируются готовые редактируемые документы Word (.docx) и Excel (.xlsx).
 */
export async function processPdfOrImageToOffice(
  fileBuffer: Buffer,
  originalFileName: string,
  targetFormat: OcrOutputFormat = 'docx'
): Promise<DocumentProofreadResult> {
  const startTime = Date.now();
  const ext = path.extname(originalFileName).toLowerCase();
  const isPdf =
    ext === '.pdf' ||
    (fileBuffer.length >= 5 && fileBuffer.subarray(0, 5).toString('ascii') === '%PDF-');

  let pages: PageRecognitionResult[];
  if (isPdf) {
    pages = await extractPagesFromPdfWithMuPdf(fileBuffer);
  } else {
    const singlePage = await recognizeRasterImagePage(fileBuffer, 1);
    pages = [singlePage];
  }

  // Объединяем блоки всех страниц с разрывами страниц
  const allBlocks: RecognizedBlock[] = [];
  let totalTables = 0;
  let totalImages = 0;
  const enginesUsed = new Set<string>();

  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const page = pages[pIdx];
    totalTables += page.tablesDetected;
    totalImages += page.imagesDetected;
    enginesUsed.add(page.engineUsed);

    if (pIdx > 0 && page.blocks.length > 0) {
      allBlocks.push({ type: 'page_break', pageNumber: page.pageNumber });
    }
    allBlocks.push(...page.blocks);
  }

  // Формируем список распознанных сегментов (дословная копия без автокоррекции!)
  const segments: DocumentSegment[] = [];
  let segCounter = 0;

  for (const block of allBlocks) {
    if ((block.type === 'heading' || block.type === 'paragraph') && block.text) {
      segCounter++;
      segments.push({
        id: `ocr-seg-${segCounter}`,
        location: block.type === 'heading' ? `Заголовок #${segCounter}` : `Текстовый блок #${segCounter}`,
        elementType: block.type === 'heading' ? 'header' : 'paragraph',
        originalText: block.text,
        correctedText: block.text,
        preservedFormattingMeta: `Точное распознавание → ${targetFormat.toUpperCase()}`,
        issues: [],
        applied: false,
      });
    } else if (block.type === 'table' && block.rows) {
      for (let r = 0; r < block.rows.length; r++) {
        segCounter++;
        const rowLine = block.rows[r].join(' | ');
        segments.push({
          id: `ocr-tbl-${segCounter}`,
          location: `Таблица, строка #${r + 1}`,
          elementType: 'table_cell',
          originalText: rowLine,
          correctedText: rowLine,
          preservedFormattingMeta: `Таблица (${block.rows[r].length} кол.)`,
          issues: [],
          applied: false,
        });
      }
    } else if (block.type === 'image') {
      segCounter++;
      const label = `${block.altText || 'Изображение'} (${block.widthPx || 0}×${block.heightPx || 0} px)`;
      segments.push({
        id: `ocr-img-${segCounter}`,
        location: `Встроенная графика #${segCounter}`,
        elementType: 'paragraph',
        originalText: label,
        correctedText: label,
        preservedFormattingMeta: 'Вставлено на исходное место в Word и Excel (PNG)',
        issues: [],
        applied: false,
      });
    }
  }

  const combinedEngineLabel = Array.from(enginesUsed).join(' · ') || 'MuPDF + RapidOCR ONNX';

  // Генерируем оба выходных контейнера (.docx и .xlsx) с встроенными картинками и таблицами
  const [docxBuffer, xlsxBuffer] = await Promise.all([
    buildDocxFromRecognizedBlocks(allBlocks),
    buildXlsxFromRecognizedBlocks(allBlocks, originalFileName, {
      pages: pages.length,
      tables: totalTables,
      images: totalImages,
      engine: combinedEngineLabel,
    }),
  ]);

  const baseName = originalFileName.replace(/\.[^.]+$/, '') || 'Распознанный_документ';
  const docxFileName = `${baseName}.docx`;
  const xlsxFileName = `${baseName}.xlsx`;

  const isPrimaryExcel = targetFormat === 'xlsx';
  const primaryBuffer = isPrimaryExcel ? xlsxBuffer : docxBuffer;
  const secondaryBuffer = isPrimaryExcel ? docxBuffer : xlsxBuffer;

  return {
    fileName: isPrimaryExcel ? xlsxFileName : docxFileName,
    fileType: isPrimaryExcel ? 'xlsx' : 'docx',
    fileSizeBytes: primaryBuffer.length,
    processingTimeMs: Math.max(10, Date.now() - startTime),
    engineUsed: `${combinedEngineLabel} · Стр.: ${pages.length}, табл.: ${totalTables}, граф.: ${totalImages}`,
    totalSegments: segments.length,
    modifiedSegments: 0,
    totalIssuesFixed: 0,
    totalChunksProcessed: pages.length,
    chunkMaxCharsUsed: 0,
    segments,
    downloadBase64: primaryBuffer.toString('base64'),
    mimeType: isPrimaryExcel ? XLSX_MIME : DOCX_MIME,
    operationMode: 'ocr',
    sourceFileName: originalFileName,
    secondaryFileName: isPrimaryExcel ? docxFileName : xlsxFileName,
    secondaryDownloadBase64: secondaryBuffer.toString('base64'),
    secondaryMimeType: isPrimaryExcel ? DOCX_MIME : XLSX_MIME,
  };
}

/**
 * Генерирует реальный тестовый PDF-документ (счёт/ведомость с русским и английским текстом,
 * настоящей таблицей и встроенным цветным SVG/векторным логотипом) через MuPDF DocumentWriter
 * для мгновенной проверки работы модуля распознавания.
 */
export async function generateSamplePdfWithRussianTable(): Promise<Buffer> {
  const mupdf = await importEsmModule<typeof MuPdfNamespace>('mupdf');

  // Формируем реальный цветной логотип и круглую синюю печать в PNG для проверки извлечения графики
  const logoImg = new Jimp({ width: 160, height: 54, color: 0x1d4ed8ff });
  for (let y = 10; y < 44; y++) {
    for (let x = 14; x < 48; x++) {
      if ((x - 31) ** 2 + (y - 27) ** 2 < 15 * 15) {
        logoImg.setPixelColor(0xfacc15ff, x, y);
      }
    }
    for (let x = 62; x < 146; x++) {
      if (y >= 19 && y <= 35) {
        logoImg.setPixelColor(0xffffffff, x, y);
      }
    }
  }
  const logoBase64 = (await logoImg.getBuffer('image/png')).toString('base64');

  const stampImg = new Jimp({ width: 110, height: 110, color: 0xffffffff });
  for (let y = 0; y < 110; y++) {
    for (let x = 0; x < 110; x++) {
      const dist = Math.hypot(x - 55, y - 55);
      if ((dist >= 42 && dist <= 47) || (dist >= 27 && dist <= 30) || dist <= 8) {
        stampImg.setPixelColor(0x2563ebff, x, y);
      }
    }
  }
  const stampBase64 = (await stampImg.getBuffer('image/png')).toString('base64');

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: sans-serif; font-size: 10pt; color: #111; margin: 28px; }
  h1 { font-size: 14pt; margin: 10px 0 8px 0; }
  p { margin: 4px 0 8px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 12px; }
  th, td { border: 1px solid #222; padding: 6px 8px; text-align: left; font-size: 9.5pt; }
  th { background: #e8eef5; font-weight: bold; }
</style>
</head>
<body>
  <img src="data:image/png;base64,${logoBase64}" width="130" height="44" />
  <h1>СЧЕТ НА ОПЛАТУ № 142 от 19.11.2026</h1>
  <p>Поставщик: ООО «ТехноСнаб-Инжиниринг» (ИНН 7708123456, КПП 770801001)</p>
  <p>Покупатель: АО «Промышленные Системы» · Order Ref: INV-2026-RU-09</p>
  <table>
    <tr>
      <th>№</th>
      <th>Наименование товара / услуги (RU / EN)</th>
      <th>Кол-во</th>
      <th>Ед.</th>
      <th>Цена, руб.</th>
      <th>Сумма, руб.</th>
    </tr>
    <tr>
      <td>1</td>
      <td>Серверная платформа Intel Xeon E-2388G (Astra Linux Certified)</td>
      <td>2</td>
      <td>шт.</td>
      <td>145 000,00</td>
      <td>290 000,00</td>
    </tr>
    <tr>
      <td>2</td>
      <td>Коммутатор промышленный Managed Switch 24-Port PoE+</td>
      <td>3</td>
      <td>шт.</td>
      <td>38 500,00</td>
      <td>115 500,00</td>
    </tr>
    <tr>
      <td>3</td>
      <td>Пусконаладочные работы и тестирование (QA &amp; Commissioning)</td>
      <td>1</td>
      <td>усл.</td>
      <td>44 500,00</td>
      <td>44 500,00</td>
    </tr>
  </table>
  <p>Итого к оплате: 450 000,00 руб. (в т.ч. НДС 20% — 75 000,00 руб.)</p>
  <img src="data:image/png;base64,${stampBase64}" width="88" height="88" />
</body>
</html>`;

  const htmlDoc = mupdf.Document.openDocument(Buffer.from(html, 'utf8'), 'text/html');
  htmlDoc.layout(595, 842, 11);

  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, 'pdf', '');
  try {
    const pageCount = htmlDoc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const page = htmlDoc.loadPage(i);
      try {
        const dev = writer.beginPage(page.getBounds());
        page.run(dev, mupdf.Matrix.identity);
        writer.endPage();
      } finally {
        page.destroy();
      }
    }
    writer.close();
    return Buffer.from(buf.asUint8Array());
  } finally {
    htmlDoc.destroy();
    buf.destroy();
  }
}
