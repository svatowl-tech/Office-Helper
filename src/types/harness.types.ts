export type CorrectionCategory =
  | 'orthography'
  | 'grammar'
  | 'punctuation'
  | 'typography'
  | 'official_style';

export interface TextIssue {
  id: string;
  startOffset: number;
  endOffset: number;
  original: string;
  replacement: string;
  category: CorrectionCategory;
  ruleTitle: string;
  explanation: string;
  confidence: number;
}

export interface DocumentSegment {
  id: string;
  location: string; // e.g., "Абзац #1 (Заголовок)" or "Лист 'Реестр', ячейка B4"
  elementType: 'paragraph' | 'table_cell' | 'header' | 'spreadsheet_cell';
  originalText: string;
  correctedText: string;
  preservedFormattingMeta: string; // e.g., "Times New Roman, 14pt, Bold, выравнивание по ширине (3 w:r узла)"
  issues: TextIssue[];
  applied: boolean;
}

export interface HarnessChunkingConfig {
  maxChunkChars: number;
  maxTokensEstimate: number;
  preserveParagraphs: boolean;
  preserveSentences: boolean;
  concurrency: number;
}

export interface TextChunkSpan {
  index: number;
  text: string;
  trailingSeparator: string;
  startOffset: number;
  endOffset: number;
  estimatedTokens: number;
}

export type OcrOutputFormat = 'docx' | 'xlsx';

export interface DocumentProofreadResult {
  fileName: string;
  fileType:
    | 'docx'
    | 'xlsx'
    | 'pptx'
    | 'doc'
    | 'xls'
    | 'ppt'
    | 'odt'
    | 'ods'
    | 'odp'
    | 'xodt'
    | 'xods'
    | 'rtf'
    | 'txt';
  fileSizeBytes: number;
  processingTimeMs: number;
  engineUsed: string;
  totalSegments: number;
  modifiedSegments: number;
  totalIssuesFixed: number;
  totalChunksProcessed?: number;
  chunkMaxCharsUsed?: number;
  segments: DocumentSegment[];
  downloadBase64: string;
  mimeType: string;
  operationMode?: 'proofread' | 'ocr' | 'dictation';
  sourceFileName?: string;
  secondaryFileName?: string;
  secondaryDownloadBase64?: string;
  secondaryMimeType?: string;
}

export interface LocalModelSpec {
  id: string;
  name: string;
  repoId: string;
  architecture: 'Seq2Seq T5 (ONNX INT8)' | 'Seq2Seq FRED-T5 (ONNX/GGUF)' | 'Causal LLM (GGUF Q4_K_M)';
  sizeMb: number;
  ramRequiredMb: number;
  cpuTokensPerSec: string;
  osCompatibility: string[];
  minLinuxKernel: string;
  windows7Support: 'Полная (Native CPU / ONNX 1.14)' | 'Полная (Mingw-w64 Win32 Threads)' | 'Частичная (Требует VxKex / Win8+)';
  formattingSafety: string;
  russianQualityScore: number;
  recommendedRole: 'primary_spell' | 'deep_editor' | 'heavy_fallback';
  description: string;
  pros: string[];
  cons: string[];
  downloadUrl: string;
}

export interface NetworkInterfaceDiag {
  name: string;
  mac: string;
  ipv4: string;
  netmask: string;
  cidr: string;
  family: string;
  internal: boolean;
  status: 'up' | 'loopback';
}

export interface LanNodeProbeResult {
  host: string;
  port: number;
  serviceGuess: string;
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string;
  errorReason?: string;
}

export interface SystemTelemetry {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemMb: number;
  freeMemMb: number;
  uptimeSeconds: number;
  airGapVerified: boolean;
  localBridgeStatus: 'active_deterministic' | 'active_llama_cpp';
  interfaces: NetworkInterfaceDiag[];
}

export interface OcrExtractionResult {
  fileName: string;
  width: number;
  height: number;
  extractedText: string;
  correctedText: string;
  issues: TextIssue[];
  confidence: number;
  processingTimeMs: number;
  engineInfo: string;
}

export interface GithubBundleConfig {
  targetLinux: 'astra_1_7_kernel_5_4' | 'debian_10_buster' | 'universal_glibc_2_28';
  targetWindows: 'win7_sp1_x64' | 'win10_ltsc_x64';
  primaryModel: 'sage-fredt5-distilled-95m' | 'sage-fredt5-large' | 'qwen2.5-1.5b-q4_k_m' | 'hybrid_sage_qwen';
  includeOcrTessdata: boolean;
  includeLibreOfficeHeadless: boolean;
  cpuInstructionSet: 'avx2' | 'sse4_2_legacy';
}
