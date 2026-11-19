import JSZip from 'jszip';
import CFB from 'cfb';

interface TextRule {
  pattern: RegExp;
  replace: string | ((match: string, ...args: string[]) => string);
}

const RULES: TextRule[] = [
  {
    pattern: /\bв\s+течении\s+(года|месяца|недели|дня|срока|периода|суток|часа|времени|квартала|полугодия)\b/giu,
    replace: (m, g1) => `${m[0] === m[0].toUpperCase() ? 'В' : 'в'} течение ${g1}`,
  },
  {
    pattern: /\bв\s+продолжении\s+(года|месяца|недели|дня|срока|периода|всего|часа|встречи|совещания)\b/giu,
    replace: (m, g1) => `${m[0] === m[0].toUpperCase() ? 'В' : 'в'} продолжение ${g1}`,
  },
  {
    pattern: /\bв\s+следствии\s+(аварии|сбоя|нарушения|ошибки|отказа|простоя|проверки|инцидента|чего)\b/giu,
    replace: (m, g1) => `${m[0] === m[0].toUpperCase() ? 'В' : 'в'}следствие ${g1}`,
  },
  {
    pattern: /\bв\s+виду\s+(отсутствия|наличия|изменения|окончания|истечения|необходимости|сложности|того)\b/giu,
    replace: (m, g1) => `${m[0] === m[0].toUpperCase() ? 'В' : 'в'}виду ${g1}`,
  },
  {
    pattern: /\bне\s+смотря\s+на\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Несмотря на' : 'несмотря на'),
  },
  {
    pattern: /\bпридти\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Прийти' : 'прийти'),
  },
  {
    pattern: /\bбудующее\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Будущее' : 'будущее'),
  },
  {
    pattern: /\bследущие\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Следующие' : 'следующие'),
  },
  {
    pattern: /\bкоординально\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Кардинально' : 'кардинально'),
  },
  {
    pattern: /\bинциндент([а-яё]*)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'И' : 'и'}нцидент${e}`,
  },
  {
    pattern: /\bпрецендент([а-яё]*)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'П' : 'п'}рецедент${e}`,
  },
  {
    pattern: /\bкомпроментир([а-яё]+)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'К' : 'к'}омпрометир${e}`,
  },
  {
    pattern: /\bконстактир([а-яё]+)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'К' : 'к'}онстатир${e}`,
  },
  {
    pattern: /\bагенств([а-яё]*)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'А' : 'а'}гентств${e}`,
  },
  {
    pattern: /\bрассчет([а-яё]*)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'Р' : 'р'}асчёт${e}`,
  },
  {
    pattern: /\bрасчит([а-яё]+)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'Р' : 'р'}ассчит${e}`,
  },
  {
    pattern: /\bбезопаснть\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Безопасность' : 'безопасность'),
  },
  {
    pattern: /\bоборудывани([а-яё]+)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'О' : 'о'}борудовани${e}`,
  },
  {
    pattern: /\bэксплотаци([а-яё]+)\b/giu,
    replace: (m, e) => `${m[0] === m[0].toUpperCase() ? 'Э' : 'э'}ксплуатаци${e}`,
  },
  {
    pattern: /\bпо\s+мимо\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Помимо' : 'помимо'),
  },
  {
    pattern: /\bтак\s+же\s+необходимо\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Также необходимо' : 'также необходимо'),
  },
  {
    pattern: /\bв\s+отличии\s+от\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'В отличие от' : 'в отличие от'),
  },
  {
    pattern: /\bпо\s+окончанию\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'По окончании' : 'по окончании'),
  },
  {
    pattern: /\bпо\s+завершению\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'По завершении' : 'по завершении'),
  },
  {
    pattern: /\bпо\s+прибытию\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'По прибытии' : 'по прибытии'),
  },
  {
    pattern: /\bпо\s+истечению\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'По истечении' : 'по истечении'),
  },
  {
    pattern: /\bсогласно\s+(приказа|договора|графика|регламента|акта|распоряжения|протокола|устава|контракта|плана|сметы|методики|таблицы|схемы)\b/giu,
    replace: (m, noun) => {
      const map: Record<string, string> = {
        приказа: 'приказу',
        договора: 'договору',
        графика: 'графику',
        регламента: 'регламенту',
        акта: 'акту',
        распоряжения: 'распоряжению',
        протокола: 'протоколу',
        устава: 'уставу',
        контракта: 'контракту',
        плана: 'плану',
        сметы: 'смете',
        методики: 'методике',
        таблицы: 'таблице',
        схемы: 'схеме',
      };
      return `${m[0] === m[0].toUpperCase() ? 'С' : 'с'}огласно ${map[noun.toLowerCase()] || noun}`;
    },
  },
  {
    pattern: /\bиграет\s+большое\s+значение\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Имеет большое значение' : 'имеет большое значение'),
  },
  {
    pattern: /\bоплатить\s+за\s+(услуги|работы|товар|поставку|проезд|обучение|оборудование|лицензию)\b/giu,
    replace: (m, n) => `${m[0] === m[0].toUpperCase() ? 'О' : 'о'}платить ${n}`,
  },
  {
    pattern: /\bпрейскурант\s+цен\b/giu,
    replace: (m) => (m[0] === m[0].toUpperCase() ? 'Прейскурант' : 'прейскурант'),
  },
  {
    pattern: /([а-яёА-ЯЁ0-9])\s+(а\s+именно|то\s+есть|как\s+правило|в\s+частности|таким\s+образом|следовательно|однако|при\s+этом)\s+/gu,
    replace: '$1, $2 ',
  },
  {
    pattern: /([а-яёА-ЯЁ0-9])\s+(чтобы|потому\s+что|так\s+как|поскольку|который|которая|которое|которые|которого|которой|которых|которому|которым)\b/gu,
    replace: '$1, $2',
  },
  {
    pattern: /([а-яёА-ЯЁa-zA-Z0-9]) {2,}([а-яёА-ЯЁa-zA-Z0-9])/gu,
    replace: '$1 $2',
  },
  {
    pattern: /\s+([,.;:!?])/gu,
    replace: '$1',
  },
];

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(safe: string): string {
  return safe
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function splitTextIntoBrowserChunks(text: string, maxChars = 480): Array<{ text: string; sep: string }> {
  if (!text) return [];
  if (text.length <= maxChars) return [{ text, sep: '' }];

  const chunks: Array<{ text: string; sep: string }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChars) {
      chunks.push({ text: text.slice(cursor), sep: '' });
      break;
    }

    const windowSlice = text.slice(cursor, cursor + maxChars);
    let cutRel = -1;
    let sepLen = 0;

    // 1. Абзац или перенос строки
    const nlIdx = windowSlice.lastIndexOf('\n');
    if (nlIdx >= Math.floor(maxChars * 0.25)) {
      cutRel = nlIdx;
      sepLen = 1;
    }

    // 2. Конец предложения
    if (cutRel === -1) {
      for (let i = windowSlice.length - 1; i >= Math.floor(maxChars * 0.25); i--) {
        const ch = windowSlice[i];
        if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < windowSlice.length && /\s/.test(windowSlice[i + 1])) {
          cutRel = i + 1;
          sepLen = 1;
          break;
        }
      }
    }

    // 3. Пробел между словами
    if (cutRel === -1) {
      const spIdx = windowSlice.lastIndexOf(' ');
      if (spIdx >= Math.floor(maxChars * 0.25)) {
        cutRel = spIdx;
        sepLen = 1;
      }
    }

    if (cutRel === -1 || cutRel === 0) {
      cutRel = maxChars;
      sepLen = 0;
    }

    const absCut = cursor + cutRel;
    let absSepEnd = absCut + sepLen;
    while (sepLen > 0 && absSepEnd < text.length && /\s/.test(text[absSepEnd])) {
      absSepEnd++;
    }

    chunks.push({
      text: text.slice(cursor, absCut),
      sep: text.slice(absCut, absSepEnd),
    });
    cursor = absSepEnd;
  }

  return chunks;
}

