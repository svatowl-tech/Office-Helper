import {
  BBox,
  ExtractedGraphicRegion,
  JimpImage,
  PositionedTextItem,
  TableRegionGrid,
} from './ocrTypes.ts';

function estimateBackgroundLuma(rgba: Uint8Array | Buffer, width: number, height: number): number {
  const samples: number[] = [];
  const stepX = Math.max(1, Math.floor(width / 40));
  const stepY = Math.max(1, Math.floor(height / 40));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const p = (y * width + x) * 4;
      const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      samples.push(luma);
    }
  }
  samples.sort((a, b) => a - b);
  // 80-й процентиль хорошо оценивает цвет бумаги/фона даже на плотных таблицах
  return samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.8))] ?? 245;
}

function clusterSortedPositions(values: number[], tolerance: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    if (sorted[i] - last[last.length - 1] <= tolerance) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => Math.round(c.reduce((s, v) => s + v, 0) / c.length));
}

interface LineSegment {
  pos: number; // y для горизонтальной, x для вертикальной
  start: number;
  end: number;
}

/**
 * Обнаруживает реальные горизонтальные и вертикальные линии табличных сеток на изображении
 * (характерно для счетов на оплату, актов, УПД, ТОРГ-12, спецификаций и ведомостей).
 */
export function detectTableGridRegions(image: JimpImage): TableRegionGrid[] {
  const origW = image.bitmap.width;
  const origH = image.bitmap.height;
  if (origW < 120 || origH < 80) return [];

  // Работаем в масштабе <= 1000 px по ширине для высокой скорости и устойчивости к шуму скана
  const scale = origW > 1000 ? 1000 / origW : 1;
  const w = Math.max(60, Math.round(origW * scale));
  const h = Math.max(60, Math.round(origH * scale));
  const work = scale < 1 ? image.clone().resize({ w, h }) : image;
  const rgba = work.bitmap.data;
  const bgLuma = estimateBackgroundLuma(rgba, w, h);
  const darkThresh = Math.max(115, bgLuma - 38);

  const isDark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    if (luma < darkThresh) isDark[i] = 1;
  }

  // 1. Поиск длинных горизонтальных отрезков
  const minHorizLen = Math.max(85, Math.round(w * 0.22));
  const hSegs: LineSegment[] = [];
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let runStart = -1;
    let gap = 0;
    for (let x = 0; x < w; x++) {
      if (isDark[rowOff + x]) {
        if (runStart === -1) runStart = x;
        gap = 0;
      } else if (runStart !== -1) {
        gap++;
        if (gap > 2) {
          const end = x - gap;
          if (end - runStart >= minHorizLen) {
            hSegs.push({ pos: y, start: runStart, end });
          }
          runStart = -1;
          gap = 0;
        }
      }
    }
    if (runStart !== -1) {
      const end = w - 1 - gap;
      if (end - runStart >= minHorizLen) {
        hSegs.push({ pos: y, start: runStart, end });
      }
    }
  }

  // Сливаем соседние по Y горизонтальные отрезки одинакового X-диапазона (толстые линии 2-4px)
  const mergedH: LineSegment[] = [];
  for (const seg of hSegs) {
    const match = mergedH.find(
      (m) =>
        Math.abs(m.pos - seg.pos) <= 4 &&
        Math.abs(m.start - seg.start) <= 18 &&
        Math.abs(m.end - seg.end) <= 18
    );
    if (match) {
      match.pos = Math.round((match.pos + seg.pos) / 2);
      match.start = Math.min(match.start, seg.start);
      match.end = Math.max(match.end, seg.end);
    } else {
      mergedH.push({ ...seg });
    }
  }

  // 2. Поиск вертикальных отрезков
  const minVertLen = Math.max(26, Math.round(h * 0.032));
  const vSegs: LineSegment[] = [];
  for (let x = 0; x < w; x++) {
    let runStart = -1;
    let gap = 0;
    for (let y = 0; y < h; y++) {
      if (isDark[y * w + x]) {
        if (runStart === -1) runStart = y;
        gap = 0;
      } else if (runStart !== -1) {
        gap++;
        if (gap > 2) {
          const end = y - gap;
          if (end - runStart >= minVertLen) {
            vSegs.push({ pos: x, start: runStart, end });
          }
          runStart = -1;
          gap = 0;
        }
      }
    }
    if (runStart !== -1) {
      const end = h - 1 - gap;
      if (end - runStart >= minVertLen) {
        vSegs.push({ pos: x, start: runStart, end });
      }
    }
  }

  const mergedV: LineSegment[] = [];
  for (const seg of vSegs) {
    const match = mergedV.find(
      (m) =>
        Math.abs(m.pos - seg.pos) <= 4 &&
        Math.abs(m.start - seg.start) <= 18 &&
        Math.abs(m.end - seg.end) <= 18
    );
    if (match) {
      match.pos = Math.round((match.pos + seg.pos) / 2);
      match.start = Math.min(match.start, seg.start);
      match.end = Math.max(match.end, seg.end);
    } else {
      mergedV.push({ ...seg });
    }
  }

  if (mergedH.length < 2 || mergedV.length < 2) {
    return [];
  }

  // 3. Группируем пересекающиеся горизонтальные и вертикальные линии в связные табличные области
  const hCount = mergedH.length;
  const vCount = mergedV.length;
  const visitedH = new Uint8Array(hCount);
  const visitedV = new Uint8Array(vCount);
  const tables: TableRegionGrid[] = [];
  const tol = 8;

  const intersects = (hSeg: LineSegment, vSeg: LineSegment): boolean =>
    vSeg.pos >= hSeg.start - tol &&
    vSeg.pos <= hSeg.end + tol &&
    hSeg.pos >= vSeg.start - tol &&
    hSeg.pos <= vSeg.end + tol;

  for (let i = 0; i < hCount; i++) {
    if (visitedH[i]) continue;
    const compH: LineSegment[] = [];
    const compV: LineSegment[] = [];
    const qH: number[] = [i];
    const qV: number[] = [];
    visitedH[i] = 1;

    while (qH.length > 0 || qV.length > 0) {
      while (qH.length > 0) {
        const hi = qH.pop()!;
        const hs = mergedH[hi];
        compH.push(hs);
        for (let vi = 0; vi < vCount; vi++) {
          if (!visitedV[vi] && intersects(hs, mergedV[vi])) {
            visitedV[vi] = 1;
            qV.push(vi);
          }
        }
      }
      while (qV.length > 0) {
        const vi = qV.pop()!;
        const vs = mergedV[vi];
        compV.push(vs);
        for (let hi = 0; hi < hCount; hi++) {
          if (!visitedH[hi] && intersects(mergedH[hi], vs)) {
            visitedH[hi] = 1;
            qH.push(hi);
          }
        }
      }
    }

    if (compH.length >= 2 && compV.length >= 2) {
      const ys = clusterSortedPositions(
        compH.map((s) => s.pos),
        6
      );
      const xs = clusterSortedPositions(
        compV.map((s) => s.pos),
        6
      );
      if (ys.length >= 2 && xs.length >= 2) {
        const x0 = Math.round(xs[0] / scale);
        const x1 = Math.round(xs[xs.length - 1] / scale);
        const y0 = Math.round(ys[0] / scale);
        const y1 = Math.round(ys[ys.length - 1] / scale);

        if (x1 - x0 >= origW * 0.18 && y1 - y0 >= 32) {
          tables.push({
            bbox: { x0, y0, x1, y1 },
            horizontalYs: ys.map((v) => Math.round(v / scale)),
            verticalXs: xs.map((v) => Math.round(v / scale)),
          });
        }
      }
    }
  }

  tables.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  return tables;
}

