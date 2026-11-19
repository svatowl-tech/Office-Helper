import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Download,
  FileUp,
  Maximize2,
  Mic,
  Pause,
  Play,
  Square,
  Upload,
  X,
} from 'lucide-react';
import {
  BusinessStyleTransformationResult,
  DocumentProofreadResult,
  MeetingTranscriptionResult,
  OcrOutputFormat,
} from './types/harness.types';
import {
  apiLoadSampleDocument,
  apiLoadSampleOcrPdf,
  apiProofreadDocument,
  apiProofreadText,
  apiRecognizePdfOrImage,
  apiTranscribeMeetingMedia,
  apiTranscribeWhisperAudio,
  apiTranscribeWhisperToText,
  apiTransformBusinessStyleDocument,
  apiTransformBusinessStyleText,
  triggerBase64Download,
} from './services/harnessApi.service';
import { WhisperWavRecorder } from './utils/wavRecorder';
import { LiveSpeechHintCapturer } from './utils/liveSpeechHint';
import {
  base64ToFile,
  formatPipelineTrail,
  getNextToolHandoffs,
  HandoffTargetTool,
  resolveResultTrail,
} from './utils/toolPipeline';
import { BusinessStyleWorkspace } from './components/BusinessStyleWorkspace';
import { MeetingTranscriptWorkspace } from './components/MeetingTranscriptWorkspace';

type DictationStatus = 'idle' | 'recording' | 'paused';
type ActiveWorkspaceView = 'tools' | 'business_style' | 'meeting_transcript';

