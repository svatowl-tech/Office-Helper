import path from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DocumentTocItem } from '../../src/types/harness.types.ts';
import {
  extractPagesFromPdfWithMuPdf,
  recognizeRasterImagePage,
} from './pdfExtractor.service.ts';
import {
  convertLegacyDocToDocxBuffer,
  convertLegacyPptToPptxBuffer,
  convertLegacyXlsToXlsxBuffer,
} from './legacyOfficeConverter.service.ts';

export const SUPPORTED_DOCUMENT_WORK_EXTENSIONS = new Set<string>([
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  '.xodt',
  '.xods',
  '.rtf',
  '.txt',
  '.md',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
]);

export function isSupportedDocumentWorkFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return SUPPORTED_DOCUMENT_WORK_EXTENSIONS.has(ext);
}

export interface ParsedDocumentChunk {
  location: string;
  pageNumber?: number;
  sectionHeading?: string;
  text: string;
}

export interface ParsedDocumentTable {
  location: string;
  headers: string[];
  rows: string[][];
}

export interface ParsedStructuredDocument {
  fileName: string;
  extension: string;
  pagesOrSheets: number;
  usedOcr: boolean;
  toc: DocumentTocItem[];
  chunks: ParsedDocumentChunk[];
  tables: ParsedDocumentTable[];
}

function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 130) return false;
  if (/[.!?;]$/.test(trimmed) && !/^\d+(?:\.\d+)*\.\s+/.test(trimmed)) return false;

  if (
    /^(?:раздел|глава|приложение|статья|пункт|часть|протокол|договор|акт|сч[её]т|спецификация|техническое\s+задание|пояснительная\s+записка)(?![а-яёa-z0-9])/iu.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/^\d+(?:\.\d+){0,2}[.)]\s+[А-ЯЁA-Z]/u.test(trimmed)) {
    return true;
  }
  const letters = trimmed.replace(/[^А-ЯЁа-яёA-Za-z]/g, '');
  if (letters.length >= 5 && letters === letters.toUpperCase()) {
    return true;
  }
  return false;
}

/**
 * Нарезает длинный текстовый блок на перекрывающиеся поисковые чанки (~700–900 символов)
 * с сохранением границ предложений и точной ссылки на страницу/раздел.
 */
function splitLongParagraphToChunks(
  text: string,
  location: string,
  sectionHeading?: string,
  pageNumber?: number,
  maxChars = 850
): ParsedDocumentChunk[] {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];
  if (clean.length <= maxChars) {
    return [{ location, pageNumber, sectionHeading, text: clean }];
  }

  const sentences = clean.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z0-9«"(])/u);
  const result: ParsedDocumentChunk[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (current.length + sentence.length + 1 <= maxChars) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      if (current) {
        result.push({ location, pageNumber, sectionHeading, text: current.trim() });
      }
      if (sentence.length > maxChars) {
        // Режем сверхдлинную строку без знаков препинания аккуратно по словам
        let cursor = 0;
        while (cursor < sentence.length) {
          let end = Math.min(sentence.length, cursor + maxChars);
          if (end < sentence.length) {
            const lastSpace = sentence.lastIndexOf(' ', end);
            if (lastSpace > cursor + Math.floor(maxChars * 0.5)) {
              end = lastSpace;
            }
          }
          const slice = sentence.slice(cursor, end).trim();
          if (slice) {
            result.push({ location, pageNumber, sectionHeading, text: slice });
          }
          cursor = Math.max(end + 1, cursor + 1);
        }
        current = '';
      } else {
        current = sentence;
      }
    }
  }
  if (current.trim()) {
    result.push({ location, pageNumber, sectionHeading, text: current.trim() });
  }
  return result;
}

/**
 * Упаковывает мелкие соседние абзацы в удобные поисковые чанки по 450–850 символов
 * внутри одного и того же раздела/страницы, чтобы поиск BM25 не терял контекст абзаца.
 */
