import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import CFB from 'cfb';
import WordExtractor from 'word-extractor';
import { DocumentProofreadResult } from '../../src/types/harness.types.ts';
import {
  processDocxBuffer,
  processPptxBuffer,
  processXlsxBuffer,
} from './documentProcessor.service.ts';
import { processRtfBuffer } from './openDocumentProcessor.service.ts';

const execFileAsync = promisify(execFile);

const CP1251_HIGH_CHARS =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

/**
 * Декодирует байты Windows-1251 (кириллица Office 97-2003) в UTF-8 строку без внешних нативных зависимостей
 */
function decodeCp1251(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else {
      out += CP1251_HIGH_CHARS[b - 0x80] || '';
    }
  }
  return out;
}

function decodeByteString(bytes: Uint8Array, codepage: number): string {
  if (codepage === 1251 || codepage === 866 || codepage === 20866) {
    return decodeCp1251(bytes);
  }
  // Для BIFF8 / PPT без явного CP1251 проверяем наличие байтов диапазона кириллицы (0xC0..0xFF)
  let cyrillicRangeHits = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0xc0) cyrillicRangeHits++;
  }
  if (cyrillicRangeHits >= 2) {
    return decodeCp1251(bytes);
  }
  return Buffer.from(bytes).toString('latin1');
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function isZipContainer(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06)
  );
}

function isOle2Container(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  );
}

function getLibreOfficeCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.LIBREOFFICE_PATH) {
    candidates.push(process.env.LIBREOFFICE_PATH);
  }
  if (os.platform() === 'win32') {
    const progFiles = process.env.ProgramFiles || '';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || '';
    if (progFiles) {
      candidates.push(path.join(progFiles, 'LibreOffice', 'program', 'soffice.exe'));
    }
    if (progFilesX86) {
      candidates.push(path.join(progFilesX86, 'LibreOffice', 'program', 'soffice.exe'));
    }
    candidates.push('soffice.exe', 'soffice');
  } else {
    candidates.push('soffice', 'libreoffice');
  }
  return candidates;
}

/**
 * Пытается выполнить lossless-конвертацию (.doc -> .docx, .xls -> .xlsx, .ppt -> .pptx)
 * через локально установленный LibreOffice (например, штатный пакет в Astra Linux SE 1.7.11).
 * Если LibreOffice не установлен — возвращает null, и срабатывает встроенный оффлайн-парсер.
 */
async function tryConvertWithLibreOffice(
  buffer: Buffer,
  sourceExt: '.doc' | '.xls' | '.ppt' | '.docx' | '.xlsx' | '.pptx',
  targetExt: 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt'
): Promise<Buffer | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-legacy-conv-'));
  const inputPath = path.join(tmpDir, `input${sourceExt}`);
  const expectedOutputPath = path.join(tmpDir, `input.${targetExt}`);
  const profileDir = path.join(tmpDir, 'lo-profile');
  const expectZip = targetExt === 'docx' || targetExt === 'xlsx' || targetExt === 'pptx';

  try {
    fs.writeFileSync(inputPath, buffer);
    const profileUri = `file://${profileDir.replace(/\\/g, '/')}`;

    for (const bin of getLibreOfficeCandidates()) {
      try {
        await execFileAsync(
          bin,
          [
            '--headless',
            '--norestore',
            '--nolockcheck',
            `-env:UserInstallation=${profileUri}`,
            '--convert-to',
            targetExt,
            '--outdir',
            tmpDir,
            inputPath,
          ],
          { timeout: 25000, windowsHide: true }
        );
        if (fs.existsSync(expectedOutputPath)) {
          const outBuf = fs.readFileSync(expectedOutputPath);
          if (outBuf.length > 0 && (!expectZip || isZipContainer(outBuf))) {
            return outBuf;
          }
        }
      } catch {
        // Пробуем следующий кандидат или переходим на встроенный JS-парсер
      }
    }
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

function stripRtfGroup(rtf: string, groupName: string): string {
  const token = `{\\${groupName}`;
  let out = rtf;
  let startIdx = out.indexOf(token);
  while (startIdx !== -1) {
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < out.length; i++) {
      const ch = out[i];
      if (ch === '\\' && i + 1 < out.length) {
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    if (endIdx <= startIdx) break;
    out = out.slice(0, startIdx) + out.slice(endIdx);
    startIdx = out.indexOf(token);
  }
  return out;
}

/**
 * Декодирует RTF-файл (часто сохраняется в корпоративных системах с расширением .doc)
 */
function extractParagraphsFromRtf(rtfRaw: string): string[] {
  let text = rtfRaw;
  for (const grp of ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'listtable', 'listoverridetable', '*']) {
    text = stripRtfGroup(text, grp);
  }

  text = text
    .replace(/\\par\b\s?/g, '\n')
    .replace(/\\line\b\s?/g, '\n')
    .replace(/\\tab\b\s?/g, '\t')
    .replace(/\\u(-?\d+)\??/g, (_m, codeStr) => {
      const n = Number(codeStr);
      const code = n < 0 ? n + 65536 : n;
      return String.fromCharCode(code);
    })
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => {
      const byteVal = parseInt(hex, 16);
      return decodeCp1251(Uint8Array.from([byteVal]));
    })
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '');

  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/**
 * Извлекает абзацы из HTML/XML документа, сохраненного с расширением .doc
 */