function formatElapsedTimer(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrInputRef = useRef<HTMLInputElement | null>(null);
  const meetingMediaInputRef = useRef<HTMLInputElement | null>(null);
  const styleDocInputRef = useRef<HTMLInputElement | null>(null);
  const wavRecorderRef = useRef<WhisperWavRecorder | null>(null);
  const styleWavRecorderRef = useRef<WhisperWavRecorder | null>(null);
  const styleSpeechCapturerRef = useRef<LiveSpeechHintCapturer | null>(null);
  const styleBaseTextBeforeDictationRef = useRef<string>('');

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [ocrOutputFormat, setOcrOutputFormat] = useState<OcrOutputFormat>('docx');
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>('idle');
  const [dictationElapsedSec, setDictationElapsedSec] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [completedFiles, setCompletedFiles] = useState<DocumentProofreadResult[]>([]);

  // Активный экран: главная сетка инструментов, расшифровка записи совещания или редактор делового стиля
  const [activeWorkspace, setActiveWorkspace] = useState<ActiveWorkspaceView>('tools');

  // Состояние расшифрованной записи совещания ([ 03 ])
  const [meetingResult, setMeetingResult] = useState<MeetingTranscriptionResult | null>(null);
  const [meetingTranscriptDraft, setMeetingTranscriptDraft] = useState<string>('');
  const [meetingProofreadNote, setMeetingProofreadNote] = useState<string | null>(null);

  // Состояние четвёртого инструмента: [ 04 ] «Деловой стиль»
  const [businessStyleInput, setBusinessStyleInput] = useState<string>('');
  const [businessStyleResult, setBusinessStyleResult] =
    useState<BusinessStyleTransformationResult | null>(null);
  const [businessStyleFormalDraft, setBusinessStyleFormalDraft] = useState<string>('');
  const [formalProofreadNote, setFormalProofreadNote] = useState<string | null>(null);
  const [styleDictationStatus, setStyleDictationStatus] = useState<DictationStatus>('idle');
  const [styleDictationElapsedSec, setStyleDictationElapsedSec] = useState<number>(0);

  // Индекс раскрытой строки «Далее →» в подвале результатов (инлайн, без выпадающих окон)
  const [expandedHandoffIdx, setExpandedHandoffIdx] = useState<number | null>(null);

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

  useEffect(() => {
    if (styleDictationStatus === 'idle') return;

    const interval = window.setInterval(() => {
      if (styleWavRecorderRef.current) {
        setStyleDictationElapsedSec(styleWavRecorderRef.current.getElapsedSeconds());
      }
    }, 300);

    return () => {
      window.clearInterval(interval);
    };
  }, [styleDictationStatus]);

  const anyDictationActive = dictationStatus !== 'idle' || styleDictationStatus !== 'idle';

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
      if (meetingMediaInputRef.current) {
        meetingMediaInputRef.current.value = '';
      }
      if (styleDocInputRef.current) {
        styleDocInputRef.current.value = '';
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
    if (isProcessing || styleDictationStatus !== 'idle') return;
    setError(null);

    try {
      const recorder = new WhisperWavRecorder();
      wavRecorderRef.current = recorder;
      await recorder.start();
      setDictationElapsedSec(0);
      setDictationStatus('recording');
    } catch (err) {
      wavRecorderRef.current = null;
      setDictationStatus('idle');
      setError(
        err instanceof Error
          ? err.message
          : 'Не удалось получить доступ к микрофону. Проверьте разрешения браузера.'
      );
    }
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
      `Whisper (${formatElapsedTimer(durationSeconds)}) → Word (.docx)`,
      () => apiTranscribeWhisperAudio(wavBlob, durationSeconds)
    );
  };

  const handleMeetingMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    await runWithProgressBar(`Расшифровка записи: ${file.name}`, async () => {
      const transcribed = await apiTranscribeMeetingMedia(file);
      setMeetingResult(transcribed);
      setMeetingTranscriptDraft(transcribed.transcriptText);
      setMeetingProofreadNote(null);
      setActiveWorkspace('meeting_transcript');
      return transcribed.documentResult;
    });
  };

  const handleProofreadMeetingTranscript = async (text: string) => {
    const clean = text.trim();
    if (!clean || isProcessing) return;
    setError(null);
    setIsProcessing(true);
    setCurrentFileName('Исправить язык — стенограмма совещания');
    setProgress(45);
    try {
      const checked = await apiProofreadText(clean);
      setMeetingTranscriptDraft(checked.correctedText);
      setMeetingProofreadNote(
        checked.issues.length > 0
          ? `ИСПРАВЛЕНО ОШИБОК: ${checked.issues.length}`
          : 'ОШИБОК НЕ НАЙДЕНО'
      );
      setProgress(100);
      await new Promise((resolve) => setTimeout(resolve, 160));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось проверить язык стенограммы.');
    } finally {
      setIsProcessing(false);
      setProgress(0);
      setCurrentFileName('');
    }
  };

  const handleSendMeetingTranscriptToBusinessStyle = async (text: string) => {
    const clean = text.trim();
    if (!clean || isProcessing) return;
    setBusinessStyleInput(clean);
    setFormalProofreadNote(null);

    await runWithProgressBar('Совещание → Деловой стиль', async () => {
      const transformed = await apiTransformBusinessStyleText(clean);
      setBusinessStyleResult(transformed);
      setBusinessStyleFormalDraft(transformed.formalText);
      setActiveWorkspace('business_style');
      return {
        ...transformed.documentResult,
        pipelineTrail: ['meeting_transcript', 'business_style'],
      };
    });
  };

  // --- Сквозная передача результата любого инструмента в следующий инструмент ---
  const handleHandoffResult = async (
    item: DocumentProofreadResult,
    target: HandoffTargetTool
  ) => {
    if (isProcessing || anyDictationActive) return;
    setExpandedHandoffIdx(null);

    const prevTrail = resolveResultTrail(item);
    const fileForNextStep = base64ToFile(item.downloadBase64, item.fileName, item.mimeType);

    if (target === 'proofread') {
      await runWithProgressBar(`Исправить язык: ${item.fileName}`, async () => {
        const proofreadResult = await apiProofreadDocument(fileForNextStep);
        return {
          ...proofreadResult,
          operationMode: 'proofread',
          pipelineTrail: [...prevTrail, 'proofread'],
        };
      });
      return;
    }

    await runWithProgressBar(`Деловой стиль: ${item.fileName}`, async () => {
      const transformed = await apiTransformBusinessStyleDocument(fileForNextStep);
      setBusinessStyleInput(transformed.originalText);
      setBusinessStyleResult(transformed);
      setBusinessStyleFormalDraft(transformed.formalText);
      setFormalProofreadNote(null);
      setActiveWorkspace('business_style');
      return {
        ...transformed.documentResult,
        pipelineTrail: [...prevTrail, 'business_style'],
      };
    });
  };

  // --- Обработчики четвёртого инструмента: [ 04 ] «Деловой стиль» ---

  const handleTransformBusinessStyleText = async () => {
    const text = businessStyleInput.trim();
    if (!text || isProcessing || anyDictationActive) return;
    setFormalProofreadNote(null);

    await runWithProgressBar('Деловой стиль — преобразование текста', async () => {
      const transformed = await apiTransformBusinessStyleText(text);
      setBusinessStyleResult(transformed);
      setBusinessStyleFormalDraft(transformed.formalText);
      setActiveWorkspace('business_style');
      return transformed.documentResult;
    });
  };

  const handleProofreadFormalDraft = async () => {
    const clean = businessStyleFormalDraft.trim();
    if (!clean || isProcessing) return;
    setError(null);
    setIsProcessing(true);
    setCurrentFileName('Исправить язык — итоговое письмо');
    setProgress(45);
    try {
      const checked = await apiProofreadText(clean);
      setBusinessStyleFormalDraft(checked.correctedText);
      setFormalProofreadNote(
        checked.issues.length > 0
          ? `ЯЗЫК ПРОВЕРЕН · ПРАВОК: ${checked.issues.length}`
          : 'ЯЗЫК ПРОВЕРЕН · БЕЗ ОШИБОК'
      );
      setProgress(100);
      await new Promise((resolve) => setTimeout(resolve, 160));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось проверить язык итогового текста.');
    } finally {
      setIsProcessing(false);
      setProgress(0);
      setCurrentFileName('');
    }
  };

  const handleBusinessStyleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormalProofreadNote(null);

    await runWithProgressBar(`Деловой стиль: ${file.name}`, async () => {
      const transformed = await apiTransformBusinessStyleDocument(file);
      setBusinessStyleInput(transformed.originalText);
      setBusinessStyleResult(transformed);
      setBusinessStyleFormalDraft(transformed.formalText);
      setActiveWorkspace('business_style');
      return transformed.documentResult;
    });
  };

  const handleStartStyleDictation = async () => {
    if (isProcessing || dictationStatus !== 'idle') return;
    setError(null);

    try {
      const recorder = new WhisperWavRecorder();
      const speechCapturer = new LiveSpeechHintCapturer();
      styleWavRecorderRef.current = recorder;
      styleSpeechCapturerRef.current = speechCapturer;
      styleBaseTextBeforeDictationRef.current = businessStyleInput.trim();

      await recorder.start();
      speechCapturer.start((liveSpokenText) => {
        if (!liveSpokenText) return;
        const base = styleBaseTextBeforeDictationRef.current;
        setBusinessStyleInput(base ? `${base}\n${liveSpokenText}` : liveSpokenText);
      });

      setStyleDictationElapsedSec(0);
      setStyleDictationStatus('recording');
    } catch (err) {
      styleWavRecorderRef.current = null;
      styleSpeechCapturerRef.current?.stop();
      styleSpeechCapturerRef.current = null;
      setStyleDictationStatus('idle');
      setError(
        err instanceof Error
          ? err.message
          : 'Не удалось начать диктовку. Проверьте разрешения микрофона.'
      );
    }
  };

  const handleTogglePauseStyleDictation = () => {
    const recorder = styleWavRecorderRef.current;
    if (!recorder) return;

    if (styleDictationStatus === 'recording') {
      recorder.pause();
      setStyleDictationElapsedSec(recorder.getElapsedSeconds());
      setStyleDictationStatus('paused');
    } else if (styleDictationStatus === 'paused') {
      recorder.resume();
      setStyleDictationStatus('recording');
    }
  };

  const handleStopStyleDictationToInput = async () => {
    const recorder = styleWavRecorderRef.current;
    if (!recorder) return;

    const liveHint = styleSpeechCapturerRef.current?.stop() || '';
    styleSpeechCapturerRef.current = null;

    const { wavBlob, durationSeconds } = await recorder.stop();
    styleWavRecorderRef.current = null;
    setStyleDictationStatus('idle');
    setStyleDictationElapsedSec(0);

    setError(null);
    setIsProcessing(true);
    setCurrentFileName(`Расшифровка диктовки (${formatElapsedTimer(durationSeconds)}) в форму`);
    setProgress(35);

    try {
      const transcript = await apiTranscribeWhisperToText(wavBlob, durationSeconds, liveHint);
      setProgress(100);
      const base = styleBaseTextBeforeDictationRef.current;
      const inserted = transcript.text.trim();
      if (inserted) {
        setBusinessStyleInput(base ? `${base}\n${inserted}` : inserted);
      }
      await new Promise((resolve) => setTimeout(resolve, 160));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось вставить надиктованный текст в форму.'
      );
    } finally {
      setIsProcessing(false);
      setProgress(0);
      setCurrentFileName('');
    }
  };

  const handleClearBusinessStyle = () => {
    setBusinessStyleInput('');
    setBusinessStyleResult(null);
    setBusinessStyleFormalDraft('');
  };

  const handleDemoCheck = async () => {
    if (isProcessing || anyDictationActive) return;
    await runWithProgressBar('Служебная_записка.docx', () => apiLoadSampleDocument('docx'));
  };

  const handleDemoOcrCheck = async () => {
    if (isProcessing || anyDictationActive) return;
    await runWithProgressBar('Скан_ведомости_ЗСПД.pdf', () => apiLoadSampleOcrPdf(ocrOutputFormat));
  };

  return (
    <div className="min-h-dvh lg:h-dvh w-screen bg-[#f2efeb] text-[#1a1a1a] p-3 sm:p-5 lg:p-8 flex items-center justify-center overflow-y-auto lg:overflow-hidden">
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

      {/* Скрытый инпут выбора аудиозаписи с диктофона или видеозаписи совещания для расшифровки */}
      <input
        ref={meetingMediaInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.wma,.amr,.3gp,.aiff,.aif,.caf,.m4b,.mp4,.mkv,.mov,.avi,.webm,.wmv,.m4v,.flv,.mpeg,.mpg,.ts,.mts,audio/*,video/*"
        onChange={handleMeetingMediaUpload}
        className="hidden"
      />

      {/* Скрытый инпут выбора документа, скана или записи для немедленного перевода в «Деловой стиль» */}
      <input
        ref={styleDocInputRef}
        type="file"
        accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.xodt,.xods,.rtf,.txt,.md,.pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp,.mp3,.wav,.m4a,.ogg,.mp4,.mkv,.mov,.webm"
        onChange={handleBusinessStyleDocUpload}
        className="hidden"
      />

      {/* Основной архитектурный фрейм — Корпоративный Архив (Variation 15) */}
      <div className="w-full max-w-[1360px] lg:h-full lg:max-h-[820px] bg-white border border-[#1a1a1a] grid grid-rows-[auto_1fr_auto] relative shadow-[24px_24px_0px_rgba(0,0,0,0.05)] lg:shadow-[40px_40px_0px_rgba(0,0,0,0.05)] overflow-hidden">
        {/* Тонкая диагональная линия в правом верхнем углу */}
        <div
          aria-hidden="true"
          className="archive-diagonal-accent absolute top-0 right-0 w-[100px] h-[100px] pointer-events-none z-0"
        />

        {/* Шапка */}
        <header className="relative z-10 px-6 py-4 sm:px-9 sm:py-6 border-b border-[#1a1a1a] flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setActiveWorkspace('tools')}
            className="text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#004ecc]"
          >
            <h1 className="font-display text-2xl sm:text-[2.1rem] font-bold uppercase tracking-[0.05em] leading-none text-[#1a1a1a]">
              Офисный Помощник
            </h1>
          </button>
          <div className="text-right font-mono text-[11px] leading-[1.45] uppercase tracking-[0.04em] text-[#1a1a1a]/60 shrink-0">
            <div>АВТОНОМНЫЙ КОНТУР</div>
            <div>DOCX · PDF · WHISPER · СТИЛЬ</div>
          </div>
        </header>

        {/* Рабочая область: 4-колоночная сетка инструментов, расшифровка записи совещания или редактор «Деловой стиль» */}
        {activeWorkspace === 'business_style' ? (
          <main className="relative z-10 flex flex-col min-h-0">
            <BusinessStyleWorkspace
              inputText={businessStyleInput}
              onInputTextChange={setBusinessStyleInput}
              result={businessStyleResult}
              formalTextDraft={businessStyleFormalDraft}
              onFormalTextDraftChange={setBusinessStyleFormalDraft}
              isProcessing={isProcessing}
              dictationStatus={styleDictationStatus}
              dictationElapsedLabel={formatElapsedTimer(styleDictationElapsedSec)}
              formalProofreadNote={formalProofreadNote}
              onStartDictation={handleStartStyleDictation}
              onTogglePauseDictation={handleTogglePauseStyleDictation}
              onStopDictationToInput={handleStopStyleDictationToInput}
              onTriggerFileUpload={() => styleDocInputRef.current?.click()}
              onTransformText={handleTransformBusinessStyleText}
              onProofreadFormalDraft={handleProofreadFormalDraft}
              onClearAll={handleClearBusinessStyle}
              onBackToTools={() => setActiveWorkspace('tools')}
            />
          </main>
        ) : activeWorkspace === 'meeting_transcript' && meetingResult ? (
          <main className="relative z-10 flex flex-col min-h-0">
            <MeetingTranscriptWorkspace
              result={meetingResult}
              transcriptDraft={meetingTranscriptDraft}
              onTranscriptDraftChange={setMeetingTranscriptDraft}
              isProcessing={isProcessing}
              proofreadNote={meetingProofreadNote}
              onUploadAnother={() => meetingMediaInputRef.current?.click()}
              onProofreadTranscript={handleProofreadMeetingTranscript}
              onSendToBusinessStyle={handleSendMeetingTranscriptToBusinessStyle}
              onBackToTools={() => setActiveWorkspace('tools')}
            />
          </main>
        ) : (
          <main className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 min-h-0">
            {/* Колонка [ 01 ]: Исправить язык */}
            <section className="p-6 xl:p-8 border-b md:border-r lg:border-b-0 border-[#1a1a1a]/10 flex flex-col justify-between transition-colors duration-200 hover:bg-[#faf9f7]">
              <div>
                <div className="font-mono text-[13px] font-bold text-[#004ecc] mb-3 tracking-[0.02em]">
                  [ 01 ]
                </div>
                <h2 className="font-display text-[1.5rem] xl:text-[1.65rem] font-bold uppercase leading-[1.1] tracking-[0.01em] text-[#1a1a1a] mb-3.5">
                  Исправить язык
                </h2>
                <p className="text-[13px] leading-[1.58] text-[#555555]">
                  Проверка орфографии и пунктуации для документов MS Office, LibreOffice и МойОфис с полным сохранением исходного оформления и таблиц.
                </p>
                <div className="mt-3.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/45">
                  DOCX · XLSX · PPTX · ODT · ODS · ODP · XODT · RTF
                </div>
              </div>

              <div className="pt-6">
                <button
                  type="button"
                  disabled={isProcessing || anyDictationActive}
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-3.5 px-4 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[0.95rem] font-medium uppercase tracking-[0.1em] transition-colors flex items-center justify-between gap-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
                >
                  <span className="whitespace-nowrap">Выбрать файл</span>
                  <ArrowUpRight className="w-4 h-4 shrink-0" />
                </button>
              </div>
            </section>

            {/* Колонка [ 02 ]: Распознать текст */}
            <section className="p-6 xl:p-8 border-b lg:border-b-0 lg:border-r border-[#1a1a1a]/10 flex flex-col justify-between transition-colors duration-200 hover:bg-[#faf9f7]">
              <div>
                <div className="font-mono text-[13px] font-bold text-[#004ecc] mb-3 tracking-[0.02em]">
                  [ 02 ]
                </div>
                <h2 className="font-display text-[1.5rem] xl:text-[1.65rem] font-bold uppercase leading-[1.1] tracking-[0.01em] text-[#1a1a1a] mb-3.5">
                  Распознать текст
                </h2>
                <p className="text-[13px] leading-[1.58] text-[#555555]">
                  Точное локальное распознавание счетов, актов, таблиц и чертежей из PDF и сканов с переносом текста RU/EN и графики на исходные места.
                </p>
                <div className="mt-3.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/45">
                  PDF · PNG · JPG · TIFF · BMP · WEBP
                </div>
              </div>

              <div className="pt-6">
                <div
                  className="grid grid-cols-2 gap-1.5 mb-2.5"
                  role="group"
                  aria-label="Формат результата распознавания"
                >
                  <button
                    type="button"
                    disabled={isProcessing || anyDictationActive}
                    onClick={() => setOcrOutputFormat('docx')}
                    className={`py-2 px-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.06em] border transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc] ${
                      ocrOutputFormat === 'docx'
                        ? 'bg-[#1a1a1a] text-white border-[#1a1a1a]'
                        : 'bg-transparent text-[#1a1a1a]/75 border-[#1a1a1a]/15 hover:border-[#1a1a1a] hover:text-[#1a1a1a]'
                    }`}
                  >
                    DOCX
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing || anyDictationActive}
                    onClick={() => setOcrOutputFormat('xlsx')}
                    className={`py-2 px-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.06em] border transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc] ${
                      ocrOutputFormat === 'xlsx'
                        ? 'bg-[#1a1a1a] text-white border-[#1a1a1a]'
                        : 'bg-transparent text-[#1a1a1a]/75 border-[#1a1a1a]/15 hover:border-[#1a1a1a] hover:text-[#1a1a1a]'
                    }`}
                  >
                    XLSX
                  </button>
                </div>

                <button
                  type="button"
                  disabled={isProcessing || anyDictationActive}
                  onClick={() => ocrInputRef.current?.click()}
                  className="w-full py-3.5 px-4 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[0.95rem] font-medium uppercase tracking-[0.1em] transition-colors flex items-center justify-between gap-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
                >
                  <span className="whitespace-nowrap">Загрузить PDF</span>
                  <ArrowUpRight className="w-4 h-4 shrink-0" />
                </button>
              </div>
            </section>

            {/* Колонка [ 03 ]: Надиктовать голосом + Загрузка записи совещания (аудио / видео) */}
            <section className="p-6 xl:p-8 border-b md:border-b-0 md:border-r border-[#1a1a1a]/10 flex flex-col justify-between transition-colors duration-200 hover:bg-[#faf9f7]">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="font-mono text-[13px] font-bold text-[#004ecc] tracking-[0.02em]">
                    [ 03 ]
                  </span>
                  {meetingResult && (
                    <button
                      type="button"
                      onClick={() => setActiveWorkspace('meeting_transcript')}
                      title="Открыть последнюю расшифровку записи совещания"
                      className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.05em] text-[#1a1a1a]/55 hover:text-[#004ecc] transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <span>Текст</span>
                      <Maximize2 className="w-3 h-3 shrink-0" />
                    </button>
                  )}
                </div>
                <h2 className="font-display text-[1.5rem] xl:text-[1.65rem] font-bold uppercase leading-[1.1] tracking-[0.01em] text-[#1a1a1a] mb-3.5">
                  Надиктовать голосом
                </h2>
                <p className="text-[13px] leading-[1.58] text-[#555555]">
                  Локальный движок Whisper переводит голосовую диктовку, записи совещаний с диктофона и аудиодорожки из видео в структурированный текст и Word.
                </p>
                <div className="mt-3.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[#1a1a1a]/45">
                  МИКРОФОН · MP3 · WAV · M4A · OGG · MP4 · MKV · MOV
                </div>
              </div>

              <div className="pt-6">
                {dictationStatus === 'idle' ? (
                  <div className="space-y-2.5">
                    <button
                      type="button"
                      disabled={isProcessing || styleDictationStatus !== 'idle'}
                      onClick={() => meetingMediaInputRef.current?.click()}
                      className="w-full py-2.5 px-3 border border-[#1a1a1a]/20 hover:border-[#1a1a1a] bg-white text-[#1a1a1a] font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
                    >
                      <Upload className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Загрузить запись совещания</span>
                    </button>

                    <button
                      type="button"
                      disabled={isProcessing || styleDictationStatus !== 'idle'}
                      onClick={handleStartDictation}
                      className="w-full py-3.5 px-4 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[0.95rem] font-medium uppercase tracking-[0.1em] transition-colors flex items-center justify-between gap-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
                    >
                      <span className="whitespace-nowrap">Начать запись</span>
                      <Mic className="w-4 h-4 shrink-0" />
                    </button>
                  </div>
                ) : (
                  <div className="border border-[#1a1a1a] bg-white p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {dictationStatus === 'recording' ? (
                          <span className="relative flex h-2.5 w-2.5 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#dc2626] opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#dc2626]" />
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full h-2.5 w-2.5 bg-[#d97706] shrink-0" />
                        )}
                        <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#1a1a1a] truncate">
                          {dictationStatus === 'recording' ? 'Запись' : 'Пауза'}
                        </span>
                      </div>
                      <span className="font-mono text-[11.5px] font-bold tabular-nums text-[#1a1a1a]">
                        {formatElapsedTimer(dictationElapsedSec)}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={handleTogglePauseDictation}
                        className="py-2 px-2 border border-[#1a1a1a] bg-white hover:bg-[#1a1a1a] hover:text-white text-[#1a1a1a] font-display text-[12px] font-medium uppercase tracking-[0.06em] transition-colors flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        {dictationStatus === 'recording' ? (
                          <>
                            <Pause className="w-3 h-3 shrink-0" />
                            <span>Пауза</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3 h-3 shrink-0" />
                            <span>Далее</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleFinishDictation}
                        className="py-2 px-2 bg-[#b91c1c] hover:bg-[#991b1b] text-white font-display text-[12px] font-medium uppercase tracking-[0.06em] transition-colors flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        <Square className="w-2.5 h-2.5 fill-current shrink-0" />
                        <span>Готово</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Колонка [ 04 ]: Деловой стиль (комбинированный ввод: текст + диктовка в поле + мгновенная обработка документа) */}
            <section className="p-6 xl:p-8 flex flex-col justify-between transition-colors duration-200 hover:bg-[#faf9f7] min-h-0">
              <div className="flex flex-col flex-1 min-h-0">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="font-mono text-[13px] font-bold text-[#004ecc] tracking-[0.02em]">
                    [ 04 ]
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveWorkspace('business_style')}
                    title="Развернуть редактор делового стиля"
                    className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.05em] text-[#1a1a1a]/55 hover:text-[#004ecc] transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <span>Редактор</span>
                    <Maximize2 className="w-3 h-3 shrink-0" />
                  </button>
                </div>

                <h2 className="font-display text-[1.5rem] xl:text-[1.65rem] font-bold uppercase leading-[1.1] tracking-[0.01em] text-[#1a1a1a] mb-2.5">
                  Деловой стиль
                </h2>

                <p className="text-[12.5px] leading-[1.5] text-[#555555] mb-3">
                  Преобразование любого текста, диктовки или документа в вежливый официальный стиль для отправки.
                </p>

                <textarea
                  value={businessStyleInput}
                  onChange={(e) => setBusinessStyleInput(e.target.value)}
                  placeholder="Напишите или вставьте текст, надиктуйте голосом либо загрузите документ..."
                  className="flex-1 min-h-[112px] w-full p-2.5 border border-[#1a1a1a]/20 focus:border-[#004ecc] focus:outline-none bg-white text-[12.5px] leading-[1.5] text-[#1a1a1a] placeholder:text-[#1a1a1a]/40 resize-none overflow-y-auto"
                />
              </div>

              <div className="pt-3 shrink-0">
                {styleDictationStatus === 'idle' ? (
                  <div className="grid grid-cols-2 gap-1.5 mb-2.5">
                    <button
                      type="button"
                      disabled={isProcessing || dictationStatus !== 'idle'}
                      onClick={() => styleDocInputRef.current?.click()}
                      className="py-2 px-2 text-center font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] border border-[#1a1a1a]/15 hover:border-[#1a1a1a] text-[#1a1a1a]/80 hover:text-[#1a1a1a] transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap"
                    >
                      <FileUp className="w-3.5 h-3.5 shrink-0" />
                      <span>Документ</span>
                    </button>

                    <button
                      type="button"
                      disabled={isProcessing || dictationStatus !== 'idle'}
                      onClick={handleStartStyleDictation}
                      className="py-2 px-2 text-center font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] border border-[#1a1a1a]/15 hover:border-[#004ecc] text-[#1a1a1a]/80 hover:text-[#004ecc] transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap"
                    >
                      <Mic className="w-3.5 h-3.5 shrink-0" />
                      <span>Диктовать</span>
                    </button>
                  </div>
                ) : (
                  <div className="border border-[#1a1a1a] bg-white px-2.5 py-2 mb-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          styleDictationStatus === 'recording'
                            ? 'bg-[#dc2626] animate-pulse'
                            : 'bg-[#d97706]'
                        }`}
                      />
                      <span className="font-mono text-[10.5px] font-bold tabular-nums text-[#1a1a1a]">
                        {formatElapsedTimer(styleDictationElapsedSec)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={handleTogglePauseStyleDictation}
                        aria-label={styleDictationStatus === 'recording' ? 'Пауза' : 'Продолжить'}
                        className="p-1 border border-[#1a1a1a]/25 hover:bg-[#1a1a1a] hover:text-white cursor-pointer"
                      >
                        {styleDictationStatus === 'recording' ? (
                          <Pause className="w-3 h-3" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={handleStopStyleDictationToInput}
                        className="px-2 py-1 bg-[#b91c1c] hover:bg-[#991b1b] text-white font-mono text-[10px] font-bold uppercase cursor-pointer whitespace-nowrap"
                      >
                        Вставить
                      </button>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  disabled={
                    isProcessing ||
                    anyDictationActive ||
                    (businessStyleInput.trim().length === 0 && !businessStyleResult)
                  }
                  onClick={() => {
                    if (businessStyleInput.trim().length > 0) {
                      handleTransformBusinessStyleText();
                    } else {
                      setActiveWorkspace('business_style');
                    }
                  }}
                  className="w-full py-3.5 px-4 bg-[#004ecc] hover:bg-[#003da1] active:bg-[#003182] disabled:opacity-45 disabled:pointer-events-none text-white font-display text-[0.95rem] font-medium uppercase tracking-[0.1em] transition-colors flex items-center justify-between gap-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#004ecc]"
                >
                  <span className="whitespace-nowrap">Преобразовать</span>
                  <ArrowUpRight className="w-4 h-4 shrink-0" />
                </button>
              </div>
            </section>
          </main>
        )}

        {/* Инвертированный подвал (статус, прогресс-бар, готовые файлы, DOC_TEST / PDF_TEST) */}
        <footer className="relative z-10 bg-[#1a1a1a] text-white px-6 py-4 sm:px-9 sm:py-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              {isProcessing ? (
                <div className="max-w-[460px]">
                  <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.04em] text-white/85 tabular-nums">
                    <span className="truncate">ОБРАБОТКА: {currentFileName}</span>
                    <span className="shrink-0">{progress}%</span>
                  </div>
                  <div className="w-full h-[3px] bg-white/15 mt-2 overflow-hidden">
                    <div
                      className="h-full bg-[#004ecc] transition-all duration-150"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              ) : error ? (
                <div className="flex items-center justify-between gap-3 bg-[#7f1d1d]/40 border border-[#ef4444]/40 px-3 py-2">
                  <span className="text-[12px] text-[#fecaca] leading-snug">{error}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setError(null)}
                      className="font-mono text-[11px] uppercase tracking-[0.05em] text-white underline underline-offset-4 hover:text-white/80 cursor-pointer whitespace-nowrap"
                    >
                      Скрыть
                    </button>
                    <button
                      type="button"
                      aria-label="Закрыть сообщение об ошибке"
                      onClick={() => setError(null)}
                      className="text-white/60 hover:text-white cursor-pointer p-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ) : completedFiles.length > 0 ? (
                <div className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.05em] text-white/75">
                  <span className="tabular-nums">
                    ГОТОВО ФАЙЛОВ: {completedFiles.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCompletedFiles([])}
                    className="text-white/45 hover:text-white transition-colors cursor-pointer"
                  >
                    ОЧИСТИТЬ
                  </button>
                </div>
              ) : (
                <div className="text-[13px] text-white/70">
                  Ожидание процесса обработки. Ссылка появится здесь.
                </div>
              )}
            </div>

            {/* Правые утилитарные ссылки для быстрой проверки */}
            <div className="flex items-center gap-5 shrink-0 font-mono text-[11px] uppercase tracking-[0.06em]">
              <button
                type="button"
                disabled={isProcessing || anyDictationActive}
                onClick={handleDemoCheck}
                className="text-white/65 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                DOC_TEST
              </button>
              <button
                type="button"
                disabled={isProcessing || anyDictationActive}
                onClick={handleDemoOcrCheck}
                className="text-white/65 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                PDF_TEST
              </button>
            </div>
          </div>

          {/* Список готовых документов (ограничен по высоте, скролл только внутри списка) */}
          {completedFiles.length > 0 && (
            <div className="mt-3.5 pt-3 border-t border-white/15 space-y-2 max-h-40 overflow-y-auto pr-1">
              {completedFiles.map((item, idx) => {
                const modeLabel =
                  item.operationMode === 'dictation'
                    ? 'Whisper → Word'
                    : item.operationMode === 'meeting_transcript'
                      ? 'Запись совещания → Текст'
                      : item.operationMode === 'ocr'
                        ? 'Распознано (точная копия)'
                        : item.operationMode === 'business_style'
                          ? 'Деловой стиль'
                          : 'Готовый файл';

                const chainTrail = formatPipelineTrail(item.pipelineTrail);
                const nextSteps = getNextToolHandoffs(item);
                const isHandoffOpen = expandedHandoffIdx === idx;

                const downloadFileName =
                  item.operationMode === 'dictation' ||
                  item.operationMode === 'meeting_transcript' ||
                  item.operationMode === 'business_style'
                    ? item.fileName
                    : `${item.operationMode === 'ocr' ? 'Распознано_' : 'Исправлено_'}${item.fileName}`;

                const secondaryIsTxt = Boolean(
                  item.secondaryFileName && item.secondaryFileName.toLowerCase().endsWith('.txt')
                );
                const secondaryDownloadName = item.secondaryFileName
                  ? item.operationMode === 'ocr'
                    ? `Распознано_${item.secondaryFileName}`
                    : item.secondaryFileName
                  : '';

                return (
                  <div
                    key={`${item.fileName}-${idx}`}
                    className="py-2 px-3 bg-white/[0.04] border border-white/10"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-white truncate">
                          {item.fileName}
                        </div>
                        <div className="font-mono text-[11px] text-white/55 tabular-nums truncate mt-0.5">
                          {chainTrail ? `${chainTrail} · ` : `${modeLabel} · `}
                          {item.operationMode === 'ocr'
                            ? `Блоков: ${item.totalSegments} · Таблицы и графика сохранены`
                            : item.operationMode === 'business_style'
                              ? `Улучшений: ${item.totalIssuesFixed} · Готово к отправке`
                              : item.operationMode === 'meeting_transcript'
                                ? `Фрагментов: ${item.totalChunksProcessed ?? item.totalSegments} · Word и TXT готовы`
                                : `Чанков: ${item.totalChunksProcessed ?? item.totalSegments} · Исправлено: ${item.totalIssuesFixed}`}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            triggerBase64Download(
                              item.downloadBase64,
                              downloadFileName,
                              item.mimeType
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#004ecc] hover:bg-[#003da1] text-white font-mono text-[11px] font-bold uppercase tracking-[0.05em] transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            {item.operationMode === 'ocr' ||
                            item.operationMode === 'dictation' ||
                            item.operationMode === 'meeting_transcript' ||
                            item.operationMode === 'business_style'
                              ? `Скачать ${item.fileType === 'xlsx' ? 'XLSX' : 'DOCX'}`
                              : 'Скачать'}
                          </span>
                        </button>

                        {item.secondaryDownloadBase64 &&
                          item.secondaryFileName &&
                          item.secondaryMimeType && (
                            <button
                              type="button"
                              onClick={() =>
                                triggerBase64Download(
                                  item.secondaryDownloadBase64!,
                                  secondaryDownloadName,
                                  item.secondaryMimeType!
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-white/30 hover:bg-white hover:text-[#1a1a1a] text-white font-mono text-[11px] uppercase tracking-[0.05em] transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5 shrink-0" />
                              <span>
                                {secondaryIsTxt
                                  ? 'TXT'
                                  : item.fileType === 'xlsx'
                                    ? 'DOCX'
                                    : 'XLSX'}
                              </span>
                            </button>
                          )}

                        {/* Единая лаконичная кнопка передачи результата в следующий инструмент */}
                        {nextSteps.length === 1 ? (
                          <button
                            type="button"
                            disabled={isProcessing || anyDictationActive}
                            title={nextSteps[0].hint}
                            onClick={() => handleHandoffResult(item, nextSteps[0].target)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-white/25 hover:border-white hover:bg-white hover:text-[#1a1a1a] disabled:opacity-40 disabled:pointer-events-none text-white/90 font-mono text-[11px] uppercase tracking-[0.05em] transition-colors whitespace-nowrap cursor-pointer"
                          >
                            <span>{nextSteps[0].shortLabel}</span>
                            <ArrowRight className="w-3 h-3 shrink-0" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isProcessing || anyDictationActive}
                            onClick={() =>
                              setExpandedHandoffIdx((prev) => (prev === idx ? null : idx))
                            }
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 border font-mono text-[11px] uppercase tracking-[0.05em] transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                              isHandoffOpen
                                ? 'bg-white text-[#1a1a1a] border-white'
                                : 'border-white/25 hover:border-white text-white/90 hover:text-white'
                            }`}
                          >
                            <span>Далее</span>
                            <ArrowRight className="w-3 h-3 shrink-0" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Компактная инлайн-полоса выбора следующего инструмента (только при нажатии «Далее») */}
                    {isHandoffOpen && nextSteps.length > 1 && (
                      <div className="mt-2 pt-2 border-t border-white/10 flex flex-wrap items-center justify-end gap-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-white/45 mr-auto">
                          Передать результат в инструмент:
                        </span>
                        {nextSteps.map((step) => (
                          <button
                            key={step.target}
                            type="button"
                            disabled={isProcessing || anyDictationActive}
                            title={step.hint}
                            onClick={() => handleHandoffResult(item, step.target)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-[#004ecc] text-white font-mono text-[10.5px] uppercase tracking-[0.05em] transition-colors cursor-pointer whitespace-nowrap"
                          >
                            <span className="text-white/60">{step.badge}</span>
                            <span>{step.shortLabel}</span>
                            <ArrowUpRight className="w-3 h-3 shrink-0" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}