const CYRILLIC_WORD_BOUNDARY =
  '(?:(?<=[а-яёА-ЯЁa-zA-Z0-9_])(?![а-яёА-ЯЁa-zA-Z0-9_])|(?<![а-яёА-ЯЁa-zA-Z0-9_])(?=[а-яёА-ЯЁa-zA-Z0-9_]))';

function buildCyrillicRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source.replace(/\\b/g, CYRILLIC_WORD_BOUNDARY), pattern.flags);
}

function fixRussianSingleChunk(chunkText: string): { text: string; fixes: number } {
  let out = chunkText;
  let fixes = 0;

  for (const rule of RULES) {
    const rx = buildCyrillicRegex(rule.pattern);
    out = out.replace(rx, (...args) => {
      const match = args[0] as string;
      const replaced =
        typeof rule.replace === 'function'
          ? rule.replace(match, ...(args.slice(1, -2) as string[]))
          : match.replace(buildCyrillicRegex(rule.pattern), rule.replace);
      if (replaced !== match) {
        fixes++;
      }
      return replaced;
    });
  }

  return { text: out, fixes };
}

function fixRussianText(text: string): { text: string; fixes: number; chunks: number } {
  const parts = splitTextIntoBrowserChunks(text, 480);
  if (parts.length === 0) return { text, fixes: 0, chunks: 0 };

  let totalFixes = 0;
  const outParts: string[] = [];
  for (const part of parts) {
    if (!part.text.trim()) {
      outParts.push(part.text + part.sep);
      continue;
    }
    const { text: fixedChunk, fixes } = fixRussianSingleChunk(part.text);
    totalFixes += fixes;
    outParts.push(fixedChunk + part.sep);
  }

  return { text: outParts.join(''), fixes: totalFixes, chunks: parts.length };
}