function packParagraphsIntoChunks(
  items: Array<{
    text: string;
    location: string;
    pageNumber?: number;
    sectionHeading?: string;
    isHeading?: boolean;
  }>,
  toc: DocumentTocItem[]
): ParsedDocumentChunk[] {
  const chunks: ParsedDocumentChunk[] = [];
  let bufferText = '';
  let bufferLocation = '';
  let bufferPage: number | undefined;
  let bufferHeading: string | undefined;

  const flush = () => {
    if (!bufferText.trim()) return;
    const split = splitLongParagraphToChunks(bufferText, bufferLocation, bufferHeading, bufferPage);
    chunks.push(...split);
    bufferText = '';
  };

  for (const item of items) {
    const clean = normalizeWhitespace(item.text);
    if (!clean) continue;

    if (item.isHeading) {
      flush();
      const tocIdx = chunks.length;
      if (toc.length < 120) {
        toc.push({
          id: `toc-${toc.length + 1}`,
          title: clean.slice(0, 110),
          location: item.location,
          pageNumber: item.pageNumber,
          level: /^\d+\.\d+/.test(clean) ? 2 : 1,
          chunkIndex: tocIdx,
        });
      }
      bufferHeading = clean.slice(0, 110);
      bufferLocation = item.location;
      bufferPage = item.pageNumber;
      bufferText = clean;
      continue;
    }

    const sameContext =
      bufferLocation === item.location &&
      bufferHeading === item.sectionHeading &&
      bufferText.length + clean.length + 2 <= 820;

    if (bufferText && sameContext) {
      bufferText = `${bufferText}\n${clean}`;
    } else {
      flush();
      bufferLocation = item.location;
      bufferPage = item.pageNumber;
      bufferHeading = item.sectionHeading || bufferHeading;
      bufferText = clean;
    }
  }

  flush();
  return chunks;
}

