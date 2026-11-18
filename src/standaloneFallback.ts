import JSZip from 'jszip';

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

function fixRussianText(text: string): { text: string; fixes: number } {
  let out = text;
  let fixes = 0;

  for (const rule of RULES) {
    const rx = new RegExp(rule.pattern.source, rule.pattern.flags);
    out = out.replace(rx, (...args) => {
      const match = args[0] as string;
      const replaced =
        typeof rule.replace === 'function'
          ? rule.replace(match, ...(args.slice(1, -2) as string[]))
          : match.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replace);
      if (replaced !== match) {
        fixes++;
      }
      return replaced;
    });
  }

  return { text: out, fixes };
}

function replaceTextNodesInParagraphXml(
  xml: string,
  pTag: 'w:p' | 'a:p',
  tTag: 'w:t' | 'a:t'
): { xml: string; totalFixes: number } {
  let totalFixes = 0;
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

    const { text: fixed, fixes } = fixRussianText(joined);
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

  return { xml: updated, totalFixes };
}

async function processOfficeFileInBrowser(file: File): Promise<{
  fileName: string;
  totalIssuesFixed: number;
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
    const { text, fixes } = fixRussianText(raw);
    return {
      fileName: file.name,
      totalIssuesFixed: fixes,
      blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    };
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  let totalFixes = 0;

  if (lower.endsWith('.docx')) {
    const targets = Object.keys(zip.files).filter(
      (p) => p === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(p)
    );
    for (const p of targets) {
      const f = zip.file(p);
      if (!f) continue;
      const { xml, totalFixes: fCount } = replaceTextNodesInParagraphXml(await f.async('string'), 'w:p', 'w:t');
      totalFixes += fCount;
      zip.file(p, xml);
    }
    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
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
      const { xml, totalFixes: fCount } = replaceTextNodesInParagraphXml(await f.async('string'), 'a:p', 'a:t');
      totalFixes += fCount;
      zip.file(p, xml);
    }
    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
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
          const { text, fixes } = fixRussianText(decoded);
          totalFixes += fixes;
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
          const { text, fixes } = fixRussianText(decoded);
          totalFixes += fixes;
          return `${open}${escapeXml(text)}${close}`;
        });
      });
      zip.file(s, updated);
    }

    return {
      fileName: file.name,
      totalIssuesFixed: totalFixes,
      blob: await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    };
  }

  throw new Error('Поддерживаются файлы .docx, .xlsx, .pptx и .txt');
}

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const progressWrap = document.getElementById('progressWrap') as HTMLDivElement;
const progressFill = document.getElementById('progressFill') as HTMLDivElement;
const progressPct = document.getElementById('progressPct') as HTMLSpanElement;
const progressLabel = document.getElementById('progressLabel') as HTMLSpanElement;
const trayEmpty = document.getElementById('trayEmpty') as HTMLDivElement;
const fileList = document.getElementById('fileList') as HTMLDivElement;
const errorBox = document.getElementById('errorBox') as HTMLDivElement;

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

    trayEmpty.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'file-row';

    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = result.fileName;
    const metaEl = document.createElement('div');
    metaEl.className = 'file-meta';
    metaEl.textContent = `Готовый файл · Исправлено ошибок: ${result.totalIssuesFixed} · Оформление сохранено`;
    info.appendChild(nameEl);
    info.appendChild(metaEl);

    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.textContent = 'Скачать';
    btn.onclick = () => {
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Исправлено_${result.fileName}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    row.appendChild(info);
    row.appendChild(btn);
    fileList.prepend(row);
  } catch (err) {
    progressWrap.style.display = 'none';
    errorBox.textContent = err instanceof Error ? err.message : 'Ошибка обработки файла';
    errorBox.style.display = 'block';
  }
  fileInput.value = '';
});