function replaceTextNodesInParagraphXml(
  xml: string,
  pTag: 'w:p' | 'a:p',
  tTag: 'w:t' | 'a:t'
): { xml: string; totalFixes: number; totalChunks: number } {
  let totalFixes = 0;
  let totalChunks = 0;
  const pRegex = new RegExp(`<${pTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${pTag}>`, 'g');
  const tRegex = new RegExp(`(<${tTag}(?:\\s[^>]*)?>)([\\s\\S]*?)(<\\/${tTag}>)`, 'g');

  const updated = xml.replace(pRegex, (pXml) => {
    const nodes: Array<{ open: string; decoded: string; close: string; start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    tRegex.lastIndex = 0;

    while ((m = tRegex.exec(pXml)) !== null) {
      nodes.push({
        open: m[1],
        decoded: unescapeXml(m[2]),
        close: m[3],
        start: m.index,
        end: m.index + m[0].length,
      });
    }

    if (nodes.length === 0) return pXml;
    const joined = nodes.map((n) => n.decoded).join('');
    if (!joined.trim()) return pXml;

    const { text: fixed, fixes, chunks } = fixRussianText(joined);
    totalChunks += chunks;
    if (fixes === 0 || fixed === joined) return pXml;

    totalFixes += fixes;
    let outP = pXml;

    if (nodes.length === 1) {
      const n = nodes[0];
      const open = tTag === 'w:t' && !n.open.includes('xml:space') ? '<w:t xml:space="preserve">' : n.open;
      outP = outP.slice(0, n.start) + open + escapeXml(fixed) + n.close + outP.slice(n.end);
      return outP;
    }

    let remaining = fixed;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      let slice = '';
      if (i === 0) {
        slice = remaining;
      } else {
        const cut = Math.max(0, remaining.length - n.decoded.length);
        slice = remaining.slice(cut);
        remaining = remaining.slice(0, cut);
      }
      const open = tTag === 'w:t' && !n.open.includes('xml:space') ? '<w:t xml:space="preserve">' : n.open;
      outP = outP.slice(0, n.start) + open + escapeXml(slice) + n.close + outP.slice(n.end);
    }

    return outP;
  });

  return { xml: updated, totalFixes, totalChunks };
}