function extractParagraphsFromHtmlOrXml(raw: string): string[] {
  const withoutScripts = raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|tr|li|h[1-6]|w:p)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/**
 * Резервное извлечение читаемого текста (UTF-16LE и CP1251) из поврежденного/нестандартного OLE2 .doc
 */
function fallbackExtractTextFromBinaryDoc(buffer: Buffer): string[] {
  const blocks: string[] = [];
  let sourceBuf = buffer;

  if (isOle2Container(buffer)) {
    try {
      const cfb = CFB.read(buffer, { type: 'buffer' });
      const wordDocEntry = CFB.find(cfb, '/WordDocument') || CFB.find(cfb, 'WordDocument');
      if (wordDocEntry && wordDocEntry.content && wordDocEntry.content.length > 0) {
        sourceBuf = Buffer.from(wordDocEntry.content);
      }
    } catch {
      // use raw buffer
    }
  }

  const utf16Text = sourceBuf.toString('utf16le');
  const utf16Runs = utf16Text.match(/[А-Яа-яЁёA-Za-z0-9][А-Яа-яЁёA-Za-z0-9\s.,:;!?№"«»()\-–—]{5,}/g) || [];
  for (const run of utf16Runs) {
    const cleaned = run.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 6 && /[А-Яа-яЁёA-Za-z]{2,}/.test(cleaned)) {
      blocks.push(cleaned);
    }
  }

  if (blocks.length === 0) {
    const cp1251Text = decodeCp1251(new Uint8Array(sourceBuf));
    const cpRuns = cp1251Text.match(/[А-Яа-яЁё][А-Яа-яЁё0-9\s.,:;!?№"«»()\-–—]{5,}/g) || [];
    for (const run of cpRuns) {
      const cleaned = run.replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 6) blocks.push(cleaned);
    }
  }

  return Array.from(new Set(blocks));
}

/**
 * Собирает валидный OOXML .docx документ из массива абзацев (Times New Roman 12pt, стандартные поля)
 */
async function buildCleanDocxFromParagraphs(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  const safeParagraphs =
    paragraphs.length > 0 ? paragraphs : ['Документ не содержит текстовых фрагментов для проверки.'];

  const bodyXml = safeParagraphs
    .map((p, idx) => {
      const isHeading = idx === 0 && p.length <= 120 && p === p.toUpperCase() && /[А-ЯЁA-Z]/.test(p);
      const jc = isHeading ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>';
      const boldTag = isHeading ? '<w:b/>' : '';
      const szTag = isHeading ? '<w:sz w:val="28"/>' : '<w:sz w:val="24"/>';
      return `<w:p><w:pPr>${jc}<w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${boldTag}${szTag}</w:rPr><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`;
    })
    .join('\n    ');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Конвертирует входной .doc (Word 97-2003, RTF, HTML-as-DOC или переименованный DOCX) в .docx
 */
export async function convertLegacyDocToDocxBuffer(
  buffer: Buffer
): Promise<{ docxBuffer: Buffer; method: string }> {
  if (isZipContainer(buffer)) {
    return { docxBuffer: buffer, method: 'OOXML-in-DOC (прямое чтение ZIP)' };
  }

  // 1. Попытка 100% lossless-конвертации через локальный LibreOffice (если установлен на ПК)
  const loConverted = await tryConvertWithLibreOffice(buffer, '.doc', 'docx');
  if (loConverted) {
    return { docxBuffer: loConverted, method: 'LibreOffice Headless (.doc → .docx)' };
  }

  // 2. Проверка на RTF / HTML / WordML, сохраненные с расширением .doc
  const headAscii = buffer.subarray(0, 512).toString('latin1').trimStart();
  if (headAscii.startsWith('{\\rtf')) {
    const paragraphs = extractParagraphsFromRtf(buffer.toString('latin1'));
    return {
      docxBuffer: await buildCleanDocxFromParagraphs(paragraphs),
      method: 'Встроенный RTF-парсер (.doc → .docx)',
    };
  }
  if (/^(<!doctype\s+html|<html|<\?xml)/i.test(headAscii)) {
    const rawStr = buffer.toString('utf8');
    const paragraphs = extractParagraphsFromHtmlOrXml(rawStr);
    return {
      docxBuffer: await buildCleanDocxFromParagraphs(paragraphs),
      method: 'Встроенный HTML/XML-парсер (.doc → .docx)',
    };
  }

  // 3. Встроенный чистый JS-парсер бинарного формата Microsoft Word 97-2003 (OLE2 WordDocument)
  const paragraphs: string[] = [];
  try {
    const extractor = new WordExtractor();
    const extracted = await extractor.extract(buffer);

    const sections = [
      extracted.getHeaders({ includeFooters: false }),
      extracted.getBody(),
      extracted.getFootnotes(),
      extracted.getEndnotes(),
      extracted.getTextboxes({ includeHeadersAndFooters: false }),
      extracted.getFooters(),
    ];

    for (const sec of sections) {
      if (!sec) continue;
      const lines = sec
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((l) => l.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim())
        .filter((l) => l.length > 0);
      paragraphs.push(...lines);
    }
  } catch (err) {
    console.debug('WordExtractor fallback triggered:', err);
  }

  if (paragraphs.length === 0) {
    paragraphs.push(...fallbackExtractTextFromBinaryDoc(buffer));
  }

  return {
    docxBuffer: await buildCleanDocxFromParagraphs(paragraphs),
    method: 'Встроенный OLE2 Word 97-2003 парсер (.doc → .docx)',
  };
}

// ============================================================================
// BIFF8 (.xls) Pure-TS Offline Parser (Excel 97-2003 + HTML/XML .xls exports)
// ============================================================================

interface BiffRecord {
  type: number;
  data: Buffer;
}

function readBiffRecords(stream: Buffer): BiffRecord[] {
  const records: BiffRecord[] = [];
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const len = stream.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + len > stream.length) break;
    records.push({
      type,
      data: stream.subarray(offset, offset + len),
    });
    offset += len;
  }
  return records;
}

function decodeRkValue(rk: number): number {
  const isMultiplied = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let value: number;
  if (isInt) {
    value = rk >> 2;
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeUInt32LE(0, 0);
    tmp.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = tmp.readDoubleLE(0);
  }
  return isMultiplied ? value / 100 : value;
}

/**
 * Декодирует BIFF8 Shared String Table (SST 0x00FC + CONTINUE 0x003C) с поддержкой UTF-16LE и CP1251
 */
function parseBiff8Sst(records: BiffRecord[], sstStartIndex: number, codepage: number): string[] {
  const chunks: Buffer[] = [records[sstStartIndex].data];
  for (let i = sstStartIndex + 1; i < records.length; i++) {
    if (records[i].type === 0x003c) {
      chunks.push(records[i].data);
    } else {
      break;
    }
  }

  let chunkIdx = 0;
  let pos = 0;

  const ensureBytes = (count: number): boolean => {
    while (chunkIdx < chunks.length && pos >= chunks[chunkIdx].length) {
      chunkIdx++;
      pos = 0;
    }
    return chunkIdx < chunks.length && pos + count <= chunks[chunkIdx].length;
  };

  const readUInt8 = (): number => {
    if (!ensureBytes(1)) return 0;
    return chunks[chunkIdx][pos++];
  };

  const readUInt16 = (): number => {
    if (ensureBytes(2)) {
      const val = chunks[chunkIdx].readUInt16LE(pos);
      pos += 2;
      return val;
    }
    const lo = readUInt8();
    const hi = readUInt8();
    return lo | (hi << 8);
  };

  const readUInt32 = (): number => {
    if (ensureBytes(4)) {
      const val = chunks[chunkIdx].readUInt32LE(pos);
      pos += 4;
      return val;
    }
    const lo = readUInt16();
    const hi = readUInt16();
    return (lo | (hi << 16)) >>> 0;
  };

  const skipBytes = (count: number) => {
    let left = count;
    while (left > 0 && chunkIdx < chunks.length) {
      const avail = chunks[chunkIdx].length - pos;
      if (avail <= 0) {
        chunkIdx++;
        pos = 0;
        continue;
      }
      const take = Math.min(avail, left);
      pos += take;
      left -= take;
    }
  };

  if (chunks[0].length < 8) return [];
  readUInt32(); // total strings
  const uniqueCount = Math.min(readUInt32(), 500000);
  const strings: string[] = [];

  for (let s = 0; s < uniqueCount && chunkIdx < chunks.length; s++) {
    if (!ensureBytes(1)) break;
    const charCount = readUInt16();
    const flags = readUInt8();
    let isUtf16 = (flags & 0x01) !== 0;
    const hasPhonetic = (flags & 0x04) !== 0;
    const hasRichText = (flags & 0x08) !== 0;

    const rtRuns = hasRichText ? readUInt16() : 0;
    const phoneticLen = hasPhonetic ? readUInt32() : 0;

    let charsRemaining = charCount;
    let built = '';

    while (charsRemaining > 0 && chunkIdx < chunks.length) {
      if (pos >= chunks[chunkIdx].length) {
        chunkIdx++;
        pos = 0;
        if (chunkIdx >= chunks.length) break;
        // В начале CONTINUE-блока внутри строки лежит 1 байт флага кодировки продолжения
        const contFlag = chunks[chunkIdx][pos++];
        isUtf16 = (contFlag & 0x01) !== 0;
      }

      const bytesPerChar = isUtf16 ? 2 : 1;
      const availChars = Math.floor((chunks[chunkIdx].length - pos) / bytesPerChar);
      const takeChars = Math.min(charsRemaining, availChars);

      if (takeChars <= 0) {
        pos = chunks[chunkIdx].length;
        continue;
      }

      const byteLen = takeChars * bytesPerChar;
      const slice = chunks[chunkIdx].subarray(pos, pos + byteLen);
      pos += byteLen;

      if (isUtf16) {
        built += slice.toString('utf16le');
      } else {
        built += decodeByteString(slice, codepage);
      }
      charsRemaining -= takeChars;
    }

    if (rtRuns > 0) skipBytes(rtRuns * 4);
    if (phoneticLen > 0) skipBytes(phoneticLen);
    strings.push(built);
  }

  return strings;
}

function readBiffShortString(buf: Buffer, offset: number, lenBytes: 1 | 2, codepage: number): string {
  if (offset + lenBytes >= buf.length) return '';
  const charCount = lenBytes === 1 ? buf.readUInt8(offset) : buf.readUInt16LE(offset);
  const flagOffset = offset + lenBytes;
  if (flagOffset >= buf.length) return '';
  const flags = buf.readUInt8(flagOffset);
  const isUtf16 = (flags & 0x01) !== 0;
  const dataStart = flagOffset + 1;
  const byteLen = charCount * (isUtf16 ? 2 : 1);
  if (dataStart + byteLen > buf.length) {
    const clamped = buf.subarray(dataStart);
    return isUtf16 ? clamped.toString('utf16le') : decodeByteString(clamped, codepage);
  }
  const slice = buf.subarray(dataStart, dataStart + byteLen);
  return isUtf16 ? slice.toString('utf16le') : decodeByteString(slice, codepage);
}

/**
 * Парсит HTML-таблицы или XML SpreadsheetML 2003, сохраненные с расширением .xls (например, экспорт из 1С)
 */
async function buildXlsxFromHtmlOrXmlXls(raw: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Лист1');

  const isXmlSpreadsheet = /<Workbook\b/i.test(raw) && /<Row\b/i.test(raw);
  if (isXmlSpreadsheet) {
    const rowMatches = raw.match(/<Row\b[^>]*>[\s\S]*?<\/Row>/gi) || [];
    for (const rowXml of rowMatches) {
      const cells: string[] = [];
      const cellRegex = /<Data\b[^>]*>([\s\S]*?)<\/Data>/gi;
      let m: RegExpExecArray | null;
      while ((m = cellRegex.exec(rowXml)) !== null) {
        cells.push(decodeHtmlEntities(m[1]).trim());
      }
      if (cells.length > 0) {
        sheet.addRow(cells);
      }
    }
  } else {
    const rowMatches = raw.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const rowHtml of rowMatches) {
      const cells: string[] = [];
      const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let m: RegExpExecArray | null;
      while ((m = cellRegex.exec(rowHtml)) !== null) {
        const plain = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(plain);
      }
      if (cells.length > 0) {
        sheet.addRow(cells);
      }
    }
  }

  if (sheet.rowCount === 0) {
    const fallbackLines = extractParagraphsFromHtmlOrXml(raw);
    for (const line of fallbackLines) {
      sheet.addRow([line]);
    }
  }

  sheet.columns.forEach((col) => {
    col.width = 28;
  });

  const outArr = await workbook.xlsx.writeBuffer();
  return Buffer.from(outArr);
}

