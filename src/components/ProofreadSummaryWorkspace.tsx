import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileText,
} from 'lucide-react';
import {
  CorrectionCategory,
  DocumentProofreadResult,
} from '../types/harness.types';
import { triggerBase64Download } from '../services/harnessApi.service';

interface ProofreadSummaryWorkspaceProps {
  result: DocumentProofreadResult;
  onBackToTools: () => void;
}

const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  orthography: 'Орфография',
  punctuation: 'Пунктуация',
  grammar: 'Грамматика',
  typography: 'Типографика',
  official_style: 'Деловой стиль',
};

interface DisplayChangeRow {
  id: string;
  index: number;
  location: string;
  category: CorrectionCategory | 'other';
  categoryLabel: string;
  original: string;
  replacement: string;
  ruleTitle: string;
  explanation: string;
  segmentOriginal: string;
  segmentCorrected: string;
}

export const ProofreadSummaryWorkspace: React.FC<ProofreadSummaryWorkspaceProps> = ({
  result,
  onBackToTools,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showContext, setShowContext] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const allChanges = useMemo<DisplayChangeRow[]>(() => {
    const rows: DisplayChangeRow[] = [];
    let idx = 1;

    for (const seg of result.segments || []) {
      if (seg.issues && seg.issues.length > 0) {
        for (const issue of seg.issues) {
          rows.push({
            id: `${seg.id}-${issue.id || idx}`,
            index: idx++,
            location: seg.location || 'Фрагмент документа',
            category: issue.category,
            categoryLabel: CATEGORY_LABELS[issue.category] || 'Коррекция',
            original: issue.original || '—',
            replacement: issue.replacement || '—',
            ruleTitle: issue.ruleTitle || '',
            explanation: issue.explanation || '',
            segmentOriginal: seg.originalText,
            segmentCorrected: seg.correctedText,
          });
        }
      } else if (seg.applied && seg.originalText.trim() !== seg.correctedText.trim()) {
        rows.push({
          id: `${seg.id}-raw-${idx}`,
          index: idx++,
          location: seg.location || 'Фрагмент документа',
          category: 'other',
          categoryLabel: 'Коррекция',
          original: seg.originalText,
          replacement: seg.correctedText,
          ruleTitle: 'Исправление фрагмента',
          explanation: 'Текст фрагмента скорректирован.',
          segmentOriginal: seg.originalText,
          segmentCorrected: seg.correctedText,
        });
      }
    }

    return rows;
  }, [result.segments]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const row of allChanges) {
      const existing = counts.get(row.category);
      if (existing) {
        existing.count++;
      } else {
        counts.set(row.category, { label: row.categoryLabel, count: 1 });
      }
    }
    return Array.from(counts.entries());
  }, [allChanges]);

  const visibleChanges = useMemo(() => {
    if (selectedCategory === 'all') return allChanges;
    return allChanges.filter((c) => c.category === selectedCategory);
  }, [allChanges, selectedCategory]);

  const handleCopySummary = async () => {
    const header = `Сводка исправлений: ${result.fileName}\nВсего правок: ${allChanges.length} (изменено фрагментов: ${result.modifiedSegments} из ${result.totalSegments})\n`;
    const body =
      allChanges.length === 0
        ? '\nОшибок не обнаружено. Исходный документ оставлен без изменений.'
        : '\n' +
          allChanges
            .map(
              (r) =>
                `${r.index}. [${r.location}] (${r.categoryLabel}) «${r.original}» → «${r.replacement}»${
                  r.explanation ? ` — ${r.explanation}` : ''
                }`
            )
            .join('\n');

    const text = `${header}${body}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Верхняя навигация */}
      <div className="shrink-0 px-5 py-3 sm:px-8 border-b border-[#1a1a1a]/12 bg-[#faf9f7] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBackToTools}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[#1a1a1a] hover:text-[#004ecc] transition-colors cursor-pointer whitespace-nowrap"
          >
            <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
            <span>Все инструменты</span>
          </button>
          <span className="text-[#1a1a1a]/20">|</span>
          <span className="font-mono text-[12px] font-bold text-[#004ecc] shrink-0">[ 01 ]</span>
          <span className="font-display text-base sm:text-lg font-bold uppercase tracking-[0.03em] text-[#1a1a1a] truncate">
            Сводка исправлений
          </span>
        </div>

        <div className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/60 truncate max-w-[380px] tabular-nums">
          {result.fileName} · Правок: {allChanges.length} · Фрагментов: {result.modifiedSegments}/
          {result.totalSegments}
        </div>
      </div>

      {/* Панель действий и фильтров */}
      <div className="shrink-0 px-5 py-3 sm:px-8 border-b border-[#1a1a1a]/10 bg-white flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {allChanges.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setSelectedCategory('all')}
                className={`px-2.5 py-1 border font-mono text-[10.5px] uppercase tracking-[0.04em] transition-colors cursor-pointer tabular-nums ${
                  selectedCategory === 'all'
                    ? 'bg-[#1a1a1a] text-white border-[#1a1a1a]'
                    : 'border-[#1a1a1a]/20 text-[#1a1a1a]/75 hover:border-[#1a1a1a]'
                }`}
              >
                Все ({allChanges.length})
              </button>
              {categoryCounts.map(([catKey, info]) => (
                <button
                  key={catKey}
                  type="button"
                  onClick={() => setSelectedCategory(catKey)}
                  className={`px-2.5 py-1 border font-mono text-[10.5px] uppercase tracking-[0.04em] transition-colors cursor-pointer tabular-nums ${
                    selectedCategory === catKey
                      ? 'bg-[#1a1a1a] text-white border-[#1a1a1a]'
                      : 'border-[#1a1a1a]/20 text-[#1a1a1a]/75 hover:border-[#1a1a1a]'
                  }`}
                >
                  {info.label} ({info.count})
                </button>
              ))}

              <label className="ml-2 inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/70 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showContext}
                  onChange={(e) => setShowContext(e.target.checked)}
                  className="accent-[#004ecc] cursor-pointer"
                />
                <span>Контекст абзаца</span>
              </label>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCopySummary}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#004ecc] shrink-0" />
                <span>Скопировано</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 shrink-0" />
                <span>Копировать</span>
              </>
            )}
          </button>

          {result.secondaryDownloadBase64 && result.secondaryFileName && result.secondaryMimeType && (
            <button
              type="button"
              onClick={() =>
                triggerBase64Download(
                  result.secondaryDownloadBase64!,
                  result.secondaryFileName!,
                  result.secondaryMimeType!
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-white text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span>Скачать сводку (DOCX)</span>
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              triggerBase64Download(
                result.downloadBase64,
                `Исправлено_${result.fileName}`,
                result.mimeType
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#004ecc] hover:bg-[#003da1] text-white font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 shrink-0" />
            <span>Исправленный файл</span>
          </button>
        </div>
      </div>

      {/* Основная таблица исправлений (единственный скролл-контейнер) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 sm:px-8">
        {visibleChanges.length === 0 ? (
          <div className="py-12 max-w-[540px]">
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[#004ecc] mb-2">
              Проверка завершена
            </div>
            <h2 className="font-display text-2xl font-bold uppercase tracking-[0.02em] text-[#1a1a1a] mb-2">
              Ошибок не обнаружено
            </h2>
            <p className="text-[13.5px] leading-relaxed text-[#555555] mb-5">
              Исходный документ «{result.fileName}» корректен и оставлен без изменений. При необходимости вы можете скачать отдельный протокол проверки в формате Word.
            </p>
            <button
              type="button"
              onClick={onBackToTools}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1a1a1a] hover:bg-[#004ecc] text-white font-mono text-[11px] font-bold uppercase tracking-[0.06em] transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Вернуться к инструментам</span>
            </button>
          </div>
        ) : (
          <div className="border border-[#1a1a1a]/15 overflow-x-auto">
            <table className="w-full text-left border-collapse text-[12.5px]">
              <thead>
                <tr className="bg-[#faf9f7] border-b border-[#1a1a1a]/15 font-mono text-[10px] font-bold uppercase tracking-[0.05em] text-[#1a1a1a]/65">
                  <th className="py-2.5 px-3 w-[44px]">№</th>
                  <th className="py-2.5 px-3 w-[190px]">Место в документе</th>
                  <th className="py-2.5 px-3 w-[125px]">Категория</th>
                  <th className="py-2.5 px-3">Было</th>
                  <th className="py-2.5 px-3">Стало</th>
                  <th className="py-2.5 px-3">Пояснение</th>
                </tr>
              </thead>
              <tbody>
                {visibleChanges.map((row) => (
                  <React.Fragment key={row.id}>
                    <tr className="border-b border-[#1a1a1a]/10 align-top hover:bg-[#faf9f7]/70">
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#1a1a1a]/50 tabular-nums">
                        {row.index}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#1a1a1a]/75">
                        {row.location}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[10.5px] uppercase tracking-[0.03em] text-[#004ecc]">
                        {row.categoryLabel}
                      </td>
                      <td className="py-2.5 px-3 text-[#991b1b] bg-[#fef2f2]/70 line-through decoration-[#dc2626]/60">
                        {row.original}
                      </td>
                      <td className="py-2.5 px-3 text-[#065f46] bg-[#ecfdf5]/70 font-medium">
                        {row.replacement}
                      </td>
                      <td className="py-2.5 px-3 text-[12px] text-[#444444] leading-snug">
                        {row.ruleTitle && row.explanation && row.ruleTitle !== row.explanation ? (
                          <>
                            <span className="font-semibold text-[#1a1a1a]">{row.ruleTitle}: </span>
                            <span>{row.explanation}</span>
                          </>
                        ) : (
                          row.explanation || row.ruleTitle || '—'
                        )}
                      </td>
                    </tr>
                    {showContext && (
                      <tr className="border-b border-[#1a1a1a]/12 bg-[#faf9f7]/50">
                        <td />
                        <td colSpan={5} className="py-2 px-3 text-[11.5px] leading-relaxed">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <span className="font-mono text-[9.5px] uppercase tracking-[0.05em] text-[#991b1b] block mb-0.5">
                                Исходный фрагмент (Было)
                              </span>
                              <div className="text-[#444444]">{row.segmentOriginal}</div>
                            </div>
                            <div>
                              <span className="font-mono text-[9.5px] uppercase tracking-[0.05em] text-[#065f46] block mb-0.5">
                                Исправленный фрагмент (Стало)
                              </span>
                              <div className="text-[#1a1a1a]">{row.segmentCorrected}</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
