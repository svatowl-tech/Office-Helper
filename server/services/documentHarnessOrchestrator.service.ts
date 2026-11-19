import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import {
  DocumentCitation,
  DocumentHarnessAnswer,
  DocumentProofreadResult,
  DocumentQueryIntent,
  DocumentSegment,
  ExtractedEntityItem,
  ExtractedTableView,
} from '../../src/types/harness.types.ts';
import {
  buildTocAndKeyExcerpts,
  buildWorkspaceSnapshot,
  collectRelevantTables,
  extractStructuredEntities,
  getOrCreateDocumentSession,
  mountDiskPathToSession,
  refreshMountedDiskSources,
  searchChunksWithBm25,
  selectActiveSources,
} from './documentHarnessIndex.service.ts';
import { buildDocxFromRecognizedBlocks, RecognizedBlock } from './ocrDocument.service.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_LLM_EVIDENCE_CHARS = 1600;

interface ParsedUserTask {
  intent: DocumentQueryIntent;
  cleanedQuery: string;
  inlineDiskPath?: string;
  fileNameHint?: string;
}

/**
 * Извлекает локальный путь к папке или файлу на диске прямо из текста естественного запроса:
 * - Windows: C:\Договоры\2026 или "D:\Архив\Счёт 12.pdf"
 * - Linux/macOS: /home/user/docs или "/mnt/share/акты 2026"
 */
function extractInlineDiskPath(query: string): { pathFound?: string; remainingQuery: string } {
  // 1. Путь в кавычках (поддерживает пробелы в именах папок и файлов)
  const quotedWin = query.match(/["'«]([A-Za-z]:\\[^"'»]+)["'»]/);
  if (quotedWin) {
    return {
      pathFound: quotedWin[1].trim(),
      remainingQuery: query.replace(quotedWin[0], ' ').replace(/\s+/g, ' ').trim(),
    };
  }
  const quotedPosix = query.match(/["'«](\/[^"'»]{2,})["'»]/);
  if (quotedPosix && !quotedPosix[1].startsWith('/api/')) {
    return {
      pathFound: quotedPosix[1].trim(),
      remainingQuery: query.replace(quotedPosix[0], ' ').replace(/\s+/g, ' ').trim(),
    };
  }

  // 2. Windows-путь без кавычек
  const bareWin = query.match(/([A-Za-z]:\\[^\s,;:!?]+)/);
  if (bareWin) {
    const candidate = bareWin[1].replace(/[.)]+$/, '');
    return {
      pathFound: candidate,
      remainingQuery: query.replace(bareWin[0], ' ').replace(/\s+/g, ' ').trim(),
    };
  }

  // 3. Unix/Linux путь без кавычек (проверяем существование на диске, чтобы не путать с дробями вида 10/20)
  const barePosixMatches = query.match(/(?:^|\s)(\/[^\s,;:!?]{2,})/g) || [];
  for (const rawMatch of barePosixMatches) {
    const candidate = rawMatch.trim().replace(/[.)]+$/, '');
    if (candidate.startsWith('/api/')) continue;
    try {
      if (fs.existsSync(candidate)) {
        return {
          pathFound: candidate,
          remainingQuery: query.replace(candidate, ' ').replace(/\s+/g, ' ').trim(),
        };
      }
    } catch {
      // ignore
    }
  }

  return { remainingQuery: query.trim() };
}

/**
 * Определяет, указал ли пользователь конкретное имя файла внутри запроса («в файле акт.pdf»).
 */
function extractFileNameHint(query: string): string | undefined {
  const extMatch = query.match(
    /([А-ЯЁа-яёA-Za-z0-9_.-]+\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|xodt|xods|rtf|txt|md|csv|png|jpe?g|tiff?))/iu
  );
  if (extMatch) return extMatch[1];

  const phraseMatch = query.match(
    /(?:в\s+файле|в\s+документе)\s+[«"']?([А-ЯЁа-яёA-Za-z0-9_.\s-]{3,40}?)[»"']?(?:\s+(?:найди|покажи|вытащи|извлеки|есть|сколько|что|какие)|[,.;!?]|$)/iu
  );
  return phraseMatch ? phraseMatch[1].trim() : undefined;
}

/**
 * Детерминированный классификатор намерения для мгновенной маршрутизации задач Харнеса.
 */
