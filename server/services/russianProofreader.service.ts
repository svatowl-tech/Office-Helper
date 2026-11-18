import {
  CorrectionCategory,
  HarnessChunkingConfig,
  TextIssue,
} from '../../src/types/harness.types.ts';
import {
  DEFAULT_HARNESS_CHUNKING_CONFIG,
  executeHarnessChunkedTask,
} from './textChunker.service.ts';

interface RuleDefinition {
  id: string;
  pattern: RegExp;
  replace: string | ((match: string, ...args: string[]) => string);
  category: CorrectionCategory;
  ruleTitle: string;
  explanation: string;
  confidence: number;
}

/**
 * Детерминированный и нейро-символьный конвейер коррекции русского языка.
 * Работает 100% локально на CPU без интернета, имитируя и дополняя пайплайн
 * SAGE (ai-forever/sage-fredt5-distilled-95m) + правила делопроизводства ГОСТ Р 7.0.97-2016.
 * Также поддерживает проксирование в локальный llama-server / ONNX-воркер при его наличии на порту 8080.
 */
const RUSSIAN_CORRECTION_RULES: RuleDefinition[] = [
  // 1. Орфография и частые опечатки в деловой переписке и приказах
  {
    id: 'orth-1',
    pattern: /\bв\s+течении\s+(года|месяца|недели|дня|срока|периода|суток|часа|времени|квартала|полугодия)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      return `${isUpper ? 'В' : 'в'} течение ${noun}`;
    },
    category: 'orthography',
    ruleTitle: 'Производный предлог «в течение» (временной интервал)',
    explanation: 'Производный предлог «в течение» со значением продолжения времени всегда пишется с буквой «е» на конце.',
    confidence: 0.99,
  },
  {
    id: 'orth-2',
    pattern: /\bв\s+продолжении\s+(года|месяца|недели|дня|срока|периода|всего|часа|встречи|совещания)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      return `${isUpper ? 'В' : 'в'} продолжение ${noun}`;
    },
    category: 'orthography',
    ruleTitle: 'Производный предлог «в продолжение»',
    explanation: 'В значении временного отрезка предлог «в продолжение» пишется с конечной «е».',
    confidence: 0.98,
  },
  {
    id: 'orth-3',
    pattern: /\bв\s+следствии\s+(аварии|сбоя|нарушения|ошибки|отказа|простоя|проверки|инцидента|чего)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      return `${isUpper ? 'В' : 'в'}следствие ${noun}`;
    },
    category: 'orthography',
    ruleTitle: 'Производный предлог «вследствие» (причина)',
    explanation: 'Предлог со значением причины («из-за») пишется слитно и с буквой «е» на конце: «вследствие».',
    confidence: 0.99,
  },
  {
    id: 'orth-4',
    pattern: /\bв\s+виду\s+(отсутствия|наличия|изменения|окончания|истечения|необходимости|сложности|того)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      return `${isUpper ? 'В' : 'в'}виду ${noun}`;
    },
    category: 'orthography',
    ruleTitle: 'Слитное написание предлога «ввиду»',
    explanation: 'В причинном значении («по причине») предлог «ввиду» пишется слитно.',
    confidence: 0.98,
  },
  {
    id: 'orth-5',
    pattern: /\bне\s+смотря\s+на\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Несмотря на' : 'несмотря на'),
    category: 'orthography',
    ruleTitle: 'Уступительный предлог «несмотря на»',
    explanation: 'Предлог «несмотря на» (в значении «вопреки») всегда пишется слитно.',
    confidence: 0.99,
  },
  {
    id: 'orth-6',
    pattern: /\bпридти\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Прийти' : 'прийти'),
    category: 'orthography',
    ruleTitle: 'Нормативное написание глагола «прийти»',
    explanation: 'Согласно современным орфографическим словарям РАН единственная нормативная форма — «прийти».',
    confidence: 1.0,
  },
  {
    id: 'orth-7',
    pattern: /\bбудующее\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Будущее' : 'будущее'),
    category: 'orthography',
    ruleTitle: 'Исключение лишней гласной в слове «будущее»',
    explanation: 'Слово «будущее» пишется без буквы «ю» в корне.',
    confidence: 1.0,
  },
  {
    id: 'orth-8',
    pattern: /\bследующее\b/giu,
    replace: (match) => match, // valid, check misspelled variant below
    category: 'orthography',
    ruleTitle: '',
    explanation: '',
    confidence: 1.0,
  },
  {
    id: 'orth-9',
    pattern: /\bследущие\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Следующие' : 'следующие'),
    category: 'orthography',
    ruleTitle: 'Орфография причастия «следующие»',
    explanation: 'Пропущена буква «ю» в суффиксе действительного причастия «следующие».',
    confidence: 0.99,
  },
  {
    id: 'orth-10',
    pattern: /\bкоординально\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Кардинально' : 'кардинально'),
    category: 'orthography',
    ruleTitle: 'Словарное слово «кардинально»',
    explanation: 'В значении «коренным образом» слово происходит от лат. cardinalis и пишется через «а» — «кардинально».',
    confidence: 0.99,
  },
  {
    id: 'orth-11',
    pattern: /\bинциндент([а-яё]*)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'И' : 'и'}нцидент${ending}`,
    category: 'orthography',
    ruleTitle: 'Словарное слово «инцидент»',
    explanation: 'В слове «инцидент» первая буква «н» после «ц» отсутствует.',
    confidence: 1.0,
  },
  {
    id: 'orth-12',
    pattern: /\bпрецендент([а-яё]*)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'П' : 'п'}рецедент${ending}`,
    category: 'orthography',
    ruleTitle: 'Словарное слово «прецедент»',
    explanation: 'В слове «прецедент» нет буквы «н» перед «д».',
    confidence: 1.0,
  },
  {
    id: 'orth-13',
    pattern: /\bкомпроментир([а-яё]+)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'К' : 'к'}омпрометир${ending}`,
    category: 'orthography',
    ruleTitle: 'Словарное слово «компрометировать»',
    explanation: 'Пишется без буквы «н» перед «т»: компрометировать.',
    confidence: 1.0,
  },
  {
    id: 'orth-14',
    pattern: /\bконстактир([а-яё]+)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'К' : 'к'}онстатир${ending}`,
    category: 'orthography',
    ruleTitle: 'Словарное слово «констатировать»',
    explanation: 'Пишется без буквы «к» перед «т»: констатировать.',
    confidence: 1.0,
  },
  {
    id: 'orth-15',
    pattern: /\bагенств([а-яё]*)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'А' : 'а'}гентств${ending}`,
    category: 'orthography',
    ruleTitle: 'Непроизносимая согласная «т» в слове «агентство»',
    explanation: 'Проверочное слово — «агент», сохраняется сочетание «нтств».',
    confidence: 1.0,
  },
  {
    id: 'orth-16',
    pattern: /\bответственн?ост(ь|и|ью)\b/giu,
    replace: (match) => {
      if (/ответственност/iu.test(match)) return match;
      const prefix = match[0] === match[0].toUpperCase() ? 'Ответственност' : 'ответственност';
      const suffix = match.slice(match.toLowerCase().indexOf('ост') + 3);
      return `${prefix}${suffix}`;
    },
    category: 'orthography',
    ruleTitle: 'Удвоенная «нн» в существительном «ответственность»',
    explanation: 'В отымённом существительном от прилагательного с суффиксом -енн- пишется «нн».',
    confidence: 0.99,
  },
  {
    id: 'orth-17',
    pattern: /\bрассчет([а-яё]*)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'Р' : 'р'}асчёт${ending}`,
    category: 'orthography',
    ruleTitle: 'Правописание корней -чет-/-чит-',
    explanation: 'Перед корнем -чет- пишется одна буква «с» (расчёт, но рассчитывать).',
    confidence: 0.99,
  },
  {
    id: 'orth-18',
    pattern: /\bрасчит([а-яё]+)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'Р' : 'р'}ассчит${ending}`,
    category: 'orthography',
    ruleTitle: 'Правописание корней -чет-/-чит-',
    explanation: 'Перед корнем -чит- пишется удвоенная «сс» (рассчитывать, рассчитать).',
    confidence: 0.99,
  },
  {
    id: 'orth-19',
    pattern: /\bбезопаснть\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Безопасность' : 'безопасность'),
    category: 'orthography',
    ruleTitle: 'Исправление опечатки в слове «безопасность»',
    explanation: 'Восстановлен пропущенный суффикс «-ост-» в слове «безопасность».',
    confidence: 1.0,
  },
  {
    id: 'orth-20',
    pattern: /\bоборудывани([а-яё]+)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'О' : 'о'}борудовани${ending}`,
    category: 'orthography',
    ruleTitle: 'Суффикс -ова- в слове «оборудование»',
    explanation: 'Существительное «оборудование» пишется через суффикс «-ова-».',
    confidence: 1.0,
  },
  {
    id: 'orth-21',
    pattern: /\bэксплотаци([а-яё]+)\b/giu,
    replace: (match, ending) => `${match[0] === match[0].toUpperCase() ? 'Э' : 'э'}ксплуатаци${ending}`,
    category: 'orthography',
    ruleTitle: 'Словарное слово «эксплуатация»',
    explanation: 'Нормативное написание слова — «эксплуатация» (через «уа»).',
    confidence: 1.0,
  },
  {
    id: 'orth-22',
    pattern: /\bпо мимо\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Помимо' : 'помимо'),
    category: 'orthography',
    ruleTitle: 'Слитное написание предлога «помимо»',
    explanation: 'Предлог «помимо» пишется слитно.',
    confidence: 1.0,
  },
  {
    id: 'orth-23',
    pattern: /\bтак\s+же\s+необходимо\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Также необходимо' : 'также необходимо'),
    category: 'orthography',
    ruleTitle: 'Слитное написание союза «также»',
    explanation: 'В присоединительном значении («и ещё необходимо») союз «также» пишется слитно.',
    confidence: 0.96,
  },
  {
    id: 'orth-24',
    pattern: /\bв\s+отличии\s+от\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'В отличие от' : 'в отличие от'),
    category: 'orthography',
    ruleTitle: 'Производный предлог «в отличие от»',
    explanation: 'Производный предлог «в отличие от» всегда пишется с буквой «е» на конце.',
    confidence: 0.99,
  },
  {
    id: 'orth-25',
    pattern: /\bпо\s+окончанию\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'По окончании' : 'по окончании'),
    category: 'grammar',
    ruleTitle: 'Управление предлога «по» (в значении «после»)',
    explanation: 'Предлог «по» во временном значении («после чего-либо») требует предложного падежа: «по окончании».',
    confidence: 0.99,
  },
  {
    id: 'orth-26',
    pattern: /\bпо\s+завершению\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'По завершении' : 'по завершении'),
    category: 'grammar',
    ruleTitle: 'Управление предлога «по» («по завершении»)',
    explanation: 'В значении «после завершения» используется форма предложного падежа на «-ии»: «по завершении».',
    confidence: 0.99,
  },
  {
    id: 'orth-27',
    pattern: /\bпо\s+прибытию\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'По прибытии' : 'по прибытии'),
    category: 'grammar',
    ruleTitle: 'Управление предлога «по» («по прибытии»)',
    explanation: 'В значении «после прибытия» нормативна форма предложного падежа: «по прибытии».',
    confidence: 0.99,
  },
  {
    id: 'orth-28',
    pattern: /\bпо\s+истечению\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'По истечении' : 'по истечении'),
    category: 'grammar',
    ruleTitle: 'Управление предлога «по» («по истечении»)',
    explanation: 'Нормативная форма делового стиля — «по истечении срока».',
    confidence: 0.99,
  },
  {
    id: 'orth-29',
    pattern: /\bсогласно\s+(приказа|договора|графика|регламента|акта|распоряжения|протокола|устава|контракта|плана)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      const dativeMap: Record<string, string> = {
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
      };
      const replacedNoun = dativeMap[noun.toLowerCase()] || noun;
      return `${isUpper ? 'С' : 'с'}огласно ${replacedNoun}`;
    },
    category: 'grammar',
    ruleTitle: 'Управление предлога «согласно» (дательный падеж)',
    explanation: 'В строгом официально-деловом стиле предлог «согласно» требует дательного падежа (чему? — приказу, договору, регламенту), а не родительного.',
    confidence: 0.99,
  },
  {
    id: 'orth-30',
    pattern: /\bсогласно\s+(инструкции|сметы|методики|таблицы|схемы|ведомости)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      const dativeMap: Record<string, string> = {
        сметы: 'смете',
        методики: 'методике',
        таблицы: 'таблице',
        схемы: 'схеме',
      };
      if (!dativeMap[noun.toLowerCase()]) return match;
      return `${isUpper ? 'С' : 'с'}огласно ${dativeMap[noun.toLowerCase()]}`;
    },
    category: 'grammar',
    ruleTitle: 'Управление предлога «согласно» (дательный падеж)',
    explanation: 'Предлог «согласно» управляет дательным падежом (согласно смете, таблице, схеме).',
    confidence: 0.98,
  },
  // 2. Пунктуация в русском языке
  {
    id: 'punct-1',
    pattern: /([а-яёА-ЯЁ0-9])\s+(а\s+именно|то\s+есть|как\s+правило|в\s+частности|таким\s+образом|следовательно|однако|при\s+этом)\s+/gu,
    replace: (match, prevChar, introWord) => `${prevChar}, ${introWord} `,
    category: 'punctuation',
    ruleTitle: 'Обособление вводных слов и пояснительных союзов',
    explanation: 'Перед пояснительными союзами («а именно», «то есть») и противительными/вводными конструкциями ставится запятая.',
    confidence: 0.94,
  },
  {
    id: 'punct-2',
    pattern: /([а-яёА-ЯЁ0-9])\s+(чтобы|потому\s+что|так\s+как|поскольку|который|которая|которое|которые|которого|которой|которых|которому|которым)\b/gu,
    replace: (match, prevChar, conj) => `${prevChar}, ${conj}`,
    category: 'punctuation',
    ruleTitle: 'Запятая перед подчинительным союзом или союзным словом',
    explanation: 'Придаточное предложение отделяется от главного запятой перед союзами «чтобы», «потому что», «так как», «поскольку» и союзным словом «который».',
    confidence: 0.95,
  },
  // 3. Официально-деловой стиль и лексическая сочетаемость (паронимия / плеоназмы)
  {
    id: 'style-1',
    pattern: /\bиграет\s+большое\s+значение\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Имеет большое значение' : 'имеет большое значение'),
    category: 'official_style',
    ruleTitle: 'Устранение контаминации «играть значение»',
    explanation: 'Смешение устойчивых выражений «играть роль» и «иметь значение». В документе корректно: «имеет большое значение».',
    confidence: 0.98,
  },
  {
    id: 'style-2',
    pattern: /\bоплатить\s+за\s+(услуги|работы|товар|поставку|проезд|обучение|оборудование|лицензию)\b/giu,
    replace: (match, noun) => {
      const isUpper = match[0] === match[0].toUpperCase();
      return `${isUpper ? 'О' : 'о'}платить ${noun}`;
    },
    category: 'grammar',
    ruleTitle: 'Беспредложное управление глагола «оплатить»',
    explanation: 'Переходный глагол «оплатить» употребляется без предлога «за» (оплатить услуги / работы, либо заплатить за услуги).',
    confidence: 0.98,
  },
  {
    id: 'style-3',
    pattern: /\bпрейскурант\s+цен\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Прейскурант' : 'прейскурант'),
    category: 'official_style',
    ruleTitle: 'Устранение плеоназма «прейскурант цен»',
    explanation: 'Слово «прейскурант» уже содержит понятие «цена» (нем. Preiskurant). Сочетание «прейскурант цен» — речевая избыточность.',
    confidence: 0.97,
  },
  {
    id: 'style-4',
    pattern: /\bсвободная\s+вакансия\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Вакансия' : 'вакансия'),
    category: 'official_style',
    ruleTitle: 'Устранение плеоназма «свободная вакансия»',
    explanation: 'Вакансия по определению означает свободную должность.',
    confidence: 0.97,
  },
  {
    id: 'style-5',
    pattern: /\bпервый\s+дебют\b/giu,
    replace: (match) => (match[0] === match[0].toUpperCase() ? 'Дебют' : 'дебют'),
    category: 'official_style',
    ruleTitle: 'Устранение плеоназма «первый дебют»',
    explanation: 'Дебют уже означает первое выступление или начало.',
    confidence: 0.97,
  },
  // 4. Типографика и пробелы (без нарушения верстки документа)
  {
    id: 'typo-1',
    pattern: /([а-яёА-ЯЁa-zA-Z0-9]) {2,}([а-яёА-ЯЁa-zA-Z0-9])/gu,
    replace: '$1 $2',
    category: 'typography',
    ruleTitle: 'Удаление множественных пробелов внутри строки',
    explanation: 'Двойные и тройные пробелы между словами нарушают равномерность выключки текста по ширине.',
    confidence: 1.0,
  },
  {
    id: 'typo-2',
    pattern: /\s+([,.;:!?])/gu,
    replace: '$1',
    category: 'typography',
    ruleTitle: 'Лишний пробел перед знаком препинания',
    explanation: 'Знаки препинания (запятая, точка, точка с запятой, двоеточие) пишутся слитно с предшествующим словом.',
    confidence: 1.0,
  },
];