/**
 * Конвертирует бинарный Excel 97-2003 (.xls, OLE2 BIFF8) в валидный .xlsx через CFB + ExcelJS
 */
async function parseBinaryBiff8XlsToXlsx(buffer: Buffer): Promise<Buffer> {
  const cfb = CFB.read(buffer, { type: 'buffer' });
  const wbEntry =
    CFB.find(cfb, '/Workbook') ||
    CFB.find(cfb, 'Workbook') ||
    CFB.find(cfb, '/Book') ||
    CFB.find(cfb, 'Book');

  if (!wbEntry || !wbEntry.content || wbEntry.content.length === 0) {
    throw new Error('Поток Workbook/Book не найден внутри файла .xls.');
  }

  const stream = Buffer.from(wbEntry.content);
  const records = readBiffRecords(stream);

  let codepage = 1251;
  let sst: string[] = [];
  const sheetDefs: Array<{ name: string; offset: number }> = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.type === 0x0042 && rec.data.length >= 2) {
      codepage = rec.data.readUInt16LE(0);
    } else if (rec.type === 0x0085 && rec.data.length >= 8) {
      const sheetOffset = rec.data.readUInt32LE(0);
      const sheetName = readBiffShortString(rec.data, 6, 1, codepage).trim() || `Лист${sheetDefs.length + 1}`;
      sheetDefs.push({ name: sheetName, offset: sheetOffset });
    } else if (rec.type === 0x00fc) {
      sst = parseBiff8Sst(records, i, codepage);
    } else if (rec.type === 0x000a) {
      // EOF глобального заголовка книги
      break;
    }
  }

  const workbook = new ExcelJS.Workbook();
  const usedSheetNames = new Set<string>();

  const makeUniqueSheetName = (rawName: string, idx: number): string => {
    const sanitized = rawName.replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || `Лист${idx + 1}`;
    let candidate = sanitized;
    let suffix = 2;
    while (usedSheetNames.has(candidate.toLowerCase())) {
      candidate = `${sanitized.slice(0, 27)}_${suffix++}`;
    }
    usedSheetNames.add(candidate.toLowerCase());
    return candidate;
  };

  if (sheetDefs.length === 0) {
    sheetDefs.push({ name: 'Лист1', offset: 0 });
  }

  sheetDefs.forEach((def, sheetIdx) => {
    const ws = workbook.addWorksheet(makeUniqueSheetName(def.name, sheetIdx));
    const subRecords = readBiffRecords(stream.subarray(def.offset));
    let lastFormulaRow = -1;
    let lastFormulaCol = -1;

    for (const rec of subRecords) {
      if (rec.type === 0x000a) {
        break; // EOF листа
      }

      if (rec.type === 0x00fd && rec.data.length >= 10) {
        // LABELSST: индекс строки в общей таблице SST
        const row = rec.data.readUInt16LE(0) + 1;
        const col = rec.data.readUInt16LE(2) + 1;
        const sstIndex = rec.data.readUInt32LE(6);
        const val = sst[sstIndex];
        if (typeof val === 'string') {
          ws.getRow(row).getCell(col).value = val;
        }
      } else if ((rec.type === 0x0204 || rec.type === 0x00d6) && rec.data.length >= 9) {
        // LABEL / RSTRING: встроенная строка ячейки
        const row = rec.data.readUInt16LE(0) + 1;
        const col = rec.data.readUInt16LE(2) + 1;
        const val = readBiffShortString(rec.data, 6, 2, codepage);
        ws.getRow(row).getCell(col).value = val;
      } else if (rec.type === 0x0203 && rec.data.length >= 14) {
        // NUMBER: IEEE 754 float64
        const row = rec.data.readUInt16LE(0) + 1;
        const col = rec.data.readUInt16LE(2) + 1;
        const num = rec.data.readDoubleLE(6);
        ws.getRow(row).getCell(col).value = num;
      } else if (rec.type === 0x027e && rec.data.length >= 10) {
        // RK: сжатое число
        const row = rec.data.readUInt16LE(0) + 1;
        const col = rec.data.readUInt16LE(2) + 1;
        const rk = rec.data.readInt32LE(6);
        ws.getRow(row).getCell(col).value = decodeRkValue(rk);
      } else if (rec.type === 0x00bd && rec.data.length >= 6) {
        // MULRK: несколько числовых ячеек подряд в одной строке
        const row = rec.data.readUInt16LE(0) + 1;
        const firstCol = rec.data.readUInt16LE(2);
        const lastCol = rec.data.readUInt16LE(rec.data.length - 2);
        let pos = 4;
        for (let c = firstCol; c <= lastCol && pos + 6 <= rec.data.length - 2; c++) {
          const rk = rec.data.readInt32LE(pos + 2);
          ws.getRow(row).getCell(c + 1).value = decodeRkValue(rk);
          pos += 6;
        }
      } else if (rec.type === 0x0006 && rec.data.length >= 14) {
        // FORMULA: сохраняем вычисленное значение (число или следующую запись STRING 0x0207)
        const row = rec.data.readUInt16LE(0) + 1;
        const col = rec.data.readUInt16LE(2) + 1;
        lastFormulaRow = row;
        lastFormulaCol = col;
        const byte6 = rec.data[12];
        const byte7 = rec.data[13];
        if (byte6 === 0xff && byte7 === 0xff) {
          const specialType = rec.data[6];
          if (specialType === 1) {
            ws.getRow(row).getCell(col).value = rec.data[8] !== 0;
          }
          // Если specialType === 0, строковый результат придет в следующей записи 0x0207
        } else {
          const num = rec.data.readDoubleLE(6);
          if (Number.isFinite(num)) {
            ws.getRow(row).getCell(col).value = num;
          }
        }
      } else if (rec.type === 0x0207 && lastFormulaRow > 0 && lastFormulaCol > 0) {
        // STRING: кешированный строковый результат формулы
        const val = readBiffShortString(rec.data, 0, 2, codepage);
        ws.getRow(lastFormulaRow).getCell(lastFormulaCol).value = val;
        lastFormulaRow = -1;
        lastFormulaCol = -1;
      } else if (rec.type === 0x0205 && rec.data.length >= 8) {
        // BOOLERR
        const row = rec.data.readUInt16LE(0) + 1;
        const col = rec.data.readUInt16LE(2) + 1;
        const isError = rec.data[7] !== 0;
        if (!isError) {
          ws.getRow(row).getCell(col).value = rec.data[6] !== 0;
        }
      }
    }

    // Аккуратная авто-ширина колонок и шрифт Arial 10pt
    ws.columns.forEach((column) => {
      let maxLen = 14;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = String(cell.value ?? '').length;
        if (len > maxLen) maxLen = Math.min(60, len + 4);
      });
      column.width = maxLen;
    });
  });

  const outArr = await workbook.xlsx.writeBuffer();
  return Buffer.from(outArr);
}