function classifyIntentDeterministic(query: string): DocumentQueryIntent {
  const q = query.toLowerCase().replace(/ё/g, 'е');

  if (
    /(?<![а-яa-z0-9])(excel|xlsx|эксел|таблиц[уы]\s+в\s+эксел|выгруз[иь]\s+в\s+excel|собери\s+.*в\s+excel|сделай\s+excel|сделай\s+таблицу\s+эксел)/iu.test(
      q
    )
  ) {
    return 'build_xlsx';
  }

  if (
    /(?<![а-яa-z0-9])(word|docx|ворд|собери\s+(?:новый\s+)?документ|сформируй\s+(?:документ|отчет|выписку|справку)|собери\s+.*в\s+word|выгруз[иь]\s+в\s+word)/iu.test(
      q
    )
  ) {
    return 'build_docx';
  }

  if (
    /(?<![а-яa-z0-9])(оглавлен|структур[ауы]|содержан|кратк(?:ую|ая)\s+сводк|сводк[ауи]|о\s+чем\s+(?:этот\s+)?(?:документ|файл)|резюме|саммари|перескаж)/iu.test(
      q
    )
  ) {
    return 'summarize_toc';
  }

  if (
    /(?<![а-яa-z0-9])(реквизит|инн(?![а-яa-z0-9])|кпп(?![а-яa-z0-9])|огрн|бик(?![а-яa-z0-9])|расчетн|все\s+сумм|сумм[ауы]\s+и\s+дат|извлек[иь]\s+(?:все\s+)?(?:сумм|дат|реквизит)|выпиш[иь]\s+(?:все\s+)?(?:сумм|дат|реквизит|номер)|какие\s+(?:сумм|дат|реквизит))/iu.test(
      q
    )
  ) {
    return 'extract_entities';
  }

  if (
    /(?<![а-яa-z0-9])(таблиц[ауы]|покажи\s+(?:все\s+)?таблиц|извлек[иь]\s+таблиц|вытащ[иь]\s+таблиц|все\s+таблиц)/iu.test(
      q
    )
  ) {
    return 'extract_tables';
  }

  return 'search_qa';
}

/**
 * Запрашивает малую локальную LLM (llama-server на 127.0.0.1:8080) для короткого
 * строго ограниченного по токенам задания (≤ 1600 символов контекста).
 * При недоступности локального llama-server мгновенно возвращает null для детерминированного синтеза.
 */
