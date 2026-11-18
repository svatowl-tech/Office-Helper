import React, { useRef, useState } from 'react';
import { Check, Download, FileCheck2, FileSpreadsheet, FileText, FileUp, ScanText } from 'lucide-react';
import { DocumentProofreadResult, OcrOutputFormat } from './types/harness.types';
import {
  apiLoadSampleDocument,
  apiLoadSampleOcrPdf,
  apiProofreadDocument,
  apiRecognizePdfOrImage,
  triggerBase64Download,
} from './services/harnessApi.service';

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrInputRef = useRef<HTMLInputElement | null>(null);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [ocrOutputFormat, setOcrOutputFormat] = useState<OcrOutputFormat>('docx');
  const [error, setError] = useState<string | null>(null);
  const [completedFiles, setCompletedFiles] = useState<DocumentProofreadResult[]>([]);

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
          : 'Не удалось обработать файл. Проверьте формат (.docx, .xlsx, .pptx, .pdf, .png, .jpg).'
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

  const handleDemoCheck = async () => {
    await runWithProgressBar('Служебная_записка.docx', () => apiLoadSampleDocument('docx'));
  };

  const handleDemoOcrCheck = async () => {
    await runWithProgressBar('Скан_ведомости_ЗСПД.pdf', () => apiLoadSampleOcrPdf(ocrOutputFormat));
  };

  return (
    <div className="h-dvh w-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col justify-between select-none">
      {/* Скрытый инпут выбора любого офисного файла (Word, Excel, PowerPoint) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx,.xlsx,.pptx,.txt"
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
      <header className="shrink-0 pt-6 px-6 text-center">
        <span className="text-sm font-medium text-slate-400 tracking-tight">
          Офисный помощник
        </span>
      </header>

      {/* Центральная зона: две главные кнопки («Исправить русский язык» и «Распознать PDF (картинку)») + полоса загрузки */}
      <main className="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-2xl flex flex-col items-center text-center">
          <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-4 items-stretch">
            {/* Кнопка 1: Исправить русский язык */}
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-7 px-6 rounded-2xl bg-sky-600 hover:bg-sky-500 active:scale-[0.99] disabled:opacity-60 disabled:pointer-events-none text-white shadow-lg transition-all flex flex-col items-center justify-center gap-3 cursor-pointer"
            >
              <FileUp className="w-8 h-8 text-sky-100" />
              <span className="text-xl font-bold tracking-tight whitespace-nowrap">
                Исправить русский язык
              </span>
              <span className="text-xs font-normal text-sky-100/80">
                Word (.docx) · Excel (.xlsx) · PowerPoint (.pptx)
              </span>
            </button>

            {/* Кнопка 2: Распознать PDF (картинку) с выдачей Word или Excel */}
            <div className="w-full flex flex-col gap-2">
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => ocrInputRef.current?.click()}
                className="flex-1 w-full py-6 px-6 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] disabled:opacity-60 disabled:pointer-events-none text-white shadow-lg transition-all flex flex-col items-center justify-center gap-2.5 cursor-pointer"
              >
                <ScanText className="w-8 h-8 text-indigo-100" />
                <span className="text-xl font-bold tracking-tight whitespace-nowrap">
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
                  disabled={isProcessing}
                  onClick={() => setOcrOutputFormat('docx')}
                  className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                    ocrOutputFormat === 'docx'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Выдать Word (.docx)</span>
                </button>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setOcrOutputFormat('xlsx')}
                  className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                    ocrOutputFormat === 'xlsx'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Выдать Excel (.xlsx)</span>
                </button>
              </div>
            </div>
          </div>

          {/* Полоса загрузки при обработке файла */}
          {isProcessing && (
            <div className="w-full max-w-md mt-5 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400 tabular-nums">
                <span className="truncate max-w-[280px]">Обработка: {currentFileName}</span>
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
          {!isProcessing && completedFiles.length === 0 && (
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

      {/* Нижняя плашка: готовые обработанные файлы с кнопкой «Скачать» (и переключением Word/Excel для распознанных файлов) */}
      <footer className="shrink-0 px-6 pb-6">
        <div className="max-w-2xl mx-auto">
          {completedFiles.length > 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg space-y-2 max-h-48 overflow-y-auto">
              {completedFiles.map((item, idx) => (
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
                        {item.operationMode === 'ocr' ? 'Распознан и проверен' : 'Готовый файл'} · Чанков: {item.totalChunksProcessed ?? item.totalSegments} · Исправлено ошибок: {item.totalIssuesFixed} · Оформление сохранено
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        triggerBase64Download(
                          item.downloadBase64,
                          `${item.operationMode === 'ocr' ? 'Распознано_' : 'Исправлено_'}${item.fileName}`,
                          item.mimeType
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {item.operationMode === 'ocr'
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
              ))}
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
