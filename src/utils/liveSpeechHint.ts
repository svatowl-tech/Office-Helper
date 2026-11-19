/**
 * Необязательная обёртка над браузерным SpeechRecognition (ru-RU),
 * работающая параллельно с WhisperWavRecorder для мгновенной вставки надиктованной речи
 * прямо в поле ввода формы (и как резервный буфер, если локальный whisper-cli не распакован).
 */

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  0: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

export class LiveSpeechHintCapturer {
  private recognition: BrowserSpeechRecognition | null = null;
  private finalizedSegments: string[] = [];
  private interimSegment = '';

  public start(onLiveUpdate?: (combinedText: string) => void): void {
    this.stop();
    this.finalizedSegments = [];
    this.interimSegment = '';

    if (typeof window === 'undefined') return;
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!Ctor) return;

    try {
      const rec = new Ctor();
      rec.lang = 'ru-RU';
      rec.continuous = true;
      rec.interimResults = true;

      rec.onresult = (event: BrowserSpeechRecognitionEvent) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i];
          const text = item?.[0]?.transcript || '';
          if (item?.isFinal) {
            if (text.trim()) {
              this.finalizedSegments.push(text.trim());
            }
          } else {
            interim += text;
          }
        }
        this.interimSegment = interim.trim();
        if (onLiveUpdate) {
          onLiveUpdate(this.getCurrentText());
        }
      };

      rec.onerror = () => {
        // Игнорируем сетевые/политические ограничения браузера — основной аудиопоток пишет WhisperWavRecorder
      };

      rec.start();
      this.recognition = rec;
    } catch {
      this.recognition = null;
    }
  }

  public getCurrentText(): string {
    return [...this.finalizedSegments, this.interimSegment].filter(Boolean).join(' ').trim();
  }

  public stop(): string {
    const captured = this.getCurrentText();
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.stop();
      } catch {
        // ignore
      }
      this.recognition = null;
    }
    return captured;
  }
}