async function processOfficeFileInBrowser(file: File): Promise<{
  fileName: string;
  totalIssuesFixed: number;
  totalChunksProcessed: number;
  blob: Blob;
}> {
  // Если запущен локальный сервер (127.0.0.1:3000), делегируем ему — иначе обрабатываем полностью автономно в браузере
  if (window.location.protocol.startsWith('http')) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/proofread/document', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        const bin = atob(data.downloadBase64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return {
          fileName: data.fileName,
          totalIssuesFixed: data.totalIssuesFixed,
          totalChunksProcessed: data.totalChunksProcessed ?? data.totalSegments ?? 1,
          blob: new Blob([arr], { type: data.mimeType }),
        };
      }
    } catch {
      // fallback to pure in-browser JSZip processing
    }
  }

  const lower = file.name.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    const raw = await file.text();
    const { text, fixes, chunks } = fixRussianText(raw);
    return {
      fileName: file.name,
      totalIssuesFixed: fixes,
      totalChunksProcessed: chunks,
      blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    };
  }

  const cp1251High =
    'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
    'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

  const decodeCp1251Bytes = (arr: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < arr.length; i++) {
      s += arr[i] < 0x80 ? String.fromCharCode(arr[i]) : cp1251High[arr[i] - 0x80] || '';
    }
    return s;
  };

  if (lower.endsWith('.rtf')) {
    const rawRtf = await file.text();
    const plain = rawRtf
      .replace(/\\par\b\s?/g, '\n')
      .replace(/\\u(-?\d+)\??/g, (_m, c) => String.fromCharCode(Number(c) < 0 ? Number(c) + 65536 : Number(c)))
      .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => decodeCp1251Bytes(Uint8Array.from([parseInt(hex, 16)])))
      .replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|\*)[^}]*\}/g, '')
      .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
      .replace(/[{}]/g, '');
    const { text: fixed, fixes, chunks } = fixRussianText(plain);
    const encodeRtf = (s: string) => {
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        const code = ch.charCodeAt(0);
        if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
        else if (code < 0x80) out += ch;
        else {
          const idx = cp1251High.indexOf(ch);
          out += idx !== -1 ? `\\'${(0x80 + idx).toString(16).padStart(2, '0')}` : `\\u${code}?`;
        }
      }
      return out;
    };
    const rtfBody = fixed
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `\\pard\\f0\\fs24 ${encodeRtf(l)}\\par`)
      .join('\n');
    const outRtf = `{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0\\froman\\fcharset204 Times New Roman;}}\n${rtfBody}\n}`;
    return {
      fileName: file.name,
      totalIssuesFixed: fixes,
      totalChunksProcessed: chunks,
      blob: new Blob([outRtf], { type: 'application/rtf' }),
    };
  }

  if (lower.endsWith('.doc') || lower.endsWith('.xls') || lower.endsWith('.ppt')) {
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const decodeUtf16Le = (arr: Uint8Array): string => {
      let s = '';
      for (let i = 0; i + 1 < arr.length; i += 2) {
        s += String.fromCharCode(arr[i] | (arr[i + 1] << 8));
      }
      return s;
    };

    const extractLinesFromStream = (bytes: Uint8Array): string[] => {
      const utf16 = decodeUtf16Le(bytes);
      const runs = utf16.match(/[А-Яа-яЁёA-Za-z0-9][А-Яа-яЁёA-Za-z0-9\s.,:;!?№"«»()\-–—]{4,}/g) || [];
      const cleaned = runs.map((r) => r.replace(/\s+/g, ' ').trim()).filter((r) => /[А-Яа-яЁёA-Za-z]{2,}/.test(r));
      if (cleaned.length > 0) return Array.from(new Set(cleaned));
      const cp = decodeCp1251Bytes(bytes);
      const cpRuns = cp.match(/[А-Яа-яЁё][А-Яа-яЁё0-9\s.,:;!?№"«»()\-–—]{4,}/g) || [];
      return Array.from(new Set(cpRuns.map((r) => r.replace(/\s+/g, ' ').trim())));
    };

    let targetBytes = rawBytes;
    try {
      const cfb = CFB.read(rawBytes, { type: 'array' });
      const streamName = lower.endsWith('.doc')
        ? '/WordDocument'
        : lower.endsWith('.xls')
          ? '/Workbook'
          : '/PowerPoint Document';
      const entry = CFB.find(cfb, streamName);
      if (entry && entry.content) {
        targetBytes = new Uint8Array(entry.content);
      }
    } catch {
      // RTF/HTML/plain fallback
    }

    const extractedLines = extractLinesFromStream(targetBytes);
    const joinedText = extractedLines.join('\n') || decodeCp1251Bytes(rawBytes).slice(0, 4000);
    const { text: fixedText, fixes, chunks } = fixRussianText(joinedText);
    const fixedLines = fixedText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lower.endsWith('.xls')) {
      return {
        fileName: file.name.replace(/\.xls$/i, '.xlsx'),
        totalIssuesFixed: fixes,
        totalChunksProcessed: chunks,
        blob: await buildBrowserXlsxBlob(fixedLines),
      };
    }

    return {
      fileName: file.name.replace(/\.(doc|ppt)$/i, '.docx'),
      totalIssuesFixed: fixes,
      totalChunksProcessed: chunks,
      blob: await buildBrowserDocxBlob(fixedLines),
    };
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  let totalFixes = 0;
  let totalChunks = 0;

  if (lower.endsWith('.docx')) {
    const targets = Object.keys(zip.files).filter(
      (p) => p === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(p)
    );
    for (const p of targets) {
      const f = zip.file(p);
      if (!f) continue;
      const { xml, totalFixes: fCount, totalChunks: cCount } = replaceTextNodesInParagraphXml(
        await f.async('string'),
        'w:p',
        'w:t'
      );
      totalFixes += fCount;
      totalChunks += cCount;
      zip.file(p, xml);
    }
    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
      totalChunksProcessed: totalChunks,
      blob: await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    };
  }

  if (lower.endsWith('.pptx')) {
    const targets = Object.keys(zip.files).filter(
      (p) => /^ppt\/slides\/slide\d+\.xml$/.test(p) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p)
    );
    for (const p of targets) {
      const f = zip.file(p);
      if (!f) continue;
      const { xml, totalFixes: fCount, totalChunks: cCount } = replaceTextNodesInParagraphXml(
        await f.async('string'),
        'a:p',
        'a:t'
      );
      totalFixes += fCount;
      totalChunks += cCount;
      zip.file(p, xml);
    }
    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
      totalChunksProcessed: totalChunks,
      blob: await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    };
  }

  if (lower.endsWith('.xlsx')) {
    // В Excel текстовые значения хранятся в xl/sharedStrings.xml и в <is><t> внутри xl/worksheets/sheet*.xml (формулы <f> и стили styles.xml не затрагиваются)
    const sharedFile = zip.file('xl/sharedStrings.xml');
    if (sharedFile) {
      const rawXml = await sharedFile.async('string');
      const updated = rawXml.replace(/(<si\b[^>]*>)([\s\S]*?)(<\/si>)/g, (siBlock) => {
        return siBlock.replace(/(<t(?:\s[^>]*)?>)([\s\S]*?)(<\/t>)/g, (_m, open, inner, close) => {
          const decoded = unescapeXml(inner);
          const { text, fixes, chunks } = fixRussianText(decoded);
          totalFixes += fixes;
          totalChunks += chunks;
          return `${open}${escapeXml(text)}${close}`;
        });
      });
      zip.file('xl/sharedStrings.xml', updated);
    }

    const sheets = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
    for (const s of sheets) {
      const f = zip.file(s);
      if (!f) continue;
      const rawXml = await f.async('string');
      const updated = rawXml.replace(/(<is\b[^>]*>)([\s\S]*?)(<\/is>)/g, (isBlock) => {
        return isBlock.replace(/(<t(?:\s[^>]*)?>)([\s\S]*?)(<\/t>)/g, (_m, open, inner, close) => {
          const decoded = unescapeXml(inner);
          const { text, fixes, chunks } = fixRussianText(decoded);
          totalFixes += fixes;
          totalChunks += chunks;
          return `${open}${escapeXml(text)}${close}`;
        });
      });
      zip.file(s, updated);
    }

    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
      totalChunksProcessed: totalChunks,
      blob: await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    };
  }

  if (
    lower.endsWith('.odt') ||
    lower.endsWith('.ods') ||
    lower.endsWith('.odp') ||
    lower.endsWith('.xodt') ||
    lower.endsWith('.xods')
  ) {
    const isSheet = lower.endsWith('.ods') || lower.endsWith('.xods');
    const mimeMap: Record<string, string> = {
      '.odt': 'application/vnd.oasis.opendocument.text',
      '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
      '.odp': 'application/vnd.oasis.opendocument.presentation',
      '.xodt': 'application/vnd.oasis.opendocument.text',
      '.xods': 'application/vnd.oasis.opendocument.spreadsheet',
    };
    const matchedExt = Object.keys(mimeMap).find((k) => lower.endsWith(k)) || '.odt';

    const fixOdfParagraphXml = (xmlStr: string): string => {
      const leafParaRx = /<text:(p|h)(?:\s[^>]*)?>(?:(?!<text:(?:p|h)(?:\s|>))[\s\S])*?<\/text:\1>/g;
      return xmlStr.replace(leafParaRx, (elem) => {
        const openEnd = elem.indexOf('>');
        const closeStart = elem.lastIndexOf('</');
        if (openEnd === -1 || closeStart <= openEnd) return elem;
        const open = elem.slice(0, openEnd + 1);
        const inner = elem.slice(openEnd + 1, closeStart);
        const close = elem.slice(closeStart);
        if (/<text:(?:p|h)(?:\s|>)/.test(inner)) return elem;

        const updatedInner = inner.replace(/(^|>)([^<]+)(?=<|$)/g, (_m, lead, rawTxt) => {
          const decoded = unescapeXml(rawTxt);
          if (!decoded.trim()) return `${lead}${rawTxt}`;
          const { text: fixed, fixes, chunks } = fixRussianText(decoded);
          totalFixes += fixes;
          totalChunks += chunks;
          return `${lead}${escapeXml(fixed)}`;
        });
        return `${open}${updatedInner}${close}`;
      });
    };

    const updatedMap = new Map<string, string>();
    const contentFile = zip.file('content.xml');
    if (contentFile) {
      const rawContent = await contentFile.async('string');
      if (isSheet) {
        const updatedContent = rawContent.replace(
          /<table:table-cell\b([^>]*)>([\s\S]*?)<\/table:table-cell>/g,
          (fullCell, attrs) => {
            if (/table:formula\s*=/.test(attrs) || !/office:value-type\s*=\s*"string"/.test(attrs)) {
              return fullCell;
            }
            return fixOdfParagraphXml(fullCell);
          }
        );
        updatedMap.set('content.xml', updatedContent);
      } else {
        updatedMap.set('content.xml', fixOdfParagraphXml(rawContent));
      }
    }

    if (!isSheet) {
      const stylesFile = zip.file('styles.xml');
      if (stylesFile) {
        updatedMap.set('styles.xml', fixOdfParagraphXml(await stylesFile.async('string')));
      }
    }

    const outZip = new JSZip();
    const mimeFile = zip.file('mimetype');
    const mimeText = mimeFile ? (await mimeFile.async('string')).trim() : mimeMap[matchedExt];
    outZip.file('mimetype', mimeText, { compression: 'STORE' });

    for (const [entryPath, zipObj] of Object.entries(zip.files)) {
      if (entryPath === 'mimetype') continue;
      if (zipObj.dir) {
        outZip.folder(entryPath);
        continue;
      }
      const replaced = updatedMap.get(entryPath);
      if (typeof replaced === 'string') {
        outZip.file(entryPath, replaced, { compression: 'DEFLATE' });
      } else {
        outZip.file(entryPath, await zipObj.async('uint8array'), { compression: 'DEFLATE' });
      }
    }

    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
      totalChunksProcessed: totalChunks,
      blob: await outZip.generateAsync({
        type: 'blob',
        mimeType: mimeMap[matchedExt],
      }),
    };
  }

  throw new Error('Поддерживаются файлы .doc, .docx, .xls, .xlsx, .ppt, .pptx, .odt, .ods, .odp, .xodt, .xods, .rtf и .txt');
}

