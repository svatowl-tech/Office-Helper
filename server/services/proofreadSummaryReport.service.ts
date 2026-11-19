import path from 'path';
import {
  CorrectionCategory,
  DocumentProofreadResult,
} from '../../src/types/harness.types.ts';
import { buildDocxFromRecognizedBlocks, RecognizedBlock } from './ocrDocument.service.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  orthography: 'Орфография',
  punctuation: 'Пунктуация',
  grammar: 'Грамматика',
  typography: 'Типографика',
  official_style: 'Деловой стиль',
};

interface FlattenedChangeRow {
  index: number;
  location: string;
  categoryLabel: string;
  original: string;
  replacement: string;
  explanation: string;
}

function formatRussianTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function buildSafeBaseName(fileName: string): string {
  const parsed = path.parse(fileName || 'документ');
  const clean = (parsed.name || 'документ')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 72);
  return clean || 'документ';
}

function truncateCell(text: string, maxLen = 280): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
}

/**
 * Собирает плоский список всех внесённых исправлений для ручной перепроверки.
 * Гарантирует, что ни одно изменение сегмента не будет потеряно.
 */
function collectFlattenedChanges(result: DocumentProofreadResult): FlattenedChangeRow[] {
  const rows: FlattenedChangeRow[] = [];
  let counter = 1;

  for (const seg of result.segments || []) {
    if (seg.issues && seg.issues.length > 0) {
      for (const issue of seg.issues) {
        rows.push({
          index: counter++,
          location: seg.location || 'Фрагмент документа',
          categoryLabel: CATEGORY_LABELS[issue.category] || 'Коррекция',
          original: truncateCell(issue.original || '—', 160),
          replacement: truncateCell(issue.replacement || '—', 160),
          explanation: truncateCell(
            issue.ruleTitle && issue.explanation && issue.ruleTitle !== issue.explanation
              ? `${issue.ruleTitle}: ${issue.explanation}`
              : issue.explanation || issue.ruleTitle || 'Исправление по правилам русского языка',
            220
          ),
        });
      }
    } else if (seg.applied && seg.originalText.trim() !== seg.correctedText.trim()) {
      rows.push({
        index: counter++,
        location: seg.location || 'Фрагмент документа',
        categoryLabel: 'Коррекция',
        original: truncateCell(seg.originalText, 180),
        replacement: truncateCell(seg.correctedText, 180),
        explanation: 'Правка текста фрагмента',
      });
    }
  }

  return rows;
}

/**
 * Генерирует отдельный документ Word (.docx) со сводкой всех исправлений для ручной перепроверки.
 * Исходный исправленный файл при этом остаётся чистым и не модифицируется посторонними пометками.
 */
export async function generateProofreadSummaryDocx(
  result: DocumentProofreadResult
): Promise<{ fileName: string; buffer: Buffer; mimeType: string }> {
  const safeBase = buildSafeBaseName(result.fileName);
  const summaryFileName = `Сводка_исправлений_${safeBase}.docx`;

  const changeRows = collectFlattenedChanges(result);
  const modifiedSegments = (result.segments || []).filter(
    (seg) => seg.applied || (seg.issues && seg.issues.length > 0) || seg.originalText !== seg.correctedText
  );

  // Подсчёт по категориям
  const categoryCounts = new Map<string, number>();
  for (const row of changeRows) {
    categoryCounts.set(row.categoryLabel, (categoryCounts.get(row.categoryLabel) || 0) + 1);
  }
  const categoryBreakdown = Array.from(categoryCounts.entries())
    .map(([label, count]) => `${label}: ${count}`)
    .join(' · ');

  const blocks: RecognizedBlock[] = [
    {
      type: 'heading',
      text: `Сводка исправлений: ${result.fileName}`,
    },
    {
      type: 'paragraph',
      text: `Дата проверки: ${formatRussianTimestamp(new Date())} | Всего исправлений: ${changeRows.length} | Изменено фрагментов: ${modifiedSegments.length} из ${result.totalSegments} | Движок: ${result.engineUsed}`,
    },
  ];

  if (categoryBreakdown) {
    blocks.push({
      type: 'paragraph',
      text: `Распределение правок: ${categoryBreakdown}`,
    });
  }

  if (changeRows.length === 0) {
    blocks.push({
      type: 'heading',
      text: 'Результат проверки',
    });
    blocks.push({
      type: 'paragraph',
      text: 'Ошибок орфографии, пунктуации и грамматики не обнаружено. Исходный документ оставлен без изменений.',
    });
  } else {
    blocks.push({
      type: 'heading',
      text: '1. Перечень внесённых исправлений (Было → Стало)',
    });
    blocks.push({
      type: 'table',
      rows: [
        ['№', 'Место в документе', 'Категория', 'Было', 'Стало', 'Пояснение'],
        ...changeRows.map((row) => [
          String(row.index),
          row.location,
          row.categoryLabel,
          row.original,
          row.replacement,
          row.explanation,
        ]),
      ],
      columnWidthFractions: [0.06, 0.19, 0.14, 0.18, 0.18, 0.25],
    });

    if (modifiedSegments.length > 0) {
      blocks.push({
        type: 'heading',
        text: '2. Изменённые фрагменты в контексте (для ручной сверки)',
      });
      blocks.push({
        type: 'table',
        rows: [
          ['Место в документе', 'Исходный текст (Было)', 'Исправленный текст (Стало)'],
          ...modifiedSegments.slice(0, 120).map((seg) => [
            seg.location || 'Фрагмент',
            truncateCell(seg.originalText, 420),
            truncateCell(seg.correctedText, 420),
          ]),
        ],
        columnWidthFractions: [0.22, 0.39, 0.39],
      });
    }
  }

  const buffer = await buildDocxFromRecognizedBlocks(blocks);
  return {
    fileName: summaryFileName,
    buffer,
    mimeType: DOCX_MIME,
  };
}

/**
 * Прикрепляет к результату проверки языка отдельный файл сводки исправлений (secondaryDownloadBase64),
 * не меняя сам исправленный документ.
 */
export async function attachProofreadChangeSummary(
  result: DocumentProofreadResult
): Promise<DocumentProofreadResult> {
  try {
    const summaryDoc = await generateProofreadSummaryDocx(result);
    return {
      ...result,
      operationMode: 'proofread',
      secondaryFileName: summaryDoc.fileName,
      secondaryDownloadBase64: summaryDoc.buffer.toString('base64'),
      secondaryMimeType: summaryDoc.mimeType,
    };
  } catch (err) {
    console.error('Не удалось сформировать отдельный файл сводки исправлений:', err);
    return {
      ...result,
      operationMode: 'proofread',
    };
  }
}
