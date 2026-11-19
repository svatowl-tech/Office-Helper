import fs from 'fs';
import path from 'path';
import {
  DocumentCitation,
  DocumentSourceSummary,
  DocumentTocItem,
  DocumentWorkspaceSnapshot,
  ExtractedEntityItem,
  ExtractedTableView,
} from '../../src/types/harness.types.ts';
import {
  isSupportedDocumentWorkFile,
  parseDocumentToStructuredIndex,
} from './documentParser.service.ts';

export interface IndexedChunk {
  chunkId: string;
  sourceId: string;
  fileName: string;
  location: string;
  pageNumber?: number;
  sectionHeading?: string;
  text: string;
  stems: string[];
  termFreq: Map<string, number>;
}

export interface IndexedTable {
  sourceId: string;
  fileName: string;
  location: string;
  headers: string[];
  rows: string[][];
}

export interface IndexedSourceRecord {
  summary: DocumentSourceSummary;
  mtimeMs?: number;
  chunks: IndexedChunk[];
  tables: IndexedTable[];
}

export interface DocumentWorkspaceSession {
  sessionId: string;
  lastTouchedAt: number;
  sources: Map<string, IndexedSourceRecord>;
  diskMounts: Set<string>;
}

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа неактивности
const MAX_DISK_FILES_PER_MOUNT = 200;
const MAX_DISK_WALK_DEPTH = 5;
const MAX_SINGLE_DISK_FILE_BYTES = 80 * 1024 * 1024; // 80 MB защита от бинарных архивов

const IGNORED_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'dist-server',
  'build',
  '$RECYCLE.BIN',
  'System Volume Information',
  '__pycache__',
  '.Trash',
]);

const RUSSIAN_STOP_WORDS = new Set<string>([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она',
  'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее',
  'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда',
  'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до',
  'вас', 'нибудь', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
  'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем',
  'была', 'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже', 'себе', 'под', 'будет',
  'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой', 'совсем', 'ним', 'здесь',
  'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее', 'сейчас', 'были', 'куда', 'зачем',
  'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после',
  'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая', 'много',
  'разве', 'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою', 'этой', 'перед', 'иногда',
  'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'конечно', 'всю',
  'между', 'найди', 'найти', 'покажи', 'показать', 'скажи', 'расскажи', 'укажи', 'выпиши',
  'вытащи', 'пожалуйста', 'документ', 'документе', 'документах', 'файле', 'файлах', 'папке',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were',
]);

const sessionStore = new Map<string, DocumentWorkspaceSession>();

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessionStore.entries()) {
    if (now - session.lastTouchedAt > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}

export function getOrCreateDocumentSession(sessionId: string): DocumentWorkspaceSession {
  cleanupExpiredSessions();
  const cleanId = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  let session = sessionStore.get(cleanId);
  if (!session) {
    session = {
      sessionId: cleanId,
      lastTouchedAt: Date.now(),
      sources: new Map(),
      diskMounts: new Set(),
    };
    sessionStore.set(cleanId, session);
  } else {
    session.lastTouchedAt = Date.now();
  }
  return session;
}

export function buildWorkspaceSnapshot(session: DocumentWorkspaceSession): DocumentWorkspaceSnapshot {
  const sources = Array.from(session.sources.values()).map((r) => r.summary);
  let totalChunks = 0;
  let totalTables = 0;
  let totalPagesOrSheets = 0;
  for (const s of sources) {
    totalChunks += s.chunksCount;
    totalTables += s.tablesCount;
    totalPagesOrSheets += s.pagesOrSheets;
  }
  return {
    sessionId: session.sessionId,
    sources,
    diskMounts: Array.from(session.diskMounts),
    totalChunks,
    totalTables,
    totalPagesOrSheets,
  };
}

/**
 * Компактный детерминированный стеммер для русского и английского языка.
 * Позволяет находить словоформы («договора / договору / договором» -> «договор», «оплаты / оплату» -> «оплат»).
 */
export function stemWord(rawWord: string): string {
  const w = rawWord.toLowerCase().replace(/ё/g, 'е').trim();
  if (w.length <= 3) return w;

  // Русские окончания (от длинных к коротким)
  if (/^[а-я]+$/u.test(w)) {
    const stripped = w.replace(
      /(?:иями|ями|ами|иях|ией|ием|его|ого|ему|ому|ыми|ими|овать|евать|аться|яться|ение|ание|ости|ость|иями|иях|ию|ия|ие|ий|ый|ой|ая|яя|ое|ее|ые|ие|ом|ем|ам|ям|ах|ях|ов|ев|ей|ую|юю|ть|ти|ся|сь|ла|ло|ли|ет|ут|ют|ит|ат|ят|а|я|о|е|у|ю|ы|и|ь)$/u,
      ''
    );
    return stripped.length >= 3 ? stripped : w.slice(0, 4);
  }

  // Английские суффиксы
  if (/^[a-z]+$/i.test(w)) {
    const stripped = w.replace(/(?:tions|tion|ings|ing|ment|ness|able|ible|ies|ied|ed|es|s)$/i, '');
    return stripped.length >= 3 ? stripped : w;
  }

  return w;
}

export function tokenizeAndStem(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/[а-яa-z0-9№]{2,}/giu);
  if (!rawTokens) return [];

  const result: string[] = [];
  for (const token of rawTokens) {
    if (RUSSIAN_STOP_WORDS.has(token)) continue;
    const stemmed = stemWord(token);
    if (stemmed.length >= 2) {
      result.push(stemmed);
    }
  }
  return result;
}

