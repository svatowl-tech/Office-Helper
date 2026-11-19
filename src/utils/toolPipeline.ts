import { DocumentProofreadResult, ToolStageId } from '../types/harness.types';

export type HandoffTargetTool = 'proofread' | 'business_style';

export interface ToolHandoffOption {
  target: HandoffTargetTool;
  shortLabel: string;
  badge: string;
  hint: string;
}

const STAGE_SHORT_NAMES: Record<ToolStageId, string> = {
  proofread: 'Исправлено',
  ocr: 'Распознано',
  dictation: 'Диктовка',
  meeting_transcript: 'Совещание',
  business_style: 'Деловой стиль',
};

/**
 * Преобразует base64-результат любого инструмента обратно в объект File,
 * чтобы передать его следующему инструменту по цепочке без сохранения на диск.
 */
export function base64ToFile(base64: string, fileName: string, mimeType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: mimeType });
}

/**
 * Извлекает чистый текст из сегментов результата (для передачи в деловой стиль или текстовый просмотр).
 */
export function extractPlainTextFromResult(result: DocumentProofreadResult): string {
  if (!result.segments || result.segments.length === 0) return '';
  return result.segments
    .map((s) => (s.correctedText || s.originalText || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Возвращает список естественных следующих шагов для результата конкретного инструмента.
 * Это позволяет использовать каждый модуль автономно либо связывать их в единую цепочку в 1 клик.
 */
export function getNextToolHandoffs(result: DocumentProofreadResult): ToolHandoffOption[] {
  const mode: ToolStageId = result.operationMode || 'proofread';

  if (mode === 'ocr') {
    return [
      {
        target: 'proofread',
        badge: '[ 01 ]',
        shortLabel: 'Исправить язык',
        hint: 'Проверить орфографию и пунктуацию в распознанном файле с сохранением таблиц и графики',
      },
      {
        target: 'business_style',
        badge: '[ 04 ]',
        shortLabel: 'Деловой стиль',
        hint: 'Перевести распознанный документ в вежливый официальный стиль',
      },
    ];
  }

  if (mode === 'dictation' || mode === 'meeting_transcript') {
    return [
      {
        target: 'business_style',
        badge: '[ 04 ]',
        shortLabel: 'Деловой стиль',
        hint: 'Оформить расшифровку в вежливое деловое письмо или служебную записку',
      },
      {
        target: 'proofread',
        badge: '[ 01 ]',
        shortLabel: 'Исправить язык',
        hint: 'Выполнить полную коррекцию документа Word (.docx)',
      },
    ];
  }

  if (mode === 'proofread') {
    return [
      {
        target: 'business_style',
        badge: '[ 04 ]',
        shortLabel: 'Деловой стиль',
        hint: 'Преобразовать исправленный документ в вежливый деловой стиль',
      },
    ];
  }

  // business_style -> финальная проверка языка в [01]
  return [
    {
      target: 'proofread',
      badge: '[ 01 ]',
      shortLabel: 'Исправить язык',
      hint: 'Проверить итоговый документ Word в корректоре орфографии и пунктуации',
    },
  ];
}

/**
 * Собирает аккуратную цепочку пройденных инструментов (только если было >= 2 шагов).
 */
export function formatPipelineTrail(trail?: ToolStageId[]): string | null {
  if (!trail || trail.length < 2) return null;
  return trail.map((stage) => STAGE_SHORT_NAMES[stage] || stage).join(' → ');
}

/**
 * Возвращает базовый этап для результата, если pipelineTrail ещё не задан.
 */
export function resolveResultTrail(result: DocumentProofreadResult): ToolStageId[] {
  if (result.pipelineTrail && result.pipelineTrail.length > 0) {
    return result.pipelineTrail;
  }
  return [result.operationMode || 'proofread'];
}
