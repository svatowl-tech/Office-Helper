import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DocumentProofreadResult, DocumentSegment } from '../../src/types/harness.types.ts';
import { proofreadRussianText } from './russianProofreader.service.ts';

/**
 * Экранирование спецсимволов XML при записи в <w:t>
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Декодирование XML-сущностей из <w:t>
 */
function unescapeXml(safe: string): string {
  return safe
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Извлекает читаемое описание форматирования абзаца из XML-узла <w:p>
 */
function extractParagraphStyleSummary(pXml: string, runCount: number): string {
  const details: string[] = [];

  const pStyleMatch = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
  if (pStyleMatch) {
    details.push(`Стиль: ${pStyleMatch[1]}`);
  }

  const fontMatch = pXml.match(/w:ascii="([^"]+)"/);
  if (fontMatch) {
    details.push(fontMatch[1]);
  } else {
    details.push('Шрифт документа');
  }

  const sizeMatch = pXml.match(/<w:sz\s+w:val="(\d+)"/);
  if (sizeMatch) {
    const pt = Number(sizeMatch[1]) / 2;
    details.push(`${pt}pt`);
  }

  if (/<w:b(\s|\/|>)/.test(pXml)) {
    details.push('Полужирный');
  }
  if (/<w:i(\s|\/|>)/.test(pXml)) {
    details.push('Курсив');
  }

  const jcMatch = pXml.match(/<w:jc\s+w:val="([^"]+)"/);
  if (jcMatch) {
    const alignMap: Record<string, string> = {
      both: 'по ширине',
      center: 'по центру',
      right: 'по правому краю',
      left: 'по левому краю',
    };
    details.push(`Выравнивание: ${alignMap[jcMatch[1]] || jcMatch[1]}`);
  }

  details.push(`Сохранено ${runCount} XML-ранов (<w:r>)`);
  return details.join(' · ');
}

/**
 * Алгоритм хирургической замены текста в абзаце <w:p> с сохранением 100% форматирования (<w:rPr>, <w:pPr>, таблиц, колонтитулов).
 * Распределяет исправленный текст пропорционально исходным узлам <w:t>, чтобы не сбить жирный/курсивный шрифт внутри абзаца.
 */
async function processDocxXmlContent(
  xmlContent: string,
  sectionLabel: string,
  segmentsCollector: DocumentSegment[],
  chunkCounter: { count: number }
): Promise<string> {
  // Находим все абзацы <w:p ...>...</w:p>
  const paragraphRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;
  let paragraphIndex = 0;

  const replacements: Array<{ start: number; end: number; newPXml: string }> = [];

  while ((match = paragraphRegex.exec(xmlContent)) !== null) {
    const pXml = match[0];
    const pStart = match.index;
    const pEnd = pStart + pXml.length;

    // Находим все текстовые узлы <w:t ...>...</w:t> внутри данного абзаца
    const wtRegex = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;
    const wtNodes: Array<{
      fullMatch: string;
      openTag: string;
      rawText: string;
      decodedText: string;
      closeTag: string;
      startInP: number;
      endInP: number;
    }> = [];

    let wtMatch: RegExpExecArray | null;
    while ((wtMatch = wtRegex.exec(pXml)) !== null) {
      wtNodes.push({
        fullMatch: wtMatch[0],
        openTag: wtMatch[1],
        rawText: wtMatch[2],
        decodedText: unescapeXml(wtMatch[2]),
        closeTag: wtMatch[3],
        startInP: wtMatch.index,
        endInP: wtMatch.index + wtMatch[0].length,
      });
    }

    if (wtNodes.length === 0) continue;

    const fullParagraphText = wtNodes.map((n) => n.decodedText).join('');
    if (fullParagraphText.trim().length === 0) continue;

    paragraphIndex++;
    const isTable = pXml.includes('<w:tcPr') || sectionLabel.includes('Таблица');
    const proofread = await proofreadRussianText(fullParagraphText);
    chunkCounter.count += Math.max(1, proofread.totalChunksProcessed);
    const styleSummary = extractParagraphStyleSummary(pXml, wtNodes.length);

    segmentsCollector.push({
      id: `docx-seg-${segmentsCollector.length + 1}`,
      location: `${sectionLabel} — Абзац #${paragraphIndex}`,
      elementType: isTable ? 'table_cell' : 'paragraph',
      originalText: fullParagraphText,
      correctedText: proofread.correctedText,
      preservedFormattingMeta: styleSummary,
      issues: proofread.issues,
      applied: proofread.issues.length > 0,
    });

    if (proofread.issues.length > 0 && proofread.correctedText !== fullParagraphText) {
      // Распределяем исправленный текст по существующим узлам <w:t>, сохраняя все <w:rPr>
      let updatedPXml = pXml;
      if (wtNodes.length === 1) {
        const node = wtNodes[0];
        const openTagWithSpace = node.openTag.includes('xml:space')
          ? node.openTag
          : '<w:t xml:space="preserve">';
        const newWt = `${openTagWithSpace}${escapeXml(proofread.correctedText)}${node.closeTag}`;
        updatedPXml =
          updatedPXml.slice(0, node.startInP) + newWt + updatedPXml.slice(node.endInP);
      } else {
        // Пропорциональное посимвольное/пословное распределение по узлам <w:t> с сохранением границ ранов
        let remainingCorrected = proofread.correctedText;
        for (let i = wtNodes.length - 1; i >= 0; i--) {
          const node = wtNodes[i];
          let sliceForThisNode = '';

          if (i === 0) {
            sliceForThisNode = remainingCorrected;
          } else {
            const origLen = node.decodedText.length;
            const cutIndex = Math.max(0, remainingCorrected.length - origLen);
            sliceForThisNode = remainingCorrected.slice(cutIndex);
            remainingCorrected = remainingCorrected.slice(0, cutIndex);
          }

          const openTagWithSpace = node.openTag.includes('xml:space')
            ? node.openTag
            : '<w:t xml:space="preserve">';
          const newWt = `${openTagWithSpace}${escapeXml(sliceForThisNode)}${node.closeTag}`;
          updatedPXml =
            updatedPXml.slice(0, node.startInP) + newWt + updatedPXml.slice(node.endInP);
        }
      }

      replacements.push({
        start: pStart,
        end: pEnd,
        newPXml: updatedPXml,
      });
    }
  }

  let finalXml = xmlContent;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const rep = replacements[i];
    finalXml = finalXml.slice(0, rep.start) + rep.newPXml + finalXml.slice(rep.end);
  }

  return finalXml;
}