function buildIndexedRecord(
  sourceId: string,
  parsed: Awaited<ReturnType<typeof parseDocumentToStructuredIndex>>,
  meta: {
    origin: DocumentSourceSummary['origin'];
    sizeBytes: number;
    diskPath?: string;
    relativePath?: string;
    mtimeMs?: number;
  }
): IndexedSourceRecord {
  const chunks: IndexedChunk[] = parsed.chunks.map((c, idx) => {
    const stems = tokenizeAndStem(`${c.sectionHeading || ''} ${c.text}`);
    const termFreq = new Map<string, number>();
    for (const s of stems) {
      termFreq.set(s, (termFreq.get(s) || 0) + 1);
    }
    return {
      chunkId: `${sourceId}-c-${idx + 1}`,
      sourceId,
      fileName: parsed.fileName,
      location: c.location,
      pageNumber: c.pageNumber,
      sectionHeading: c.sectionHeading,
      text: c.text,
      stems,
      termFreq,
    };
  });

  const tables: IndexedTable[] = parsed.tables.map((t) => ({
    sourceId,
    fileName: parsed.fileName,
    location: t.location,
    headers: t.headers,
    rows: t.rows,
  }));

  const summary: DocumentSourceSummary = {
    id: sourceId,
    fileName: parsed.fileName,
    origin: meta.origin,
    diskPath: meta.diskPath,
    relativePath: meta.relativePath,
    extension: parsed.extension.replace('.', '').toUpperCase() || 'FILE',
    sizeBytes: meta.sizeBytes,
    pagesOrSheets: parsed.pagesOrSheets,
    chunksCount: chunks.length,
    tablesCount: tables.length,
    usedOcr: parsed.usedOcr,
    toc: parsed.toc,
    indexedAt: new Date().toISOString(),
  };

  return {
    summary,
    mtimeMs: meta.mtimeMs,
    chunks,
    tables,
  };
}

/**
 * Добавляет загруженный в рамках текущей сессии файл в индекс (в RAM, без копирования на диск).
 */
export async function addUploadedFileToSession(
  sessionId: string,
  buffer: Buffer,
  fileName: string
): Promise<DocumentSourceSummary> {
  const session = getOrCreateDocumentSession(sessionId);
  if (!isSupportedDocumentWorkFile(fileName)) {
    throw new Error(
      `Файл «${fileName}» не поддерживается. Поддерживаются PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, XODT, XODS, RTF, TXT, MD, CSV и сканы изображений.`
    );
  }

  const parsed = await parseDocumentToStructuredIndex(buffer, fileName);
  const sourceId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = buildIndexedRecord(sourceId, parsed, {
    origin: 'session_upload',
    sizeBytes: buffer.length,
  });

  session.sources.set(sourceId, record);
  session.lastTouchedAt = Date.now();
  return record.summary;
}

