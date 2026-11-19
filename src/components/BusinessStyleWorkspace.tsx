import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileUp,
  Mic,
  Pause,
  Play,
  Square,
  Trash2,
} from 'lucide-react';
import { BusinessStyleTransformationResult } from '../types/harness.types';
import { triggerBase64Download } from '../services/harnessApi.service';

export type InlineDictationStatus = 'idle' | 'recording' | 'paused';

interface BusinessStyleWorkspaceProps {
  inputText: string;
  onInputTextChange: (value: string) => void;
  result: BusinessStyleTransformationResult | null;
  formalTextDraft: string;
  onFormalTextDraftChange: (value: string) => void;
  isProcessing: boolean;
  dictationStatus: InlineDictationStatus;
  dictationElapsedLabel: string;
  formalProofreadNote?: string | null;
  onStartDictation: () => void;
  onTogglePauseDictation: () => void;
  onStopDictationToInput: () => void;
  onTriggerFileUpload: () => void;
  onTransformText: () => void;
  onProofreadFormalDraft: () => void;
  onClearAll: () => void;
  onBackToTools: () => void;
}

const SAMPLE_INFORMAL_TEXT =
  'Привет! Слушай, вы опять накосячили в акте за прошлый месяц, сколько можно ждать исправлений?! Надо срочно переделать доки и скинуть сегодня до конца дня, а то бухгалтерия ругается и мы не успеваем закрыть счёт. Отпишись как сделаешь, спс!';