/**
 * Обрабатывает реальный файл .docx с сохранением всей верстки, стилей, таблиц, картинок и колонтитулов.
 */
export async function processDocxBuffer(
  buffer: Buffer,
  fileName: string
): Promise<DocumentProofreadResult> {
  const startTime = Date.now();
  const zip = await JSZip.loadAsync(buffer);
  const segments: DocumentSegment[] = [];

  // Обрабатываем основной документ word/document.xml, а также колонтитулы word/header*.xml и word/footer*.xml
  const xmlFilesToProcess = Object.keys(zip.files).filter(
    (path) =>
      path === 'word/document.xml' ||
      /^word\/header\d*\.xml$/.test(path) ||
      /^word\/footer\d*\.xml$/.test(path)
  );

  const chunkCounter = { count: 0 };

  for (const xmlPath of xmlFilesToProcess) {
    const fileObj = zip.file(xmlPath);
    if (!fileObj) continue;

    const rawXml = await fileObj.async('string');
    const sectionLabel =
      xmlPath === 'word/document.xml'
        ? 'Основной документ'
        : xmlPath.includes('header')
          ? 'Верхний колонтитул'
          : 'Нижний колонтитул';

    const updatedXml = await processDocxXmlContent(rawXml, sectionLabel, segments, chunkCounter);
    zip.file(xmlPath, updatedXml);
  }

  const outBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const modifiedSegments = segments.filter((s) => s.issues.length > 0).length;
  const totalIssuesFixed = segments.reduce((acc, s) => acc + s.issues.length, 0);

  return {
    fileName,
    fileType: 'docx',
    fileSizeBytes: outBuffer.length,
    processingTimeMs: Math.max(12, Date.now() - startTime),
    engineUsed: 'SAGE-FRED-T5-95M-INT8 + OpenXML Chunked Run-Preserving Engine',
    totalSegments: segments.length,
    modifiedSegments,
    totalIssuesFixed,
    totalChunksProcessed: chunkCounter.count,
    chunkMaxCharsUsed: Number(process.env.HARNESS_CHUNK_MAX_CHARS) || 480,
    segments,
    downloadBase64: outBuffer.toString('base64'),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

/**
 * Обрабатывает реальный файл .xlsx через ExcelJS с сохранением шрифтов, границ, заливки, формул и ширины колонок.
 */
export async function processXlsxBuffer(
  buffer: Buffer,
  fileName: string
): Promise<DocumentProofreadResult> {
  const startTime = Date.now();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const segments: DocumentSegment[] = [];
  let totalChunksProcessed = 0;

  for (const worksheet of workbook.worksheets) {
    const rows: ExcelJS.Row[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      rows.push(row);
    });

    for (const row of rows) {
      const cells: ExcelJS.Cell[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        cells.push(cell);
      });

      for (const cell of cells) {
        // Не трогаем формулы, числа и даты — правим исключительно текстовые ячейки и RichText
        if (cell.formula || cell.type === ExcelJS.ValueType.Number || cell.type === ExcelJS.ValueType.Date) {
          continue;
        }

        if (typeof cell.value === 'string' && cell.value.trim().length > 0) {
          const originalText = cell.value;
          const proofread = await proofreadRussianText(originalText);
          totalChunksProcessed += Math.max(1, proofread.totalChunksProcessed);

          const fontName = cell.font?.name || 'Calibri';
          const fontSize = cell.font?.size || 11;
          const isBold = cell.font?.bold ? ', Полужирный' : '';
          const hasFill = cell.fill ? ', Заливка ячейки сохранена' : '';
          const hasBorder = cell.border ? ', Рамки сохранены' : '';

          segments.push({
            id: `xlsx-seg-${segments.length + 1}`,
            location: `Лист «${worksheet.name}», ячейка ${cell.address}`,
            elementType: 'spreadsheet_cell',
            originalText,
            correctedText: proofread.correctedText,
            preservedFormattingMeta: `${fontName} ${fontSize}pt${isBold}${hasFill}${hasBorder}`,
            issues: proofread.issues,
            applied: proofread.issues.length > 0,
          });

          if (proofread.issues.length > 0) {
            // Присваиваем только текстовое значение, не перезаписывая cell.style
            cell.value = proofread.correctedText;
          }
        } else if (
          cell.value &&
          typeof cell.value === 'object' &&
          'richText' in cell.value &&
          Array.isArray(cell.value.richText)
        ) {
          const richParts = cell.value.richText;
          const combinedOriginal = richParts.map((p) => p.text).join('');
          if (combinedOriginal.trim().length === 0) continue;

          const proofread = await proofreadRussianText(combinedOriginal);
          const allIssues = [...proofread.issues];

          for (const part of richParts) {
            if (part.text && part.text.trim().length > 0) {
              const partProof = await proofreadRussianText(part.text);
              totalChunksProcessed += Math.max(1, partProof.totalChunksProcessed);
              if (partProof.issues.length > 0) {
                part.text = partProof.correctedText;
              }
            }
          }

          segments.push({
            id: `xlsx-seg-${segments.length + 1}`,
            location: `Лист «${worksheet.name}», ячейка ${cell.address} (RichText)`,
            elementType: 'spreadsheet_cell',
            originalText: combinedOriginal,
            correctedText: richParts.map((p) => p.text).join(''),
            preservedFormattingMeta: `RichText (${richParts.length} фрагментов форматирования сохранено)`,
            issues: allIssues,
            applied: allIssues.length > 0,
          });
        }
      }
    }
  }

  const outArrayBuffer = await workbook.xlsx.writeBuffer();
  const outBuffer = Buffer.from(outArrayBuffer);

  const modifiedSegments = segments.filter((s) => s.issues.length > 0).length;
  const totalIssuesFixed = segments.reduce((acc, s) => acc + s.issues.length, 0);

  return {
    fileName,
    fileType: 'xlsx',
    fileSizeBytes: outBuffer.length,
    processingTimeMs: Math.max(15, Date.now() - startTime),
    engineUsed: 'SAGE-FRED-T5-95M-INT8 + ExcelJS Chunked Style-Safe AST',
    totalSegments: segments.length,
    modifiedSegments,
    totalIssuesFixed,
    totalChunksProcessed,
    chunkMaxCharsUsed: Number(process.env.HARNESS_CHUNK_MAX_CHARS) || 480,
    segments,
    downloadBase64: outBuffer.toString('base64'),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

/**
 * Генерирует демонстрационный документ .docx с реальной сложной версткой (таблица, стили, заголовки, жирный/курсив)
 * и типичными ошибками делового русского языка для мгновенной проверки пользователем в 1 клик.
 */
export async function generateSampleDocxWithErrors(): Promise<Buffer> {
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

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="32"/></w:rPr>
        <w:t xml:space="preserve">СЛУЖЕБНАЯ ЗАПИСКА № 48/АЛ «О проверке контура информационной безопаснть»</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="both"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="28"/></w:rPr>
        <w:t xml:space="preserve">Согласно приказа </w:t>
      </w:r>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr>
        <w:t xml:space="preserve">руководителя департамента в течении месяца была проведена ревизия серверного оборудывания на узлах Астра Линукс и Windows 7.</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="both"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:i/><w:sz w:val="28"/></w:rPr>
        <w:t xml:space="preserve">В следствии сбоя </w:t>
      </w:r>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr>
        <w:t xml:space="preserve">маршрутизации зафиксирован инциндент потери пакетов, не смотря на резервирование канала. Начальнику смены поручено координально пересмотреть регламент эксплотации и расчитать нагрузку.</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="both"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr>
        <w:t xml:space="preserve">По окончанию регламентных работ прошу бухгалтерию оплатить за оборудование согласно договора поставки, так как соблюдение сроков играет большое значение для будующее аттестации объекта.</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Генерирует демонстрационный файл .xlsx со стилями (шапка таблицы, цвета, границы, формулы)
 * и орфографическими/грамматическими ошибками в ячейках для проверки Excel-корректора.
 */
export async function generateSampleXlsxWithErrors(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Ведомость узлов ЗСПД');

  sheet.columns = [
    { header: 'Код узла', key: 'code', width: 16 },
    { header: 'Описание регламентных работ (с сохранением стилей)', key: 'desc', width: 64 },
    { header: 'Статус проверки', key: 'status', width: 36 },
    { header: 'Трудозатраты (ч)', key: 'hours', width: 18 },
  ];

  // Оформляем шапку таблицы
  const headerRow = sheet.getRow(1);
  headerRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' },
  };

  const rowsData = [
    {
      code: 'ASTRA-SRV-01',
      desc: 'Проверка выявила инциндент в течении недели согласно регламента эксплотации.',
      status: 'По окончанию работ доложить в агенство',
      hours: 12,
    },
    {
      code: 'WIN7-ARM-04',
      desc: 'В виду отсутствия внешних репозиториев необходимо расчитать рассчет емкости диска.',
      status: 'В следствии ошибки требуется обновление',
      hours: 8,
    },
    {
      code: 'GATEWAY-LAN-02',
      desc: 'Не смотря на нагрузку, система играет большое значение и работает согласно графика.',
      status: 'Оплатить за услуги по завершению этапа',
      hours: 16,
    },
  ];

  rowsData.forEach((item, idx) => {
    const r = sheet.addRow(item);
    r.font = { name: 'Arial', size: 10, bold: idx === 0 };
    r.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      };
    });
  });

  // Добавим строку с формулой, чтобы доказать, что формулы не ломаются
  const totalRow = sheet.addRow({
    code: 'ИТОГО',
    desc: 'Суммарный объем работ по договору (формула SUM сохранена)',
    status: 'По истечению срока',
    hours: { formula: 'SUM(D2:D4)', result: 36 },
  });
  totalRow.font = { name: 'Arial', size: 10, bold: true };

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * Алгоритм хирургической замены текста в слайде PowerPoint (<a:p> и <a:t>) с сохранением 100% дизайна презентации
 * (макеты слайдов, шрифты <a:rPr>, анимации, фигуры, таблицы и цвета остаются нетронутыми).
 */
