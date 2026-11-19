import {
  BusinessStyleTransformationResult,
  DocumentCitation,
  DocumentHarnessAnswer,
  DocumentProofreadResult,
  DocumentSourceSummary,
  DocumentWorkspaceSnapshot,
  ExtractedEntityItem,
  ExtractedTableView,
  GithubBundleConfig,
  LanNodeProbeResult,
  LocalModelSpec,
  MeetingTranscriptionResult,
  OcrOutputFormat,
  SystemTelemetry,
  TextIssue,
  WhisperTranscriptOnlyResult,
} from '../types/harness.types';

export async function apiProofreadText(text: string): Promise<{
  originalText: string;
  correctedText: string;
  issues: TextIssue[];
  engineUsed: string;
  processingTimeMs: number;
}> {
  const res = await fetch('/api/proofread/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка проверки текста' }));
    throw new Error(err.error || 'Ошибка проверки текста');
  }
  return res.json();
}

export async function apiProofreadDocument(file: File): Promise<DocumentProofreadResult> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/proofread/document', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка обработки файла' }));
    throw new Error(err.error || 'Ошибка обработки файла');
  }
  return res.json();
}

export async function apiRecognizePdfOrImage(
  file: File,
  outputFormat: OcrOutputFormat = 'docx'
): Promise<DocumentProofreadResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('outputFormat', outputFormat);

  const res = await fetch('/api/ocr/recognize', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка распознавания PDF / изображения' }));
    throw new Error(err.error || 'Ошибка распознавания PDF / изображения');
  }
  return res.json();
}

export async function apiLoadSampleOcrPdf(
  outputFormat: OcrOutputFormat = 'docx'
): Promise<DocumentProofreadResult> {
  const res = await fetch('/api/ocr/sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputFormat }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Не удалось распознать тестовый PDF' }));
    throw new Error(err.error || 'Не удалось распознать тестовый PDF');
  }
  return res.json();
}

export async function apiTranscribeWhisperAudio(
  wavBlob: Blob,
  durationSeconds: number,
  clientTranscriptHint?: string
): Promise<DocumentProofreadResult> {
  const formData = new FormData();
  formData.append('audio', wavBlob, 'dictation_16khz.wav');
  formData.append('durationSeconds', String(Math.max(1, Math.round(durationSeconds))));
  if (clientTranscriptHint && clientTranscriptHint.trim().length > 0) {
    formData.append('clientTranscriptHint', clientTranscriptHint.trim());
  }

  const res = await fetch('/api/whisper/transcribe', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка распознавания речи Whisper' }));
    throw new Error(err.error || 'Ошибка распознавания речи Whisper');
  }
  return res.json();
}

export async function apiTranscribeWhisperToText(
  wavBlob: Blob,
  durationSeconds: number,
  clientTranscriptHint?: string
): Promise<WhisperTranscriptOnlyResult> {
  const formData = new FormData();
  formData.append('audio', wavBlob, 'dictation_16khz.wav');
  formData.append('durationSeconds', String(Math.max(1, Math.round(durationSeconds))));
  if (clientTranscriptHint && clientTranscriptHint.trim().length > 0) {
    formData.append('clientTranscriptHint', clientTranscriptHint.trim());
  }

  const res = await fetch('/api/whisper/transcribe-text', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка распознавания надиктованной речи' }));
    throw new Error(err.error || 'Ошибка распознавания надиктованной речи');
  }
  return res.json();
}

export async function apiTranscribeMeetingMedia(file: File): Promise<MeetingTranscriptionResult> {
  const formData = new FormData();
  formData.append('media', file);

  const res = await fetch('/api/whisper/transcribe-file', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res
      .json()
      .catch(() => ({ error: 'Не удалось расшифровать запись совещания' }));
    throw new Error(err.error || 'Не удалось расшифровать запись совещания');
  }
  return res.json();
}

export async function apiTransformBusinessStyleText(
  text: string
): Promise<BusinessStyleTransformationResult> {
  const res = await fetch('/api/business-style/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка преобразования в деловой стиль' }));
    throw new Error(err.error || 'Ошибка преобразования в деловой стиль');
  }
  return res.json();
}

export async function apiTransformBusinessStyleDocument(
  file: File
): Promise<BusinessStyleTransformationResult> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/business-style/document', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res
      .json()
      .catch(() => ({ error: 'Не удалось извлечь текст и преобразовать документ в деловой стиль' }));
    throw new Error(err.error || 'Не удалось извлечь текст и преобразовать документ в деловой стиль');
  }
  return res.json();
}