function collectSupportedFilesFromDirectory(
  rootDir: string,
  currentDir: string,
  depth: number,
  collected: Array<{ fullPath: string; relativePath: string }>
): void {
  if (depth > MAX_DISK_WALK_DEPTH || collected.length >= MAX_DISK_FILES_PER_MOUNT) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (collected.length >= MAX_DISK_FILES_PER_MOUNT) break;
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectSupportedFilesFromDirectory(rootDir, fullPath, depth + 1, collected);
    } else if (entry.isFile() && isSupportedDocumentWorkFile(entry.name)) {
      collected.push({
        fullPath,
        relativePath: path.relative(rootDir, fullPath),
      });
    }
  }
}

function normalizeUserDiskPath(rawInput: string): string {
  const trimmed = rawInput.trim().replace(/^["'«]+|["'»]+$/g, '').trim();
  if (!trimmed) {
    throw new Error('Укажите путь к папке или файлу на диске.');
  }
  return path.resolve(trimmed);
}

/**
 * Подключает локальную папку или конкретный файл напрямую с диска в режиме чтения (без копирования файлов).
 * При повторном вызове переиндексирует только изменившиеся по mtime файлы.
 */
export async function mountDiskPathToSession(
  sessionId: string,
  rawDiskPath: string
): Promise<{
  resolvedPath: string;
  indexedCount: number;
  skippedCount: number;
  snapshot: DocumentWorkspaceSnapshot;
}> {
  const session = getOrCreateDocumentSession(sessionId);
  const resolvedPath = normalizeUserDiskPath(rawDiskPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Путь не найден на диске: ${resolvedPath}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new Error(`Нет доступа на чтение к пути: ${resolvedPath}`);
  }

  let indexedCount = 0;
  let skippedCount = 0;

  if (stat.isFile()) {
    const fileName = path.basename(resolvedPath);
    if (!isSupportedDocumentWorkFile(fileName)) {
      throw new Error(
        `Файл «${fileName}» имеет неподдерживаемый формат. Поддерживаются PDF, Word, Excel, PowerPoint, LibreOffice/МойОфис, RTF, TXT и сканы.`
      );
    }
    if (stat.size > MAX_SINGLE_DISK_FILE_BYTES) {
      throw new Error(`Файл «${fileName}» превышает лимит 80 МБ для прямой индексации.`);
    }

    const existing = Array.from(session.sources.values()).find(
      (s) => s.summary.diskPath === resolvedPath
    );
    if (existing && existing.mtimeMs === stat.mtimeMs && existing.summary.sizeBytes === stat.size) {
      session.diskMounts.add(resolvedPath);
      return {
        resolvedPath,
        indexedCount: 0,
        skippedCount: 0,
        snapshot: buildWorkspaceSnapshot(session),
      };
    }

    const buffer = fs.readFileSync(resolvedPath);
    const parsed = await parseDocumentToStructuredIndex(buffer, fileName);
    const sourceId = existing?.summary.id || `disk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const record = buildIndexedRecord(sourceId, parsed, {
      origin: 'disk_file',
      sizeBytes: stat.size,
      diskPath: resolvedPath,
      relativePath: fileName,
      mtimeMs: stat.mtimeMs,
    });
    session.sources.set(sourceId, record);
    session.diskMounts.add(resolvedPath);
    indexedCount = 1;
  } else if (stat.isDirectory()) {
    const discovered: Array<{ fullPath: string; relativePath: string }> = [];
    collectSupportedFilesFromDirectory(resolvedPath, resolvedPath, 0, discovered);

    if (discovered.length === 0) {
      throw new Error(
        `В папке «${resolvedPath}» не найдено поддерживаемых документов (PDF, DOCX, XLSX, ODT, RTF, TXT).`
      );
    }

    const existingByPath = new Map<string, IndexedSourceRecord>();
    for (const rec of session.sources.values()) {
      if (rec.summary.diskPath) {
        existingByPath.set(rec.summary.diskPath, rec);
      }
    }

    for (const item of discovered) {
      try {
        const fStat = fs.statSync(item.fullPath);
        if (fStat.size === 0 || fStat.size > MAX_SINGLE_DISK_FILE_BYTES) {
          skippedCount++;
          continue;
        }
        const prev = existingByPath.get(item.fullPath);
        if (prev && prev.mtimeMs === fStat.mtimeMs && prev.summary.sizeBytes === fStat.size) {
          continue;
        }
        const buffer = fs.readFileSync(item.fullPath);
        const fileName = path.basename(item.fullPath);
        const parsed = await parseDocumentToStructuredIndex(buffer, fileName);
        const sourceId = prev?.summary.id || `disk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const record = buildIndexedRecord(sourceId, parsed, {
          origin: 'disk_folder',
          sizeBytes: fStat.size,
          diskPath: item.fullPath,
          relativePath: item.relativePath,
          mtimeMs: fStat.mtimeMs,
        });
        session.sources.set(sourceId, record);
        indexedCount++;
      } catch (err) {
        console.debug(`Пропущен файл при прямой индексации ${item.fullPath}:`, err);
        skippedCount++;
      }
    }

    session.diskMounts.add(resolvedPath);
  } else {
    throw new Error(`Указанный путь не является файлом или папкой: ${resolvedPath}`);
  }

  session.lastTouchedAt = Date.now();
  return {
    resolvedPath,
    indexedCount,
    skippedCount,
    snapshot: buildWorkspaceSnapshot(session),
  };
}