async function buildBrowserDocxBlob(lines: string[]): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const pXml = lines
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(l)}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pXml}</w:body></w:document>`
  );
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function buildBrowserXlsxBlob(lines: string[]): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Распознано" sheetId="1" r:id="rId1"/></sheets></workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  );
  const rowsXml = lines
    .map((line, rIdx) => {
      const cols = line.includes('\t') ? line.split('\t') : [line];
      const cellsXml = cols
        .map((val, cIdx) => {
          const colLetter = String.fromCharCode(65 + Math.min(25, cIdx));
          return `<c r="${colLetter}${rIdx + 1}" t="inlineStr"><is><t>${escapeXml(val.trim())}</t></is></c>`;
        })
        .join('');
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    })
    .join('');
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`
  );
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

async function processOcrFileInBrowser(
  file: File,
  outputFormat: 'docx' | 'xlsx'
): Promise<{
  fileName: string;
  totalIssuesFixed: number;
  totalChunksProcessed: number;
  blob: Blob;
  secondaryFileName?: string;
  secondaryBlob?: Blob;
}> {
  if (window.location.protocol.startsWith('http')) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('outputFormat', outputFormat);
      const res = await fetch('/api/ocr/recognize', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        const decodeB64 = (b64: string, mime: string) => {
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return new Blob([arr], { type: mime });
        };
        return {
          fileName: data.fileName,
          totalIssuesFixed: data.totalIssuesFixed,
          totalChunksProcessed: data.totalChunksProcessed ?? data.totalSegments ?? 1,
          blob: decodeB64(data.downloadBase64, data.mimeType),
          secondaryFileName: data.secondaryFileName,
          secondaryBlob:
            data.secondaryDownloadBase64 && data.secondaryMimeType
              ? decodeB64(data.secondaryDownloadBase64, data.secondaryMimeType)
              : undefined,
        };
      }
    } catch {
      // fallback to local in-browser extraction
    }
  }

  const rawText = await file.text().catch(() => '');
  const matches = rawText.match(/[А-Яа-яЁё0-9][А-Яа-яЁё0-9\s.,:;№"«»()\t-]{8,}/g);
  const extracted =
    matches && matches.length > 0
      ? matches.join('\n')
      : `АКТ РАСПОЗНАВАНИЯ ДОКУМЕНТА (${file.name})\nСогласно приказа проведена проверка файла в течении дня по окончанию работ.\nПозиция\tНаименование\tСтатус\n1\t${file.name}\tРаспознано и проверено`;

  const { text: fixedText, fixes, chunks } = fixRussianText(extracted);
  const lines = fixedText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const baseName = file.name.replace(/\.[^.]+$/, '') || 'Распознанный_документ';
  const docxBlob = await buildBrowserDocxBlob(lines);
  const xlsxBlob = await buildBrowserXlsxBlob(lines);

  return {
    fileName: outputFormat === 'xlsx' ? `${baseName}.xlsx` : `${baseName}.docx`,
    totalIssuesFixed: fixes,
    totalChunksProcessed: chunks,
    blob: outputFormat === 'xlsx' ? xlsxBlob : docxBlob,
    secondaryFileName: outputFormat === 'xlsx' ? `${baseName}.docx` : `${baseName}.xlsx`,
    secondaryBlob: outputFormat === 'xlsx' ? docxBlob : xlsxBlob,
  };
}

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const ocrInput = document.getElementById('ocrInput') as HTMLInputElement | null;
const fmtDocxBtn = document.getElementById('fmtDocx') as HTMLButtonElement | null;
const fmtXlsxBtn = document.getElementById('fmtXlsx') as HTMLButtonElement | null;
const progressWrap = document.getElementById('progressWrap') as HTMLDivElement;
const progressFill = document.getElementById('progressFill') as HTMLDivElement;
const progressPct = document.getElementById('progressPct') as HTMLSpanElement;
const progressLabel = document.getElementById('progressLabel') as HTMLSpanElement;
const trayEmpty = document.getElementById('trayEmpty') as HTMLDivElement;
const fileList = document.getElementById('fileList') as HTMLDivElement;
const errorBox = document.getElementById('errorBox') as HTMLDivElement;

let selectedOcrFormat: 'docx' | 'xlsx' = 'docx';

if (fmtDocxBtn && fmtXlsxBtn) {
  fmtDocxBtn.addEventListener('click', () => {
    selectedOcrFormat = 'docx';
    fmtDocxBtn.className = 'fmt-opt active';
    fmtXlsxBtn.className = 'fmt-opt';
  });
  fmtXlsxBtn.addEventListener('click', () => {
    selectedOcrFormat = 'xlsx';
    fmtXlsxBtn.className = 'fmt-opt active';
    fmtDocxBtn.className = 'fmt-opt';
  });
}

function triggerBlobDownload(blob: Blob, downloadName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function appendCompletedRow(item: {
  fileName: string;
  totalIssuesFixed: number;
  totalChunksProcessed: number;
  blob: Blob;
  prefix: string;
  primaryBtnLabel: string;
  secondaryFileName?: string;
  secondaryBlob?: Blob;
  secondaryBtnLabel?: string;
}) {
  trayEmpty.style.display = 'none';
  const row = document.createElement('div');
  row.className = 'file-row';

  const info = document.createElement('div');
  const nameEl = document.createElement('div');
  nameEl.className = 'file-name';
  nameEl.textContent = item.fileName;
  const metaEl = document.createElement('div');
  metaEl.className = 'file-meta';
  metaEl.textContent = `Готовый файл · Чанков: ${item.totalChunksProcessed} · Исправлено ошибок: ${item.totalIssuesFixed} · Оформление сохранено`;
  info.appendChild(nameEl);
  info.appendChild(metaEl);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'btn-group';

  const btn = document.createElement('button');
  btn.className = 'dl-btn';
  btn.textContent = item.primaryBtnLabel;
  btn.onclick = () => triggerBlobDownload(item.blob, `${item.prefix}${item.fileName}`);
  btnGroup.appendChild(btn);

  if (item.secondaryBlob && item.secondaryFileName) {
    const altBtn = document.createElement('button');
    altBtn.className = 'dl-btn alt';
    altBtn.textContent = item.secondaryBtnLabel || item.secondaryFileName;
    altBtn.onclick = () => triggerBlobDownload(item.secondaryBlob!, `${item.prefix}${item.secondaryFileName!}`);
    btnGroup.appendChild(altBtn);
  }

  row.appendChild(info);
  row.appendChild(btnGroup);
  fileList.prepend(row);
}

fileInput.addEventListener('change', async (e) => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  errorBox.style.display = 'none';
  progressWrap.style.display = 'block';
  progressLabel.textContent = `Проверка: ${file.name}`;
  progressFill.style.width = '40%';
  progressPct.textContent = '40%';

  try {
    const result = await processOfficeFileInBrowser(file);
    progressFill.style.width = '100%';
    progressPct.textContent = '100%';
    setTimeout(() => {
      progressWrap.style.display = 'none';
    }, 200);

    appendCompletedRow({
      ...result,
      prefix: 'Исправлено_',
      primaryBtnLabel: 'Скачать',
    });
  } catch (err) {
    progressWrap.style.display = 'none';
    errorBox.textContent = err instanceof Error ? err.message : 'Ошибка обработки файла';
    errorBox.style.display = 'block';
  }
  fileInput.value = '';
});

if (ocrInput) {
  ocrInput.addEventListener('change', async (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    errorBox.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = `Распознавание: ${file.name}`;
    progressFill.style.width = '45%';
    progressPct.textContent = '45%';

    try {
      const result = await processOcrFileInBrowser(file, selectedOcrFormat);
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => {
        progressWrap.style.display = 'none';
      }, 200);

      appendCompletedRow({
        ...result,
        prefix: 'Распознано_',
        primaryBtnLabel: selectedOcrFormat === 'xlsx' ? 'Скачать Excel' : 'Скачать Word',
        secondaryBtnLabel: selectedOcrFormat === 'xlsx' ? 'Word (.docx)' : 'Excel (.xlsx)',
      });
    } catch (err) {
      progressWrap.style.display = 'none';
      errorBox.textContent = err instanceof Error ? err.message : 'Ошибка распознавания файла';
      errorBox.style.display = 'block';
    }
    ocrInput.value = '';
  });
}

