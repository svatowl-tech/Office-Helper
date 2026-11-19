import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileAudio,
  FileText,
  Film,
  Upload,
} from 'lucide-react';
import { MeetingTranscriptionResult } from '../types/harness.types';
import { triggerBase64Download } from '../services/harnessApi.service';

interface MeetingTranscriptWorkspaceProps {
  result: MeetingTranscriptionResult;
  transcriptDraft: string;
  onTranscriptDraftChange: (value: string) => void;
  isProcessing: boolean;
  proofreadNote?: string | null;
  onUploadAnother: () => void;
  onProofreadTranscript: (text: string) => void;
  onSendToBusinessStyle: (text: string) => void;
  onBackToTools: () => void;
}

function formatDurationLabel(totalSeconds: number): string {
  const safe = Math.max(1, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const MeetingTranscriptWorkspace: React.FC<MeetingTranscriptWorkspaceProps> = ({
  result,
  transcriptDraft,
  onTranscriptDraftChange,
  isProcessing,
  proofreadNote,
  onUploadAnother,
  onProofreadTranscript,
  onSendToBusinessStyle,
  onBackToTools,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const textToCopy = transcriptDraft.trim();
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

  const handleDownloadTxt = () => {
    const content = transcriptDraft.trim();
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download =
      result.documentResult.secondaryFileName ||
      `${result.documentResult.fileName.replace(/\.docx$/i, '')}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const isVideo = result.mediaKind === 'video';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Верхняя строка навигации — всегда есть возврат к инструментам */}
      <div className="shrink-0 px-6 py-3 sm:px-8 border-b border-[#1a1a1a]/12 bg-[#faf9f7] flex flex-wrap items-center justify-between gap-3">
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
          <span className="font-mono text-[12px] font-bold text-[#004ecc] shrink-0">[ 03 ]</span>
          <span className="font-display text-base sm:text-lg font-bold uppercase tracking-[0.03em] text-[#1a1a1a] truncate">
            Расшифровка записи совещания
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/65 min-w-0">
          {isVideo ? (
            <Film className="w-3.5 h-3.5 text-[#004ecc] shrink-0" />
          ) : (
            <FileAudio className="w-3.5 h-3.5 text-[#004ecc] shrink-0" />
          )}
          <span className="truncate max-w-[200px] sm:max-w-[280px]">{result.sourceFileName}</span>
          <span className="text-[#1a1a1a]/25">·</span>
          <span className="tabular-nums shrink-0">{formatDurationLabel(result.durationSeconds)}</span>
        </div>
      </div>

      {/* Основное полотно расшифрованного текста */}
      <div className="flex-1 min-h-0 p-5 sm:p-7 flex flex-col bg-white">
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2.5 mb-3">
          <div className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[#1a1a1a]/70">
            {isVideo
              ? `ИЗВЛЕЧЕНО ИЗ ВИДЕО (${result.mediaExtension}) → ТЕКСТ`
              : `АУДИОЗАПИСЬ (${result.mediaExtension}) → ТЕКСТ`}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isProcessing}
              onClick={onUploadAnother}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5 shrink-0" />
              <span>Другая запись</span>
            </button>

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
              onClick={handleDownloadTxt}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#1a1a1a]/25 hover:border-[#1a1a1a] text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span>TXT</span>
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
        </div>

        <textarea
          value={transcriptDraft}
          onChange={(e) => onTranscriptDraftChange(e.target.value)}
          className="flex-1 min-h-[180px] w-full p-4 border border-[#1a1a1a] focus:border-[#004ecc] focus:outline-none bg-[#faf9f7] text-[13.5px] leading-[1.65] text-[#1a1a1a] resize-none overflow-y-auto"
        />

        <div className="shrink-0 pt-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-[10.5px] text-[#1a1a1a]/55 tabular-nums">
            СИМВОЛОВ: {transcriptDraft.length} · ФРАГМЕНТОВ: {result.chunksProcessed}
            {result.audioCodec ? ` · КОДЕК: ${result.audioCodec.toUpperCase()}` : ''}
            {proofreadNote ? ` · ${proofreadNote}` : ''}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isProcessing || transcriptDraft.trim().length === 0}
              onClick={() => onProofreadTranscript(transcriptDraft)}
              className="py-2.5 px-4 border border-[#1a1a1a]/25 hover:border-[#1a1a1a] disabled:opacity-45 disabled:pointer-events-none text-[#1a1a1a] font-mono text-[11px] font-bold uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
            >
              Исправить язык
            </button>

            <button
              type="button"
              disabled={isProcessing || transcriptDraft.trim().length === 0}
              onClick={() => onSendToBusinessStyle(transcriptDraft)}
              className="py-2.5 px-5 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[14px] font-medium uppercase tracking-[0.08em] transition-colors inline-flex items-center gap-2 cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
            >
              <span>В «Деловой стиль»</span>
              <ArrowUpRight className="w-4 h-4 shrink-0" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