function decodeRtfToPlainText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  let text = raw
    .replace(/\\par\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, ' ');

  text = text.replace(/\\u(-?\d+)\??/g, (_m, codeStr: string) => {
    let code = Number(codeStr);
    if (code < 0) code += 65536;
    return String.fromCharCode(code);
  });

  const cp1251Decoder = new TextDecoder('windows-1251');
  text = text.replace(/(?:\\'([0-9a-fA-F]{2}))+/g, (seq) => {
    const hexMatches = seq.match(/[0-9a-fA-F]{2}/g) || [];
    const bytes = new Uint8Array(hexMatches.map((h) => parseInt(h, 16)));
    return cp1251Decoder.decode(bytes);
  });

  return text
    .replace(/\{\\\*\\[^}]*\}/g, '')
    .replace(/\{\\(?:fonttbl|colortbl|stylesheet|info)[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parseDocxStructured(
  buffer: Buffer,
  fileName: string,
  ext: string
): Promise<ParsedStructuredDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) {
    return {
      fileName,
      extension: ext,
      pagesOrSheets: 1,
      usedOcr: false,
      toc: [],
      chunks: [],
      tables: [],
    };
  }

  const toc: DocumentTocItem[] = [];
  const tables: ParsedDocumentTable[] = [];
  const rawItems: Array<{
    text: string;
    location: string;
    pageNumber?: number;
    sectionHeading?: string;
    isHeading?: boolean;
  }> = [];

  // Извлекаем тело документа по порядку: верхнеуровневые абзацы и таблицы
  const bodyMatch = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  const bodyXml = bodyMatch ? bodyMatch[1] : docXml;

  // Сначала вытаскиваем таблицы и заменяем их маркерами, чтобы сохранить порядок чтения
  let tableCounter = 0;
  const tablePlaceholders = new Map<string, ParsedDocumentTable>();
  const bodyWithMarkers = bodyXml.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g, (tblXml) => {
    tableCounter++;
    const trMatches = tblXml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [];
    const matrix: string[][] = [];
    for (const trXml of trMatches) {
      const tcMatches = trXml.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || [];
      const rowCells = tcMatches.map((tcXml) => {
        const tMatches = tcXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [];
        return normalizeWhitespace(
          tMatches.map((t) => unescapeXml(t.replace(/<[^>]+>/g, ''))).join('')
        );
      });
      if (rowCells.some((c) => c.length > 0)) {
        matrix.push(rowCells);
      }
    }

    const marker = `__DOC_TABLE_MARKER_${tableCounter}__`;
    if (matrix.length > 0) {
      const headers = matrix[0];
      const rows = matrix.slice(1);
      tablePlaceholders.set(marker, {
        location: `Таблица #${tableCounter}`,
        headers,
        rows,
      });
    }
    return `<w:p><w:r><w:t>${marker}</w:t></w:r></w:p>`;
  });

  const pMatches = bodyWithMarkers.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  let approxPage = 1;
  let charsOnPage = 0;
  let currentHeading: string | undefined;

  for (const pXml of pMatches) {
    if (/<w:br[^>]*w:type="page"/i.test(pXml) || /<w:lastRenderedPageBreak/i.test(pXml)) {
      approxPage++;
      charsOnPage = 0;
    }

    const tMatches = pXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [];
    const text = normalizeWhitespace(
      tMatches.map((t) => unescapeXml(t.replace(/<[^>]+>/g, ''))).join('')
    );
    if (!text) continue;

    const tbl = tablePlaceholders.get(text);
    if (tbl) {
      const locatedTable: ParsedDocumentTable = {
        ...tbl,
        location: `Стр. ~${approxPage}, ${tbl.location}`,
      };
      tables.push(locatedTable);

      // Также индексируем строки таблицы как поисковые чанки, чтобы можно было искать любые значения внутри таблиц
      const tableLines = [
        locatedTable.headers.join(' | '),
        ...locatedTable.rows.map((r) => r.join(' | ')),
      ].filter(Boolean);
      const batchSize = 8;
      for (let i = 0; i < tableLines.length; i += batchSize) {
        const chunkText = tableLines.slice(i, i + batchSize).join('\n');
        rawItems.push({
          text: chunkText,
          location: locatedTable.location,
          pageNumber: approxPage,
          sectionHeading: currentHeading,
        });
      }
      charsOnPage += tableLines.join(' ').length;
      continue;
    }

    const isStyledHeading =
      /<w:pStyle[^>]*w:val="(?:Heading|Заголовок|Title|Subtitle)/i.test(pXml) ||
      looksLikeHeading(text);

    if (isStyledHeading) {
      currentHeading = text.slice(0, 110);
    }

    rawItems.push({
      text,
      location: `Стр. ~${approxPage}`,
      pageNumber: approxPage,
      sectionHeading: currentHeading,
      isHeading: isStyledHeading,
    });

    charsOnPage += text.length;
    if (charsOnPage > 2600) {
      approxPage++;
      charsOnPage = 0;
    }
  }

  const chunks = packParagraphsIntoChunks(rawItems, toc);
  return {
    fileName,
    extension: ext,
    pagesOrSheets: Math.max(1, approxPage),
    usedOcr: false,
    toc,
    chunks,
    tables,
  };
}

async function parseXlsxStructured(
  buffer: Buffer,
  fileName: string,
  ext: string
): Promise<ParsedStructuredDocument> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const toc: DocumentTocItem[] = [];
  const chunks: ParsedDocumentChunk[] = [];
  const tables: ParsedDocumentTable[] = [];
  let sheetIdx = 0;

  workbook.eachSheet((sheet) => {
    sheetIdx++;
    const sheetTitle = sheet.name || `Лист ${sheetIdx}`;
    const location = `Лист «${sheetTitle}»`;

    toc.push({
      id: `toc-${toc.length + 1}`,
      title: sheetTitle,
      location,
      pageNumber: sheetIdx,
      level: 1,
      chunkIndex: chunks.length,
    });

    const matrix: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      let maxCol = 0;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        maxCol = Math.max(maxCol, colNumber);
        const rawVal = cell.text?.trim() || (cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : '');
        cells[colNumber - 1] = rawVal;
      });
      if (maxCol > 0) {
        const dense: string[] = [];
        for (let c = 0; c < maxCol; c++) {
          dense.push(cells[c] || '');
        }
        if (dense.some((v) => v.length > 0)) {
          matrix.push(dense);
        }
      }
    });

    if (matrix.length > 0) {
      const headers = matrix[0];
      const rows = matrix.slice(1);
      tables.push({
        location,
        headers,
        rows,
      });

      const headerLine = headers.join(' | ');
      const batchSize = 10;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const startRowNum = i + 2;
        const endRowNum = startRowNum + batch.length - 1;
        const lines = batch.map((r, offset) => `Строка ${startRowNum + offset}: ${r.join(' | ')}`);
        chunks.push({
          location: `${location}, строки ${startRowNum}–${endRowNum}`,
          pageNumber: sheetIdx,
          sectionHeading: sheetTitle,
          text: `${headerLine}\n${lines.join('\n')}`,
        });
      }
      if (rows.length === 0) {
        chunks.push({
          location,
          pageNumber: sheetIdx,
          sectionHeading: sheetTitle,
          text: headerLine,
        });
      }
    }
  });

  return {
    fileName,
    extension: ext,
    pagesOrSheets: Math.max(1, sheetIdx),
    usedOcr: false,
    toc,
    chunks,
    tables,
  };
}

