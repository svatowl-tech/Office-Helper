import { HarnessChunkingConfig, TextChunkSpan, TextIssue } from '../../src/types/harness.types.ts';

/**
 * ==============================================================================
 * СТАНДАРТНЫЙ КОНВЕЙЕР ЧАНКИНГА ДЛИННЫХ ТЕКСТОВ И ФАЙЛОВ ХАРНЕСА (HARNESS CHUNKER)
 * ==============================================================================
 * Предназначен для работы с малыми локальными CPU-моделями (SAGE FRED-T5 95M с окном
 * 512 токенов и Qwen2.5-1.5B GGUF с ограниченным контекстом на 4-ядерных CPU без GPU).
 *
 * Архитектура модуля универсальна и масштабируема на любые инструменты харнеса:
 *   1) Исправление русского языка (орфография, грамматика, пунктуация, ГОСТ)
 *   2) Постобработка OCR-документов
 *   3) Суммаризация, классификация, перевод или извлечение сущностей из больших файлов
 *
 * Гарантирует:
 *   - 100% сохранение переводов строк, пробелов и границ абзацев/предложений
 *     (`chunk.text + chunk.trailingSeparator` склеивается обратно без потери ни одного байта).
 *   - Автоматический пересчет глобальных смещений (`startOffset` / `endOffset`) найденных ошибок.
 *   - Безопасное разбиение по каскаду: Абзацы -> Предложения (с учетом русских сокращений
 *     «г.», «ул.», «т.д.», «т.п.», «руб.», «ст.», «п.») -> Клаузы (; ,) -> Слова.
 */

export const DEFAULT_HARNESS_CHUNKING_CONFIG: HarnessChunkingConfig = {
  maxChunkChars: Number(process.env.HARNESS_CHUNK_MAX_CHARS) || 480,
  maxTokensEstimate: Number(process.env.HARNESS_CHUNK_MAX_TOKENS) || 180,
  preserveParagraphs: true,
  preserveSentences: true,
  concurrency: 1, // Последовательная обработка для стабильной нагрузки на CPU (i3-9100 / Win7)
};

// Список стандартных русских деловых сокращений, после точки в которых НЕ начинается новое предложение
const RUSSIAN_ABBREVIATIONS = new Set([
  'г',
  'гг',
  'гр',
  'ул',
  'пр',
  'просп',
  'пер',
  'д',
  'кв',
  'корп',
  'стр',
  'обл',
  'р-н',
  'ст',
  'п',
  'пп',
  'подп',
  'разд',
  'гл',
  'рис',
  'табл',
  'см',
  'ср',
  'напр',
  'др',
  'пр',
  'руб',
  'коп',
  'тыс',
  'млн',
  'млрд',
  'экз',
  'им',
  'тов',
  'зам',
  'исп',
  'вх',
  'исх',
  'инв',
  'т',
]);

/**
 * Оценка количества токенов для кириллического/смешанного текста
 * (в BPE/SentencePiece токенизаторах 1 русский токен ~ 2.4 - 2.8 символа).
 */
export function estimateCyrillicTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2.6);
}

/**
 * Проверяет, является ли точка в конце фрагмента частью русского сокращения (например, «г.», «т. д.», «п.»)
 */
