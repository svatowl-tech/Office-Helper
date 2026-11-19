import type { Jimp } from 'jimp';

export type JimpImage = Awaited<ReturnType<typeof Jimp.fromBuffer>>;

/**
 * Нативный динамический import(), защищённый от перезаписи esbuild в require() при сборке CJS (server.cjs).
 * Необходимо для ESM-модулей с top-level await (mupdf, onnxruntime-web).
 */
export const importEsmModule = new Function(
  'specifier',
  'return import(specifier);'
) as <T = unknown>(specifier: string) => Promise<T>;

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PositionedTextItem {
  text: string;
  bbox: BBox;
  confidence: number;
  fontSize?: number;
  isBold?: boolean;
  source: 'pdf' | 'rapidocr' | 'tesseract';
}

export interface ExtractedGraphicRegion {
  pngBuffer: Buffer;
  widthPx: number;
  heightPx: number;
  bbox: BBox;
  kind: 'pdf_image' | 'logo_or_drawing' | 'stamp_or_signature' | 'full_page_fallback';
  altText: string;
}

export interface TableRegionGrid {
  bbox: BBox;
  horizontalYs: number[];
  verticalXs: number[];
}

export interface TableCellSpec {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  isMergedContinuation?: boolean;
}

export interface RecognizedBlock {
  type: 'heading' | 'paragraph' | 'table' | 'image' | 'page_break';
  text?: string;
  align?: 'left' | 'center' | 'right' | 'both';
  fontSizePt?: number;
  rows?: string[][];
  cellGrid?: TableCellSpec[][];
  columnWidthFractions?: number[];
  pngBuffer?: Buffer;
  widthPx?: number;
  heightPx?: number;
  altText?: string;
  pageNumber?: number;
}

export interface PageRecognitionResult {
  pageNumber: number;
  width: number;
  height: number;
  textItems: PositionedTextItem[];
  graphics: ExtractedGraphicRegion[];
  blocks: RecognizedBlock[];
  engineUsed: string;
  tablesDetected: number;
  imagesDetected: number;
}