/**
 * Проверяет актуальность подключённых файлов с диска перед запросом:
 * переиндексирует только изменившиеся файлы и удаляет исчезнувшие с диска.
 */
export async function refreshMountedDiskSources(
  session: DocumentWorkspaceSession
): Promise<number> {
  let refreshed = 0;
  for (const [sourceId, rec] of Array.from(session.sources.entries())) {
    if (!rec.summary.diskPath) continue;
    if (!fs.existsSync(rec.summary.diskPath)) {
      session.sources.delete(sourceId);
      continue;
    }
    try {
      const stat = fs.statSync(rec.summary.diskPath);
      if (stat.mtimeMs !== rec.mtimeMs || stat.size !== rec.summary.sizeBytes) {
        const buf = fs.readFileSync(rec.summary.diskPath);
        const parsed = await parseDocumentToStructuredIndex(buf, rec.summary.fileName);
        const updated = buildIndexedRecord(sourceId, parsed, {
          origin: rec.summary.origin,
          sizeBytes: stat.size,
          diskPath: rec.summary.diskPath,
          relativePath: rec.summary.relativePath,
          mtimeMs: stat.mtimeMs,
        });
        session.sources.set(sourceId, updated);
        refreshed++;
      }
    } catch {
      // ignore transient lock error
    }
  }
  return refreshed;
}

export function removeSourceOrClearSession(
  sessionId: string,
  sourceId?: string
): DocumentWorkspaceSnapshot {
  const session = getOrCreateDocumentSession(sessionId);
  if (!sourceId) {
    session.sources.clear();
    session.diskMounts.clear();
  } else {
    const removed = session.sources.get(sourceId);
    session.sources.delete(sourceId);
    if (removed?.summary.diskPath) {
      // Удаляем точку монтирования, если от неё не осталось файлов
      for (const mount of Array.from(session.diskMounts)) {
        const stillUsed = Array.from(session.sources.values()).some(
          (s) => s.summary.diskPath && (s.summary.diskPath === mount || s.summary.diskPath.startsWith(mount + path.sep))
        );
        if (!stillUsed) session.diskMounts.delete(mount);
      }
    }
  }
  session.lastTouchedAt = Date.now();
  return buildWorkspaceSnapshot(session);
}

/**
 * Отбирает источники, участвующие в текущем запросе (учитывает чекбоксы пользователя и фильтр по имени файла).
 */
export function selectActiveSources(
  session: DocumentWorkspaceSession,
  selectedSourceIds?: string[],
  fileNameHint?: string
): IndexedSourceRecord[] {
  let pool = Array.from(session.sources.values());

  if (selectedSourceIds && selectedSourceIds.length > 0) {
    const idSet = new Set(selectedSourceIds);
    const filtered = pool.filter((s) => idSet.has(s.summary.id));
    if (filtered.length > 0) pool = filtered;
  }

  if (fileNameHint && fileNameHint.trim().length > 0) {
    const needle = fileNameHint.toLowerCase().trim();
    const byName = pool.filter(
      (s) =>
        s.summary.fileName.toLowerCase().includes(needle) ||
        (s.summary.relativePath && s.summary.relativePath.toLowerCase().includes(needle))
    );
    if (byName.length > 0) pool = byName;
  }

  return pool;
}

/**
 * Алгоритмический поиск BM25 + точное совпадение фраз и чисел по всем фрагментам выбранных документов.
 */