/**
 * Конвертирует входной .xls (Excel 97-2003, HTML-таблица, XML SpreadsheetML или переименованный XLSX) в .xlsx
 */
export async function convertLegacyXlsToXlsxBuffer(
  buffer: Buffer
): Promise<{ xlsxBuffer: Buffer; method: string }> {
  if (isZipContainer(buffer)) {
    return { xlsxBuffer: buffer, method: 'OOXML-in-XLS (прямое чтение ZIP)' };
  }

  // 1. Lossless-конвертация через локальный LibreOffice (если установлен)
  const loConverted = await tryConvertWithLibreOffice(buffer, '.xls', 'xlsx');
  if (loConverted) {
    return { xlsxBuffer: loConverted, method: 'LibreOffice Headless (.xls → .xlsx)' };
  }

  // 2. HTML-таблица или XML SpreadsheetML 2003 (частый экспорт из 1С и корпоративных систем с расширением .xls)
  const headAscii = buffer.subarray(0, 512).toString('latin1').trimStart();
  if (/^(<!doctype\s+html|<html|<table|<\?xml|<workbook)/i.test(headAscii)) {
    const rawStr = buffer.toString('utf8');
    return {
      xlsxBuffer: await buildXlsxFromHtmlOrXmlXls(rawStr),
      method: 'Встроенный HTML/XML-парсер таблиц (.xls → .xlsx)',
    };
  }

  // 3. Бинарный OLE2 BIFF8 (.xls) через CFB + ExcelJS
  const xlsxBuffer = await parseBinaryBiff8XlsToXlsx(buffer);
  return {
    xlsxBuffer,
    method: 'Встроенный OLE2 BIFF8 парсер (.xls → .xlsx)',
  };
}

