import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderOpen,
  HardDrive,
  PanelLeft,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import {
  DocumentHarnessAnswer,
  DocumentSourceSummary,
  DocumentWorkspaceSnapshot,
} from '../types/harness.types';
import { triggerBase64Download } from '../services/harnessApi.service';

interface DocumentWorkWorkspaceProps {
  snapshot: DocumentWorkspaceSnapshot;
  answers: DocumentHarnessAnswer[];
  isProcessing: boolean;
  onUploadFiles: (files: File[]) => void;
  onMountDiskPath: (diskPath: string) => void;
  onRemoveSource: (sourceId?: string) => void;
  onSubmitQuery: (query: string, selectedSourceIds?: string[]) => void;
  onExportOffice: (answer: DocumentHarnessAnswer, format: 'docx' | 'xlsx') => void;
  onSendAnswerToBusinessStyle: (text: string) => void;
  onBackToTools: () => void;
}

const STARTER_PROMPTS = [
  {
    label: 'Сводка и оглавление',
    query: 'Сделай краткую сводку и покажи оглавление документов',
  },
  {
    label: 'Суммы, даты и реквизиты',
    query: 'Извлеки все суммы, даты, ИНН, КПП и реквизиты из документов',
  },
  {
    label: 'Показать все таблицы',
    query: 'Покажи все таблицы из подключённых документов',
  },
  {
    label: 'Собрать выписку в Word',
    query: 'Собери новый документ Word со сводкой, суммами и ключевыми цитатами',
  },
];

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export const DocumentWorkWorkspace: React.FC<DocumentWorkWorkspaceProps> = ({
  snapshot,
  answers,
  isProcessing,
  onUploadFiles,
  onMountDiskPath,
  onRemoveSource,
  onSubmitQuery,
  onExportOffice,
  onSendAnswerToBusinessStyle,
  onBackToTools,
}) => {
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const [diskPathInput, setDiskPathInput] = useState<string>('');
  const [queryInput, setQueryInput] = useState<string>('');
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [expandedTocSourceId, setExpandedTocSourceId] = useState<string | null>(null);
  const [expandedCitationsId, setExpandedCitationsId] = useState<Record<string, boolean>>({});
  const [copiedAnswerId, setCopiedAnswerId] = useState<string | null>(null);
  const [mobileSourcesOpen, setMobileSourcesOpen] = useState<boolean>(false);

  // Синхронизируем выбранные чекбоксы, если источник удалён
  useEffect(() => {
    const validIds = new Set(snapshot.sources.map((s) => s.id));
    setSelectedSourceIds((prev) => prev.filter((id) => validIds.has(id)));
  }, [snapshot.sources]);

  // Мягкая прокрутка к последнему ответу
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [answers.length]);

  const handleToggleSelectSource = (sourceId: string) => {
    setSelectedSourceIds((prev) =>
      prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId]
    );
  };

  const handleMountSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = diskPathInput.trim();
    if (!cleaned || isProcessing) return;
    onMountDiskPath(cleaned);
    setDiskPathInput('');
  };

  const handleQuerySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = queryInput.trim();
    if (!cleaned || isProcessing) return;
    onSubmitQuery(cleaned, selectedSourceIds.length > 0 ? selectedSourceIds : undefined);
    setQueryInput('');
  };

  const handleQuickPrompt = (promptText: string) => {
    if (isProcessing) return;
    onSubmitQuery(promptText, selectedSourceIds.length > 0 ? selectedSourceIds : undefined);
  };

  const handleTocItemClick = (source: DocumentSourceSummary, headingTitle: string) => {
    if (isProcessing) return;
    const prompt = `В файле ${source.fileName} найди и кратко изложи раздел «${headingTitle}» со ссылками и суммами`;
    onSubmitQuery(prompt, [source.id]);
    setMobileSourcesOpen(false);
  };

  const handleCopyAnswer = async (answer: DocumentHarnessAnswer) => {
    try {
      await navigator.clipboard.writeText(answer.answerText);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = answer.answerText;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
    }
    setCopiedAnswerId(answer.id);
    window.setTimeout(() => setCopiedAnswerId(null), 1600);
  };

  const handleLocalFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onUploadFiles(files);
    }
    if (localFileInputRef.current) {
      localFileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <input
        ref={localFileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.xodt,.xods,.rtf,.txt,.md,.csv,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp"
        onChange={handleLocalFilesSelected}
        className="hidden"
      />

      {/* Верхняя строка навигации модуля */}
      <div className="shrink-0 px-5 py-3 sm:px-8 border-b border-[#1a1a1a]/12 bg-[#faf9f7] flex items-center justify-between gap-3">
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
          <span className="font-mono text-[12px] font-bold text-[#004ecc] shrink-0">[ 05 ]</span>
          <span className="font-display text-base sm:text-lg font-bold uppercase tracking-[0.03em] text-[#1a1a1a] truncate">
            Работа с документом
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:block font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/55 tabular-nums">
            Файлов: {snapshot.sources.length} · Страниц: {snapshot.totalPagesOrSheets}
            {snapshot.diskMounts.length > 0 ? ` · Диск: ${snapshot.diskMounts.length}` : ''}
          </div>
          <button
            type="button"
            onClick={() => setMobileSourcesOpen((prev) => !prev)}
            className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-1 border border-[#1a1a1a]/20 font-mono text-[10.5px] uppercase tracking-[0.05em] text-[#1a1a1a] cursor-pointer"
          >
            <PanelLeft className="w-3.5 h-3.5 shrink-0" />
            <span>Источники ({snapshot.sources.length})</span>
          </button>
        </div>
      </div>

      {/* Основная 2-колоночная область: компактная панель источников слева + рабочее полотно диалога справа */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* Левая панель источников (сессия + прямой путь на диске без копирования) */}
        <aside
          className={`${
            mobileSourcesOpen ? 'flex' : 'hidden lg:flex'
          } w-full lg:w-[300px] xl:w-[320px] shrink-0 border-b lg:border-b-0 lg:border-r border-[#1a1a1a]/12 bg-[#faf9f7]/60 flex-col min-h-0 max-h-[260px] lg:max-h-none`}
        >
          {/* Панель добавления источников */}
          <div className="shrink-0 p-4 border-b border-[#1a1a1a]/10 space-y-3">
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => localFileInputRef.current?.click()}
              className="w-full py-2.5 px-3 bg-[#004ecc] hover:bg-[#003da1] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[0.88rem] font-medium uppercase tracking-[0.08em] transition-colors flex items-center justify-between gap-2 cursor-pointer"
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <FileUp className="w-3.5 h-3.5 shrink-0" />
                <span>Загрузить файлы</span>
              </span>
              <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
            </button>

            <form onSubmit={handleMountSubmit} className="space-y-1.5">
              <label
                htmlFor="doc-work-disk-path"
                className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.05em] text-[#1a1a1a]/60"
              >
                <HardDrive className="w-3 h-3 shrink-0 text-[#004ecc]" />
                <span>Папка или файл на диске</span>
              </label>
              <div className="flex items-stretch gap-1.5">
                <input
                  id="doc-work-disk-path"
                  type="text"
                  value={diskPathInput}
                  onChange={(e) => setDiskPathInput(e.target.value)}
                  placeholder="D:\Договоры или /home/docs"
                  className="flex-1 min-w-0 px-2.5 py-1.5 border border-[#1a1a1a]/20 focus:border-[#004ecc] focus:outline-none bg-white text-[12px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/35 font-mono"
                />
                <button
                  type="submit"
                  disabled={isProcessing || !diskPathInput.trim()}
                  title="Подключить папку или файл напрямую с диска без копирования"
                  className="px-2.5 py-1.5 border border-[#1a1a1a] bg-white hover:bg-[#1a1a1a] hover:text-white disabled:opacity-40 disabled:pointer-events-none font-mono text-[10px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer shrink-0"
                >
                  Открыть
                </button>
              </div>
              <p className="text-[11px] leading-snug text-[#1a1a1a]/50">
                Чтение напрямую с диска без копирования. Путь можно писать и прямо в запросе.
              </p>
            </form>
          </div>

          {/* Список проиндексированных документов сессии */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
            {snapshot.sources.length === 0 ? (
              <div className="py-6 text-[12px] leading-relaxed text-[#1a1a1a]/55">
                Загрузите один или несколько документов в сессию либо укажите путь к папке на диске.
                Поддерживаются PDF (включая сканы), DOCX, DOC, XLSX, XLS, ODT, ODS, RTF, TXT.
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 pb-1">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.05em] text-[#1a1a1a]/55 tabular-nums">
                    {selectedSourceIds.length > 0
                      ? `Выбрано: ${selectedSourceIds.length} из ${snapshot.sources.length}`
                      : `Все документы (${snapshot.sources.length})`}
                  </span>
                  <div className="flex items-center gap-2">
                    {selectedSourceIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedSourceIds([])}
                        className="font-mono text-[10px] uppercase text-[#004ecc] hover:underline cursor-pointer"
                      >
                        Сбросить
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => onRemoveSource(undefined)}
                      title="Очистить все документы сессии"
                      className="inline-flex items-center gap-1 font-mono text-[10px] uppercase text-[#1a1a1a]/50 hover:text-[#b91c1c] cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Очистить</span>
                    </button>
                  </div>
                </div>

                {snapshot.sources.map((src) => {
                  const isChecked = selectedSourceIds.includes(src.id);
                  const isTocOpen = expandedTocSourceId === src.id;
                  const isDisk = src.origin === 'disk_file' || src.origin === 'disk_folder';

                  return (
                    <div
                      key={src.id}
                      className={`border-b border-[#1a1a1a]/10 pb-2.5 last:border-b-0 ${
                        isChecked ? 'bg-[#004ecc]/[0.04] -mx-2 px-2 pt-1.5' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleSelectSource(src.id)}
                          title="Ограничить поиск выбранными документами"
                          className="mt-1 accent-[#004ecc] cursor-pointer shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className="text-[12.5px] font-semibold text-[#1a1a1a] truncate"
                            title={src.diskPath || src.fileName}
                          >
                            {src.fileName}
                          </div>
                          <div className="font-mono text-[10px] text-[#1a1a1a]/55 tabular-nums mt-0.5 flex flex-wrap items-center gap-x-1.5">
                            <span>{src.extension}</span>
                            <span>·</span>
                            <span>{src.pagesOrSheets} стр.</span>
                            <span>·</span>
                            <span>{formatBytesShort(src.sizeBytes)}</span>
                            {src.usedOcr && (
                              <>
                                <span>·</span>
                                <span className="text-[#004ecc]">OCR</span>
                              </>
                            )}
                            {isDisk && (
                              <>
                                <span>·</span>
                                <span className="inline-flex items-center gap-0.5 text-[#1a1a1a]/75">
                                  <FolderOpen className="w-2.5 h-2.5" />
                                  Диск
                                </span>
                              </>
                            )}
                          </div>

                          {src.toc.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedTocSourceId((prev) => (prev === src.id ? null : src.id))
                              }
                              className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em] text-[#004ecc] hover:underline cursor-pointer"
                            >
                              {isTocOpen ? (
                                <ChevronDown className="w-3 h-3 shrink-0" />
                              ) : (
                                <ChevronRight className="w-3 h-3 shrink-0" />
                              )}
                              <BookOpen className="w-2.5 h-2.5 shrink-0" />
                              <span>Оглавление ({src.toc.length})</span>
                            </button>
                          )}
                        </div>

                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => onRemoveSource(src.id)}
                          aria-label={`Удалить ${src.fileName}`}
                          className="p-0.5 text-[#1a1a1a]/35 hover:text-[#b91c1c] cursor-pointer shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {isTocOpen && src.toc.length > 0 && (
                        <ul className="mt-2 ml-5 space-y-1 border-l border-[#1a1a1a]/15 pl-2.5">
                          {src.toc.slice(0, 14).map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={() => handleTocItemClick(src, item.title)}
                                className="w-full text-left text-[11.5px] leading-snug text-[#1a1a1a]/75 hover:text-[#004ecc] transition-colors cursor-pointer flex items-baseline justify-between gap-2"
                              >
                                <span className="truncate">{item.title}</span>
                                <span className="font-mono text-[9.5px] text-[#1a1a1a]/40 shrink-0 tabular-nums">
                                  {item.location}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </aside>

        {/* Правое рабочее полотно диалога с Харнесом */}
        <section className="flex-1 min-h-0 flex flex-col bg-white">
          {/* Лента ответов — единственный скроллируемый контейнер в правой части */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 sm:px-8 space-y-6">
            {answers.length === 0 ? (
              <div className="h-full flex flex-col justify-center max-w-[680px]">
                <div className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[#004ecc] mb-2">
                  Алгоритмический Харнес больших документов
                </div>
                <h2 className="font-display text-2xl sm:text-[1.75rem] font-bold uppercase tracking-[0.02em] leading-tight text-[#1a1a1a] mb-3">
                  Поиск, извлечение данных и сборка файлов без перегрузки памяти модели
                </h2>
                <p className="text-[13.5px] leading-[1.6] text-[#555555] mb-5">
                  Харнес самостоятельно индексирует большие PDF, сканы, Word, Excel и целые папки на диске, находит нужные страницы, извлекает суммы, даты, реквизиты и таблицы, а в локальную модель передаёт только точные факты.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
                  {STARTER_PROMPTS.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      disabled={isProcessing || snapshot.sources.length === 0}
                      onClick={() => handleQuickPrompt(item.query)}
                      className="text-left p-3 border border-[#1a1a1a]/15 hover:border-[#004ecc] hover:bg-[#faf9f7] disabled:opacity-45 disabled:pointer-events-none transition-colors cursor-pointer flex items-center justify-between gap-2"
                    >
                      <span className="text-[12.5px] font-medium text-[#1a1a1a]">{item.label}</span>
                      <ArrowUpRight className="w-3.5 h-3.5 text-[#004ecc] shrink-0" />
                    </button>
                  ))}
                </div>

                <div className="font-mono text-[11px] leading-relaxed text-[#1a1a1a]/55 border-l-2 border-[#004ecc] pl-3">
                  Пример запроса к папке на диске без загрузки файлов:
                  <div className="text-[#1a1a1a] mt-0.5">
                    «Найди в папке D:\Договоры\2026 все суммы и сроки оплаты и собери таблицу в Excel»
                  </div>
                </div>
              </div>
            ) : (
              answers.map((ans) => {
                const citesOpen = Boolean(expandedCitationsId[ans.id]);
                return (
                  <article
                    key={ans.id}
                    className="pb-6 border-b border-[#1a1a1a]/12 last:border-b-0 space-y-3.5"
                  >
                    {/* Вопрос пользователя */}
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="font-display text-[1.05rem] font-bold uppercase tracking-[0.02em] text-[#1a1a1a]">
                        {ans.query}
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-[#1a1a1a]/45 shrink-0 tabular-nums">
                        {ans.processingTimeMs} мс
                      </span>
                    </div>

                    {/* Компактная строка шагов Харнеса */}
                    {ans.harnessSteps.length > 0 && (
                      <div className="font-mono text-[10.5px] text-[#1a1a1a]/55 leading-relaxed">
                        {ans.harnessSteps.join(' · ')}
                      </div>
                    )}

                    {/* Основной структурированный ответ */}
                    <div className="text-[13.5px] leading-[1.65] text-[#1a1a1a] whitespace-pre-wrap">
                      {ans.answerText}
                    </div>

                    {/* Таблица извлечённых сумм, дат и реквизитов */}
                    {ans.entities.length > 0 && (
                      <div className="pt-1">
                        <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#1a1a1a]/65 mb-2">
                          Извлечённые значения ({ans.entities.length})
                        </div>
                        <div className="overflow-x-auto border border-[#1a1a1a]/15">
                          <table className="w-full text-left border-collapse text-[12px]">
                            <thead>
                              <tr className="bg-[#faf9f7] border-b border-[#1a1a1a]/15 font-mono text-[10px] uppercase tracking-[0.05em] text-[#1a1a1a]/65">
                                <th className="py-1.5 px-2.5">Тип</th>
                                <th className="py-1.5 px-2.5">Значение</th>
                                <th className="py-1.5 px-2.5">Источник</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ans.entities.slice(0, 14).map((ent, idx) => (
                                <tr
                                  key={`${ent.kind}-${ent.value}-${idx}`}
                                  className="border-b border-[#1a1a1a]/10 last:border-b-0"
                                >
                                  <td className="py-1.5 px-2.5 font-mono text-[11px] text-[#1a1a1a]/65 whitespace-nowrap">
                                    {ent.label}
                                  </td>
                                  <td className="py-1.5 px-2.5 font-semibold text-[#1a1a1a] tabular-nums">
                                    {ent.value}
                                  </td>
                                  <td className="py-1.5 px-2.5 font-mono text-[10.5px] text-[#1a1a1a]/55 whitespace-nowrap">
                                    {ent.fileName} · {ent.location}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Предпросмотр найденных таблиц */}
                    {ans.tables.length > 0 && (
                      <div className="pt-1 space-y-3">
                        {ans.tables.slice(0, 2).map((tbl, tIdx) => (
                          <div key={`${tbl.fileName}-${tbl.location}-${tIdx}`}>
                            <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#1a1a1a]/65 mb-1.5">
                              Таблица: {tbl.fileName} · {tbl.location} (строк: {tbl.totalRowCount})
                            </div>
                            <div className="overflow-x-auto border border-[#1a1a1a]/15">
                              <table className="w-full text-left border-collapse text-[11.5px] tabular-nums">
                                <thead>
                                  <tr className="bg-[#faf9f7] border-b border-[#1a1a1a]/15">
                                    {tbl.headers.slice(0, 8).map((h, hIdx) => (
                                      <th
                                        key={hIdx}
                                        className="py-1.5 px-2 font-mono text-[10px] font-bold uppercase text-[#1a1a1a]/70"
                                      >
                                        {h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {tbl.rows.slice(0, 8).map((row, rIdx) => (
                                    <tr
                                      key={rIdx}
                                      className="border-b border-[#1a1a1a]/10 last:border-b-0"
                                    >
                                      {row.slice(0, 8).map((cell, cIdx) => (
                                        <td key={cIdx} className="py-1.5 px-2 text-[#1a1a1a]">
                                          {cell}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Раскрываемые источники и точные цитаты */}
                    {ans.citations.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedCitationsId((prev) => ({
                              ...prev,
                              [ans.id]: !prev[ans.id],
                            }))
                          }
                          className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#004ecc] hover:underline cursor-pointer"
                        >
                          {citesOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>Источники и цитаты ({ans.citations.length})</span>
                        </button>

                        {citesOpen && (
                          <div className="mt-2 space-y-2 border-l-2 border-[#1a1a1a]/15 pl-3">
                            {ans.citations.map((cite, cIdx) => (
                              <div key={`${cite.sourceId}-${cIdx}`} className="text-[12px]">
                                <div className="font-mono text-[10.5px] font-bold text-[#1a1a1a]/75">
                                  {cite.fileName} · {cite.location}
                                  {cite.sectionHeading ? ` · ${cite.sectionHeading}` : ''}
                                </div>
                                <div className="text-[#444444] leading-relaxed mt-0.5">
                                  {cite.excerpt}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Панель действий: скачать готовую сборку / собрать Word / Excel / копировать / в Деловой стиль */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {ans.generatedDocument && (
                        <button
                          type="button"
                          onClick={() =>
                            triggerBase64Download(
                              ans.generatedDocument!.downloadBase64,
                              ans.generatedDocument!.fileName,
                              ans.generatedDocument!.mimeType
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#004ecc] hover:bg-[#003da1] text-white font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Download className="w-3.5 h-3.5 shrink-0" />
                          <span>Скачать {ans.generatedDocument.fileName}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => onExportOffice(ans, 'docx')}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap"
                      >
                        <FileText className="w-3.5 h-3.5 shrink-0" />
                        <span>Собрать Word</span>
                      </button>

                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => onExportOffice(ans, 'xlsx')}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
                        <span>Собрать Excel</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopyAnswer(ans)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {copiedAnswerId === ans.id ? (
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

                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => onSendAnswerToBusinessStyle(ans.answerText)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#004ecc]/30 hover:border-[#004ecc] text-[#004ecc] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap"
                      >
                        <span>В «Деловой стиль»</span>
                        <ArrowUpRight className="w-3 h-3 shrink-0" />
                      </button>
                    </div>
                  </article>
                );
              })
            )}
            <div ref={feedEndRef} />
          </div>

          {/* Нижняя строка ввода вопроса или команды Харнесу */}
          <form
            onSubmit={handleQuerySubmit}
            className="shrink-0 p-4 sm:px-8 sm:py-4 border-t border-[#1a1a1a]/12 bg-[#faf9f7] flex items-center gap-2.5"
          >
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              disabled={isProcessing}
              placeholder="Спросите по документам или укажите путь к папке на диске (например: в папке D:\Акты найди суммы)..."
              className="flex-1 min-w-0 px-3.5 py-2.5 border border-[#1a1a1a]/25 focus:border-[#004ecc] focus:outline-none bg-white text-[13px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/40"
            />
            <button
              type="submit"
              disabled={isProcessing || !queryInput.trim()}
              className="px-5 py-2.5 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[0.92rem] font-medium uppercase tracking-[0.08em] transition-colors inline-flex items-center gap-2 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <span>Выполнить</span>
              <Send className="w-3.5 h-3.5 shrink-0" />
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