function endsWithRussianAbbreviation(prefix: string): boolean {
  const trimmed = prefix.trimEnd();
  if (!trimmed.endsWith('.')) return false;

  // Проверяем конструкции вида "т.д.", "т.п.", "и т. д.", "инициалы А.Б."
  const lastWordMatch = trimmed.slice(0, -1).match(/([а-яёА-ЯЁa-zA-Z-]+)$/u);
  if (!lastWordMatch) return false;

  const word = lastWordMatch[1];
  // Одиночная заглавная буква (инициал: «И. И. Иванов»)
  if (word.length === 1 && word === word.toUpperCase()) {
    return true;
  }

  return RUSSIAN_ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Находит оптимальную точку разреза длинного фрагмента не дальше maxLen символов,
 * не разрывая слова и по возможности разрезая по границе предложения или знаку препинания.
 */
function findSafeSplitPoint(text: string, maxLen: number, preserveSentences: boolean): number {
  if (text.length <= maxLen) return text.length;

  const windowSlice = text.slice(0, maxLen);
  const minAcceptablePos = Math.floor(maxLen * 0.35);

  // 1. Приоритет: перевод строки внутри окна
  const lastNewline = windowSlice.lastIndexOf('\n');
  if (lastNewline >= minAcceptablePos) {
    return lastNewline + 1;
  }

  // 2. Приоритет: конец предложения (. ! ? …) с пробелом после него, не являющийся сокращением
  if (preserveSentences) {
    const sentenceEndRegex = /[.!?…]+(?=\s|$)/gu;
    let bestSentenceCut = -1;
    let match: RegExpExecArray | null;

    while ((match = sentenceEndRegex.exec(windowSlice)) !== null) {
      const candidateEnd = match.index + match[0].length;
      if (candidateEnd < minAcceptablePos) continue;
      const prefix = windowSlice.slice(0, candidateEnd);
      if (!endsWithRussianAbbreviation(prefix)) {
        bestSentenceCut = candidateEnd;
      }
    }

    if (bestSentenceCut >= minAcceptablePos) {
      return bestSentenceCut;
    }
  }

  // 3. Приоритет: точка с запятой, двоеточие или запятая
  const clauseRegex = /[;:,](?=\s)/gu;
  let bestClauseCut = -1;
  let clauseMatch: RegExpExecArray | null;
  while ((clauseMatch = clauseRegex.exec(windowSlice)) !== null) {
    const candidateEnd = clauseMatch.index + clauseMatch[0].length;
    if (candidateEnd >= minAcceptablePos) {
      bestClauseCut = candidateEnd;
    }
  }
  if (bestClauseCut >= minAcceptablePos) {
    return bestClauseCut;
  }

  // 4. Приоритет: граница слова (последний пробел/табуляция)
  const lastSpace = Math.max(windowSlice.lastIndexOf(' '), windowSlice.lastIndexOf('\t'));
  if (lastSpace >= minAcceptablePos) {
    return lastSpace;
  }

  // 5. Крайний случай (сверхдлинная строка без пробелов): жесткий разрез по maxLen
  return maxLen;
}

/**
 * Разбивает текст произвольной длины на безопасные для малой модели чанки (`TextChunkSpan[]`).
 * Гарантирует инвариант:
 *   `chunks.map(c => c.text + c.trailingSeparator).join('') === originalText`
 */
export function splitTextIntoHarnessChunks(
  text: string,
  customConfig?: Partial<HarnessChunkingConfig>
): TextChunkSpan[] {
  const config: HarnessChunkingConfig = {
    ...DEFAULT_HARNESS_CHUNKING_CONFIG,
    ...customConfig,
  };

  const maxChars = Math.max(80, config.maxChunkChars);

  if (!text || text.length === 0) {
    return [];
  }

  // Если весь текст помещается в один чанк — возвращаем его без лишних разрезов
  if (text.length <= maxChars) {
    return [
      {
        index: 0,
        text,
        trailingSeparator: '',
        startOffset: 0,
        endOffset: text.length,
        estimatedTokens: estimateCyrillicTokens(text),
      },
    ];
  }

  const chunks: TextChunkSpan[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.slice(cursor);

    if (remaining.length <= maxChars) {
      chunks.push({
        index: chunks.length,
        text: remaining,
        trailingSeparator: '',
        startOffset: cursor,
        endOffset: text.length,
        estimatedTokens: estimateCyrillicTokens(remaining),
      });
      break;
    }

    // Если включено сохранение абзацев и ближайший двойной перенос строки находится в пределах окна
    let splitLen = -1;
    if (config.preserveParagraphs) {
      const windowSlice = remaining.slice(0, maxChars);
      const doubleNewlineMatch = /\r?\n\s*\r?\n/g;
      let lastParaEnd = -1;
      let m: RegExpExecArray | null;
      while ((m = doubleNewlineMatch.exec(windowSlice)) !== null) {
        if (m.index >= Math.floor(maxChars * 0.25)) {
          lastParaEnd = m.index;
        }
      }
      if (lastParaEnd > 0) {
        splitLen = lastParaEnd;
      }
    }

    if (splitLen <= 0) {
      splitLen = findSafeSplitPoint(remaining, maxChars, config.preserveSentences);
    }

    const rawSlice = remaining.slice(0, splitLen);

    // Отделяем хвостовые пробелы и переводы строк в trailingSeparator,
    // чтобы модель не съела форматирующие переносы строк между чанками
    const trailingWsMatch = rawSlice.match(/(\s+)$/);
    let coreText = rawSlice;
    let trailingSeparator = '';

    if (trailingWsMatch && trailingWsMatch[1].length < rawSlice.length) {
      trailingSeparator = trailingWsMatch[1];
      coreText = rawSlice.slice(0, rawSlice.length - trailingSeparator.length);
    }

    // Если сразу за разрезом в remaining идут пробелы/переносы строк — присоединяем их к разделителю этого чанка
    const afterSlice = remaining.slice(splitLen);
    const leadingNextWsMatch = afterSlice.match(/^(\s+)/);
    let extraWsLen = 0;
    if (leadingNextWsMatch) {
      trailingSeparator += leadingNextWsMatch[1];
      extraWsLen = leadingNextWsMatch[1].length;
    }

    const chunkStart = cursor;
    const chunkEnd = cursor + coreText.length;

    chunks.push({
      index: chunks.length,
      text: coreText,
      trailingSeparator,
      startOffset: chunkStart,
      endOffset: chunkEnd,
      estimatedTokens: estimateCyrillicTokens(coreText),
    });

    cursor = chunkEnd + trailingSeparator.length;
    if (extraWsLen === 0 && splitLen === 0) {
      // Защита от бесконечного цикла
      cursor += maxChars;
    }
  }

  return chunks;
}

export interface ChunkProcessorOutput<TMeta = unknown> {
  transformedText: string;
  issues?: TextIssue[];
  meta?: TMeta;
}

export interface ChunkedPipelineResult<TMeta = unknown> {
  originalText: string;
  transformedText: string;
  totalChunks: number;
  chunkMaxCharsUsed: number;
  issues: TextIssue[];
  chunkMeta: TMeta[];
}

/**
 * Универсальный исполнитель любого инструмента харнеса поверх конвейера чанкинга.
 * Принимает длинный текст, делит его на маленькие кусочки под окно контекста модели,
 * последовательно (или батчами) передает каждый чанк в `processor(chunkText, chunkSpan)`
 * и бесшовно собирает исправленный текст и глобальные координаты ошибок.
 */
export async function executeHarnessChunkedTask<TMeta = unknown>(
  text: string,
  processor: (chunkText: string, span: TextChunkSpan) => Promise<ChunkProcessorOutput<TMeta>>,
  customConfig?: Partial<HarnessChunkingConfig>
): Promise<ChunkedPipelineResult<TMeta>> {
  const config: HarnessChunkingConfig = {
    ...DEFAULT_HARNESS_CHUNKING_CONFIG,
    ...customConfig,
  };

  if (!text || text.trim().length === 0) {
    return {
      originalText: text,
      transformedText: text,
      totalChunks: 0,
      chunkMaxCharsUsed: config.maxChunkChars,
      issues: [],
      chunkMeta: [],
    };
  }

  const chunks = splitTextIntoHarnessChunks(text, config);
  const assembledParts: string[] = [];
  const allIssues: TextIssue[] = [];
  const chunkMeta: TMeta[] = [];

  let currentTransformedOffset = 0;

  for (const span of chunks) {
    if (span.text.trim().length === 0) {
      assembledParts.push(span.text + span.trailingSeparator);
      currentTransformedOffset += span.text.length + span.trailingSeparator.length;
      continue;
    }

    const result = await processor(span.text, span);
    const safeTransformed =
      typeof result.transformedText === 'string' && result.transformedText.length > 0
        ? result.transformedText
        : span.text;

    if (Array.isArray(result.issues)) {
      for (const issue of result.issues) {
        allIssues.push({
          ...issue,
          id: `${issue.id}-ch${span.index}`,
          startOffset: currentTransformedOffset + issue.startOffset,
          endOffset: currentTransformedOffset + issue.endOffset,
        });
      }
    }

    if (result.meta !== undefined) {
      chunkMeta.push(result.meta);
    }

    assembledParts.push(safeTransformed + span.trailingSeparator);
    currentTransformedOffset += safeTransformed.length + span.trailingSeparator.length;
  }

  return {
    originalText: text,
    transformedText: assembledParts.join(''),
    totalChunks: chunks.length,
    chunkMaxCharsUsed: config.maxChunkChars,
    issues: allIssues,
    chunkMeta,
  };
}