// ============================================================================
// MS-PPT (.ppt) Pure-TS Offline Parser (PowerPoint 97-2003 OLE2 -> .pptx)
// ============================================================================

/**
 * Рекурсивно обходит дерево записей MS-PPT и извлекает слайды с текстовыми блоками
 * из TextCharsAtom (0x0FA0, UTF-16LE кириллица) и TextBytesAtom (0x0FA8, CP1251).
 */
function extractSlidesFromPowerPointStream(stream: Buffer): string[][] {
  const slides: string[][] = [];
  let currentSlideTexts: string[] = [];

  const flushSlide = () => {
    const cleaned = currentSlideTexts.map((t) => t.trim()).filter((t) => t.length > 0);
    if (cleaned.length > 0) {
      slides.push(cleaned);
    }
    currentSlideTexts = [];
  };

  const walk = (start: number, end: number, depth: number) => {
    if (depth > 24) return;
    let offset = start;
    while (offset + 8 <= end) {
      const verInst = stream.readUInt16LE(offset);
      const recVer = verInst & 0x000f;
      const recType = stream.readUInt16LE(offset + 2);
      const recLen = stream.readUInt32LE(offset + 4);
      const bodyStart = offset + 8;
      const bodyEnd = bodyStart + recLen;

      if (bodyEnd > end || bodyEnd < bodyStart) {
        break;
      }

      // 0x03EE = RT_Slide, 0x03F3 = RT_SlidePersistAtom (граница слайда в SlideListWithText)
      if (recType === 0x03ee || recType === 0x03f3) {
        flushSlide();
      }

      if (recVer === 0x000f) {
        // Контейнерная запись — заходим внутрь
        walk(bodyStart, bodyEnd, depth + 1);
        if (recType === 0x03ee) {
          flushSlide();
        }
      } else if (recType === 0x0fa0) {
        // RT_TextCharsAtom (UTF-16LE Unicode)
        const text = stream
          .subarray(bodyStart, bodyEnd)
          .toString('utf16le')
          .replace(/\r/g, '\n')
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length > 0) currentSlideTexts.push(trimmed);
        }
      } else if (recType === 0x0fa8) {
        // RT_TextBytesAtom (однобайтовая строка, Windows-1251 для русского языка)
        const text = decodeByteString(stream.subarray(bodyStart, bodyEnd), 1251)
          .replace(/\r/g, '\n')
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length > 0) currentSlideTexts.push(trimmed);
        }
      }

      offset = bodyEnd;
    }
  };

  walk(0, stream.length, 0);
  flushSlide();

  // Удаляем дублирующиеся слайды (в .ppt текст может дублироваться в SlideListWithText и RT_Slide)
  const uniqueSlides: string[][] = [];
  const seenSignatures = new Set<string>();
  for (const slideLines of slides) {
    const sig = slideLines.join('\u0001');
    if (!seenSignatures.has(sig)) {
      seenSignatures.add(sig);
      uniqueSlides.push(slideLines);
    }
  }

  return uniqueSlides;
}