async function processPptxSlideXmlContent(
  xmlContent: string,
  slideLabel: string,
  segmentsCollector: DocumentSegment[],
  chunkCounter: { count: number }
): Promise<string> {
  const paragraphRegex = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g;
  let match: RegExpExecArray | null;
  let paragraphIndex = 0;

  const replacements: Array<{ start: number; end: number; newPXml: string }> = [];

  while ((match = paragraphRegex.exec(xmlContent)) !== null) {
    const pXml = match[0];
    const pStart = match.index;
    const pEnd = pStart + pXml.length;

    const atRegex = /(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/g;
    const atNodes: Array<{
      fullMatch: string;
      openTag: string;
      rawText: string;
      decodedText: string;
      closeTag: string;
      startInP: number;
      endInP: number;
    }> = [];

    let atMatch: RegExpExecArray | null;
    while ((atMatch = atRegex.exec(pXml)) !== null) {
      atNodes.push({
        fullMatch: atMatch[0],
        openTag: atMatch[1],
        rawText: atMatch[2],
        decodedText: unescapeXml(atMatch[2]),
        closeTag: atMatch[3],
        startInP: atMatch.index,
        endInP: atMatch.index + atMatch[0].length,
      });
    }

    if (atNodes.length === 0) continue;

    const fullParagraphText = atNodes.map((n) => n.decodedText).join('');
    if (fullParagraphText.trim().length === 0) continue;

    paragraphIndex++;
    const proofread = await proofreadRussianText(fullParagraphText);
    chunkCounter.count += Math.max(1, proofread.totalChunksProcessed);

    segmentsCollector.push({
      id: `pptx-seg-${segmentsCollector.length + 1}`,
      location: `${slideLabel} — Блок #${paragraphIndex}`,
      elementType: 'paragraph',
      originalText: fullParagraphText,
      correctedText: proofread.correctedText,
      preservedFormattingMeta: `Сохранено ${atNodes.length} текстовых узлов (<a:t>) и свойства <a:rPr>`,
      issues: proofread.issues,
      applied: proofread.issues.length > 0,
    });

    if (proofread.issues.length > 0 && proofread.correctedText !== fullParagraphText) {
      let updatedPXml = pXml;
      if (atNodes.length === 1) {
        const node = atNodes[0];
        const newAt = `${node.openTag}${escapeXml(proofread.correctedText)}${node.closeTag}`;
        updatedPXml =
          updatedPXml.slice(0, node.startInP) + newAt + updatedPXml.slice(node.endInP);
      } else {
        let remainingCorrected = proofread.correctedText;
        for (let i = atNodes.length - 1; i >= 0; i--) {
          const node = atNodes[i];
          let sliceForThisNode = '';
          if (i === 0) {
            sliceForThisNode = remainingCorrected;
          } else {
            const origLen = node.decodedText.length;
            const cutIndex = Math.max(0, remainingCorrected.length - origLen);
            sliceForThisNode = remainingCorrected.slice(cutIndex);
            remainingCorrected = remainingCorrected.slice(0, cutIndex);
          }
          const newAt = `${node.openTag}${escapeXml(sliceForThisNode)}${node.closeTag}`;
          updatedPXml =
            updatedPXml.slice(0, node.startInP) + newAt + updatedPXml.slice(node.endInP);
        }
      }

      replacements.push({
        start: pStart,
        end: pEnd,
        newPXml: updatedPXml,
      });
    }
  }

  let finalXml = xmlContent;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const rep = replacements[i];
    finalXml = finalXml.slice(0, rep.start) + rep.newPXml + finalXml.slice(rep.end);
  }

  return finalXml;
}