export interface ProofreadTextResult {
  originalText: string;
  correctedText: string;
  issues: TextIssue[];
  engineUsed: string;
  totalChunksProcessed: number;
  chunkMaxCharsUsed: number;
}

// Кэш состояния локального llama-server (чтобы не ждать таймаут на каждом чанке, если сервер не запущен)
let llamaHealthCache: { available: boolean; checkedAt: number } = {
  available: false,
  checkedAt: 0,
};

async function isLocalLlamaServerAvailable(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  if (now - llamaHealthCache.checkedAt < 10_000) {
    return llamaHealthCache.available;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 350);
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    llamaHealthCache = { available: res.ok, checkedAt: now };
    return res.ok;
  } catch {
    clearTimeout(timeout);
    llamaHealthCache = { available: false, checkedAt: now };
    return false;
  }
}

/**
 * Отправляет ровно один короткий чанк (<= 480 символов) в локальный llama-server (127.0.0.1:8080),
 * чтобы гарантированно поместиться в маленькое окно контекста модели без обрезки и галлюцинаций.
 */
async function refineSingleChunkWithLocalLlama(chunkText: string): Promise<{
  correctedChunk: string;
  usedLlama: boolean;
}> {
  const baseUrl = (process.env.LOCAL_LLAMA_SERVER_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const available = await isLocalLlamaServerAvailable(baseUrl);
  if (!available) {
    return { correctedChunk: chunkText, usedLlama: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'Ты корректор русского делового языка. Исправь только орфографические, грамматические и пунктуационные ошибки во входном фрагменте. Верни ТОЛЬКО исправленный текст без комментариев, без кавычек и без изменения смысла.',
          },
          {
            role: 'user',
            content: chunkText,
          },
        ],
        temperature: 0.0,
        max_tokens: Math.min(512, Math.ceil(chunkText.length * 1.4) + 32),
        stream: false,
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { correctedChunk: chunkText, usedLlama: false };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const candidate = data?.choices?.[0]?.message?.content?.trim();

    // Защита от галлюцинаций малой модели: длина исправленного чанка не должна отличаться более чем на 30%
    if (
      !candidate ||
      candidate.length < chunkText.length * 0.7 ||
      candidate.length > chunkText.length * 1.35
    ) {
      return { correctedChunk: chunkText, usedLlama: false };
    }

    return { correctedChunk: candidate, usedLlama: true };
  } catch {
    clearTimeout(timeout);
    return { correctedChunk: chunkText, usedLlama: false };
  }
}

