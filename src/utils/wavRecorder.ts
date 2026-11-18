/**
 * Запись аудио с микрофона напрямую в формат 16 kHz, 16-bit Mono PCM WAV,
 * который нативно принимается бинарником whisper-cli (whisper.cpp) без ffmpeg.
 * Поддерживает паузу (приостановку захвата и распознавания), продолжение и завершение.
 */

export interface WavRecordingResult {
  wavBlob: Blob;
  durationSeconds: number;
  usedHardwareMic: boolean;
}

export class WhisperWavRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private pcmChunks: Float32Array[] = [];
  private inputSampleRate = 16000;
  private state: 'idle' | 'recording' | 'paused' = 'idle';
  private accumulatedMs = 0;
  private lastResumeTimestamp = 0;
  private usedHardwareMic = false;

  public async start(): Promise<{ usedHardwareMic: boolean }> {
    this.cleanup();
    this.pcmChunks = [];
    this.accumulatedMs = 0;
    this.state = 'recording';
    this.lastResumeTimestamp = Date.now();
    this.usedHardwareMic = false;

    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx({ sampleRate: 16000 });
        this.inputSampleRate = ctx.sampleRate || 16000;
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (event: AudioProcessingEvent) => {
          if (this.state !== 'recording') return;
          const channelData = event.inputBuffer.getChannelData(0);
          const copy = new Float32Array(channelData.length);
          copy.set(channelData);
          this.pcmChunks.push(copy);
        };

        source.connect(processor);
        processor.connect(ctx.destination);

        this.mediaStream = stream;
        this.audioContext = ctx;
        this.sourceNode = source;
        this.processorNode = processor;
        this.usedHardwareMic = true;
      } catch {
        // Если микрофон не подключен на рабочем месте или доступ ограничен политиками браузера,
        // продолжаем отсчет времени записи в автономном режиме без тупиковых ошибок
        this.usedHardwareMic = false;
      }
    }

    return { usedHardwareMic: this.usedHardwareMic };
  }

  public pause(): void {
    if (this.state !== 'recording') return;
    this.accumulatedMs += Math.max(0, Date.now() - this.lastResumeTimestamp);
    this.state = 'paused';
    if (this.audioContext && this.audioContext.state === 'running') {
      this.audioContext.suspend().catch(() => undefined);
    }
  }

  public resume(): void {
    if (this.state !== 'paused') return;
    this.lastResumeTimestamp = Date.now();
    this.state = 'recording';
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => undefined);
    }
  }

  public getElapsedSeconds(): number {
    let totalMs = this.accumulatedMs;
    if (this.state === 'recording') {
      totalMs += Math.max(0, Date.now() - this.lastResumeTimestamp);
    }
    return Math.max(0, Math.floor(totalMs / 1000));
  }

  public async stop(): Promise<WavRecordingResult> {
    if (this.state === 'recording') {
      this.accumulatedMs += Math.max(0, Date.now() - this.lastResumeTimestamp);
    }
    const durationSeconds = Math.max(1, Math.round(this.accumulatedMs / 1000));
    const wasHardware = this.usedHardwareMic;

    const mergedSamples = this.mergeAndDownsampleTo16kHz(this.pcmChunks, this.inputSampleRate);
    this.cleanup();

    const wavBuffer = encodeMono16BitPcmWav(mergedSamples, 16000);
    const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

    return {
      wavBlob,
      durationSeconds,
      usedHardwareMic: wasHardware,
    };
  }

  private mergeAndDownsampleTo16kHz(chunks: Float32Array[], sourceRate: number): Float32Array {
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLength === 0) {
      return new Float32Array(0);
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const targetRate = 16000;
    if (sourceRate === targetRate || sourceRate <= 0) {
      return merged;
    }

    const ratio = sourceRate / targetRate;
    const newLength = Math.max(1, Math.round(merged.length / ratio));
    const downsampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIdx = Math.min(merged.length - 1, Math.floor(i * ratio));
      downsampled[i] = merged[srcIdx];
    }

    return downsampled;
  }

  private cleanup(): void {
    this.state = 'idle';
    try {
      this.processorNode?.disconnect();
      this.sourceNode?.disconnect();
    } catch {
      // ignore
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    if (this.audioContext) {
      try {
        this.audioContext.close().catch(() => undefined);
      } catch {
        // ignore
      }
    }
    this.processorNode = null;
    this.sourceNode = null;
    this.mediaStream = null;
    this.audioContext = null;
  }
}

/**
 * Кодирует Float32Array [-1..1] в стандартный 44-байтный RIFF WAVE (16 kHz, 16-bit, Mono PCM)
 */
export function encodeMono16BitPcmWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const bytesPerSample = 2;
  const numChannels = 1;
  const dataByteLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (byteOffset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(byteOffset + i, text.charCodeAt(i));
    }
  };

  // RIFF chunk descriptor
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');

  // fmt sub-chunk
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample = 16

  // data sub-chunk
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
  }

  return buffer;
}
