import React, { useRef, useState } from 'react';
import { Check, Download, FileCheck2, FileUp } from 'lucide-react';
import { DocumentProofreadResult } from './types/harness.types';
import {
  apiLoadSampleDocument,
  apiProofreadDocument,
  triggerBase64Download,
} from './services/harnessApi.service';

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>('');
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
          : 'Не удалось обработать файл. Проверьте формат (.docx, .xlsx, .pptx).'
      );
    } finally {
      setIsProcessing(false);
      setProgress(0);
      setCurrentFileName('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    await runWithProgressBar(file.name, () => apiProofreadDocument(file));
  };

  const handleDemoCheck = async () => {
    await runWithProgressBar('Служебная_записка.docx', () => apiLoadSampleDocument('docx'));
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

      {/* Верхняя минималистичная подпись */}
      <header className="shrink-0 pt-6 px-6 text-center">
        <span className="text-sm font-medium text-slate-400 tracking-tight">
          Офисный помощник
        </span>
      </header>

      {/* Центральная зона: одна главная кнопка и полоса загрузки */}
      <main className="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-md flex flex-col items-center text-center">
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-7 px-8 rounded-2xl bg-sky-600 hover:bg-sky-500 active:scale-[0.99] disabled:opacity-60 disabled:pointer-events-none text-white shadow-lg transition-all flex flex-col items-center justify-center gap-3 cursor-pointer"
          >
            <FileUp className="w-8 h-8 text-sky-100" />
            <span className="text-xl font-bold tracking-tight whitespace-nowrap">
              Исправить русский язык
            </span>
            <span className="text-xs font-normal text-sky-100/80">
              Word (.docx) · Excel (.xlsx) · PowerPoint (.pptx)
            </span>
          </button>

          {/* Полоса загрузки при обработке файла */}
          {isProcessing && (
            <div className="w-full mt-5 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400 tabular-nums">
                <span className="truncate max-w-[260px]">Проверка: {currentFileName}</span>
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

          {/* Сообщение об ошибке с кнопкой быстрого теста */}
          {error && !isProcessing && (
            <div className="w-full mt-4 p-3 rounded-xl bg-red-950/60 border border-red-800/80 text-xs text-red-200 flex items-center justify-between gap-3">
              <span className="text-left">{error}</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 bg-red-900 hover:bg-red-800 text-white rounded-lg font-medium shrink-0"
              >
                Выбрать файл
              </button>
            </div>
          )}

          {/* Незаметная ссылка для мгновенной проверки на тестовом документе, если под рукой нет файла */}
          {!isProcessing && completedFiles.length === 0 && (
            <button
              type="button"
              onClick={handleDemoCheck}
              className="mt-4 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Проверить работу на тестовом документе Word
            </button>
          )}
        </div>
      </main>

      {/* Нижняя плашка: готовые обработанные файлы с кнопкой «Скачать» */}
      <footer className="shrink-0 px-6 pb-6">
        <div className="max-w-xl mx-auto">
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
                        Готовый файл · Исправлено ошибок: {item.totalIssuesFixed} · Оформление сохранено
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      triggerBase64Download(
                        item.downloadBase64,
                        `Исправлено_${item.fileName}`,
                        item.mimeType
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Скачать
                  </button>
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