async function parsePptxStructured(
  buffer: Buffer,
  fileName: string,
  ext: string
): Promise<ParsedStructuredDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));

  const toc: DocumentTocItem[] = [];
  const chunks: ParsedDocumentChunk[] = [];

  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.file(slideNames[i])?.async('string');
    if (!xml) continue;
    const texts = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [])
      .map((t) => normalizeWhitespace(unescapeXml(t.replace(/<[^>]+>/g, ''))))
      .filter(Boolean);
    if (texts.length === 0) continue;

    const slideNum = i + 1;
    const location = `Слайд ${slideNum}`;
    const title = texts[0].slice(0, 100);
    toc.push({
      id: `toc-${toc.length + 1}`,
      title,
      location,
      pageNumber: slideNum,
      level: 1,
      chunkIndex: chunks.length,
    });

    chunks.push(
      ...splitLongParagraphToChunks(texts.join('\n'), location, title, slideNum)
    );
  }

  return {
    fileName,
    extension: ext,
    pagesOrSheets: Math.max(1, slideNames.length),
    usedOcr: false,
    toc,
    chunks,
    tables: [],
  };
}

async function parseOpenDocStructured(
  buffer: Buffer,
  fileName: string,
  ext: string
): Promise<ParsedStructuredDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) {
    return {
      fileName,
      extension: ext,
      pagesOrSheets: 1,
      usedOcr: false,
      toc: [],
      chunks: [],
      tables: [],
    };
  }

  const toc: DocumentTocItem[] = [];
  const tables: ParsedDocumentTable[] = [];
  const rawItems: Array<{
    text: string;
    location: string;
    pageNumber?: number;
    sectionHeading?: string;
    isHeading?: boolean;
  }> = [];

  // Извлекаем таблицы OpenDocument
  let tableIdx = 0;
  const tableMatches = contentXml.match(/<table:table(?:\s[^>]*)?>[\s\S]*?<\/table:table>/g) || [];
  for (const tblXml of tableMatches) {
    tableIdx++;
    const nameMatch = tblXml.match(/table:name="([^"]+)"/);
    const tblName = nameMatch ? unescapeXml(nameMatch[1]) : `Таблица #${tableIdx}`;
    const rowMatches = tblXml.match(/<table:table-row(?:\s[^>]*)?>[\s\S]*?<\/table:table-row>/g) || [];
    const matrix: string[][] = [];
    for (const rowXml of rowMatches) {
      const cellMatches = rowXml.match(/<table:table-cell(?:\s[^>]*)?>[\s\S]*?<\/table:table-cell>/g) || [];
      const rowCells = cellMatches.map((cXml) =>
        normalizeWhitespace(unescapeXml(cXml.replace(/<[^>]+>/g, ' ')))
      );
      if (rowCells.some((c) => c.length > 0)) {
        matrix.push(rowCells);
      }
    }
    if (matrix.length > 0) {
      tables.push({
        location: tblName,
        headers: matrix[0],
        rows: matrix.slice(1),
      });
    }
  }

  const textMatches = contentXml.match(/<text:(?:h|p)(?:\s[^>]*)?>[\s\S]*?<\/text:(?:h|p)>/g) || [];
  let approxPage = 1;
  let charsOnPage = 0;
  let currentHeading: string | undefined;

  for (const el of textMatches) {
    const isH = el.startsWith('<text:h');
    const clean = normalizeWhitespace(unescapeXml(el.replace(/<[^>]+>/g, ' ')));
    if (!clean) continue;

    const headingFlag = isH || looksLikeHeading(clean);
    if (headingFlag) currentHeading = clean.slice(0, 110);

    rawItems.push({
      text: clean,
      location: `Стр. ~${approxPage}`,
      pageNumber: approxPage,
      sectionHeading: currentHeading,
      isHeading: headingFlag,
    });

    charsOnPage += clean.length;
    if (charsOnPage > 2600) {
      approxPage++;
      charsOnPage = 0;
    }
  }

  const chunks = packParagraphsIntoChunks(rawItems, toc);
  return {
    fileName,
    extension: ext,
    pagesOrSheets: Math.max(1, approxPage),
    usedOcr: false,
    toc,
    chunks,
    tables,
  };
}