export async function apiGetDocumentWorkSession(
  sessionId: string
): Promise<DocumentWorkspaceSnapshot> {
  const res = await fetch(`/api/doc-work/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Не удалось загрузить сессию документов' }));
    throw new Error(err.error || 'Не удалось загрузить сессию документов');
  }
  return res.json();
}

export async function apiUploadDocumentWorkFiles(
  sessionId: string,
  files: File[]
): Promise<{ added: DocumentSourceSummary[]; snapshot: DocumentWorkspaceSnapshot }> {
  const formData = new FormData();
  formData.append('sessionId', sessionId);
  for (const file of files) {
    formData.append('files', file);
  }

  const res = await fetch('/api/doc-work/upload', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res
      .json()
      .catch(() => ({ error: 'Не удалось проиндексировать загруженные файлы' }));
    throw new Error(err.error || 'Не удалось проиндексировать загруженные файлы');
  }
  return res.json();
}

export async function apiMountDocumentWorkDiskPath(
  sessionId: string,
  diskPath: string
): Promise<{
  resolvedPath: string;
  indexedCount: number;
  skippedCount: number;
  snapshot: DocumentWorkspaceSnapshot;
}> {
  const res = await fetch('/api/doc-work/mount-disk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, diskPath }),
  });
  if (!res.ok) {
    const err = await res
      .json()
      .catch(() => ({ error: 'Не удалось подключить указанную папку или файл на диске' }));
    throw new Error(err.error || 'Не удалось подключить указанную папку или файл на диске');
  }
  return res.json();
}

export async function apiRemoveDocumentWorkSource(
  sessionId: string,
  sourceId?: string
): Promise<{ snapshot: DocumentWorkspaceSnapshot }> {
  const res = await fetch('/api/doc-work/source', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, sourceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Не удалось удалить документ из сессии' }));
    throw new Error(err.error || 'Не удалось удалить документ из сессии');
  }
  return res.json();
}

export async function apiQueryDocumentWork(
  sessionId: string,
  query: string,
  selectedSourceIds?: string[]
): Promise<DocumentHarnessAnswer> {
  const res = await fetch('/api/doc-work/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, query, selectedSourceIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка выполнения запроса по документам' }));
    throw new Error(err.error || 'Ошибка выполнения запроса по документам');
  }
  return res.json();
}

export async function apiExportDocumentWorkOffice(params: {
  format: 'docx' | 'xlsx';
  title: string;
  answerText: string;
  citations: DocumentCitation[];
  entities: ExtractedEntityItem[];
  tables: ExtractedTableView[];
}): Promise<DocumentProofreadResult> {
  const res = await fetch('/api/doc-work/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Не удалось собрать файл Word / Excel' }));
    throw new Error(err.error || 'Не удалось собрать файл Word / Excel');
  }
  return res.json();
}

export async function apiLoadSampleDocument(
  type: 'docx' | 'xlsx'
): Promise<DocumentProofreadResult & { originalSampleBase64: string }> {
  const res = await fetch('/api/proofread/sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Не удалось создать образец' }));
    throw new Error(err.error || 'Не удалось создать образец');
  }
  return res.json();
}

export async function apiGetModelCatalog(): Promise<LocalModelSpec[]> {
  const res = await fetch('/api/models/catalog');
  if (!res.ok) {
    throw new Error('Не удалось загрузить каталог моделей');
  }
  const data = await res.json();
  return data.models;
}

export async function apiGetNetworkTelemetry(): Promise<SystemTelemetry> {
  const res = await fetch('/api/network/telemetry');
  if (!res.ok) {
    throw new Error('Ошибка чтения сетевой телеметрии');
  }
  return res.json();
}

export async function apiProbeLanNodes(
  host: string,
  ports?: number[]
): Promise<{ host: string; results: LanNodeProbeResult[] }> {
  const res = await fetch('/api/network/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, ports }),
  });
  if (!res.ok) {
    throw new Error('Ошибка сканирования узла');
  }
  return res.json();
}

export async function apiGenerateGithubBundle(config: GithubBundleConfig): Promise<{
  workflowYaml: string;
  linuxScript: string;
  win7Script: string;
  zipBase64: string;
}> {
  const res = await fetch('/api/bundle/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    throw new Error('Ошибка генерации комплекта GitHub Actions');
  }
  return res.json();
}

export function triggerBase64Download(base64: string, fileName: string, mimeType: string): void {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