/**
 * Генерирует валидный PresentationML (.pptx) архив из массива слайдов и текстовых блоков
 */
async function buildCleanPptxFromSlides(slides: string[][]): Promise<Buffer> {
  const safeSlides =
    slides.length > 0
      ? slides
      : [['Презентация не содержит текстовых блоков для проверки.']];

  const zip = new JSZip();

  const slideContentTypeOverrides = safeSlides
    .map(
      (_s, idx) =>
        `  <Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join('\n');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
${slideContentTypeOverrides}
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  );

  const sldIdList = safeSlides
    .map((_s, idx) => `    <p:sldId id="${256 + idx}" r:id="rId${idx + 2}"/>`)
    .join('\n');

  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${sldIdList}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`
  );

  const slideRels = safeSlides
    .map(
      (_s, idx) =>
        `  <Relationship Id="rId${idx + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>`
    )
    .join('\n');

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRels}
</Relationships>`
  );

  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`
  );

  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`
  );

  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`
  );

  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`
  );

  safeSlides.forEach((lines, idx) => {
    const slideNum = idx + 1;
    const paragraphsXml = lines
      .map((line, lineIdx) => {
        const isTitle = lineIdx === 0;
        const sz = isTitle ? '2400' : '1600';
        const bold = isTitle ? ' b="1"' : '';
        return `          <a:p><a:r><a:rPr lang="ru-RU" sz="${sz}"${bold}/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`;
      })
      .join('\n');

    zip.file(
      `ppt/slides/slide${slideNum}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="5943600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square"/>
          <a:lstStyle/>