export const BusinessStyleWorkspace: React.FC<BusinessStyleWorkspaceProps> = ({
  inputText,
  onInputTextChange,
  result,
  formalTextDraft,
  onFormalTextDraftChange,
  isProcessing,
  dictationStatus,
  dictationElapsedLabel,
  formalProofreadNote,
  onStartDictation,
  onTogglePauseDictation,
  onStopDictationToInput,
  onTriggerFileUpload,
  onTransformText,
  onProofreadFormalDraft,
  onClearAll,
  onBackToTools,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const textToCopy = formalTextDraft.trim();
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = textToCopy;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Верхняя строка навигации редактора — всегда есть шаг назад */}
      <div className="shrink-0 px-6 py-3 sm:px-8 border-b border-[#1a1a1a]/12 bg-[#faf9f7] flex items-center justify-between gap-4">
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
          <span className="font-mono text-[12px] font-bold text-[#004ecc] shrink-0">[ 04 ]</span>
          <span className="font-display text-base sm:text-lg font-bold uppercase tracking-[0.03em] text-[#1a1a1a] truncate">
            Деловой стиль
          </span>
        </div>

        {result?.sourceFileName && (
          <div className="hidden sm:block font-mono text-[11px] text-[#1a1a1a]/55 truncate max-w-[260px]">
            ФАЙЛ: {result.sourceFileName}
          </div>
        )}
      </div>

      {/* Двухколоночное полотно: Исходный ввод (текст / документ / голос) → Вежливый деловой стиль */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
        {/* Левая колонка: комбинированный ввод */}
        <section className="p-5 sm:p-7 border-b lg:border-b-0 lg:border-r border-[#1a1a1a]/10 flex flex-col min-h-0">
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 mb-3">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[#1a1a1a]/70">
              Исходный текст · Ввод / Голос / Документ
            </span>

            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                disabled={isProcessing || dictationStatus !== 'idle'}
                onClick={onTriggerFileUpload}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap"
              >
                <FileUp className="w-3.5 h-3.5 shrink-0" />
                <span>Документ</span>
              </button>

              {dictationStatus === 'idle' ? (
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={onStartDictation}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#004ecc] hover:text-[#004ecc] text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap"
                >
                  <Mic className="w-3.5 h-3.5 shrink-0" />
                  <span>Надиктовать</span>
                </button>
              ) : (
                <div className="inline-flex items-center gap-1.5 px-2 py-1 border border-[#1a1a1a] bg-[#faf9f7]">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      dictationStatus === 'recording' ? 'bg-[#dc2626] animate-pulse' : 'bg-[#d97706]'
                    }`}
                  />
                  <span className="font-mono text-[10.5px] font-bold tabular-nums text-[#1a1a1a]">
                    {dictationElapsedLabel}
                  </span>
                  <button
                    type="button"
                    onClick={onTogglePauseDictation}
                    aria-label={dictationStatus === 'recording' ? 'Пауза' : 'Продолжить'}
                    className="p-1 hover:bg-[#1a1a1a] hover:text-white transition-colors cursor-pointer"
                  >
                    {dictationStatus === 'recording' ? (
                      <Pause className="w-3 h-3" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onStopDictationToInput}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#b91c1c] hover:bg-[#991b1b] text-white font-mono text-[10px] font-bold uppercase cursor-pointer whitespace-nowrap"
                  >
                    <Square className="w-2.5 h-2.5 fill-current" />
                    <span>Вставить</span>
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={isProcessing || dictationStatus !== 'idle'}
                onClick={() => onInputTextChange(SAMPLE_INFORMAL_TEXT)}
                className="px-2 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.05em] text-[#1a1a1a]/55 hover:text-[#004ecc] transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
              >
                Пример
              </button>

              {inputText.trim().length > 0 && (
                <button
                  type="button"
                  disabled={isProcessing || dictationStatus !== 'idle'}
                  onClick={onClearAll}
                  aria-label="Очистить поля"
                  className="p-1.5 text-[#1a1a1a]/45 hover:text-[#b91c1c] transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <textarea
            value={inputText}
            onChange={(e) => onInputTextChange(e.target.value)}
            placeholder="Введите или вставьте любой текст, надиктуйте голосом (текст вставится прямо сюда) либо загрузите документ — он обработается сразу..."
            className="flex-1 min-h-[160px] w-full p-4 border border-[#1a1a1a]/20 focus:border-[#004ecc] focus:outline-none bg-[#faf9f7] text-[13.5px] leading-[1.6] text-[#1a1a1a] placeholder:text-[#1a1a1a]/40 resize-none overflow-y-auto"
          />

          <div className="shrink-0 pt-3.5 flex items-center justify-between gap-3">
            <span className="font-mono text-[10.5px] text-[#1a1a1a]/45 tabular-nums">
              СИМВОЛОВ: {inputText.length}
            </span>
            <button
              type="button"
              disabled={isProcessing || dictationStatus !== 'idle' || inputText.trim().length === 0}
              onClick={onTransformText}
              className="py-3 px-6 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[15px] font-medium uppercase tracking-[0.08em] transition-colors inline-flex items-center gap-2 cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
            >
              <span>Преобразовать</span>
              <ArrowUpRight className="w-4 h-4 shrink-0" />
            </button>
          </div>
        </section>

        {/* Правая колонка: готовый вежливый деловой текст */}
        <section className="p-5 sm:p-7 flex flex-col min-h-0 bg-white">
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 mb-3">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[#004ecc]">
              Официальный деловой стиль
            </span>

            {result && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a] bg-white hover:bg-[#1a1a1a] hover:text-white text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 shrink-0" />
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
                  onClick={() =>
                    triggerBase64Download(
                      result.documentResult.downloadBase64,
                      result.documentResult.fileName,
                      result.documentResult.mimeType
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#1a1a1a] hover:bg-[#004ecc] text-white font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>Word (.docx)</span>
                </button>
              </div>
            )}
          </div>

          {formalTextDraft ? (
            <textarea
              value={formalTextDraft}
              onChange={(e) => onFormalTextDraftChange(e.target.value)}
              className="flex-1 min-h-[160px] w-full p-4 border border-[#1a1a1a] focus:border-[#004ecc] focus:outline-none bg-white text-[13.5px] leading-[1.65] text-[#1a1a1a] resize-none overflow-y-auto"
            />
          ) : (
            <div className="flex-1 min-h-[160px] border border-dashed border-[#1a1a1a]/20 bg-[#faf9f7]/60 p-6 flex flex-col items-center justify-center text-center gap-2">
              <div className="font-display text-sm uppercase tracking-[0.06em] text-[#1a1a1a]/65">
                Готовый официальный текст появится здесь
              </div>
              <p className="text-[12.5px] text-[#555555] max-w-[360px] leading-relaxed">
                Введите текст слева, надиктуйте голосом или загрузите документ — модуль сохранит основную мысль и переведёт её в вежливый деловой стиль.
              </p>
            </div>
          )}

          <div className="shrink-0 pt-3.5 flex items-center justify-between gap-3 min-h-[44px]">
            {result ? (
              <div className="font-mono text-[10.5px] text-[#1a1a1a]/60 truncate">
                УЛУЧШЕНИЙ: {result.improvementsCount}
                {formalProofreadNote
                  ? ` · ${formalProofreadNote}`
                  : result.appliedTransformations.length > 0
                    ? ` · ${result.appliedTransformations.slice(0, 2).join(' · ')}`
                    : ''}
              </div>
            ) : (
              <div className="font-mono text-[10.5px] text-[#1a1a1a]/40 uppercase">
                ГОТОВО К ОФИЦИАЛЬНОЙ ОТПРАВКЕ И СКАЧИВАНИЮ В DOCX
              </div>
            )}

            {formalTextDraft.trim().length > 0 && (
              <button
                type="button"
                disabled={isProcessing}
                onClick={onProofreadFormalDraft}
                className="px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] disabled:opacity-45 disabled:pointer-events-none text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                Проверить язык
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