function boxesOverlapArea(a: BBox, b: BBox): number {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

/**
 * Выделяет и вырезает в полном цвете нетекстовые графические области со скана/изображения/PDF:
 * логотипы компаний, круглые печати, подписи, схемы, QR-коды и чертежи.
 * Исключает распознанные текстовые блоки и тонкие 1-3px линии табличных сеток.
 */
export async function extractNonTextGraphicRegions(
  originalImage: JimpImage,
  textItems: PositionedTextItem[],
  tableGrids: TableRegionGrid[],
  existingGraphicBoxes: BBox[] = []
): Promise<ExtractedGraphicRegion[]> {
  const origW = originalImage.bitmap.width;
  const origH = originalImage.bitmap.height;
  if (origW < 60 || origH < 60) return [];

  const maxWorkW = 460;
  const scale = origW > maxWorkW ? maxWorkW / origW : 1;
  const w = Math.max(40, Math.round(origW * scale));
  const h = Math.max(40, Math.round(origH * scale));

  const work = scale < 1 ? originalImage.clone().resize({ w, h }) : originalImage;
  const rgba = work.bitmap.data;
  const bgLuma = estimateBackgroundLuma(rgba, w, h);
  const darkThresh = Math.max(105, bgLuma - 32);

  // 1. Строим маску «чернил» (любой цветной объект OR тёмный объект относительно фона)
  const mask = new Uint8Array(w * h);
  const colorMask = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3];
    if (a < 20) continue;

    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    const isColored = chroma >= 34 && luma < bgLuma - 12;
    const isDark = luma < darkThresh;

    if (isColored) {
      mask[i] = 1;
      colorMask[i] = 1;
    } else if (isDark) {
      mask[i] = 1;
    }
  }

  // 2. Стираем уверенно распознанные текстовые боксы (чтобы обычный текст не попадал в картинки),
  //    НО не стираем сильно цветные логотипы/печати, где OCR выдал мусор с низкой уверенностью (<58)
  for (const item of textItems) {
    const pad = 3;
    const x0 = Math.max(0, Math.floor(item.bbox.x0 * scale) - pad);
    const y0 = Math.max(0, Math.floor(item.bbox.y0 * scale) - pad);
    const x1 = Math.min(w - 1, Math.ceil(item.bbox.x1 * scale) + pad);
    const y1 = Math.min(h - 1, Math.ceil(item.bbox.y1 * scale) + pad);

    let boxPixels = 0;
    let coloredPixels = 0;
    for (let y = y0; y <= y1; y++) {
      const rowOff = y * w;
      for (let x = x0; x <= x1; x++) {
        if (mask[rowOff + x]) boxPixels++;
        if (colorMask[rowOff + x]) coloredPixels++;
      }
    }
    const colorRatio = boxPixels > 0 ? coloredPixels / boxPixels : 0;
    // Если бокс сильно цветной и OCR в нём не уверен — это печать или логотип, оставляем в маске графики!
    if (colorRatio > 0.45 && item.confidence < 62 && item.text.length <= 8) {
      continue;
    }

    for (let y = y0; y <= y1; y++) {
      const rowOff = y * w;
      for (let x = x0; x <= x1; x++) {
        mask[rowOff + x] = 0;
      }
    }
  }

  // 3. Стираем линии известных табличных сеток (толщина +-3px в масштабе work), чтобы пустые рамки таблиц не вырезались как чертежи
  for (const grid of tableGrids) {
    const gx0 = Math.max(0, Math.floor(grid.bbox.x0 * scale) - 3);
    const gx1 = Math.min(w - 1, Math.ceil(grid.bbox.x1 * scale) + 3);
    const gy0 = Math.max(0, Math.floor(grid.bbox.y0 * scale) - 3);
    const gy1 = Math.min(h - 1, Math.ceil(grid.bbox.y1 * scale) + 3);

    for (const hy of grid.horizontalYs) {
      const cy = Math.round(hy * scale);
      for (let y = Math.max(0, cy - 3); y <= Math.min(h - 1, cy + 3); y++) {
        const rowOff = y * w;
        for (let x = gx0; x <= gx1; x++) {
          if (!colorMask[rowOff + x]) mask[rowOff + x] = 0;
        }
      }
    }

    for (const vx of grid.verticalXs) {
      const cx = Math.round(vx * scale);
      for (let y = gy0; y <= gy1; y++) {
        const rowOff = y * w;
        for (let x = Math.max(0, cx - 3); x <= Math.min(w - 1, cx + 3); x++) {
          if (!colorMask[rowOff + x]) mask[rowOff + x] = 0;
        }
      }
    }
  }

  // 4. Стираем изолированные тонкие горизонтальные и вертикальные разделительные линии (подчеркивания, разделители шапки)
  const thinRunH = Math.max(40, Math.round(w * 0.16));
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const active = x < w && mask[rowOff + x] === 1 && colorMask[rowOff + x] === 0;
      if (active) {
        if (start === -1) start = x;
      } else if (start !== -1) {
        if (x - start >= thinRunH) {
          // Проверяем, действительно ли это тонкая линия (сверху и снизу на +-3px пусто)
          let thickCount = 0;
          for (let tx = start; tx < x; tx++) {
            const above = y >= 3 ? mask[(y - 3) * w + tx] : 0;
            const below = y + 3 < h ? mask[(y + 3) * w + tx] : 0;
            if (above || below) thickCount++;
          }
          if (thickCount < (x - start) * 0.25) {
            for (let dy = -2; dy <= 2; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= h) continue;
              for (let tx = start; tx < x; tx++) {
                mask[ny * w + tx] = 0;
              }
            }
          }
        }
        start = -1;
      }
    }
  }

  // 5. Морфологическое укрупнение (dilation 2px) чтобы штрихи одного логотипа/чертежа склеились в один объект
  const dilated = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const nRow = ny * w;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          dilated[nRow + nx] = 1;
        }
      }
    }
  }

  // 6. Поиск 8-связных компонент
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);

  interface RawComp {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    inkPixels: number;
    colorPixels: number;
  }

  const comps: RawComp[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!dilated[start] || visited[start]) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let inkPixels = 0;
      let colorPixels = 0;

      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % w;
        const cy = (idx - cx) / w;
        if (mask[idx]) inkPixels++;
        if (colorMask[idx]) colorPixels++;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          const nRow = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = nRow + nx;
            if (dilated[nIdx] && !visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < 10 || bh < 10 || inkPixels < 35) continue;
      comps.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, inkPixels, colorPixels });
    }
  }

  // 7. Объединяем близкие компоненты (части одного логотипа, чертежа или печати в радиусе 10px в work-масштабе)
  const mergeGap = 10;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i];
        const b = comps[j];
        const closeX = a.x0 - mergeGap <= b.x1 && b.x0 - mergeGap <= a.x1;
        const closeY = a.y0 - mergeGap <= b.y1 && b.y0 - mergeGap <= a.y1;
        if (closeX && closeY) {
          a.x0 = Math.min(a.x0, b.x0);
          a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1);
          a.y1 = Math.max(a.y1, b.y1);
          a.inkPixels += b.inkPixels;
          a.colorPixels += b.colorPixels;
          comps.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  // 8. Фильтруем шум и вырезаем чистые полноцветные PNG из исходного изображения
  const results: ExtractedGraphicRegion[] = [];
  for (const comp of comps) {
    const bwOrig = Math.round((comp.x1 - comp.x0 + 1) / scale);
    const bhOrig = Math.round((comp.y1 - comp.y0 + 1) / scale);
    const aspect = bwOrig / Math.max(1, bhOrig);

    // Игнорируем мелкие точки/артефакты, сверхтонкие линии и рамку всей страницы
    if (bwOrig < 38 || bhOrig < 30 || bwOrig * bhOrig < 1500) continue;
    if (aspect > 12 || aspect < 1 / 12) continue;
    if (bwOrig > origW * 0.88 && bhOrig > origH * 0.88) continue;

    const workArea = Math.max(1, (comp.x1 - comp.x0 + 1) * (comp.y1 - comp.y0 + 1));
    const inkDensity = comp.inkPixels / workArea;
    if (inkDensity < 0.035) continue;

    const padOrig = 6;
    const x0 = Math.max(0, Math.floor(comp.x0 / scale) - padOrig);
    const y0 = Math.max(0, Math.floor(comp.y0 / scale) - padOrig);
    const x1 = Math.min(origW, Math.ceil((comp.x1 + 1) / scale) + padOrig);
    const y1 = Math.min(origH, Math.ceil((comp.y1 + 1) / scale) + padOrig);
    const cropW = x1 - x0;
    const cropH = y1 - y0;
    if (cropW < 30 || cropH < 24) continue;

    const candidateBbox: BBox = { x0, y0, x1, y1 };

    // Не дублируем графику, которая уже была извлечена из PDF через MuPDF onImageBlock
    const alreadyExtracted = existingGraphicBoxes.some((eb) => {
      const ov = boxesOverlapArea(candidateBbox, eb);
      const minA = Math.min(
        (candidateBbox.x1 - candidateBbox.x0) * (candidateBbox.y1 - candidateBbox.y0),
        (eb.x1 - eb.x0) * (eb.y1 - eb.y0)
      );
      return minA > 0 && ov / minA > 0.45;
    });
    if (alreadyExtracted) continue;

    // Не вырезаем область, которая почти целиком заполнена распознанным текстом таблицы
    let coveredByText = 0;
    for (const ti of textItems) {
      if (ti.confidence >= 65) {
        coveredByText += boxesOverlapArea(candidateBbox, ti.bbox);
      }
    }
    const candArea = cropW * cropH;
    const colorShare = comp.colorPixels / Math.max(1, comp.inkPixels);
    if (coveredByText / candArea > 0.55 && colorShare < 0.25) continue;

    const cropped = originalImage.clone().crop({ x: x0, y: y0, w: cropW, h: cropH });
    const pngBuffer = await cropped.getBuffer('image/png');

    const isStamp = colorShare > 0.35 && aspect >= 0.6 && aspect <= 1.7 && y0 > origH * 0.45;
    results.push({
      pngBuffer,
      widthPx: cropW,
      heightPx: cropH,
      bbox: candidateBbox,
      kind: isStamp ? 'stamp_or_signature' : 'logo_or_drawing',
      altText: isStamp ? 'Печать / подпись документа' : 'Изображение / логотип / чертёж',
    });
  }

  results.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  return results;
}
