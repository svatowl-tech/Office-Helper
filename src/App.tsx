import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FileUp,
  Mic,
  Pause,
  Play,
  ScanText,
  Square,
} from 'lucide-react';
import { DocumentProofreadResult, OcrOutputFormat } from './types/harness.types';
import {
  apiLoadSampleDocument,
  apiLoadSampleOcrPdf,
  apiProofreadDocument,
  apiRecognizePdfOrImage,
  apiTranscribeWhisperAudio,
  triggerBase64Download,
} from './services/harnessApi.service';
import { WhisperWavRecorder } from './utils/wavRecorder';

type DictationStatus = 'idle' | 'recording' | 'paused';

function formatElapsedTimer(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrInputRef = useRef<HTMLInputElement | null>(null);
  const wavRecorderRef = useRef<WhisperWavRecorder | null>(null);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [ocrOutputFormat, setOcrOutputFormat] = useState<OcrOutputFormat>('docx');
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>('idle');
  const [dictationElapsedSec, setDictationElapsedSec] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [completedFiles, setCompletedFiles] = useState<DocumentProofreadResult[]>([]);

  useEffect(() => {
    if (dictationStatus === 'idle') return;

    const interval = window.setInterval(() => {
      if (wavRecorderRef.current) {
        setDictationElapsedSec(wavRecorderRef.current.getElapsedSeconds());
      }
    }, 300);

    return () => {
      window.clearInterval(interval);
    };
  }, [dictationStatus]);

  const runWithProgressBar = async (
    fileNameLabel: string,
    task: () => Promise<DocumentProofreadResult>
  ) => {
    setError(null);
    setIsProcessing(true);
    setCurrentFileName(fileNameLabel);
    setProgress(12);

    const timer = window.setInterval(() => {
      setProgress((prev) => (prev < 88 ? prev + 14 : prev));
    }, 120);

    try {
      const result = await task();
      window.clearInterval(timer);
      setProgress(100);
      await new Promise((resolve) => setTimeout(resolve, 220));
      setCompletedFiles((prev) => [result, ...prev]);
    } catch (err) {
      window.clearInterval(timer);
      setError(
        err instanceof Error
          ? err.message
          : 'Не удалось обработать файл. Проверьте формат (.doc, .docx, .xls, .xlsx, .ppt, .pptx, .odt, .ods, .odp, .xodt, .xods, .rtf, .pdf, .png, .jpg).'
      );
    } finally {
      setIsProcessing(false);
      setProgress(0);
      setCurrentFileName('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      if (ocrInputRef.current) {
        ocrInputRef.current.value = '';
      }
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    await runWithProgressBar(file.name, () => apiProofreadDocument(file));
  };

  const handleOcrFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    await runWithProgressBar(file.name, () => apiRecognizePdfOrImage(file, ocrOutputFormat));
  };

  const handleStartDictation = async () => {
    if (isProcessing) return;
    setError(null);

    const recorder = new WhisperWavRecorder();
    wavRecorderRef.current = recorder;
    await recorder.start();
    setDictationElapsedSec(0);
    setDictationStatus('recording');
  };

  const handleTogglePauseDictation = () => {
    const recorder = wavRecorderRef.current;
    if (!recorder) return;

    if (dictationStatus === 'recording') {
      recorder.pause();
      setDictationElapsedSec(recorder.getElapsedSeconds());
      setDictationStatus('paused');
    } else if (dictationStatus === 'paused') {
      recorder.resume();
      setDictationStatus('recording');
    }
  };

  const handleFinishDictation = async () => {
    const recorder = wavRecorderRef.current;
    if (!recorder) return;

    const { wavBlob, durationSeconds } = await recorder.stop();
    wavRecorderRef.current = null;
    setDictationStatus('idle');
    setDictationElapsedSec(0);

    await runWithProgressBar(
      `Распознавание речи Whisper (${formatElapsedTimer(durationSeconds)}) → Улучшение текста → Word (.docx)`,
      () => apiTranscribeWhisperAudio(wavBlob, durationSeconds)
    );
  };

  const handleDemoCheck = async () => {
    await runWithProgressBar('Служебная_записка.docx', () => apiLoadSampleDocument('docx'));
  };

  const handleDemoOcrCheck = async () => {
    await runWithProgressBar('Скан_ведомости_ЗСПД.pdf', () => apiLoadSampleOcrPdf(ocrOutputFormat));
  };

  return (
    <div className="h-dvh w-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col justify-between select-none">
      {/* Скрытый инпут выбора любого офисного файла (MS Office, LibreOffice, OpenOffice, МойОфис) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.xodt,.xods,.rtf,.txt"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Скрытый инпут выбора PDF или картинки для распознавания в Word / Excel */}
      <input
        ref={ocrInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp"
        onChange={handleOcrFileChange}
        className="hidden"
      />

      {/* Верхняя минималистичная подпись */}
      <header className="shrink-0 pt-5 px-6 text-center">
        <span className="text-sm font-medium text-slate-400 tracking-tight">
          Офисный помощник
        </span>
      </header>

      {/* Центральная зона: три главные кнопки («Исправить русский язык», «Распознать PDF (картинку)», «Надиктовать текст») + полоса загрузки */}
      <main className="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-4xl flex flex-col items-center text-center">
          <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
            {/* Кнопка 1: Исправить русский язык */}
            <button
              type="button"
              disabled={isProcessing || dictationStatus !== 'idle'}
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-6 px-5 rounded-2xl bg-sky-600 hover:bg-sky-500 active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none text-white shadow-lg transition-all flex flex-col items-center justify-center gap-2.5 cursor-pointer"
            >
              <FileUp className="w-7 h-7 text-sky-100" />
              <span className="text-lg font-bold tracking-tight">
                Исправить русский язык
              </span>
              <span className="text-xs font-normal text-sky-100/80">
                Word · Excel · PowerPoint · LibreOffice / МойОфис (.odt, .ods, .odp, .xodt, .xods, .rtf)
              </span>
            </button>

            {/* Кнопка 2: Распознать PDF (картинку) с выдачей Word или Excel */}
            <div className="w-full flex flex-col gap-2">
              <button
                type="button"
                disabled={isProcessing || dictationStatus !== 'idle'}
                onClick={() => ocrInputRef.current?.click()}
                className="flex-1 w-full py-5 px-5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none text-white shadow-lg transition-all flex flex-col items-center justify-center gap-2 cursor-pointer"
              >
                <ScanText className="w-7 h-7 text-indigo-100" />
                <span className="text-lg font-bold tracking-tight">
                  Распознать PDF (картинку)
                </span>
                <span className="text-xs font-normal text-indigo-100/80">
                  PDF · PNG · JPG · TIFF → в {ocrOutputFormat === 'docx' ? 'Word (.docx)' : 'Excel (.xlsx)'}
                </span>
              </button>

              {/* Компактный переключатель выходного формата (Word или Excel) */}
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800">
                <button
                  type="button"
                  disabled={isProcessing || dictationStatus !== 'idle'}
                  onClick={() => setOcrOutputFormat('docx')}
                  className={`py-1.5 px-2.5 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                    ocrOutputFormat === 'docx'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Word (.docx)</span>
                </button>
                <button
                  type="button"
                  disabled={isProcessing || dictationStatus !== 'idle'}
                  onClick={() => setOcrOutputFormat('xlsx')}
                  className={`py-1.5 px-2.5 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                    ocrOutputFormat === 'xlsx'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Excel (.xlsx)</span>
                </button>
              </div>
            </div>

            {/* Кнопка 3: Надиктовать текст (Локальный Whisper -> Улучшение и исправление -> Word .docx) */}
            {dictationStatus === 'idle' ? (
              <button
                type="button"
                disabled={isProcessing}
                onClick={handleStartDictation}
                className="w-full py-6 px-5 rounded-2xl bg-slate-900 hover:bg-slate-800/90 border border-slate-700/80 hover:border-rose-500/60 active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none text-white shadow-lg transition-all flex flex-col items-center justify-center gap-2.5 cursor-pointer group"
              >
                <div className="relative flex items-center justify-center">
                  <Mic className="w-7 h-7 text-rose-400 group-hover:text-rose-300 transition-colors" />
                </div>
                <span className="text-lg font-bold tracking-tight">
                  Надиктовать текст
                </span>
                <span className="text-xs font-normal text-slate-300/80">
                  Локальный Whisper · Улучшение и коррекция → Word (.docx)
                </span>
              </button>
            ) : (
              <div
                className={`w-full py-4 px-4 rounded-2xl border shadow-lg transition-all flex flex-col items-center justify-between gap-3 ${
                  dictationStatus === 'recording'
                    ? 'bg-slate-900/95 border-red-500/90 shadow-red-950/30'
                    : 'bg-slate-900/95 border-amber-500/80 shadow-amber-950/20'
                }`}
              >
                {/* Красный горящий индикатор записи или индикатор паузы */}
                <div className="w-full flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {dictationStatus === 'recording' ? (
                      <span className="relative flex h-3.5 w-3.5 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-80" />
                        <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-600 shadow-[0_0_12px_#ef4444]" />
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full h-3.5 w-3.5 bg-amber-500 shadow-[0_0_8px_#f59e0b] shrink-0" />
                    )}
                    <span
                      className={`text-xs font-bold tracking-tight truncate ${
                        dictationStatus === 'recording' ? 'text-red-300' : 'text-amber-300'
                      }`}
                    >
                      {dictationStatus === 'recording'
                        ? 'Идёт запись (Whisper)...'
                        : 'На паузе (остановлено)'}
                    </span>
                  </div>
                  <span className="text-xs font-mono font-bold text-slate-200 tabular-nums bg-slate-950/80 px-2 py-0.5 rounded-md border border-slate-800">
                    {formatElapsedTimer(dictationElapsedSec)}
                  </span>
                </div>

                <p className="text-[11px] text-slate-400 leading-snug">
                  {dictationStatus === 'recording'
                    ? 'Наговаривайте текст. По завершении речь пройдёт через систему улучшения и исправления в Word (.docx).'
                    : 'Распознавание приостановлено. Нажмите «Продолжить» для дозаписи или «Завершить» для выдачи Word.'}
                </p>

                {/* Кнопки управления: Пауза / Продолжить и Завершить */}
                <div className="w-full grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleTogglePauseDictation}
                    className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                      dictationStatus === 'recording'
                        ? 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700'
                        : 'bg-amber-600 hover:bg-amber-500 text-white'
                    }`}
                  >
                    {dictationStatus === 'recording' ? (
                      <>
                        <Pause className="w-3.5 h-3.5" />
                        <span>На паузу</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        <span>Продолжить</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleFinishDictation}
                    className="py-2 px-3 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Завершить</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Полоса загрузки при обработке файла или расшифровке речи */}
          {isProcessing && (
            <div className="w-full max-w-md mt-5 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400 tabular-nums">
                <span className="truncate max-w-[340px]">Обработка: {currentFileName}</span>
                <span>{progress}%</span>
              </div>
              <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-150"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Сообщение об ошибке с кнопками повторного выбора */}
          {error && !isProcessing && (
            <div className="w-full max-w-md mt-4 p-3 rounded-xl bg-red-950/60 border border-red-800/80 text-xs text-red-200 flex items-center justify-between gap-3">
              <span className="text-left">{error}</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 bg-red-900 hover:bg-red-800 text-white rounded-lg font-medium shrink-0 cursor-pointer"
              >
                Выбрать файл
              </button>
            </div>
          )}

          {/* Незаметные ссылки для мгновенной проверки на тестовом документе или PDF, если под рукой нет файла */}
          {!isProcessing && completedFiles.length === 0 && dictationStatus === 'idle' && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-4 text-xs text-slate-500">
              <button
                type="button"
                onClick={handleDemoCheck}
                className="hover:text-slate-300 transition-colors cursor-pointer"
              >
                Проверить на тестовом документе Word
              </button>
              <span className="text-slate-800">·</span>
              <button
                type="button"
                onClick={handleDemoOcrCheck}
                className="hover:text-slate-300 transition-colors cursor-pointer"
              >
                Проверить распознавание на тестовом PDF
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Нижняя плашка: готовые обработанные файлы с кнопкой «Скачать» */}
      <footer className="shrink-0 px-6 pb-6">
        <div className="max-w-3xl mx-auto">
          {completedFiles.length > 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg space-y-2 max-h-48 overflow-y-auto">
              {completedFiles.map((item, idx) => {
                const modeLabel =
                  item.operationMode === 'dictation'
                    ? 'Надиктовано (Whisper) и исправлено'
                    : item.operationMode === 'ocr'
                      ? 'Распознано (точная копия)'
                      : 'Готовый файл';

                const downloadFileName =
                  item.operationMode === 'dictation'
                    ? item.fileName
                    : `${item.operationMode === 'ocr' ? 'Распознано_' : 'Исправлено_'}${item.fileName}`;

                return (
                  <div
                    key={`${item.fileName}-${idx}`}
                    className="flex items-center justify-between gap-4 py-1.5 px-2 rounded-lg hover:bg-slate-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileCheck2 className="w-5 h-5 text-emerald-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-100 truncate">
                          {item.fileName}
                        </div>
                        <div className="text-xs text-slate-400 tabular-nums">
                          {item.operationMode === 'ocr'
                            ? `${modeLabel} · Блоков: ${item.totalSegments} · Таблицы и графика сохранены`
                            : `${modeLabel} · Чанков: ${item.totalChunksProcessed ?? item.totalSegments} · Исправлено ошибок: ${item.totalIssuesFixed} · Оформление сохранено`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          triggerBase64Download(
                            item.downloadBase64,
                            downloadFileName,
                            item.mimeType
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {item.operationMode === 'ocr' || item.operationMode === 'dictation'
                          ? `Скачать ${item.fileType === 'xlsx' ? 'Excel' : 'Word'}`
                          : 'Скачать'}
                      </button>

                      {item.secondaryDownloadBase64 && item.secondaryFileName && item.secondaryMimeType && (
                        <button
                          type="button"
                          onClick={() =>
                            triggerBase64Download(
                              item.secondaryDownloadBase64!,
                              `Распознано_${item.secondaryFileName!}`,
                              item.secondaryMimeType!
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {item.fileType === 'xlsx' ? 'Word (.docx)' : 'Excel (.xlsx)'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-slate-900 bg-slate-900/30 py-3 px-4 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
              <Check className="w-3.5 h-3.5 text-slate-600" />
              <span>Готовые файлы для скачивания появятся здесь после обработки</span>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