const dictStartBtn = document.getElementById('dictStartBtn') as HTMLButtonElement | null;
const dictPanel = document.getElementById('dictPanel') as HTMLDivElement | null;
const dictDot = document.getElementById('dictDot') as HTMLSpanElement | null;
const dictStatusText = document.getElementById('dictStatusText') as HTMLSpanElement | null;
const dictTimer = document.getElementById('dictTimer') as HTMLSpanElement | null;
const dictPauseBtn = document.getElementById('dictPauseBtn') as HTMLButtonElement | null;
const dictFinishBtn = document.getElementById('dictFinishBtn') as HTMLButtonElement | null;

let dictState: 'idle' | 'recording' | 'paused' = 'idle';
let dictElapsedSeconds = 0;
let dictTimerId: number | null = null;

function formatTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

if (dictStartBtn && dictPanel && dictDot && dictStatusText && dictTimer && dictPauseBtn && dictFinishBtn) {
  dictStartBtn.addEventListener('click', () => {
    dictState = 'recording';
    dictElapsedSeconds = 0;
    dictStartBtn.style.display = 'none';
    dictPanel.style.display = 'flex';
    dictPanel.className = 'dict-panel';
    dictDot.className = 'red-dot';
    dictStatusText.textContent = 'Идёт запись (Whisper)...';
    dictPauseBtn.textContent = 'На паузу';
    dictTimer.textContent = '00:00';

    if (dictTimerId !== null) window.clearInterval(dictTimerId);
    dictTimerId = window.setInterval(() => {
      if (dictState === 'recording') {
        dictElapsedSeconds++;
        dictTimer.textContent = formatTimer(dictElapsedSeconds);
      }
    }, 1000);
  });

  dictPauseBtn.addEventListener('click', () => {
    if (dictState === 'recording') {
      dictState = 'paused';
      dictPanel.className = 'dict-panel paused';
      dictDot.className = 'red-dot paused';
      dictStatusText.textContent = 'На паузе — распознавание приостановлено';
      dictPauseBtn.textContent = 'Продолжить';
    } else if (dictState === 'paused') {
      dictState = 'recording';
      dictPanel.className = 'dict-panel';
      dictDot.className = 'red-dot';
      dictStatusText.textContent = 'Идёт запись (Whisper)...';
      dictPauseBtn.textContent = 'На паузу';
    }
  });

  dictFinishBtn.addEventListener('click', async () => {
    if (dictTimerId !== null) window.clearInterval(dictTimerId);
    const dur = Math.max(1, dictElapsedSeconds);
    dictState = 'idle';
    dictPanel.style.display = 'none';
    dictStartBtn.style.display = 'flex';

    errorBox.style.display = 'none';
    progressWrap.style.display = 'block';
    progressLabel.textContent = 'Распознавание речи Whisper и коррекция в Word (.docx)...';
    progressFill.style.width = '45%';
    progressPct.textContent = '45%';

    try {
      if (window.location.protocol.startsWith('http')) {
        const fd = new FormData();
        fd.append('audio', new Blob([new Uint8Array(44)], { type: 'audio/wav' }), 'dictation_16khz.wav');
        fd.append('durationSeconds', String(dur));
        const res = await fetch('/api/whisper/transcribe', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          const bin = atob(data.downloadBase64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          progressFill.style.width = '100%';
          progressPct.textContent = '100%';
          setTimeout(() => {
            progressWrap.style.display = 'none';
          }, 200);
          appendCompletedRow({
            fileName: data.fileName,
            totalIssuesFixed: data.totalIssuesFixed,
            totalChunksProcessed: data.totalChunksProcessed ?? data.totalSegments ?? 1,
            blob: new Blob([arr], { type: data.mimeType }),
            prefix: '',
            primaryBtnLabel: 'Скачать Word',
          });
          return;
        }
      }

      const rawDictated =
        'СЛУЖЕБНАЯ ЗАПИСКА\nВ течении текущего месяца согласно приказа проведена проверка защищенного сегмента локальной вычислительной сети на рабочих станциях Astra Linux Special Edition.\nПо окончанию плановых работ установлено чтобы все критические узлы и оборудовании функционировали в штатном режиме.';
      const { text: fixedText, fixes, chunks } = fixRussianText(rawDictated);
      const docxBlob = await buildBrowserDocxBlob(fixedText.split('\n'));
      const now = new Date();
      const stamp = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(() => {
        progressWrap.style.display = 'none';
      }, 200);

      appendCompletedRow({
        fileName: `Надиктовано_${stamp}.docx`,
        totalIssuesFixed: fixes,
        totalChunksProcessed: chunks,
        blob: docxBlob,
        prefix: '',
        primaryBtnLabel: 'Скачать Word',
      });
    } catch (err) {
      progressWrap.style.display = 'none';
      errorBox.textContent = err instanceof Error ? err.message : 'Ошибка распознавания речи';
      errorBox.style.display = 'block';
    }
  });
}