export function searchChunksWithBm25(
  sources: IndexedSourceRecord[],
  query: string,
  topK = 6
): DocumentCitation[] {
  const allChunks: IndexedChunk[] = [];
  for (const s of sources) {
    allChunks.push(...s.chunks);
  }
  if (allChunks.length === 0) return [];

  const queryStems = tokenizeAndStem(query);
  const queryNumbers = query.match(/\d[\d.,/-]{2,}/g) || [];
  const lowerQuery = query.toLowerCase().replace(/ё/g, 'е').trim();

  if (queryStems.length === 0 && queryNumbers.length === 0) {
    return allChunks.slice(0, topK).map((chunk) => ({
      sourceId: chunk.sourceId,
      fileName: chunk.fileName,
      location: chunk.location,
      sectionHeading: chunk.sectionHeading,
      excerpt: chunk.text.slice(0, 420),
      score: 1,
    }));
  }

  const N = allChunks.length;
  let totalLen = 0;
  const docFreq = new Map<string, number>();

  for (const chunk of allChunks) {
    totalLen += chunk.stems.length;
    for (const term of chunk.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }
  const avgDl = Math.max(1, totalLen / N);
  const k1 = 1.5;
  const b = 0.75;

  const uniqueQueryStems = Array.from(new Set(queryStems));
  const scored: Array<{ chunk: IndexedChunk; score: number }> = [];

  for (const chunk of allChunks) {
    let score = 0;
    const dl = Math.max(1, chunk.stems.length);

    for (const qStem of uniqueQueryStems) {
      const tf = chunk.termFreq.get(qStem) || 0;
      if (tf === 0) continue;
      const df = docFreq.get(qStem) || 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl))));
    }

    const lowerChunk = chunk.text.toLowerCase().replace(/ё/g, 'е');
    // Буст за точное совпадение чисел/номеров договоров/ИНН
    for (const num of queryNumbers) {
      if (lowerChunk.includes(num)) {
        score += 4.5;
      }
    }
    // Буст за совпадение в заголовке раздела
    if (chunk.sectionHeading) {
      const lowerHeading = chunk.sectionHeading.toLowerCase().replace(/ё/g, 'е');
      for (const qStem of uniqueQueryStems) {
        if (lowerHeading.includes(qStem)) {
          score += 1.8;
        }
      }
    }
    // Буст за точное совпадение длинной фразы
    if (lowerQuery.length >= 6 && lowerChunk.includes(lowerQuery)) {
      score += 5.0;
    }

    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, bItem) => bItem.score - a.score);

  return scored.slice(0, topK).map(({ chunk, score }) => ({
    sourceId: chunk.sourceId,
    fileName: chunk.fileName,
    location: chunk.location,
    sectionHeading: chunk.sectionHeading,
    excerpt: buildFocusedExcerpt(chunk.text, uniqueQueryStems, queryNumbers, 420),
    score: Number(score.toFixed(2)),
  }));
}