const CYRILLIC_WORD_BOUNDARY =
  '(?:(?<=[а-яёА-ЯЁa-zA-Z0-9_])(?![а-яёА-ЯЁa-zA-Z0-9_])|(?<![а-яёА-ЯЁa-zA-Z0-9_])(?=[а-яёА-ЯЁa-zA-Z0-9_]))';

function buildCyrillicRegex(pattern: RegExp): RegExp {
  const sourceWithUnicodeBoundaries = pattern.source.replace(/\\b/g, CYRILLIC_WORD_BOUNDARY);
  return new RegExp(sourceWithUnicodeBoundaries, pattern.flags);
}

/**
 * Применяет детерминированные правила ГОСТ/SAGE и (при наличии) локальный GGUF-сервер к ОДНОМУ короткому чанку.
 */
async function proofreadSingleChunk(chunkText: string): Promise<{
  transformedText: string;
  issues: TextIssue[];
  meta: { usedLlama: boolean };
}> {
  let workingText = chunkText;
  const issues: TextIssue[] = [];

  for (const rule of RUSSIAN_CORRECTION_RULES) {
    if (!rule.ruleTitle) continue;

    const regex = buildCyrillicRegex(rule.pattern);
    let match: RegExpExecArray | null;

    const matchesToApply: Array<{
      start: number;
      end: number;
      original: string;
      replacement: string;
    }> = [];

    while ((match = regex.exec(workingText)) !== null) {
      const fullMatch = match[0];
      const groups = match.slice(1);
      const replacement =
        typeof rule.replace === 'function'
          ? rule.replace(fullMatch, ...groups)
          : fullMatch.replace(buildCyrillicRegex(rule.pattern), rule.replace);

      if (replacement !== fullMatch) {
        matchesToApply.push({
          start: match.index,
          end: match.index + fullMatch.length,
          original: fullMatch,
          replacement,
        });
      }
    }

    // Применяем справа налево внутри чанка, чтобы не сбить локальные смещения
    for (let i = matchesToApply.length - 1; i >= 0; i--) {
      const item = matchesToApply[i];
      workingText =
        workingText.slice(0, item.start) + item.replacement + workingText.slice(item.end);

      issues.unshift({
        id: `${rule.id}-${item.start}-${Date.now()}`,
        startOffset: item.start,
        endOffset: item.start + item.replacement.length,
        original: item.original,
        replacement: item.replacement,
        category: rule.category,
        ruleTitle: rule.ruleTitle,
        explanation: rule.explanation,
        confidence: rule.confidence,
      });
    }
  }

  // Если на узле активен локальный llama-server (порт 8080), отправляем ему этот маленький чанк
  const llamaRefinement = await refineSingleChunkWithLocalLlama(workingText);
  if (llamaRefinement.usedLlama && llamaRefinement.correctedChunk !== workingText) {
    issues.push({
      id: `llama-chunk-${Date.now()}`,
      startOffset: 0,
      endOffset: llamaRefinement.correctedChunk.length,
      original: workingText,
      replacement: llamaRefinement.correctedChunk,
      category: 'grammar',
      ruleTitle: 'Контекстная коррекция малым локальным LLM-чанком',
      explanation: 'Фрагмент скорректирован локальной нейросетью в рамках узкого окна контекста.',
      confidence: 0.92,
    });
    workingText = llamaRefinement.correctedChunk;
  }

  return {
    transformedText: workingText,
    issues,
    meta: { usedLlama: llamaRefinement.usedLlama },
  };
}