function parsePlainTextStructured(
  rawText: string,
  fileName: string,
  ext: string
): ParsedStructuredDocument {
  const toc: DocumentTocItem[] = [];
  const tables: ParsedDocumentTable[] = [];

  // Для CSV сразу формируем таблицу
  if (ext === '.csv') {
    const lines = rawText
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const sep = lines[0]?.includes(';') ? ';' : ',';
    const matrix = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, '')));
    if (matrix.length > 0) {
      tables.push({
        location: 'Таблица CSV',
        headers: matrix[0],
        rows: matrix.slice(1),
      });
    }
  }

  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const rawItems: Array<{
    text: string;
    location: string;
    pageNumber?: number;
    sectionHeading?: string;
    isHeading?: boolean;
  }> = [];

  let approxPage = 1;
  let charsOnPage = 0;
  let currentHeading: string | undefined;

  for (const line of lines) {
    const clean = line.replace(/^#{1,6}\s+/, '').trim();
    if (!clean) continue;
    const isMdHeading = /^#{1,6}\s+/.test(line.trim());
    const headingFlag = isMdHeading || looksLikeHeading(clean);
    if (headingFlag) currentHeading = clean.slice(0, 110);

    rawItems.push({
      text: clean,
      location: `Стр. ~${approxPage}`,
      pageNumber: approxPage,
      sectionHeading: currentHeading,
      isHeading: headingFlag,
    });

    charsOnPage += clean.length;
    if (charsOnPage > 2600) {
      approxPage++;
      charsOnPage = 0;
    }
  }

  const chunks = packParagraphsIntoChunks(rawItems, toc);
  return {
    fileName,
    extension: ext,
    pagesOrSheets: Math.max(1, approxPage),
    usedOcr: false,
    toc,
    chunks,
    tables,
  };
}

/**
 * Универсальный структурный разбор документа любого поддерживаемого формата
 * (цифровые и сканированные PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, ODT/ODS/ODP/XODT/XODS, RTF, TXT/MD/CSV, изображения).
 */
