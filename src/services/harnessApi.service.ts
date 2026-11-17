import {
  DocumentProofreadResult,
  GithubBundleConfig,
  LanNodeProbeResult,
  LocalModelSpec,
  SystemTelemetry,
  TextIssue,
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