/**
 * Обрабатывает реальный файл презентации .pptx (PowerPoint) с сохранением всех слайдов, тем, фигур и шрифтов.
 */
export async function processPptxBuffer(
  buffer: Buffer,
  fileName: string
): Promise<DocumentProofreadResult> {
  const startTime = Date.now();
  const zip = await JSZip.loadAsync(buffer);
  const segments: DocumentSegment[] = [];

  const slideXmlPaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
    .sort();

  const chunkCounter = { count: 0 };

  for (const xmlPath of slideXmlPaths) {
    const fileObj = zip.file(xmlPath);
    if (!fileObj) continue;

    const rawXml = await fileObj.async('string');
    const slideNumMatch = xmlPath.match(/slide(\d+)\.xml$/);
    const slideLabel = xmlPath.includes('notesSlide')
      ? `Заметки к слайду #${slideNumMatch ? slideNumMatch[1] : ''}`
      : `Слайд #${slideNumMatch ? slideNumMatch[1] : ''}`;

    const updatedXml = await processPptxSlideXmlContent(rawXml, slideLabel, segments, chunkCounter);
    zip.file(xmlPath, updatedXml);
  }

  const outBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const modifiedSegments = segments.filter((s) => s.issues.length > 0).length;
  const totalIssuesFixed = segments.reduce((acc, s) => acc + s.issues.length, 0);

  return {
    fileName,
    fileType: 'pptx',
    fileSizeBytes: outBuffer.length,
    processingTimeMs: Math.max(14, Date.now() - startTime),
    engineUsed: 'SAGE-FRED-T5-95M-INT8 + PresentationML Chunked Slide-Safe Engine',
    totalSegments: segments.length,
    modifiedSegments,
    totalIssuesFixed,
    totalChunksProcessed: chunkCounter.count,
    chunkMaxCharsUsed: Number(process.env.HARNESS_CHUNK_MAX_CHARS) || 480,
    segments,
    downloadBase64: outBuffer.toString('base64'),
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
}