async function callSmallLocalLlm(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 260,
  timeoutMs = 10_000
): Promise<string | null> {
  const baseUrl = (process.env.LOCAL_LLAMA_SERVER_URL || 'http://127.0.0.1:8080').replace(
    /\/+$/,
    ''
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.DEFAULT_MODEL_ID || 'local-small-model',
        temperature: 0.15,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content && content.length >= 12 ? content : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Стадия 1: Разбор запроса пользователя (путь на диске, фильтр по имени файла, тип задачи).
 * При работающей малой локальной LLM уточняет неоднозначное намерение за ≤ 180 токенов.
 */
async function planHarnessTask(rawQuery: string): Promise<ParsedUserTask> {
  const { pathFound, remainingQuery } = extractInlineDiskPath(rawQuery);
  const cleanedQuery = remainingQuery || rawQuery.trim();
  const fileNameHint = extractFileNameHint(cleanedQuery);
  let intent = classifyIntentDeterministic(cleanedQuery);

  // Если намерение не совпало с явными ключевыми словами (fallback search_qa),
  // можно мягко уточнить через локальную малую модель (короткий JSON-промпт <= 160 токенов)
  if (intent === 'search_qa' && cleanedQuery.length >= 10) {
    const llmPlan = await callSmallLocalLlm(
      'Ты роутер команд для Харнеса документов. Верни ТОЛЬКО одно слово из списка: search_qa, extract_entities, extract_tables, summarize_toc, build_docx, build_xlsx.',
      `Запрос пользователя: "${cleanedQuery.slice(0, 220)}"`,
      16,
      3000
    );
    if (llmPlan) {
      const normalized = llmPlan.toLowerCase().replace(/[^a-z_]/g, '');
      const allowed: DocumentQueryIntent[] = [
        'search_qa',
        'extract_entities',
        'extract_tables',
        'summarize_toc',
        'build_docx',
        'build_xlsx',
      ];
      if (allowed.includes(normalized as DocumentQueryIntent)) {
        intent = normalized as DocumentQueryIntent;
      }
    }
  }

  return {
    intent,
    cleanedQuery,
    inlineDiskPath: pathFound,
    fileNameHint,
  };
}

/**
 * Упаковывает проверенные факты Харнеса в жёстко ограниченный микро-контекст (<= 1600 символов),
 * чтобы малая локальная модель не теряла фокус и не галлюцинировала.
 */
function buildCompactEvidencePacket(
  citations: DocumentCitation[],
  entities: ExtractedEntityItem[],
  tables: ExtractedTableView[],
  tocOverview?: Array<{ fileName: string; items: Array<{ title: string; location: string }> }>
): string {
  const parts: string[] = [];
  let used = 0;

  const appendIfFits = (chunk: string) => {
    if (used + chunk.length + 2 > MAX_LLM_EVIDENCE_CHARS) return false;
    parts.push(chunk);
    used += chunk.length + 2;
    return true;
  };

  if (tocOverview && tocOverview.length > 0) {
    for (const doc of tocOverview.slice(0, 3)) {
      const headings = doc.items
        .slice(0, 8)
        .map((i) => `- ${i.title} (${i.location})`)
        .join('\n');
      if (headings) {
        appendIfFits(`Оглавление «${doc.fileName}»:\n${headings}`);
      }
    }
  }

  if (entities.length > 0) {
    const entityLines = entities
      .slice(0, 14)
      .map((e) => `- ${e.label}: ${e.value} [${e.fileName}, ${e.location}]`)
      .join('\n');
    appendIfFits(`Извлечённые реквизиты/суммы/даты:\n${entityLines}`);
  }

  if (tables.length > 0) {
    const tbl = tables[0];
    const header = tbl.headers.join(' | ');
    const rows = tbl.rows
      .slice(0, 4)
      .map((r) => r.join(' | '))
      .join('\n');
    appendIfFits(`Таблица [${tbl.fileName}, ${tbl.location}]:\n${header}\n${rows}`);
  }

  for (const cite of citations.slice(0, 4)) {
    const line = `[${cite.fileName}, ${cite.location}${cite.sectionHeading ? ` · ${cite.sectionHeading}` : ''}]\n${cite.excerpt.slice(0, 340)}`;
    if (!appendIfFits(line)) break;
  }

  return parts.join('\n\n').slice(0, MAX_LLM_EVIDENCE_CHARS);
}

/**
 * Детерминированный человекочитаемый композитор ответа на основе проверенных фактов Харнеса
 * (работает мгновенно и без локального llama-server).
 */
function composeDeterministicAnswer(
  intent: DocumentQueryIntent,
  query: string,
  citations: DocumentCitation[],
  entities: ExtractedEntityItem[],
  tables: ExtractedTableView[],
  tocOverview?: Array<{ fileName: string; items: Array<{ title: string; location: string }> }>,
  sourcesCount = 1,
  generatedFileName?: string
): string {
  const lines: string[] = [];

  if (intent === 'summarize_toc') {
    lines.push(`Подготовлена сводка и структура по документам (${sourcesCount} шт.):`);
    if (tocOverview && tocOverview.length > 0) {
      for (const doc of tocOverview) {
        lines.push(`\n• ${doc.fileName}`);
        if (doc.items.length > 0) {
          for (const item of doc.items.slice(0, 10)) {
            lines.push(`  — ${item.title} (${item.location})`);
          }
          if (doc.items.length > 10) {
            lines.push(`  — … и ещё ${doc.items.length - 10} разделов`);
          }
        } else {
          lines.push('  — Явные заголовки разделов не выделены; текст проиндексирован по страницам.');
        }
      }
    }
    if (entities.length > 0) {
      const amounts = entities.filter((e) => e.kind === 'amount').slice(0, 4);
      const dates = entities.filter((e) => e.kind === 'date').slice(0, 4);
      const refs = entities.filter((e) => e.kind === 'document_ref').slice(0, 3);
      const keyFacts: string[] = [];
      if (refs.length > 0) keyFacts.push(`документы: ${refs.map((r) => r.value).join(', ')}`);
      if (amounts.length > 0) keyFacts.push(`суммы: ${amounts.map((a) => a.value).join(', ')}`);
      if (dates.length > 0) keyFacts.push(`даты: ${dates.map((d) => d.value).join(', ')}`);
      if (keyFacts.length > 0) {
        lines.push(`\nКлючевые факты: ${keyFacts.join('; ')}.`);
      }
    }
    return lines.join('\n').trim();
  }

  if (intent === 'extract_entities') {
    if (entities.length === 0) {
      return `По запросу «${query}» в выбранных документах не обнаружено явных сумм, дат или реквизитов. Попробуйте снять фильтр по файлам или уточнить формулировку.`;
    }
    const groups: Array<{ kind: ExtractedEntityItem['kind']; title: string }> = [
      { kind: 'document_ref', title: 'Номера документов и договоров' },
      { kind: 'amount', title: 'Суммы и стоимостные показатели' },
      { kind: 'date', title: 'Даты и сроки' },
      { kind: 'requisite', title: 'Реквизиты и контакты' },
    ];
    lines.push(`Харнес извлёк ${entities.length} структурированных значений из ${sourcesCount} документов:`);
    for (const g of groups) {
      const subset = entities.filter((e) => e.kind === g.kind);
      if (subset.length === 0) continue;
      lines.push(`\n${g.title} (${subset.length}):`);
      for (const item of subset.slice(0, 8)) {
        lines.push(`• ${item.label}: ${item.value} — ${item.fileName} (${item.location})`);
      }
      if (subset.length > 8) {
        lines.push(`• … и ещё ${subset.length - 8} записей (полный список в таблице ниже и при выгрузке в Excel/Word).`);
      }
    }
    return lines.join('\n').trim();
  }

  if (intent === 'extract_tables') {
    if (tables.length === 0) {
      return 'В выбранных документах не найдено структурированных таблиц. Вы можете выполнить текстовый поиск или запросить извлечение сумм и реквизитов.';
    }
    lines.push(`Найдено таблиц: ${tables.length}. Предпросмотр доступен ниже, полные таблицы можно сразу выгрузить в Excel (.xlsx) или Word (.docx):`);
    for (const tbl of tables.slice(0, 5)) {
      lines.push(
        `• ${tbl.fileName} (${tbl.location}) — колонок: ${tbl.headers.length}, строк: ${tbl.totalRowCount}`
      );
    }
    return lines.join('\n').trim();
  }

  if (intent === 'build_docx' || intent === 'build_xlsx') {
    const fmtLabel = intent === 'build_xlsx' ? 'Excel (.xlsx)' : 'Word (.docx)';
    lines.push(
      `Харнес собрал новый файл ${fmtLabel}${generatedFileName ? ` «${generatedFileName}»` : ''} по запросу «${query}».`
    );
    lines.push(
      `Включено: фрагментов текста — ${citations.length}, извлечённых реквизитов/сумм/дат — ${entities.length}, таблиц — ${tables.length}.`
    );
    lines.push('Файл доступен для скачивания и дальнейшей передачи в инструменты «Исправить язык» или «Деловой стиль».');
    return lines.join('\n');
  }

  // search_qa
  if (citations.length === 0) {
    return `По запросу «${query}» точных совпадений в выбранных документах не найдено. Попробуйте указать ключевое слово, номер договора/счёта или снять ограничение по файлам.`;
  }

  lines.push(`По запросу «${query}» найдено ${citations.length} релевантных фрагментов:`);
  for (const cite of citations.slice(0, 4)) {
    const loc = cite.sectionHeading ? `${cite.location}, ${cite.sectionHeading}` : cite.location;
    lines.push(`\n• [${cite.fileName} · ${loc}]\n  ${cite.excerpt}`);
  }
  return lines.join('\n').trim();
}

/**
 * Собирает готовый Word (.docx) или Excel (.xlsx) документ из результатов работы Харнеса.
 */
export async function buildOfficeDocumentFromHarnessResult(params: {
  format: 'docx' | 'xlsx';
  title: string;
  answerText: string;
  citations: DocumentCitation[];
  entities: ExtractedEntityItem[];
  tables: ExtractedTableView[];
}): Promise<DocumentProofreadResult> {
  const startTime = Date.now();
  const safeBase =
    params.title
      .replace(/[^\p{L}\p{N}_ -]+/gu, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 48) || 'Выборка_документов';

  if (params.format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Офисный Помощник — Харнес документов';
    workbook.created = new Date();

    // Лист 1: Сводка и найденные фрагменты
    const summarySheet = workbook.addWorksheet('Сводка и цитаты');
    summarySheet.addRow(['Запрос / тема', params.title]).font = { bold: true };
    summarySheet.addRow(['Ответ Харнеса', params.answerText]);
    summarySheet.addRow([]);

    if (params.citations.length > 0) {
      const hdr = summarySheet.addRow(['Файл', 'Страница / Раздел', 'Цитата']);
      hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hdr.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
      });
      for (const c of params.citations) {
        const row = summarySheet.addRow([
          c.fileName,
          c.sectionHeading ? `${c.location} · ${c.sectionHeading}` : c.location,
          c.excerpt,
        ]);
        row.alignment = { wrapText: true, vertical: 'top' };
      }
    }
    summarySheet.getColumn(1).width = 28;
    summarySheet.getColumn(2).width = 28;
    summarySheet.getColumn(3).width = 72;

    // Лист 2: Извлечённые суммы, даты и реквизиты
    if (params.entities.length > 0) {
      const entSheet = workbook.addWorksheet('Суммы и реквизиты');
      const hdr = entSheet.addRow(['Тип', 'Значение', 'Файл', 'Расположение', 'Контекст']);
      hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hdr.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF004ECC' } };
      });
      for (const e of params.entities) {
        const row = entSheet.addRow([e.label, e.value, e.fileName, e.location, e.context]);
        row.alignment = { wrapText: true, vertical: 'top' };
      }
      entSheet.getColumn(1).width = 18;
      entSheet.getColumn(2).width = 26;
      entSheet.getColumn(3).width = 28;
      entSheet.getColumn(4).width = 18;
      entSheet.getColumn(5).width = 56;
    }

    // Листы 3+: Извлечённые таблицы
    params.tables.slice(0, 6).forEach((tbl, idx) => {
      const sheetName = `Таблица_${idx + 1}`.slice(0, 31);
      const tSheet = workbook.addWorksheet(sheetName);
      tSheet.addRow([`${tbl.fileName} (${tbl.location})`]).font = { bold: true };
      tSheet.addRow([]);
      if (tbl.headers.length > 0) {
        const hRow = tSheet.addRow(tbl.headers);
        hRow.font = { bold: true };
      }
      for (const r of tbl.rows) {
        tSheet.addRow(r);
      }
      const colCount = Math.max(tbl.headers.length, 3);
      for (let c = 1; c <= colCount; c++) {
        tSheet.getColumn(c).width = 22;
      }
    });

    const outBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const outFileName = `Сборка_${safeBase}.xlsx`;

    return {
      fileName: outFileName,
      fileType: 'xlsx',
      fileSizeBytes: outBuffer.length,
      processingTimeMs: Math.max(10, Date.now() - startTime),
      engineUsed: 'Алгоритмический Харнес документов → Excel (.xlsx)',
      totalSegments: Math.max(1, params.citations.length + params.entities.length + params.tables.length),
      modifiedSegments: 1,
      totalIssuesFixed: params.entities.length + params.tables.length,
      totalChunksProcessed: Math.max(1, params.citations.length),
      segments: [],
      downloadBase64: outBuffer.toString('base64'),
      mimeType: XLSX_MIME,
      operationMode: 'document_work',
    };
  }

  // Сборка Word (.docx) через проверенный генератор блоков
  const blocks: RecognizedBlock[] = [
    { type: 'heading', text: `Аналитическая выборка: ${params.title}` },
  ];

  for (const para of params.answerText.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
    blocks.push({ type: 'paragraph', text: para });
  }

  if (params.entities.length > 0) {
    blocks.push({ type: 'heading', text: 'Извлечённые суммы, даты и реквизиты' });
    blocks.push({
      type: 'table',
      rows: [
        ['Тип', 'Значение', 'Источник', 'Расположение'],
        ...params.entities.slice(0, 50).map((e) => [e.label, e.value, e.fileName, e.location]),
      ],
    });
  }

  for (const tbl of params.tables.slice(0, 4)) {
    blocks.push({ type: 'heading', text: `Таблица — ${tbl.fileName} (${tbl.location})` });
    blocks.push({
      type: 'table',
      rows: [tbl.headers, ...tbl.rows.slice(0, 40)],
    });
  }

  if (params.citations.length > 0) {
    blocks.push({ type: 'heading', text: 'Источники и точные цитаты' });
    for (const cite of params.citations) {
      blocks.push({
        type: 'paragraph',
        text: `[${cite.fileName} · ${cite.location}${cite.sectionHeading ? ` · ${cite.sectionHeading}` : ''}] ${cite.excerpt}`,
      });
    }
  }

  const docxBuffer = await buildDocxFromRecognizedBlocks(blocks);
  const outFileName = `Сборка_${safeBase}.docx`;
  const segments: DocumentSegment[] = params.citations.map((c, idx) => ({
    id: `docwork-seg-${idx + 1}`,
    location: `${c.fileName} (${c.location})`,
    elementType: 'paragraph',
    originalText: c.excerpt,
    correctedText: c.excerpt,
    preservedFormattingMeta: 'Сборка Харнеса документов → Word (.docx)',
    issues: [],
    applied: false,
  }));

  return {
    fileName: outFileName,
    fileType: 'docx',
    fileSizeBytes: docxBuffer.length,
    processingTimeMs: Math.max(10, Date.now() - startTime),
    engineUsed: 'Алгоритмический Харнес документов → Word (.docx)',
    totalSegments: Math.max(1, blocks.length),
    modifiedSegments: 1,
    totalIssuesFixed: params.citations.length + params.entities.length,
    totalChunksProcessed: Math.max(1, params.citations.length),
    segments,
    downloadBase64: docxBuffer.toString('base64'),
    mimeType: DOCX_MIME,
    operationMode: 'document_work',
  };
}