${paragraphsXml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
    );

    zip.file(
      `ppt/slides/_rels/slide${slideNum}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`
    );
  });

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Конвертирует входной .ppt (PowerPoint 97-2003 OLE2 или переименованный PPTX) в .pptx
 */
export async function convertLegacyPptToPptxBuffer(
  buffer: Buffer
): Promise<{ pptxBuffer: Buffer; method: string }> {
  if (isZipContainer(buffer)) {
    return { pptxBuffer: buffer, method: 'OOXML-in-PPT (прямое чтение ZIP)' };
  }

  // 1. Lossless-конвертация через локальный LibreOffice (если установлен)
  const loConverted = await tryConvertWithLibreOffice(buffer, '.ppt', 'pptx');
  if (loConverted) {
    return { pptxBuffer: loConverted, method: 'LibreOffice Headless (.ppt → .pptx)' };
  }

  // 2. Встроенный чистый JS-парсер бинарного OLE2 PowerPoint 97-2003 (.ppt)
  const cfb = CFB.read(buffer, { type: 'buffer' });
  const pptEntry =
    CFB.find(cfb, '/PowerPoint Document') || CFB.find(cfb, 'PowerPoint Document');

  if (!pptEntry || !pptEntry.content || pptEntry.content.length === 0) {
    throw new Error('Поток PowerPoint Document не найден внутри файла .ppt.');
  }

  const slides = extractSlidesFromPowerPointStream(Buffer.from(pptEntry.content));
  const pptxBuffer = await buildCleanPptxFromSlides(slides);
  return {
    pptxBuffer,
    method: 'Встроенный OLE2 PowerPoint 97-2003 парсер (.ppt → .pptx)',
  };
}