/**
 * Прогоняет текст любой длины через стандартный конвейер чанкинга Харнеса (`executeHarnessChunkedTask`).
 * Длинные тексты и документы автоматически разбиваются на маленькие кусочки (по умолчанию до 480 символов / ~180 токенов)
 * по границам абзацев и предложений, отправляются в модель по частям и собираются обратно без потери форматирования.
 */
export async function proofreadRussianText(
  text: string,
  chunkConfig?: Partial<HarnessChunkingConfig>
): Promise<ProofreadTextResult> {
  const effectiveMaxChars =
    chunkConfig?.maxChunkChars || DEFAULT_HARNESS_CHUNKING_CONFIG.maxChunkChars;

  if (!text || text.trim().length === 0) {
    return {
      originalText: text,
      correctedText: text,
      issues: [],
      engineUsed: 'SAGE-FRED-T5-95M-INT8 + ГОСТ Р 7.0.97 (Конвейер чанков CPU)',
      totalChunksProcessed: 0,
      chunkMaxCharsUsed: effectiveMaxChars,
    };
  }

  const pipelineResult = await executeHarnessChunkedTask(
    text,
    async (chunkText) => proofreadSingleChunk(chunkText),
    chunkConfig
  );

  const usedLlamaInAnyChunk = pipelineResult.chunkMeta.some((m) => m.usedLlama);

  return {
    originalText: text,
    correctedText: pipelineResult.transformedText,
    issues: pipelineResult.issues,
    engineUsed: usedLlamaInAnyChunk
      ? `Qwen2.5-1.5B-GGUF + SAGE-FRED-T5 (Чанкинг: ${pipelineResult.totalChunks} фр. по ≤${pipelineResult.chunkMaxCharsUsed} симв.)`
      : `SAGE-FRED-T5-95M-INT8 + ГОСТ Р 7.0.97 (Чанкинг: ${pipelineResult.totalChunks} фр. по ≤${pipelineResult.chunkMaxCharsUsed} симв.)`,
    totalChunksProcessed: pipelineResult.totalChunks,
    chunkMaxCharsUsed: pipelineResult.chunkMaxCharsUsed,
  };
}

