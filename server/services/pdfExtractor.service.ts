import { Jimp } from 'jimp';
import type * as MuPdfNamespace from 'mupdf';
import {
  BBox,
  ExtractedGraphicRegion,
  importEsmModule,
  PageRecognitionResult,
  PositionedTextItem,
} from './ocrTypes.ts';
import {
  analyzeTableRegionWithSlaNet,
  runRapidOcrOnImage,
  SlaNetTableStructure,
} from './rapidOcrOnnx.service.ts';
import { runTesseractFallbackOnPng } from './ocrTesseractFallback.service.ts';
import {
  detectTableGridRegions,
  extractNonTextGraphicRegions,
} from './ocrGraphicsRegion.service.ts';
import { buildPageLayoutBlocks } from './ocrLayoutBuilder.service.ts';

const MAX_PDF_PAGES = 35;

/**
 * Распознаёт одно растровое изображение (PNG/JPG/BMP/TIFF/WebP или отрендеренную скан-страницу PDF):
 * 1. Запускает RapidOCR ONNX (PP-OCRv4 Det + Cls + PP-OCRv5 East-Slavic RU/EN) либо оффлайн Tesseract 5 резерв.
 * 2. Обнаруживает линии табличных сеток и запускает SLANet ONNX для сложных таблиц.
 * 3. Вырезает в полном цвете нетекстовую графику (логотипы, печати, чертежи).
 * 4. Собирает упорядоченные блоки страницы с дословным сохранением текста.
 */
export async function recognizeRasterImagePage(
  imageBuffer: Buffer,
  pageNumber = 1
): Promise<PageRecognitionResult> {
  const originalImage = await Jimp.fromBuffer(imageBuffer);
  const origW = originalImage.bitmap.width;
  const origH = originalImage.bitmap.height;

  // Если картинка слишком мелкая (например, скриншот документа 700px), аккуратно увеличиваем копию для OCR
  let ocrImage = originalImage;
  let ocrScale = 1;
  if (origW < 1050 && origH < 1500 && origW > 0) {
    ocrScale = Math.min(2, 1400 / origW);
    const scaled = originalImage.clone();
    scaled.resize({
      w: Math.round(origW * ocrScale),
      h: Math.round(origH * ocrScale),
    });
    ocrImage = scaled;
  }

  let textItems: PositionedTextItem[] = [];
  let engineUsed = 'RapidOCR ONNX';

  // 1. Основной движок — локальный RapidOCR ONNX (PP-OCRv4 Det + PP-OCRv5 East-Slavic RU/EN)
  const rapidRes = await runRapidOcrOnImage(ocrImage);
  if (rapidRes) {
    engineUsed = rapidRes.engineName;
    textItems = rapidRes.items.map((it) => ({
      ...it,
      bbox: {
        x0: it.bbox.x0 / ocrScale,
        y0: it.bbox.y0 / ocrScale,
        x1: it.bbox.x1 / ocrScale,
        y1: it.bbox.y1 / ocrScale,
      },
      fontSize: it.fontSize ? it.fontSize / ocrScale : undefined,
    }));
  }

  // 2. Резервный локальный контур Tesseract 5 WASM (`rus+eng`), если ONNX-модели отсутствуют или вернули пустоту
  if (textItems.length === 0) {
    const pngForTess = ocrScale === 1 ? imageBuffer : await ocrImage.getBuffer('image/png');
    const tessRes = await runTesseractFallbackOnPng(pngForTess);
    if (tessRes.items.length > 0) {
      engineUsed = tessRes.engineName;
      textItems = tessRes.items.map((it) => ({
        ...it,
        bbox: {
          x0: it.bbox.x0 / ocrScale,
          y0: it.bbox.y0 / ocrScale,
          x1: it.bbox.x1 / ocrScale,
          y1: it.bbox.y1 / ocrScale,
        },
        fontSize: it.fontSize ? it.fontSize / ocrScale : undefined,
      }));
    } else if (!rapidRes) {
      engineUsed = tessRes.engineName;
    }
  }

  // 3. Обнаруживаем физические линии таблиц и запускаем SLANet ONNX по найденным табличным регионам
  const tableGrids = detectTableGridRegions(originalImage);
  const slaNetTables = new Map<number, SlaNetTableStructure>();

  for (let i = 0; i < tableGrids.length; i++) {
    const sla = await analyzeTableRegionWithSlaNet(originalImage, tableGrids[i].bbox);
    if (sla) {
      slaNetTables.set(i, sla);
      if (!engineUsed.includes('SLANet')) {
        engineUsed += ' + SLANet Table';
      }
    }
  }

  // 4. Извлекаем полноцветную нетекстовую графику (логотипы, печати, чертежи, схемы)
  const graphics = await extractNonTextGraphicRegions(originalImage, textItems, tableGrids);

  // 5. Если на изображении вообще нет читаемого текста И детектор не вырезал под-области (например, чистый чертёж/схема) —
  //    вставляем само исходное изображение целиком (никакого выдуманного текста!)
  if (textItems.length === 0 && graphics.length === 0) {
    const cleanPng = await originalImage.getBuffer('image/png');
    graphics.push({
      pngBuffer: cleanPng,
      widthPx: origW,
      heightPx: origH,
      bbox: { x0: 0, y0: 0, x1: origW, y1: origH },
      kind: 'full_page_fallback',
      altText: `Графический лист / чертёж (стр. ${pageNumber})`,
    });
  }

  // 6. Реконструкция макета и таблиц в строгом порядке чтения сверху вниз
  const layout = buildPageLayoutBlocks({
    textItems,
    graphics,
    tableGrids,
    slaNetTables,
    pageWidth: origW,
    pageHeight: origH,
  });

  return {
    pageNumber,
    width: origW,
    height: origH,
    textItems,
    graphics,
    blocks: layout.blocks,
    engineUsed,
    tablesDetected: layout.tablesDetected,
    imagesDetected: layout.imagesDetected,
  };
}