export async function parseDocumentToStructuredIndex(
  buffer: Buffer,
  fileName: string
): Promise<ParsedStructuredDocument> {
  const ext = path.extname(fileName).toLowerCase();

  if (ext === '.pdf') {
    const pages = await extractPagesFromPdfWithMuPdf(buffer);
    const toc: DocumentTocItem[] = [];
    const tables: ParsedDocumentTable[] = [];
    const rawItems: Array<{
      text: string;
      location: string;
      pageNumber?: number;
      sectionHeading?: string;
      isHeading?: boolean;
    }> = [];

    let usedOcr = false;
    let currentHeading: string | undefined;

    for (const page of pages) {
      if (
        /ocr|tesseract/i.test(page.engineUsed) ||
        page.textItems.some((item) => item.source !== 'pdf')
      ) {
        usedOcr = true;
      }
      const pageNum = page.pageNumber;
      const pageLoc = `Стр. ${pageNum}`;

      for (const block of page.blocks) {
        if (block.type === 'heading' && block.text?.trim()) {
          currentHeading = block.text.trim().slice(0, 110);
          rawItems.push({
            text: block.text.trim(),
            location: pageLoc,
            pageNumber: pageNum,
            sectionHeading: currentHeading,
            isHeading: true,
          });
        } else if (block.type === 'paragraph' && block.text?.trim()) {
          const isH = looksLikeHeading(block.text.trim());
          if (isH) currentHeading = block.text.trim().slice(0, 110);
          rawItems.push({
            text: block.text.trim(),
            location: pageLoc,
            pageNumber: pageNum,
            sectionHeading: currentHeading,
            isHeading: isH,
          });
        } else if (block.type === 'table' && block.rows && block.rows.length > 0) {
          const cleanRows = block.rows
            .map((r) => r.map((c) => normalizeWhitespace(c)))
            .filter((r) => r.some((c) => c.length > 0));
          if (cleanRows.length > 0) {
            const tblLoc = `${pageLoc}, таблица #${tables.length + 1}`;
            tables.push({
              location: tblLoc,
              headers: cleanRows[0],
              rows: cleanRows.slice(1),
            });
            const tableText = cleanRows.map((r) => r.join(' | ')).join('\n');
            rawItems.push({
              text: tableText,
              location: tblLoc,
              pageNumber: pageNum,
              sectionHeading: currentHeading,
            });
          }
        }
      }
    }

    const chunks = packParagraphsIntoChunks(rawItems, toc);
    return {
      fileName,
      extension: ext,
      pagesOrSheets: Math.max(1, pages.length),
      usedOcr,
      toc,
      chunks,
      tables,
    };
  }

  if (['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'].includes(ext)) {
    const page = await recognizeRasterImagePage(buffer, 1);
    const toc: DocumentTocItem[] = [];
    const tables: ParsedDocumentTable[] = [];
    const rawItems: Array<{
      text: string;
      location: string;
      pageNumber?: number;
      sectionHeading?: string;
      isHeading?: boolean;
    }> = [];

    for (const block of page.blocks) {
      if ((block.type === 'heading' || block.type === 'paragraph') && block.text?.trim()) {
        rawItems.push({
          text: block.text.trim(),
          location: 'Изображение (OCR)',
          pageNumber: 1,
          isHeading: block.type === 'heading',
        });
      } else if (block.type === 'table' && block.rows && block.rows.length > 0) {
        const cleanRows = block.rows.map((r) => r.map((c) => normalizeWhitespace(c)));
        tables.push({
          location: 'Изображение, таблица',
          headers: cleanRows[0],
          rows: cleanRows.slice(1),
        });
        rawItems.push({
          text: cleanRows.map((r) => r.join(' | ')).join('\n'),
          location: 'Изображение, таблица',
          pageNumber: 1,
        });
      }
    }

    const chunks = packParagraphsIntoChunks(rawItems, toc);
    return {
      fileName,
      extension: ext,
      pagesOrSheets: 1,
      usedOcr: true,
      toc,
      chunks,
      tables,
    };
  }

  if (ext === '.docx') {
    return parseDocxStructured(buffer, fileName, ext);
  }

  if (ext === '.doc') {
    const converted = await convertLegacyDocToDocxBuffer(buffer);
    return parseDocxStructured(converted.docxBuffer, fileName, ext);
  }

  if (ext === '.xlsx') {
    return parseXlsxStructured(buffer, fileName, ext);
  }

  if (ext === '.xls') {
    const converted = await convertLegacyXlsToXlsxBuffer(buffer);
    return parseXlsxStructured(converted.xlsxBuffer, fileName, ext);
  }

  if (ext === '.pptx') {
    return parsePptxStructured(buffer, fileName, ext);
  }

  if (ext === '.ppt') {
    const converted = await convertLegacyPptToPptxBuffer(buffer);
    return parsePptxStructured(converted.pptxBuffer, fileName, ext);
  }

  if (ext === '.odt' || ext === '.ods' || ext === '.odp' || ext === '.xodt' || ext === '.xods') {
    return parseOpenDocStructured(buffer, fileName, ext);
  }

  if (ext === '.rtf') {
    return parsePlainTextStructured(decodeRtfToPlainText(buffer), fileName, ext);
  }

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return parsePlainTextStructured(buffer.toString('utf8'), fileName, ext);
  }

  throw new Error(
    `Формат «${ext || 'неизвестен'}» не поддерживается в модуле «Работа с документом».`
  );
}