/**
 * Главный 3-этапный конвейер модуля [ 05 ] «Работа с документом»:
 * 1) Разбор задачи и автоматическое подключение пути на диске (если указан в тексте запроса)
 * 2) Исполнение алгоритмических инструментов Харнеса (BM25-поиск, извлечение сумм/дат/реквизитов/таблиц, оглавление, сборка Word/Excel)
 * 3) Синтез человекочитаемого ответа малой локальной моделью по микро-пакету фактов (<= 1600 симв.) или детерминированным композитором.
 */
export async function executeDocumentHarnessQuery(params: {
  sessionId: string;
  query: string;
  selectedSourceIds?: string[];
}): Promise<DocumentHarnessAnswer> {
  const startTime = Date.now();
  const rawQuery = (params.query || '').trim();
  if (!rawQuery) {
    throw new Error('Введите вопрос или команду для работы с документами.');
  }

  const session = getOrCreateDocumentSession(params.sessionId);
  const harnessSteps: string[] = [];

  // Этап 1: планирование задачи и авто-подключение пути на диске из текста запроса
  const task = await planHarnessTask(rawQuery);
  let autoMountedPath: string | undefined;

  if (task.inlineDiskPath) {
    const mountRes = await mountDiskPathToSession(params.sessionId, task.inlineDiskPath);
    autoMountedPath = mountRes.resolvedPath;
    harnessSteps.push(
      `Подключено напрямую с диска без копирования: ${mountRes.resolvedPath} (новых файлов: ${mountRes.indexedCount})`
    );
  } else {
    const refreshed = await refreshMountedDiskSources(session);
    if (refreshed > 0) {
      harnessSteps.push(`Обновлено изменённых файлов на диске: ${refreshed}`);
    }
  }

  const activeSources = selectActiveSources(session, params.selectedSourceIds, task.fileNameHint);
  if (activeSources.length === 0) {
    throw new Error(
      'Нет подключённых документов. Загрузите файл в текущую сессию, укажите путь к папке/файлу на диске слева или напишите путь прямо в запросе.'
    );
  }

  const totalChunksScanned = activeSources.reduce((acc, s) => acc + s.chunks.length, 0);
  harnessSteps.push(
    `Проанализировано документов: ${activeSources.length} (фрагментов в индексе: ${totalChunksScanned})`
  );

  // Этап 2: алгоритмическое исполнение инструментов Харнеса
  let citations: DocumentCitation[] = [];
  let entities: ExtractedEntityItem[] = [];
  let tables: ExtractedTableView[] = [];
  let tocOverview: Array<{ fileName: string; items: Array<{ id: string; title: string; location: string; pageNumber?: number; level: number; chunkIndex: number }> }> | undefined;
  let generatedDocument: DocumentProofreadResult | undefined;

  if (task.intent === 'summarize_toc') {
    const tocBundle = buildTocAndKeyExcerpts(activeSources);
    tocOverview = tocBundle.tocOverview;
    citations = tocBundle.keyCitations;
    entities = extractStructuredEntities(activeSources, undefined, 24);
    harnessSteps.push('Сформировано оглавление и ключевые выдержки без загрузки файлов целиком в LLM');
  } else if (task.intent === 'extract_entities') {
    entities = extractStructuredEntities(activeSources, task.cleanedQuery, 80);
    citations = searchChunksWithBm25(activeSources, task.cleanedQuery, 4);
    harnessSteps.push(`Алгоритмически извлечено значений (суммы/даты/реквизиты): ${entities.length}`);
  } else if (task.intent === 'extract_tables') {
    tables = collectRelevantTables(activeSources, task.cleanedQuery, 10, 30);
    citations = searchChunksWithBm25(activeSources, task.cleanedQuery, 3);
    harnessSteps.push(`Отобрано структурированных таблиц: ${tables.length}`);
  } else if (task.intent === 'build_docx' || task.intent === 'build_xlsx') {
    citations = searchChunksWithBm25(activeSources, task.cleanedQuery, 8);
    entities = extractStructuredEntities(activeSources, task.cleanedQuery, 50);
    tables = collectRelevantTables(activeSources, task.cleanedQuery, 6, 40);
    harnessSteps.push(
      `Собраны материалы для выгрузки: цитат ${citations.length}, реквизитов/сумм ${entities.length}, таблиц ${tables.length}`
    );
  } else {
    citations = searchChunksWithBm25(activeSources, task.cleanedQuery, 6);
    entities = extractStructuredEntities(activeSources, task.cleanedQuery, 16);
    tables = collectRelevantTables(activeSources, task.cleanedQuery, 3, 15);
    harnessSteps.push(`Поиск BM25 отобрал ${citations.length} наиболее точных фрагментов со ссылками`);
  }

  // Этап 3: Синтез структурированного человекочитаемого ответа по жёстко ограниченному пакету фактов
  let engineUsed = 'Алгоритмический Харнес документов (детерминированный синтез)';
  let answerText = '';

  const evidencePacket = buildCompactEvidencePacket(citations, entities, tables, tocOverview);
  if (evidencePacket.length > 0 && task.intent !== 'build_docx' && task.intent !== 'build_xlsx') {
    const llmSynthesis = await callSmallLocalLlm(
      'Ты аккуратный помощник по документам. Отвечай строго на русском языке, кратко и структурированно, ТОЛЬКО по приведённым фактам Харнеса. Обязательно указывай файл и страницу в квадратных скобках. Никогда не выдумывай цифры и факты.',
      `Запрос: ${task.cleanedQuery}\n\nПроверенные фрагменты Харнеса:\n${evidencePacket}`,
      320,
      12_000
    );
    if (llmSynthesis) {
      answerText = llmSynthesis;
      engineUsed = 'Харнес (BM25 + экстракторы) → локальная LLM (микро-контекст)';
      harnessSteps.push(
        `Передан компактный пакет фактов (${evidencePacket.length} симв.) в локальную LLM для формулировки ответа`
      );
    }
  }

  if (!answerText) {
    answerText = composeDeterministicAnswer(
      task.intent,
      task.cleanedQuery,
      citations,
      entities,
      tables,
      tocOverview,
      activeSources.length
    );
  }

  if (task.intent === 'build_docx' || task.intent === 'build_xlsx') {
    const outFmt = task.intent === 'build_xlsx' ? 'xlsx' : 'docx';
    generatedDocument = await buildOfficeDocumentFromHarnessResult({
      format: outFmt,
      title: task.cleanedQuery,
      answerText,
      citations,
      entities,
      tables,
    });
    answerText = composeDeterministicAnswer(
      task.intent,
      task.cleanedQuery,
      citations,
      entities,
      tables,
      tocOverview,
      activeSources.length,
      generatedDocument.fileName
    );
    harnessSteps.push(`Сформирован готовый файл ${generatedDocument.fileName}`);
  }

  return {
    id: `ans_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    query: rawQuery,
    intent: task.intent,
    answerText,
    citations,
    entities,
    tables,
    tocOverview,
    harnessSteps,
    engineUsed,
    processingTimeMs: Math.max(10, Date.now() - startTime),
    generatedDocument,
    autoMountedPath,
    workspaceSnapshot: buildWorkspaceSnapshot(session),
  };
}