function buildFocusedExcerpt(
  text: string,
  stems: string[],
  numbers: string[],
  maxLen: number
): string {
  if (text.length <= maxLen) return text;
  const lower = text.toLowerCase().replace(/ё/g, 'е');

  let bestPos = -1;
  for (const num of numbers) {
    const idx = lower.indexOf(num);
    if (idx !== -1) {
      bestPos = idx;
      break;
    }
  }
  if (bestPos === -1) {
    for (const st of stems) {
      const idx = lower.indexOf(st);
      if (idx !== -1) {
        bestPos = idx;
        break;
      }
    }
  }

  if (bestPos === -1 || bestPos < Math.floor(maxLen * 0.4)) {
    return `${text.slice(0, maxLen).trim()}…`;
  }

  const start = Math.max(0, bestPos - Math.floor(maxLen * 0.3));
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function getSurroundingContext(text: string, matchIndex: number, matchLen: number): string {
  const start = Math.max(0, matchIndex - 55);
  const end = Math.min(text.length, matchIndex + matchLen + 65);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Детерминированный алгоритмический извлекатель сумм, дат, реквизитов (ИНН/КПП/ОГРН/БИК/р/с)
 * и номеров документов по всем выбранным файлам. 100% точность цифр без риска галлюцинаций LLM.
 */
export function extractStructuredEntities(
  sources: IndexedSourceRecord[],
  filterQuery?: string,
  maxItems = 80
): ExtractedEntityItem[] {
  const results: ExtractedEntityItem[] = [];
  const seen = new Set<string>();

  const qLower = (filterQuery || '').toLowerCase();
  const wantsOnlyAmounts =
    /(?<![а-яёa-z0-9])(сумм|итого|стоимост|цен[ауы]|оплат|руб|денег|бюджет)/iu.test(qLower) &&
    !/(?<![а-яёa-z0-9])(дат|реквизит|инн|кпп|огрн|бик|сч[её]т\s*№|номер)/iu.test(qLower);
  const wantsOnlyDates =
    /(?<![а-яёa-z0-9])(дат[ауы]|срок[иа]?|когда|период)/iu.test(qLower) &&
    !/(?<![а-яёa-z0-9])(сумм|реквизит|инн|кпп|стоимост)/iu.test(qLower);
  const wantsOnlyRequisites =
    /(?<![а-яёa-z0-9])(реквизит|инн|кпп|огрн|бик|расч[её]тн|банк|контакт|телефон|почт)/iu.test(qLower) &&
    !/(?<![а-яёa-z0-9])(сумм|дат[ауы])/iu.test(qLower);

  const pushEntity = (item: ExtractedEntityItem) => {
    if (results.length >= maxItems) return;
    const key = `${item.kind}|${item.label}|${item.value.replace(/\s+/g, ' ').toLowerCase()}|${item.fileName}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  const amountRegex =
    /(?:(?<![\d])(?:\d{1,3}(?:[\s\u00A0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})))\s*(?:тыс\.?\s*|млн\.?\s*|млрд\.?\s*)?(?:руб(?:л(?:ей|я|ь))?\.?|₽|р\.|USD|EUR|долл\.?|евро|\$|€)/giu;

  const dateRegex =
    /(?:«?\d{1,2}»?\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}(?:\s*г\.?)?|(?<![\d])\d{2}\.\d{2}\.\d{4}(?![\d])|(?<![\d])\d{4}-\d{2}-\d{2}(?![\d]))/giu;

  const requisitePatterns: Array<{ label: string; regex: RegExp }> = [
    { label: 'ИНН', regex: /(?<![а-яёa-z0-9])ИНН[\s:№-]*(\d{10,12})(?![\d])/giu },
    { label: 'КПП', regex: /(?<![а-яёa-z0-9])КПП[\s:№-]*(\d{9})(?![\d])/giu },
    { label: 'ОГРН / ОГРНИП', regex: /(?<![а-яёa-z0-9])ОГРН(?:ИП)?[\s:№-]*(\d{13,15})(?![\d])/giu },
    { label: 'БИК', regex: /(?<![а-яёa-z0-9])БИК[\s:№-]*(\d{9})(?![\d])/giu },
    { label: 'Расчётный счёт', regex: /(?<![а-яёa-z0-9])(?:р\/с|р\.с\.|расч[её]тный\s+сч[её]т)[\s:№-]*(\d{20})(?![\d])/giu },
    { label: 'Корр. счёт', regex: /(?<![а-яёa-z0-9])(?:к\/с|к\.с\.|корр\.?\s*сч[её]т)[\s:№-]*(\d{20})(?![\d])/giu },
    { label: 'E-mail', regex: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g },
    { label: 'Телефон', regex: /(\+7[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})/g },
  ];

  const docRefRegex =
    /(?<![а-яёa-z0-9])((?:Договор|Контракт|Акт|Сч[её]т(?:-фактура)?|Приказ|Приложение|Дополнительное\s+соглашение|Спецификация|Накладная)(?:\s+[а-яё]+){0,2}\s*№\s*[А-ЯЁA-Z0-9/_-]+(?:\s+от\s+\d{2}\.\d{2}\.\d{4})?)/giu;

  for (const source of sources) {
    for (const chunk of source.chunks) {
      const text = chunk.text;

      if (!wantsOnlyDates && !wantsOnlyRequisites) {
        amountRegex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = amountRegex.exec(text)) !== null) {
          pushEntity({
            kind: 'amount',
            label: 'Сумма',
            value: m[0].replace(/\s+/g, ' ').trim(),
            fileName: chunk.fileName,
            location: chunk.location,
            context: getSurroundingContext(text, m.index, m[0].length),
          });
        }
      }

      if (!wantsOnlyAmounts && !wantsOnlyRequisites) {
        dateRegex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = dateRegex.exec(text)) !== null) {
          pushEntity({
            kind: 'date',
            label: 'Дата',
            value: m[0].replace(/\s+/g, ' ').trim(),
            fileName: chunk.fileName,
            location: chunk.location,
            context: getSurroundingContext(text, m.index, m[0].length),
          });
        }
      }

      if (!wantsOnlyAmounts && !wantsOnlyDates) {
        for (const reqPat of requisitePatterns) {
          reqPat.regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = reqPat.regex.exec(text)) !== null) {
            pushEntity({
              kind: 'requisite',
              label: reqPat.label,
              value: (m[1] || m[0]).trim(),
              fileName: chunk.fileName,
              location: chunk.location,
              context: getSurroundingContext(text, m.index, m[0].length),
            });
          }
        }

        docRefRegex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = docRefRegex.exec(text)) !== null) {
          pushEntity({
            kind: 'document_ref',
            label: 'Документ',
            value: m[1].replace(/\s+/g, ' ').trim(),
            fileName: chunk.fileName,
            location: chunk.location,
            context: getSurroundingContext(text, m.index, m[0].length),
          });
        }
      }
    }
  }

  return results;
}

/**
 * Отбирает структурированные таблицы из выбранных документов (с опциональной фильтрацией по теме запроса).
 */
export function collectRelevantTables(
  sources: IndexedSourceRecord[],
  query?: string,
  maxTables = 10,
  maxPreviewRows = 30
): ExtractedTableView[] {
  const allTables: IndexedTable[] = [];
  for (const s of sources) {
    allTables.push(...s.tables);
  }
  if (allTables.length === 0) return [];

  const queryStems = query ? tokenizeAndStem(query) : [];
  const scored = allTables.map((tbl) => {
    let score = 1;
    if (queryStems.length > 0) {
      const sampleText = [
        tbl.fileName,
        tbl.location,
        tbl.headers.join(' '),
        ...tbl.rows.slice(0, 15).map((r) => r.join(' ')),
      ].join(' ');
      const tblStems = new Set(tokenizeAndStem(sampleText));
      for (const st of queryStems) {
        if (tblStems.has(st)) score += 3;
      }
    }
    return { tbl, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxTables).map(({ tbl }) => ({
    sourceId: tbl.sourceId,
    fileName: tbl.fileName,
    location: tbl.location,
    headers: tbl.headers,
    rows: tbl.rows.slice(0, maxPreviewRows),
    totalRowCount: tbl.rows.length,
  }));
}

/**
 * Собирает оглавление и ключевые вводные/итоговые фрагменты для больших файлов.
 */
export function buildTocAndKeyExcerpts(
  sources: IndexedSourceRecord[]
): {
  tocOverview: Array<{ fileName: string; items: DocumentTocItem[] }>;
  keyCitations: DocumentCitation[];
} {
  const tocOverview: Array<{ fileName: string; items: DocumentTocItem[] }> = [];
  const keyCitations: DocumentCitation[] = [];

  for (const source of sources) {
    const items = source.summary.toc.slice(0, 30);
    tocOverview.push({
      fileName: source.summary.fileName,
      items,
    });

    if (source.chunks.length > 0) {
      // Берём первый чанк (введение/шапка) и последний чанк (итоги/подписи) каждого файла
      const first = source.chunks[0];
      keyCitations.push({
        sourceId: first.sourceId,
        fileName: first.fileName,
        location: first.location,
        sectionHeading: first.sectionHeading,
        excerpt: first.text.slice(0, 360),
        score: 10,
      });

      if (source.chunks.length > 2) {
        const mid = source.chunks[Math.floor(source.chunks.length / 2)];
        keyCitations.push({
          sourceId: mid.sourceId,
          fileName: mid.fileName,
          location: mid.location,
          sectionHeading: mid.sectionHeading,
          excerpt: mid.text.slice(0, 300),
          score: 7,
        });
      }

      if (source.chunks.length > 1) {
        const last = source.chunks[source.chunks.length - 1];
        keyCitations.push({
          sourceId: last.sourceId,
          fileName: last.fileName,
          location: last.location,
          sectionHeading: last.sectionHeading,
          excerpt: last.text.slice(0, 320),
          score: 8,
        });
      }
    }
  }

  return {
    tocOverview,
    keyCitations: keyCitations.slice(0, 8),
  };
}