// ============================================================================
// Высокоуровневые обработчики для server.ts: .doc / .xls / .ppt -> коррекция
// ============================================================================

export async function processLegacyDocBuffer(
  buffer: Buffer,
  originalFileName: string
): Promise<DocumentProofreadResult> {
  const headAscii = buffer.subarray(0, 512).toString('latin1').trimStart();
  const { docxBuffer, method } = await convertLegacyDocToDocxBuffer(buffer);
  const targetDocxName = originalFileName.replace(/\.doc$/i, '.docx');
  const result = await processDocxBuffer(docxBuffer, targetDocxName);

  // Если на ПК установлен LibreOffice — возвращаем строго исходный формат .doc (.doc -> .doc)
  const correctedDocxBuf = Buffer.from(result.downloadBase64, 'base64');
  const roundTripDoc = await tryConvertWithLibreOffice(correctedDocxBuf, '.docx', 'doc');
  if (roundTripDoc) {
    return {
      ...result,
      fileName: originalFileName,
      fileType: 'doc',
      fileSizeBytes: roundTripDoc.length,
      downloadBase64: roundTripDoc.toString('base64'),
      mimeType: 'application/msword',
      sourceFileName: originalFileName,
      engineUsed: `${result.engineUsed} + ${method} → .doc`,
    };
  }

  // Если входной .doc был в формате RTF, сохраняем строго исходный формат .doc даже без LibreOffice
  if (headAscii.startsWith('{\\rtf')) {
    const rtfRes = await processRtfBuffer(buffer, originalFileName);
    return {
      ...rtfRes,
      fileName: originalFileName,
      fileType: 'doc',
      mimeType: 'application/msword',
      sourceFileName: originalFileName,
    };
  }

  return {
    ...result,
    sourceFileName: originalFileName,
    engineUsed: `${result.engineUsed} + ${method}`,
  };
}

export async function processLegacyXlsBuffer(
  buffer: Buffer,
  originalFileName: string
): Promise<DocumentProofreadResult> {
  const { xlsxBuffer, method } = await convertLegacyXlsToXlsxBuffer(buffer);
  const targetXlsxName = originalFileName.replace(/\.xls$/i, '.xlsx');
  const result = await processXlsxBuffer(xlsxBuffer, targetXlsxName);

  // Если на ПК установлен LibreOffice — возвращаем строго исходный формат .xls (.xls -> .xls)
  const correctedXlsxBuf = Buffer.from(result.downloadBase64, 'base64');
  const roundTripXls = await tryConvertWithLibreOffice(correctedXlsxBuf, '.xlsx', 'xls');
  if (roundTripXls) {
    return {
      ...result,
      fileName: originalFileName,
      fileType: 'xls',
      fileSizeBytes: roundTripXls.length,
      downloadBase64: roundTripXls.toString('base64'),
      mimeType: 'application/vnd.ms-excel',
      sourceFileName: originalFileName,
      engineUsed: `${result.engineUsed} + ${method} → .xls`,
    };
  }

  return {
    ...result,
    sourceFileName: originalFileName,
    engineUsed: `${result.engineUsed} + ${method}`,
  };
}

export async function processLegacyPptBuffer(
  buffer: Buffer,
  originalFileName: string
): Promise<DocumentProofreadResult> {
  const { pptxBuffer, method } = await convertLegacyPptToPptxBuffer(buffer);
  const targetPptxName = originalFileName.replace(/\.ppt$/i, '.pptx');
  const result = await processPptxBuffer(pptxBuffer, targetPptxName);

  // Если на ПК установлен LibreOffice — возвращаем строго исходный формат .ppt (.ppt -> .ppt)
  const correctedPptxBuf = Buffer.from(result.downloadBase64, 'base64');
  const roundTripPpt = await tryConvertWithLibreOffice(correctedPptxBuf, '.pptx', 'ppt');
  if (roundTripPpt) {
    return {
      ...result,
      fileName: originalFileName,
      fileType: 'ppt',
      fileSizeBytes: roundTripPpt.length,
      downloadBase64: roundTripPpt.toString('base64'),
      mimeType: 'application/vnd.ms-powerpoint',
      sourceFileName: originalFileName,
      engineUsed: `${result.engineUsed} + ${method} → .ppt`,
    };
  }

  return {
    ...result,
    sourceFileName: originalFileName,
    engineUsed: `${result.engineUsed} + ${method}`,
  };
}
