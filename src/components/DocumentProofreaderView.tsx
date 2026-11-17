import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Play,
  RotateCcw,
  Upload,
} from 'lucide-react';
import {
  CorrectionCategory,
  DocumentProofreadResult,
  TextIssue,
} from '../types/harness.types';
import {
  apiLoadSampleDocument,
  apiProofreadDocument,
  apiProofreadText,
  triggerBase64Download,
} from '../services/harnessApi.service';

const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  orthography: 'Орфография',
  grammar: 'Грамматика и падежи',
  punctuation: 'Пунктуация',
  typography: 'Типографика',
  official_style: 'Деловой стиль (ГОСТ)',
};

const DEFAULT_INLINE_TEXT = `СЛУЖЕБНАЯ ЗАПИСКА

Согласно приказа директора департамента в течении месяца была проведена проверка серверного оборудывания на объектах с ОС Астра Линукс 5.4 и Windows 7.

В следствии сбоя коммутатора зафиксирован инциндент потери пакетов, не смотря на резервирование канала связи. Инженерам поручено координально пересмотреть регламент эксплотации и расчитать рассчет нагрузки на процессор.

По окончанию регламентных работ прошу бухгалтерию оплатить за оборудование согласно договора поставки, так как соблюдение сроков играет большое значение для будующее аттестации контура информационной безопаснть.`;