/**
 * Многостраничный разбор PDF через Artifex MuPDF (WebAssembly):
 * - Цифровые/гибридные страницы: прямое извлечение точного Unicode-текста (RU+EN) с координатами + встроенных растровых картинок (логотипов/чертежей) + детекция табличных сеток и векторной графики.
 * - Сканированные страницы (где нет текстового слоя): рендер в высоком разрешении (250-300 DPI) → RapidOCR ONNX + SLANet + вырезка графики.
 */
export async function extractPagesFromPdfWithMuPdf(
  pdfBuffer: Buffer
): Promise<PageRecognitionResult[]> {
  const mupdf = await importEsmModule<typeof MuPdfNamespace>('mupdf');
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');

  try {
    const totalPages = Math.min(doc.countPages(), MAX_PDF_PAGES);
    const pageResults: PageRecognitionResult[] = [];

    for (let p = 0; p < totalPages; p++) {
      const page = doc.loadPage(p);
      try {
        const bounds = page.getBounds(); // [x0, y0, x1, y1]
        const pageW = Math.max(1, bounds[2] - bounds[0]);
        const pageH = Math.max(1, bounds[3] - bounds[1]);
        const pageArea = pageW * pageH;

        const stext = page.toStructuredText('preserve-images,preserve-whitespace');
        const pdfTextItems: PositionedTextItem[] = [];
        const pdfEmbeddedImages: ExtractedGraphicRegion[] = [];
        let hasFullPageScanImage = false;
        let totalNonSpaceChars = 0;

        try {
          let currentWordChars: string[] = [];
          let wordX0 = Infinity;
          let wordY0 = Infinity;
          let wordX1 = -Infinity;
          let wordY1 = -Infinity;
          let wordFontSize = 11;
          let wordIsBold = false;
          let prevCharX1 = -Infinity;

          const flushWord = () => {
            const text = currentWordChars.join('').trim();
            if (text.length > 0 && Number.isFinite(wordX0) && wordX1 > wordX0) {
              pdfTextItems.push({
                text,
                bbox: {
                  x0: wordX0 - bounds[0],
                  y0: wordY0 - bounds[1],
                  x1: wordX1 - bounds[0],
                  y1: wordY1 - bounds[1],
                },
                confidence: 100,
                fontSize: wordFontSize,
                isBold: wordIsBold,
                source: 'pdf',
              });
            }
            currentWordChars = [];
            wordX0 = Infinity;
            wordY0 = Infinity;
            wordX1 = -Infinity;
            wordY1 = -Infinity;
            wordFontSize = 11;
            wordIsBold = false;
            prevCharX1 = -Infinity;
          };

          stext.walk({
            beginLine() {
              flushWord();
            },
            onChar(c, _origin, font, size, quad) {
              if (!c) return;
              // Quad: [ulx, uly, urx, ury, llx, lly, lrx, lry]
              const cx0 = Math.min(quad[0], quad[2], quad[4], quad[6]);
              const cy0 = Math.min(quad[1], quad[3], quad[5], quad[7]);
              const cx1 = Math.max(quad[0], quad[2], quad[4], quad[6]);
              const cy1 = Math.max(quad[1], quad[3], quad[5], quad[7]);

              if (/^\s$/.test(c)) {
                flushWord();
                return;
              }

              // Если между символами внутри строки широкий зазор (> 0.65 * fontSize) — начинаем новый токен (колонка/слово)
              if (
                currentWordChars.length > 0 &&
                Number.isFinite(prevCharX1) &&
                cx0 - prevCharX1 > Math.max(2.5, size * 0.45)
              ) {
                flushWord();
              }

              totalNonSpaceChars++;
              currentWordChars.push(c);
              wordX0 = Math.min(wordX0, cx0);
              wordY0 = Math.min(wordY0, cy0);
              wordX1 = Math.max(wordX1, cx1);
              wordY1 = Math.max(wordY1, cy1);
              wordFontSize = Math.max(wordFontSize, size || 11);

              try {
                const fName = font?.getName?.() || '';
                if (font?.isBold?.() || /bold|black|heavy|semibold/i.test(fName)) {
                  wordIsBold = true;
                }
              } catch {
                // ignore font metadata error
              }
              prevCharX1 = cx1;
            },
            endLine() {
              flushWord();
            },
            onImageBlock(bbox, _transform, image) {
              try {
                const bx0 = bbox[0] - bounds[0];
                const by0 = bbox[1] - bounds[1];
                const bx1 = bbox[2] - bounds[0];
                const by1 = bbox[3] - bounds[1];
                const bw = bx1 - bx0;
                const bh = by1 - by0;
                if (bw < 14 || bh < 14) return;

                const coverage = (bw * bh) / pageArea;
                if (coverage >= 0.72) {
                  hasFullPageScanImage = true;
                  return;
                }

                const rawPix = image.toPixmap();
                let rgbPix = rawPix;
                try {
                  // Конвертируем CMYK/Grayscale/DeviceN в стандартный RGB перед сохранением в PNG
                  const cs = rawPix.getColorSpace();
                  if (cs && cs !== mupdf.ColorSpace.DeviceRGB) {
                    rgbPix = rawPix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
                  }
                  const pngUint8 = rgbPix.asPNG();
                  const pngBuffer = Buffer.from(pngUint8);
                  const imgW = rgbPix.getWidth();
                  const imgH = rgbPix.getHeight();
                  if (imgW >= 20 && imgH >= 20 && pngBuffer.length > 100) {
                    pdfEmbeddedImages.push({
                      pngBuffer,
                      widthPx: imgW,
                      heightPx: imgH,
                      bbox: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
                      kind: 'pdf_image',
                      altText: `Изображение из PDF (стр. ${p + 1})`,
                    });
                  }
                } finally {
                  if (rgbPix !== rawPix) {
                    try {
                      rgbPix.destroy();
                    } catch {
                      // ignore
                    }
                  }
                  try {
                    rawPix.destroy();
                  } catch {
                    // ignore
                  }
                }
              } catch (imgErr) {
                console.debug('Пропущен нестандартный растровый объект PDF:', imgErr);
              }
            },
          });
          flushWord();
        } finally {
          stext.destroy();
        }

        // Проверяем, является ли страница сканом (нет реального текстового слоя или почти вся страница — скан-картинка)
        const isScannedPage =
          totalNonSpaceChars < 20 || (hasFullPageScanImage && totalNonSpaceChars < 90);

        if (isScannedPage) {
          // Рендерим скан-страницу в высоком DPI (~250-300 DPI) через MuPDF и прогоняем через RapidOCR ONNX + SLANet + вырезку графики
          const renderScale = Math.min(3.2, Math.max(2.4, 2200 / Math.max(pageW, pageH)));
          const pixmap = page.toPixmap(
            mupdf.Matrix.scale(renderScale, renderScale),
            mupdf.ColorSpace.DeviceRGB,
            false,
            true
          );
          let renderedPng: Buffer;
          try {
            renderedPng = Buffer.from(pixmap.asPNG());
          } finally {
            pixmap.destroy();
          }

          const ocrPage = await recognizeRasterImagePage(renderedPng, p + 1);
          ocrPage.engineUsed = `MuPDF Render (${Math.round(renderScale * 72)} DPI) → ${ocrPage.engineUsed}`;
          pageResults.push(ocrPage);
        } else {
          // Цифровой / гибридный PDF: рендерим 2x снимок для точной детекции векторных табличных сеток и векторных логотипов/чертежей
          const snapScale = Math.min(2.2, Math.max(1.5, 1400 / Math.max(pageW, pageH)));
          const snapPix = page.toPixmap(
            mupdf.Matrix.scale(snapScale, snapScale),
            mupdf.ColorSpace.DeviceRGB,
            false,
            true
          );
          let snapPng: Buffer;
          try {
            snapPng = Buffer.from(snapPix.asPNG());
          } finally {
            snapPix.destroy();
          }

          const snapImg = await Jimp.fromBuffer(snapPng);
          const scaledTextItems: PositionedTextItem[] = pdfTextItems.map((it) => ({
            ...it,
            bbox: {
              x0: it.bbox.x0 * snapScale,
              y0: it.bbox.y0 * snapScale,
              x1: it.bbox.x1 * snapScale,
              y1: it.bbox.y1 * snapScale,
            },
          }));
          const scaledPdfGraphics: ExtractedGraphicRegion[] = pdfEmbeddedImages.map((g) => ({
            ...g,
            bbox: {
              x0: g.bbox.x0 * snapScale,
              y0: g.bbox.y0 * snapScale,
              x1: g.bbox.x1 * snapScale,
              y1: g.bbox.y1 * snapScale,
            },
          }));

          const tableGrids = detectTableGridRegions(snapImg);
          const slaNetTables = new Map<number, SlaNetTableStructure>();
          for (let ti = 0; ti < tableGrids.length; ti++) {
            const sla = await analyzeTableRegionWithSlaNet(snapImg, tableGrids[ti].bbox);
            if (sla) slaNetTables.set(ti, sla);
          }

          // Ищем дополнительные векторные логотипы/чертежи/печати, которые не были растровыми onImageBlock
          const existingBoxes: BBox[] = scaledPdfGraphics.map((g) => g.bbox);
          const vectorGraphics = await extractNonTextGraphicRegions(
            snapImg,
            scaledTextItems,
            tableGrids,
            existingBoxes
          );

          const allGraphics = [...scaledPdfGraphics, ...vectorGraphics];

          const layout = buildPageLayoutBlocks({
            textItems: scaledTextItems,
            graphics: allGraphics,
            tableGrids,
            slaNetTables,
            pageWidth: snapImg.bitmap.width,
            pageHeight: snapImg.bitmap.height,
          });

          pageResults.push({
            pageNumber: p + 1,
            width: snapImg.bitmap.width,
            height: snapImg.bitmap.height,
            textItems: scaledTextItems,
            graphics: allGraphics,
            blocks: layout.blocks,
            engineUsed:
              slaNetTables.size > 0
                ? 'MuPDF WASM (Unicode + Embedded Graphics) + SLANet Table'
                : 'MuPDF WASM (Unicode + Embedded Graphics + Layout Grid)',
            tablesDetected: layout.tablesDetected,
            imagesDetected: layout.imagesDetected,
          });
        }
      } finally {
        page.destroy();
      }
    }

    return pageResults;
  } finally {
    doc.destroy();
  }
}