export const DocumentProofreaderView: React.FC = () => {
  const [mode, setMode] = useState<'document' | 'inline'>('document');
  const [docResult, setDocResult] = useState<DocumentProofreadResult | null>(null);
  const [originalSampleBase64, setOriginalSampleBase64] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [filterOnlyIssues, setFilterOnlyIssues] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // State for inline text editor mode
  const [inlineInput, setInlineInput] = useState<string>(DEFAULT_INLINE_TEXT);
  const [inlineCorrected, setInlineCorrected] = useState<string>('');
  const [inlineIssues, setInlineIssues] = useState<TextIssue[]>([]);
  const [inlineTimeMs, setInlineTimeMs] = useState<number>(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleLoadSample = async (sampleType: 'docx' | 'xlsx') => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiLoadSampleDocument(sampleType);
      setDocResult(res);
      setOriginalSampleBase64(res.originalSampleBase64);
      setMode('document');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки образца');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setOriginalSampleBase64(null);
    try {
      const res = await apiProofreadDocument(file);
      setDocResult(res);
      setMode('document');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обработки документа');
    } finally {
      setLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRunInlineProofread = async (textToCheck: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiProofreadText(textToCheck);
      setInlineCorrected(res.correctedText);
      setInlineIssues(res.issues);
      setInlineTimeMs(res.processingTimeMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка проверки текста');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    handleLoadSample('docx');
  }, []);

  const filteredSegments =
    docResult?.segments.filter((seg) => {
      if (filterOnlyIssues && seg.issues.length === 0) return false;
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        return (
          seg.originalText.toLowerCase().includes(q) ||
          seg.correctedText.toLowerCase().includes(q) ||
          seg.location.toLowerCase().includes(q)
        );
      }
      return true;
    }) || [];

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-950 text-slate-100">
      {/* Панель управления рабочей областью */}
      <div className="shrink-0 px-6 py-3.5 border-b border-slate-800 bg-slate-900/60 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center p-1 bg-slate-950 border border-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setMode('document')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                mode === 'document'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Файлы DOCX / XLSX (Без потери верстки)
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('inline');
                if (!inlineCorrected) {
                  handleRunInlineProofread(inlineInput);
                }
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                mode === 'inline'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Текстовый буфер (Свободный ввод)
            </button>
          </div>

          <div className="hidden xl:flex items-center gap-2 text-xs text-slate-400">
            <span>Ядро: SAGE-FRED-T5-95M-INT8 + ГОСТ Р 7.0.97</span>
            <span aria-hidden="true">·</span>
            <span>CPU-Only (Без GPU)</span>
            <span aria-hidden="true">·</span>
            <span>100% сохранение XML-стилей</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.xlsx,.txt,.md"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="w-3.5 h-3.5 text-sky-400" />
            Загрузить свой .DOCX / .XLSX
          </button>

          <button
            type="button"
            onClick={() => handleLoadSample('docx')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <FileText className="w-3.5 h-3.5 text-sky-400" />
            Тест .DOCX (Приказ)
          </button>

          <button
            type="button"
            onClick={() => handleLoadSample('xlsx')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
            Тест .XLSX (Ведомость)
          </button>
        </div>
      </div>

      {/* Информационная строка ошибки при наличии */}
      {error && (
        <div className="shrink-0 px-6 py-3 bg-red-950/60 border-b border-red-800/70 flex items-center justify-between text-xs text-red-200">
          <span>Ошибка обработки: {error}</span>
          <button
            type="button"
            onClick={() => handleLoadSample('docx')}
            className="px-3 py-1 bg-red-900/80 hover:bg-red-800 text-white rounded-md font-medium whitespace-nowrap shrink-0"
          >
            Восстановить образец
          </button>
        </div>
      )}

      {/* Основная рабочая область (Content-First) */}
      {mode === 'document' ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Сводка по открытому документу и действия экспорта */}
          {docResult && (
            <div className="shrink-0 px-6 py-3 border-b border-slate-800/80 bg-slate-900/30 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="font-semibold text-slate-100">{docResult.fileName}</span>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span className="text-slate-400 tabular-nums">
                  Проверено узлов: <strong className="text-slate-200">{docResult.totalSegments}</strong>
                </span>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span className="text-slate-400 tabular-nums">
                  Исправлено ошибок: <strong className="text-emerald-400">{docResult.totalIssuesFixed}</strong>
                </span>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span className="text-slate-400 tabular-nums">
                  Время CPU: <strong className="text-slate-200">{docResult.processingTimeMs} мс</strong>
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Поиск по абзацам или ячейкам..."
                    className="w-56 px-3 py-1.5 text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setFilterOnlyIssues(!filterOnlyIssues)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    filterOnlyIssues
                      ? 'bg-sky-950/80 border-sky-700 text-sky-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Filter className="w-3.5 h-3.5" />
                  Только с правками ({docResult.modifiedSegments})
                </button>

                {originalSampleBase64 && (
                  <button
                    type="button"
                    onClick={() =>
                      triggerBase64Download(
                        originalSampleBase64,
                        `ИСХОДНИК_${docResult.fileName}`,
                        docResult.mimeType
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5 text-slate-400" />
                    Скачать исходник с ошибками
                  </button>
                )}

                <button
                  type="button"
                  onClick={() =>
                    triggerBase64Download(
                      docResult.downloadBase64,
                      `ИСПРАВЛЕНО_${docResult.fileName}`,
                      docResult.mimeType
                    )
                  }
                  className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Скачать исправленный .{docResult.fileType.toUpperCase()} (Стили сохранены)
                </button>
              </div>
            </div>
          )}

          {/* Прокручиваемый реестр абзацев и ячеек документа */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map((n) => (
                  <div
                    key={n}
                    className="h-32 rounded-lg border border-slate-800 bg-slate-900/40 animate-pulse p-4"
                  />
                ))}
              </div>
            ) : filteredSegments.length === 0 ? (
              <div className="py-16 text-center border border-slate-800 rounded-lg bg-slate-900/20">
                <p className="text-sm text-slate-300 font-medium">
                  По заданному фильтру сегментов не найдено
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Сбросьте фильтр поиска или загрузите документ для поузлового разбора
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setFilterOnlyIssues(false);
                    setSearchQuery('');
                  }}
                  className="mt-4 px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg"
                >
                  Очистить фильтры
                </button>
              </div>
            ) : (
              filteredSegments.map((seg) => (
                <div
                  key={seg.id}
                  className="border border-slate-800 rounded-lg bg-slate-900/40 overflow-hidden"
                >
                  {/* Верхняя строка сегмента: локация + метаданные сохраненного XML-форматирования */}
                  <div className="px-4 py-2.5 border-b border-slate-800/80 bg-slate-900/70 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-200">{seg.location}</span>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span className="text-slate-400 font-mono text-[11px]">
                        {seg.preservedFormattingMeta}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {seg.issues.length > 0 ? (
                        <span className="text-emerald-400 font-medium tabular-nums">
                          Внесено правок: {seg.issues.length}
                        </span>
                      ) : (
                        <span className="text-slate-500">Ошибок не обнаружено</span>
                      )}
                    </div>
                  </div>

                  {/* Сравнение: До и После с сохранением верстки */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
                    <div className="p-4">
                      <div className="text-[11px] font-medium text-slate-500 mb-1.5">
                        Исходный текст узла ({seg.elementType === 'spreadsheet_cell' ? 'ячейка таблицы' : 'XML-ран <w:t>'})
                      </div>
                      <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                        {seg.originalText}
                      </p>
                    </div>

                    <div className="p-4 bg-slate-950/40">
                      <div className="text-[11px] font-medium text-emerald-400/90 mb-1.5 flex items-center gap-1.5">
                        <Check className="w-3.5 h-3.5" />
                        Исправленный текст (записан обратно в исходные теги стилей)
                      </div>
                      <p className="text-sm text-slate-100 leading-relaxed whitespace-pre-wrap">
                        {seg.correctedText}
                      </p>
                    </div>
                  </div>

                  {/* Детализация сработавших лингвистических правил */}
                  {seg.issues.length > 0 && (
                    <div className="px-4 py-2.5 border-t border-slate-800/80 bg-slate-950/70 space-y-1.5">
                      {seg.issues.map((iss) => (
                        <div
                          key={iss.id}
                          className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs"
                        >
                          <span className="font-mono text-red-400 line-through">
                            «{iss.original}»
                          </span>
                          <span className="text-slate-500">→</span>
                          <span className="font-mono text-emerald-400 font-medium">
                            «{iss.replacement}»
                          </span>
                          <span className="text-slate-600" aria-hidden="true">·</span>
                          <span className="text-sky-400 font-medium">
                            {CATEGORY_LABELS[iss.category]}: {iss.ruleTitle}
                          </span>
                          <span className="text-slate-500">— {iss.explanation}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* Режим свободного инлайн-редактирования текста */
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
          <div className="lg:col-span-5 flex flex-col min-h-0 p-5">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-semibold text-slate-300">
                Исходный русский текст для вычитки
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setInlineInput(DEFAULT_INLINE_TEXT);
                    handleRunInlineProofread(DEFAULT_INLINE_TEXT);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 rounded-md"
                >
                  <RotateCcw className="w-3 h-3" />
                  Сбросить к примеру
                </button>
                <button
                  type="button"
                  onClick={() => handleRunInlineProofread(inlineInput)}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-md"
                >
                  <Play className="w-3 h-3" />
                  Проверить текст
                </button>
              </div>
            </div>
            <textarea
              value={inlineInput}
              onChange={(e) => setInlineInput(e.target.value)}
              className="flex-1 min-h-0 w-full p-4 text-sm bg-slate-900/70 border border-slate-800 rounded-lg text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500 resize-none"
              placeholder="Вставьте сюда текст приказа, акта, письма или пояснительной записки..."
            />
          </div>

          <div className="lg:col-span-7 flex flex-col min-h-0 p-5 overflow-y-auto space-y-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-emerald-400">
                  Исправленный результат ({inlineIssues.length} правок · {inlineTimeMs} мс)
                </span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(inlineCorrected)}
                  className="px-2.5 py-1 text-xs bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-md text-slate-300"
                >
                  Копировать результат
                </button>
              </div>
              <div className="p-4 bg-slate-900/40 border border-slate-800 rounded-lg text-sm text-slate-100 leading-relaxed whitespace-pre-wrap">
                {inlineCorrected || 'Нажмите «Проверить текст» для запуска корректора.'}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-3">
                Пояснения по внесенным исправлениям ({inlineIssues.length})
              </h3>
              {inlineIssues.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Орфографических, грамматических и пунктуационных ошибок не обнаружено.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {inlineIssues.map((iss) => (
                    <div
                      key={iss.id}
                      className="p-3 rounded-lg border border-slate-800 bg-slate-900/50 text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-red-400 line-through">
                          «{iss.original}»
                        </span>
                        <span className="text-slate-500">→</span>
                        <span className="font-mono text-emerald-400 font-semibold">
                          «{iss.replacement}»
                        </span>
                        <span className="text-slate-600" aria-hidden="true">·</span>
                        <span className="text-sky-400 font-medium">
                          {CATEGORY_LABELS[iss.category]} — {iss.ruleTitle}
                        </span>
                      </div>
                      <p className="text-slate-400">{iss.explanation}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
