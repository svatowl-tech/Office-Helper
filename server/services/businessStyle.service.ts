import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {
  BusinessStyleTransformationResult,
  DocumentProofreadResult,
  DocumentSegment,
} from '../../src/types/harness.types.ts';
import { proofreadRussianText } from './russianProofreader.service.ts';
import {
  buildDocxFromRecognizedBlocks,
  parseRecognizedTextToBlocks,
  processPdfOrImageToOffice,
} from './ocrDocument.service.ts';
import { extractPagesFromPdfWithMuPdf } from './pdfExtractor.service.ts';
import {
  detectMeetingMediaKind,
  transcribeMeetingMediaFile,
} from './meetingMedia.service.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CYR_BOUNDARY =
  '(?:(?<=[а-яёА-ЯЁa-zA-Z0-9_])(?![а-яёА-ЯЁa-zA-Z0-9_])|(?<![а-яёА-ЯЁa-zA-Z0-9_])(?=[а-яёА-ЯЁa-zA-Z0-9_]))';

function cyrRegex(source: string, flags = 'giu'): RegExp {
  return new RegExp(source.replace(/\\b/g, CYR_BOUNDARY), flags);
}

function matchInitialCase(source: string, replacement: string): string {
  if (!replacement) return replacement;
  const firstAlpha = source.match(/[а-яёА-ЯЁa-zA-Z]/u)?.[0];
  if (firstAlpha && firstAlpha === firstAlpha.toUpperCase() && firstAlpha !== firstAlpha.toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

interface StyleRule {
  id: string;
  label: string;
  pattern: RegExp;
  replace: string | ((match: string, ...args: string[]) => string);
}

/**
 * Детерминированный словарь преобразования разговорной, эмоциональной, неформальной
 * и резкой речи в корректный, вежливый официально-деловой стиль русского языка.
 * Сохраняет все факты, даты, суммы, номера договоров и основную мысль автора.
 */
const BUSINESS_STYLE_RULES: StyleRule[] = [
  // 1. Смягчение резких/конфликтных формулировок и нецензурной/грубой лексики
  {
    id: 'bs-profanity-1',
    label: 'Нейтрализация резких и ненормативных выражений',
    pattern: cyrRegex('\\b(бля[а-яё]*|хер[а-яё]*|хрен[а-яё]*|фигн[а-яё]+|еба[а-яё]*|ёб[а-яё]*|пизд[а-яё]*|сука|нахер|нафиг|отстой|бредятина|полный\\s+бред|чушь\\s+собачья|идиотизм|дурдом|бардак)\\b'),
    replace: (m) => matchInitialCase(m, 'недопустимая ситуация'),
  },
  {
    id: 'bs-conflict-1',
    label: 'Перевод претензий в конструктивное русло',
    pattern: cyrRegex('\\b(вы\\s+опять\\s+накосячили|опять\\s+накосячили|вы\\s+накосячили|накосячили|облажались|проворонили|запороли)\\b'),
    replace: (m) => matchInitialCase(m, 'к сожалению, были выявлены несоответствия'),
  },
  {
    id: 'bs-conflict-2',
    label: 'Смягчение эмоциональной критики',
    pattern: cyrRegex('\\b(это\\s+никуда\\s+не\\s+годится|полная\\s+ерунда|какая-то\\s+ерунда|ерунда\\s+какая-то|что\\s+за\\s+безобразие|ужасная\\s+работа|сделано\\s+ужасно|сделано\\s+отвратительно)\\b'),
    replace: (m) => matchInitialCase(m, 'представленный вариант требует существенной доработки'),
  },
  {
    id: 'bs-conflict-3a',
    label: 'Вежливый запрос о сроках вместо упрёка',
    pattern: cyrRegex('\\b(сколько\\s+можно\\s+ждать)\\s+([а-яё]+)\\b'),
    replace: (m, _phrase: string, noun: string) =>
      matchInitialCase(m, `прошу уточнить актуальные сроки предоставления ${noun}`),
  },
  {
    id: 'bs-conflict-3b',
    label: 'Вежливый запрос о сроках вместо упрёка',
    pattern: cyrRegex('\\b(сколько\\s+можно\\s+ждать|когда\\s+уже\\s+будет\\s+готово|хватит\\s+тянуть|не\\s+тяните\\s+резину|не\\s+тяните|давайте\\s+быстрее|быстро\\s+сделайте|шевелитесь)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу сообщить актуальный статус и по возможности ускорить выполнение задачи'),
  },
  {
    id: 'bs-conflict-4',
    label: 'Вежливое уточнение оплаты',
    pattern: cyrRegex('\\b(где\\s+деньги|где\\s+оплата|вы\\s+нам\\s+должны|когда\\s+оплатите|когда\\s+заплатите|бабки\\s+когда)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу уточнить планируемую дату оплаты и по возможности направить платёжное поручение'),
  },
  {
    id: 'bs-conflict-5',
    label: 'Вежливое уточнение готовности документов',
    pattern: cyrRegex('\\b(где\\s+документы|где\\s+доки|где\\s+акт|где\\s+сч[её]т|где\\s+договор)\\b'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower.includes('акт')) return matchInitialCase(m, 'прошу уточнить статус подготовки акта');
      if (lower.includes('счет') || lower.includes('счёт')) return matchInitialCase(m, 'прошу уточнить статус выставления счёта');
      if (lower.includes('договор')) return matchInitialCase(m, 'прошу уточнить статус согласования договора');
      return matchInitialCase(m, 'прошу уточнить статус подготовки необходимых документов');
    },
  },
  {
    id: 'bs-conflict-6',
    label: 'Смягчение категоричного отказа и несогласия',
    pattern: cyrRegex('\\b(мне\\s+это\\s+не\\s+подходит|нам\\s+это\\s+не\\s+подходит|нас\\s+это\\s+не\\s+устраивает|меня\\s+это\\s+не\\s+устраивает|категорически\\s+против|я\\s+не\\s+согласен|я\\s+не\\s+согласна|мы\\s+не\\s+согласны)\\b'),
    replace: (m) => matchInitialCase(m, 'к сожалению, предложенный вариант на текущий момент не соответствует нашим требованиям; предлагаем обсудить альтернативное решение'),
  },
  {
    id: 'bs-conflict-7',
    label: 'Корректная формулировка технического сбоя',
    pattern: cyrRegex('\\b(ничего\\s+не\\s+работает|вс[её]\\s+сломалось|вс[её]\\s+упало|опять\\s+упало|опять\\s+глючит|сильно\\s+глючит|глючит|тормозит\\s+ужасно|тупит)\\b'),
    replace: (m) => matchInitialCase(m, 'зафиксирован технический сбой в работе системы, прошу организовать проверку'),
  },
  {
    id: 'bs-conflict-8a',
    label: 'Деловая формулировка срочности перед действием',
    pattern: cyrRegex('\\b(срочно\\s+надо|надо\\s+срочно|срочно\\s+нужно|нужно\\s+срочно|нужно\\s+прямо\\s+сейчас|прямо\\s+сейчас\\s+надо)\\s+([а-яё]+(?:ть|ти|чь|ться))\\b'),
    replace: (m, _phrase: string, verb: string) =>
      matchInitialCase(m, `прошу в кратчайшие сроки ${verb}`),
  },
  {
    id: 'bs-conflict-8b',
    label: 'Деловая формулировка срочности',
    pattern: cyrRegex('\\b(надо\\s+было\\s+ещ[её]\\s+вчера|срочно\\s+надо|надо\\s+срочно|срочно\\s+нужно|нужно\\s+срочно|нужно\\s+прямо\\s+сейчас|прямо\\s+сейчас\\s+надо)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу рассмотреть в приоритетном порядке и выполнить в кратчайшие сроки'),
  },
  {
    id: 'bs-conflict-9',
    label: 'Вежливая формулировка требования',
    pattern: cyrRegex('\\b(я\\s+требую|мы\\s+требуем|требую\\s+немедленно|требуем\\s+немедленно)\\b'),
    replace: (m) => matchInitialCase(m, 'настоятельно прошу принять необходимые меры'),
  },
  {
    id: 'bs-conflict-10a',
    label: 'Деловое уведомление о рисках по срокам перед действием',
    pattern: cyrRegex('\\b(мы\\s+не\\s+успеваем|я\\s+не\\s+успеваю|не\\s+успеваем|не\\s+успеваю)\\s+([а-яё]+(?:ть|ти|чь|ться))\\b'),
    replace: (m, _phrase: string, verb: string) =>
      matchInitialCase(m, `возникает риск не успеть своевременно ${verb}`),
  },
  {
    id: 'bs-conflict-10b',
    label: 'Деловое уведомление о переносе сроков',
    pattern: cyrRegex('\\b(мы\\s+не\\s+успеваем|я\\s+не\\s+успеваю|не\\s+успеваем|не\\s+успеваю|срываем\\s+сроки|опаздываем\\s+со\\s+сроками)\\b'),
    replace: (m) => matchInitialCase(m, 'в связи с высокой текущей загрузкой прошу согласовать корректировку сроков исполнения'),
  },
  {
    id: 'bs-conflict-11',
    label: 'Корректное извинение за задержку',
    pattern: cyrRegex('\\b(ой\\s+забыл[аи]?|совсем\\s+забыл[аи]?|вылетело\\s+из\\s+головы|сорри\\s+за\\s+задержку|извиняюсь\\s+за\\s+задержку|простите\\s+за\\s+тормоза)\\b'),
    replace: (m) => matchInitialCase(m, 'приношу извинения за задержку с ответом'),
  },
  {
    id: 'bs-conflict-12',
    label: 'Вежливый отказ по бюджету или возможностям',
    pattern: cyrRegex('\\b(денег\\s+нет|нет\\s+денег|не\\s+можем\\s+заплатить|бюджета\\s+нет)\\b'),
    replace: (m) => matchInitialCase(m, 'в настоящее время бюджетные возможности по данному направлению ограничены'),
  },
  {
    id: 'bs-conflict-13',
    label: 'Вежливая форма о невозможности',
    pattern: cyrRegex('\\b(не\\s+получится|у\\s+меня\\s+не\\s+получится|у\\s+нас\\s+не\\s+получится|я\\s+не\\s+смогу|мы\\s+не\\s+сможем)\\b'),
    replace: (m) => matchInitialCase(m, 'к сожалению, на текущий момент не представляется возможным выполнить указанное условие'),
  },

  // 2. Удаление слов-паразитов и неформальных вводных междометий
  {
    id: 'bs-fillers-1',
    label: 'Исключение разговорных междометий и слов-паразитов',
    pattern: cyrRegex('(^|[.!?\\n]\\s*|[,;]\\s*)\\b(слушай|слушайте|короче|короче\\s+говоря|типа|блин|ну\\s+вот|ну\\s+короче|ну\\s+давай|ну\\s+смотрите|эй|алло|капец|жесть|офигеть|ёлки-палки|елки-палки|реально|тупо|вообще-то|как\\s+бы|по\\s+ходу|в\\s+общем-то)\\b[,!\\s]*'),
    replace: '$1',
  },
  {
    id: 'bs-fillers-2',
    label: 'Удаление внутрифразовых разговорных частиц',
    pattern: cyrRegex('\\s+\\b(блин|типа|короче|капец|жесть|тупо|как\\s+бы|ну\\s+типа|чё|чо)\\b(?=[\\s,.;:!?]|$)'),
    replace: '',
  },

  // 3. Неформальные приветствия и прощания -> деловой этикет
  {
    id: 'bs-greet-1',
    label: 'Деловое приветствие',
    pattern: cyrRegex('(^|\\n)\\s*(привет\\s+всем|всем\\s+привет|коллеги[,\\s]+привет|привет[,\\s]+коллеги|привет|приветик|здарова|здорово|хай|салют|добрый\\s+день\\s+всем|доброго\\s+времени\\s+суток)[!,\\s]*'),
    replace: (_m, prefix: string, greet: string) => {
      const lower = greet.toLowerCase();
      if (lower.includes('коллеги') || lower.includes('всем')) {
        return `${prefix}Уважаемые коллеги! `;
      }
      return `${prefix}Добрый день! `;
    },
  },
  {
    id: 'bs-bye-1',
    label: 'Официальная формула прощания',
    pattern: cyrRegex('\\b(пока|бывай|до\\s+скорого|давай\\s+на\\s+связи|на\\s+связи|жму\\s+руку|чмок|спс\\s+заранее|заранее\\s+спс|спасибки|от\\s+души)\\b[!.]*'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower.includes('спс') || lower.includes('спасиб') || lower.includes('от души')) {
        return matchInitialCase(m, 'заранее благодарю за содействие');
      }
      return matchInitialCase(m, 'благодарю за сотрудничество');
    },
  },

  // 4. Разговорные инфинитивы и обороты «как сделаешь» -> литературная деловая речь
  {
    id: 'bs-inf-1',
    label: 'Замена разговорных глаголов на деловые формулировки',
    pattern: cyrRegex('\\b(как\\s+сделаешь|когда\\s+сделаешь|как\\s+будет\\s+готово|скинуть|кинуть|переделать|поправить|глянуть|чекнуть|отписаться|пофиксить|починить|зааппрувить)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        'как сделаешь': 'по мере готовности',
        'когда сделаешь': 'по мере готовности',
        'как будет готово': 'по мере готовности',
        скинуть: 'направить',
        кинуть: 'направить',
        переделать: 'доработать',
        поправить: 'скорректировать',
        глянуть: 'ознакомиться',
        чекнуть: 'проверить',
        отписаться: 'сообщить о результатах',
        пофиксить: 'устранить неисправность',
        починить: 'восстановить работоспособность',
        зааппрувить: 'согласовать',
      };
      return matchInitialCase(m, map[m.toLowerCase()] || m);
    },
  },

  // 5. Повелительные и фамильярные глаголы («ты»-формы) -> вежливые деловые просьбы
  {
    id: 'bs-verb-send',
    label: 'Вежливая просьба направить материалы',
    pattern: cyrRegex('\\b(скинь|скиньте|кинь|киньте|пришли|пришлите|отправь|отправьте|перешли|перешлите|вышли|вышлите)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу направить'),
  },
  {
    id: 'bs-verb-review',
    label: 'Вежливая просьба ознакомиться',
    pattern: cyrRegex('\\b(глянь|гляньте|посмотри|посмотрите|чекни|чекните|пробегись\\s+глазами)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу ознакомиться'),
  },
  {
    id: 'bs-verb-do',
    label: 'Вежливая просьба выполнить задачу',
    pattern: cyrRegex('\\b(сделай|сделайте|запили|запилите|оформи|оформите)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу подготовить и выполнить'),
  },
  {
    id: 'bs-verb-fix',
    label: 'Вежливая просьба внести правки',
    pattern: cyrRegex('\\b(поправь|поправьте|исправь|исправьте|переделай|переделайте|пофикси|пофиксите|почини|почините)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу скорректировать'),
  },
  {
    id: 'bs-verb-approve',
    label: 'Вежливая просьба согласовать / подписать',
    pattern: cyrRegex('\\b(подпиши|подпишите|согласуй|согласуйте|зааппрувь|зааппрувьте|аппрувни|аппрувните)\\b'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower.startsWith('подпиш')) return matchInitialCase(m, 'прошу подписать');
      return matchInitialCase(m, 'прошу согласовать');
    },
  },
  {
    id: 'bs-verb-pay',
    label: 'Вежливая просьба произвести оплату',
    pattern: cyrRegex('\\b(оплати|оплатите|заплати|заплатите)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу произвести оплату'),
  },
  {
    id: 'bs-verb-call',
    label: 'Вежливая просьба связаться',
    pattern: cyrRegex('\\b(перезвони|перезвоните|набери\\s+мне|наберите\\s+мне|позвони|позвоните)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу связаться со мной по телефону в удобное время'),
  },
  {
    id: 'bs-verb-reply',
    label: 'Вежливая просьба об обратной связи',
    pattern: cyrRegex('\\b(отпишись|отпишитесь|ответь|ответьте|дай\\s+знать|дайте\\s+знать|маякни|маякните|напиши\\s+мне|напишите\\s+мне)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу проинформировать о результатах'),
  },
  {
    id: 'bs-verb-explain',
    label: 'Вежливая просьба о разъяснении',
    pattern: cyrRegex('\\b(скажи|скажите|объясни|объясните|уточни|уточните|подскажи|подскажите)\\b'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower.startsWith('объясн')) return matchInitialCase(m, 'прошу предоставить разъяснения');
      return matchInitialCase(m, 'прошу уточнить');
    },
  },
  {
    id: 'bs-verb-check',
    label: 'Вежливая просьба провести проверку',
    pattern: cyrRegex('\\b(проверь|проверьте|разберись|разберитесь)\\b'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower.startsWith('разбер')) return matchInitialCase(m, 'прошу рассмотреть данный вопрос и принять необходимые меры');
      return matchInitialCase(m, 'прошу провести проверку');
    },
  },
  {
    id: 'bs-verb-help',
    label: 'Вежливая просьба об оказании содействия',
    pattern: cyrRegex('\\b(помоги|помогите|выручи|выручите)\\b'),
    replace: (m) => matchInitialCase(m, 'прошу оказать содействие'),
  },
  {
    id: 'bs-verb-confirm',
    label: 'Вежливая просьба подтвердить',
    pattern: cyrRegex('\\b(подтверди|подтвердите|передай|передайте|добавь|добавьте|убери|уберите|поменяй|поменяйте)\\b'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower.startsWith('подтверд')) return matchInitialCase(m, 'прошу подтвердить');
      if (lower.startsWith('переда')) return matchInitialCase(m, 'прошу передать');
      if (lower.startsWith('добав')) return matchInitialCase(m, 'прошу дополнить');
      if (lower.startsWith('убер')) return matchInitialCase(m, 'прошу исключить');
      return matchInitialCase(m, 'прошу скорректировать');
    },
  },

  // 6. Глаголы 2-го лица ед.ч. («ты»-обращение) -> уважительная форма на «Вы»
  {
    id: 'bs-verb-2sg-vy',
    label: 'Перевод глаголов обращения с «ты» на «Вы»',
    pattern: cyrRegex('\\b(сделаешь|сможешь|пришл[её]шь|скинешь|посмотришь|ответишь|подпишешь|оплатишь|успеешь|будешь|хочешь|можешь|знаешь|видишь|понимаешь|думаешь|отправишь)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        сделаешь: 'выполните',
        сможешь: 'сможете',
        пришлешь: 'направите',
        пришлёшь: 'направите',
        скинешь: 'направите',
        посмотришь: 'ознакомитесь',
        ответишь: 'сообщите',
        подпишешь: 'подпишете',
        оплатишь: 'произведёте оплату',
        успеешь: 'успеете',
        будешь: 'будете',
        хочешь: 'желаете',
        можешь: 'можете',
        знаешь: 'знаете',
        видишь: 'видите',
        понимаешь: 'понимаете',
        думаешь: 'считаете',
        отправишь: 'направите',
      };
      return matchInitialCase(m, map[m.toLowerCase()] || m);
    },
  },

  // 7. Разговорный сленг и офисный жаргон -> литературная деловая лексика
  {
    id: 'bs-slang-1',
    label: 'Замена сленга на официальные термины',
    pattern: cyrRegex('\\b(доки|доков|докам|доками|бумажки|бумажек)\\b'),
    replace: (m) => {
      const lower = m.toLowerCase();
      if (lower === 'доков' || lower === 'бумажек') return matchInitialCase(m, 'документов');
      if (lower === 'докам') return matchInitialCase(m, 'документам');
      if (lower === 'доками') return matchInitialCase(m, 'документами');
      return matchInitialCase(m, 'документы');
    },
  },
  {
    id: 'bs-slang-2',
    label: 'Замена сокращений «инфа / преза / таска / дедлайн / фидбек»',
    pattern: cyrRegex('\\b(инфа|инфу|инфы|преза|презу|таска|таску|таски|дедлайн|дедлайны|фидбек|фидбэк|апрув|аппрув|созвон|созвониться|созвонимся)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        инфа: 'информация',
        инфу: 'информацию',
        инфы: 'информации',
        преза: 'презентация',
        презу: 'презентацию',
        таска: 'задача',
        таску: 'задачу',
        таски: 'задачи',
        дедлайн: 'контрольный срок',
        дедлайны: 'контрольные сроки',
        фидбек: 'обратная связь',
        фидбэк: 'обратная связь',
        апрув: 'согласование',
        аппрув: 'согласование',
        созвон: 'рабочее совещание по телефону',
        созвониться: 'провести телефонные переговоры',
        созвонимся: 'свяжемся по телефону',
      };
      return matchInitialCase(m, map[m.toLowerCase()] || m);
    },
  },
  {
    id: 'bs-slang-3',
    label: 'Замена разговорных слов «косяк / затык / баг / бабки / щас»',
    pattern: cyrRegex('\\b(с\\s+косяками|косяк|косяки|косяков|косяками|затык|затыки|баг|баги|бабки|бабок|щас|сейчас\\s+же|сорри|извиняюсь|пардон|ок|окей|лады|спс|плиз|плз)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        'с косяками': 'с замечаниями',
        косяк: 'несоответствие',
        косяки: 'замечания',
        косяков: 'замечаний',
        косяками: 'замечаниями',
        затык: 'затруднение',
        затыки: 'затруднения',
        баг: 'техническая ошибка',
        баги: 'технические ошибки',
        бабки: 'денежные средства',
        бабок: 'денежных средств',
        щас: 'в настоящее время',
        'сейчас же': 'в приоритетном порядке',
        сорри: 'приношу извинения',
        извиняюсь: 'приношу извинения',
        пардон: 'приношу извинения',
        ок: 'принято в работу',
        окей: 'принято в работу',
        лады: 'согласовано',
        спс: 'заранее благодарю за содействие',
        плиз: 'пожалуйста',
        плз: 'пожалуйста',
      };
      return matchInitialCase(m, map[m.toLowerCase()] || m);
    },
  },
  {
    id: 'bs-slang-4',
    label: 'Деловые связки и союзы',
    pattern: cyrRegex('\\b(а\\s+то|иначе\\s+будет\\s+плохо|если\\s+что|если\\s+вдруг|на\\s+всякий\\s+случай|без\\s+проблем|не\\s+вопрос|вроде\\s+бы|куча|дофига|нормально|норм|кстати)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        'а то': 'в противном случае',
        'иначе будет плохо': 'во избежание негативных последствий',
        'если что': 'в случае возникновения дополнительных вопросов',
        'если вдруг': 'в случае возникновения необходимости',
        'на всякий случай': 'дополнительно для сведения',
        'без проблем': 'безусловно, готовы оказать содействие',
        'не вопрос': 'подтверждаю готовность выполнить запрос',
        'вроде бы': 'по предварительной информации',
        куча: 'значительное количество',
        дофига: 'значительный объём',
        нормально: 'в штатном режиме',
        норм: 'удовлетворительно',
        кстати: 'дополнительно сообщаю, что',
      };
      return matchInitialCase(m, map[m.toLowerCase()] || m);
    },
  },
  {
    id: 'bs-slang-5',
    label: 'Замена разговорного «надо / хочу / давай / ругается»',
    pattern: cyrRegex('\\b(надо|нужно|хочу\\s+попросить|хотим\\s+попросить|давай\\s+сделаем|давай\\s+обсудим|давайте\\s+обсудим|ругается|ругаются)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        надо: 'необходимо',
        нужно: 'необходимо',
        'хочу попросить': 'прошу Вас',
        'хотим попросить': 'просим Вас',
        'давай сделаем': 'предлагаю реализовать',
        'давай обсудим': 'предлагаю обсудить',
        'давайте обсудим': 'предлагаем обсудить',
        ругается: 'направляет замечания',
        ругаются: 'выражают обеспокоенность',
      };
      return matchInitialCase(m, map[m.toLowerCase()] || m);
    },
  },

  // 8. Вежливое обращение на «Вы» вместо неформального «ты»
  {
    id: 'bs-pronoun-vy',
    label: 'Перевод обращения с «ты» на уважительное «Вы»',
    pattern: cyrRegex('\\b(ты|тебя|тебе|тобой|тобою|твой|твоя|тво[её]|твои|твоего|твоей|твоих|твоему|твоим|твоими)\\b'),
    replace: (m) => {
      const map: Record<string, string> = {
        ты: 'Вы',
        тебя: 'Вас',
        тебе: 'Вам',
        тобой: 'Вами',
        тобою: 'Вами',
        твой: 'Ваш',
        твоя: 'Ваша',
        твое: 'Ваше',
        твоё: 'Ваше',
        твои: 'Ваши',
        твоего: 'Вашего',
        твоей: 'Вашей',
        твоих: 'Ваших',
        твоему: 'Вашему',
        твоим: 'Вашим',
        твоими: 'Вашими',
      };
      return map[m.toLowerCase()] || m;
    },
  },
];

let localLlamaStyleHealth: { available: boolean; checkedAt: number } = {
  available: false,
  checkedAt: 0,
};

async function isLocalLlamaAvailableForStyle(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  if (now - localLlamaStyleHealth.checkedAt < 10_000) {
    return localLlamaStyleHealth.available;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 350);
  try {
    const res = await fetch(`${baseUrl}/health`, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);
    localLlamaStyleHealth = { available: res.ok, checkedAt: now };
    return res.ok;
  } catch {
    clearTimeout(timeout);
    localLlamaStyleHealth = { available: false, checkedAt: now };
    return false;
  }
}

async function refineWithLocalLlamaBusinessStyle(rawText: string): Promise<string | null> {
  const baseUrl = (process.env.LOCAL_LLAMA_SERVER_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  if (!(await isLocalLlamaAvailableForStyle(baseUrl))) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
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
              'Ты опытный корпоративный редактор деловой переписки. Преобразуй текст пользователя в вежливый, грамотный, уважительный официально-деловой стиль на русском языке, пригодный для официальной отправки. Сохрани основной смысл, все факты, имена, даты и суммы. Верни только готовый текст письма без комментариев.',
          },
          {
            role: 'user',
            content: rawText,
          },
        ],
        temperature: 0.2,
        max_tokens: Math.min(1024, Math.ceil(rawText.length * 1.8) + 120),
        stream: false,
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (!out || out.length < Math.min(20, rawText.trim().length * 0.4)) {
      return null;
    }
    return out;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Снижает крикливый КАПСЛОК в предложениях, сохраняя известные аббревиатуры (ООО, АО, НДС, ГОСТ, PDF, РФ, ЗСПД и т.д.)
 */
function normalizeShoutingCase(input: string): { text: string; changed: boolean } {
  const letters = input.match(/[а-яёА-ЯЁ]/gu) || [];
  if (letters.length < 12) return { text: input, changed: false };
  const upperCount = letters.filter((c) => c === c.toUpperCase()).length;
  if (upperCount / letters.length < 0.72) return { text: input, changed: false };

  const preserveAcronyms = new Set([
    'ООО', 'ОАО', 'ЗАО', 'ПАО', 'АО', 'ИП', 'РФ', 'НДС', 'ИНН', 'КПП', 'ОГРН', 'БИК',
    'ГОСТ', 'СНИП', 'ТЗ', 'КП', 'ЭДО', 'ЗСПД', 'ФСТЭК', 'ФСБ', 'МВД', 'МЧС', 'ФНС',
    'PDF', 'DOCX', 'XLSX', 'CSV', 'XML', 'HTML', 'IT', 'HR', 'KPI', 'SLA', 'VIP',
  ]);

  const lower = input.toLowerCase();
  const restored = lower.replace(/[а-яёa-z]{2,6}/giu, (word) => {
    const up = word.toUpperCase();
    return preserveAcronyms.has(up) ? up : word;
  });

  return { text: restored, changed: restored !== input };
}

/**
 * Оформляет преобразованный текст по правилам делового письма:
 * - убирает дублирующиеся восклицательные/вопросительные знаки;
 * - восстанавливает регистр предложений;
 * - добавляет вежливое приветствие и корректную завершающую формулу при их отсутствии.
 */
function frameAsPoliteBusinessMessage(text: string): { framed: string; addedFraming: boolean } {
  let cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/!{2,}/g, '.')
    .replace(/\?{2,}/g, '?')
    .replace(/\?!+|!\?+/g, '?')
    .replace(/([,;:])\s*[,;:]+/g, '$1')
    .replace(/^\s*[,;:\-–—]+\s*/gm, '')
    .replace(/прошу\s+прошу/giu, 'прошу')
    .replace(/необходимо\s+необходимо/giu, 'необходимо')
    .replace(/прошу\s+Вас\s+прошу/giu, 'прошу Вас')
    .replace(/срочно\s+прошу\s+/giu, 'прошу в кратчайшие сроки ')
    .replace(/(\bи\s+)прошу\s+(направить|подготовить|согласовать|подписать|скорректировать|проинформировать)/giu, '$1$2')
    .trim();

  // Выделяем приветствие, если оно уже есть в начале текста, чтобы сохранить «!» в приветствии, но успокоить пунктуацию в теле письма
  const greetingPattern =
    /^((?:добрый\s+(?:день|вечер)|доброе\s+утро|здравствуйте|уважаем(?:ый|ая|ые)(?:\s+[а-яёА-ЯЁa-zA-Z\-]+){0,3}|приветствую))[!,.:]?\s*/iu;
  let greetingLine: string | null = null;
  const greetingMatch = cleaned.match(greetingPattern);
  if (greetingMatch) {
    const rawGreeting = greetingMatch[1].trim();
    greetingLine = `${rawGreeting[0].toUpperCase()}${rawGreeting.slice(1)}!`;
    cleaned = cleaned.slice(greetingMatch[0].length).trim();
  }

  // Нормализация предложений и абзацев основной части
  const rawParagraphs = cleaned
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const formattedParagraphs = rawParagraphs
    .map((para) => {
      let line = para
        // В теле официального письма убираем эмоциональные восклицательные знаки
        .replace(/!/g, '.')
        // Убираем случайный вопросительный знак в конце утвердительной вежливой просьбы
        .replace(
          /((?:^|[.!?]\s+)(?:прошу(?:\s+Вас)?|необходимо|благодарю|рекомендуем|сообщаем|направляем)[^.!?]*)\?/giu,
          '$1.'
        )
        // Разделяем склеенные через запятую независимые формулы вежливой просьбы / благодарности
        .replace(/,\s+(прошу\s+Вас|прошу\s+уточнить|благодарю\s+за\s+содействие)/giu, '. $1')
        .replace(/\.{2,}/g, '.')
        .replace(/[ \t]+([,.;:!?])/g, '$1')
        .replace(/([,.;:!?])([а-яёА-ЯЁa-zA-Z])/gu, '$1 $2')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      if (!line) return '';
      line = line[0].toUpperCase() + line.slice(1);
      line = line.replace(
        /([.!?]\s+)([а-яёa-z])/gu,
        (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`
      );
      if (!/[.!?:]$/.test(line)) {
        line += '.';
      }
      return line;
    })
    .filter(Boolean);

  const bodyText = formattedParagraphs.join('\n\n');

  const hasClosing =
    /(с\s+уважением|благодар(ю|им)\s+за\s+(внимание|сотрудничество|содействие|понимание)|заранее\s+благодар(ю|им))/iu.test(
      bodyText
    );

  let addedFraming = false;
  const sections: string[] = [];

  if (greetingLine) {
    sections.push(greetingLine);
  } else {
    sections.push('Добрый день!');
    addedFraming = true;
  }

  if (bodyText) {
    sections.push(bodyText);
  }

  if (!hasClosing) {
    sections.push('Заранее благодарю за внимание и содействие.\nС уважением,');
    addedFraming = true;
  } else if (!/с\s+уважением/iu.test(bodyText)) {
    sections.push('С уважением,');
    addedFraming = true;
  }

  return {
    framed: sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    addedFraming,
  };
}

/**
 * Основная функция модуля «Деловой стиль»: преобразует произвольный текст в вежливый официальный стиль,
 * прогоняет через орфографический/пунктуационный корректор и формирует готовый файл Word (.docx).
 */
export async function transformToBusinessStyle(
  rawText: string,
  sourceFileName?: string
): Promise<BusinessStyleTransformationResult> {
  const startTime = Date.now();
  const normalizedInput = rawText.trim();
  if (!normalizedInput) {
    throw new Error('Введите, надиктуйте или загрузите текст для преобразования в деловой стиль.');
  }

  const appliedLabels = new Set<string>();
  let improvementsCount = 0;
  let workingText = normalizedInput;
  let engineUsed = 'Локальный редактор делового стиля (ГОСТ Р 7.0.97 + этикет)';

  // 1. Опциональный локальный llama-server (127.0.0.1:8080), если развёрнут на рабочем месте
  const localLlamaDraft = await refineWithLocalLlamaBusinessStyle(workingText);
  if (localLlamaDraft) {
    workingText = localLlamaDraft;
    improvementsCount += 1;
    appliedLabels.add('Стилистическая переработка локальной моделью (llama-server)');
    engineUsed = 'Локальный llama-server + редактор делового стиля ГОСТ Р 7.0.97';
  } else {
    // 2. Снятие КАПСЛОКа
    const shoutCheck = normalizeShoutingCase(workingText);
    if (shoutCheck.changed) {
      workingText = shoutCheck.text;
      improvementsCount += 1;
      appliedLabels.add('Смягчение повышенного регистра (CAPS LOCK)');
    }

    // 3. Многоэтапная детерминированная стилистическая трансформация
    for (const rule of BUSINESS_STYLE_RULES) {
      const before = workingText;
      workingText =
        typeof rule.replace === 'function'
          ? workingText.replace(rule.pattern, rule.replace)
          : workingText.replace(rule.pattern, rule.replace);

      if (workingText !== before) {
        improvementsCount += 1;
        appliedLabels.add(rule.label);
      }
    }
  }

  // 4. Оформление по стандарту вежливой официальной переписки
  const framedResult = frameAsPoliteBusinessMessage(workingText);
  workingText = framedResult.framed;
  if (framedResult.addedFraming) {
    improvementsCount += 1;
    appliedLabels.add('Оформление вежливого приветствия и завершающей формулы');
  }

  // 5. Финальная проверка орфографии, грамматики и пунктуации через стандартный корректор
  const proofread = await proofreadRussianText(workingText);
  const finalFormalText = proofread.correctedText;
  if (proofread.issues.length > 0) {
    improvementsCount += proofread.issues.length;
    appliedLabels.add(`Орфография и пунктуация (исправлено: ${proofread.issues.length})`);
  }

  // 6. Формирование готового документа Word (.docx) для официальной отправки
  const blocks = parseRecognizedTextToBlocks(finalFormalText);
  const docxBuffer = await buildDocxFromRecognizedBlocks(blocks);

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const baseSource = sourceFileName
    ? path.basename(sourceFileName, path.extname(sourceFileName)).replace(/[^\p{L}\p{N}_-]+/gu, '_')
    : stamp;
  const outFileName = `Деловой_стиль_${baseSource}.docx`;

  const segment: DocumentSegment = {
    id: 'business-style-seg-1',
    location: sourceFileName ? `Документ: ${sourceFileName}` : 'Обращение в деловом стиле',
    elementType: 'paragraph',
    originalText: normalizedInput,
    correctedText: finalFormalText,
    preservedFormattingMeta: 'Официально-деловой стиль · Вежливый этикет · ГОСТ Word (.docx)',
    issues: proofread.issues,
    applied: true,
  };

  const documentResult: DocumentProofreadResult = {
    fileName: outFileName,
    fileType: 'docx',
    fileSizeBytes: docxBuffer.length,
    processingTimeMs: Math.max(8, Date.now() - startTime),
    engineUsed,
    totalSegments: Math.max(1, finalFormalText.split(/\n+/).filter(Boolean).length),
    modifiedSegments: 1,
    totalIssuesFixed: Math.max(1, improvementsCount),
    totalChunksProcessed: Math.max(1, proofread.totalChunksProcessed),
    chunkMaxCharsUsed: proofread.chunkMaxCharsUsed,
    segments: [segment],
    downloadBase64: docxBuffer.toString('base64'),
    mimeType: DOCX_MIME,
    operationMode: 'business_style',
    sourceFileName,
  };

  return {
    originalText: normalizedInput,
    formalText: finalFormalText,
    improvementsCount: Math.max(1, improvementsCount),
    appliedTransformations: Array.from(appliedLabels),
    processingTimeMs: documentResult.processingTimeMs,
    engineUsed,
    sourceFileName,
    documentResult,
  };
}

function unescapeXmlEntities(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function decodeRtfToPlainText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  let text = raw
    .replace(/\\par\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, ' ');

  // Декодирование Unicode \uN? и CP1251 \'xx
  text = text.replace(/\\u(-?\d+)\??/g, (_m, codeStr: string) => {
    let code = Number(codeStr);
    if (code < 0) code += 65536;
    return String.fromCharCode(code);
  });

  const cp1251Decoder = new TextDecoder('windows-1251');
  text = text.replace(/(?:\\'([0-9a-fA-F]{2}))+/g, (seq) => {
    const hexMatches = seq.match(/[0-9a-fA-F]{2}/g) || [];
    const bytes = new Uint8Array(hexMatches.map((h) => parseInt(h, 16)));
    return cp1251Decoder.decode(bytes);
  });

  // Убираем служебные группы шрифтов/цветов и управляющие слова RTF
  text = text
    .replace(/\{\\\*\\[^}]*\}/g, '')
    .replace(/\{\\(?:fonttbl|colortbl|stylesheet|info)[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function extractReadableTextFromLegacyBinary(buffer: Buffer): string {
  // Извлекаем UTF-16LE кириллические/латинские строки (характерно для .doc / .ppt / .xls)
  const utf16 = buffer.toString('utf16le');
  const utf16Chunks = utf16.match(/[А-Яа-яЁёA-Za-z0-9][А-Яа-яЁёA-Za-z0-9 ,.;:!?«»"'()\-\n]{8,}/gu) || [];
  const filteredUtf16 = utf16Chunks
    .map((s) => s.trim())
    .filter((s) => /[А-Яа-яЁё]{3,}/u.test(s) && !/^(Root Entry|WordDocument|Microsoft|Times New Roman|Arial|Calibri)/i.test(s));

  if (filteredUtf16.length > 0) {
    return filteredUtf16.join('\n').trim();
  }

  // Fallback: windows-1251
  const cp1251 = new TextDecoder('windows-1251').decode(buffer);
  const cpChunks = cp1251.match(/[А-Яа-яЁё][А-Яа-яЁёA-Za-z0-9 ,.;:!?«»"'()\-\n]{8,}/gu) || [];
  return cpChunks.map((s) => s.trim()).join('\n').trim();
}

/**
 * Извлекает читаемый текст из любого загруженного офисного документа (.docx, .odt, .xodt, .xlsx, .ods, .pptx, .odp, .rtf, .txt, .pdf, .doc, .xls, .ppt)
 */
export async function extractTextFromDocumentBuffer(
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const ext = path.extname(fileName).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    return buffer.toString('utf8').trim();
  }

  if (ext === '.rtf') {
    return decodeRtfToPlainText(buffer);
  }

  if (ext === '.docx') {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')?.async('string');
    if (!docXml) return '';
    const paragraphs: string[] = [];
    const pMatches = docXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
    for (const pXml of pMatches) {
      const tMatches = pXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [];
      const line = tMatches
        .map((t) => unescapeXmlEntities(t.replace(/<[^>]+>/g, '')))
        .join('')
        .trim();
      if (line) paragraphs.push(line);
    }
    return paragraphs.join('\n\n');
  }

  if (ext === '.odt' || ext === '.xodt' || ext === '.ods' || ext === '.xods' || ext === '.odp') {
    const zip = await JSZip.loadAsync(buffer);
    const contentXml = await zip.file('content.xml')?.async('string');
    if (!contentXml) return '';
    const paragraphs: string[] = [];
    const matches = contentXml.match(/<text:(?:p|h)(?:\s[^>]*)?>[\s\S]*?<\/text:(?:p|h)>/g) || [];
    for (const el of matches) {
      const clean = unescapeXmlEntities(el.replace(/<[^>]+>/g, '')).trim();
      if (clean) paragraphs.push(clean);
    }
    return paragraphs.join('\n\n');
  }

  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const na = Number(a.match(/\d+/)?.[0] || 0);
        const nb = Number(b.match(/\d+/)?.[0] || 0);
        return na - nb;
      });
    const slidesText: string[] = [];
    for (const slideName of slideNames) {
      const xml = await zip.file(slideName)?.async('string');
      if (!xml) continue;
      const texts = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
      const joined = texts
        .map((t) => unescapeXmlEntities(t.replace(/<[^>]+>/g, '')).trim())
        .filter(Boolean)
        .join(' ');
      if (joined) slidesText.push(joined);
    }
    return slidesText.join('\n\n');
  }

  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell((cell) => {
          const val = cell.text?.trim();
          if (val) cells.push(val);
        });
        if (cells.length > 0) lines.push(cells.join(' — '));
      });
    });
    return lines.join('\n');
  }

  if (ext === '.pdf') {
    const pages = await extractPagesFromPdfWithMuPdf(buffer);
    const pageTexts = pages
      .map((page) =>
        page.blocks
          .map((block) => {
            if (block.type === 'heading' || block.type === 'paragraph') {
              return block.text?.trim() || '';
            }
            if (block.type === 'table' && block.rows) {
              return block.rows
                .map((row) => row.map((cell) => cell.trim()).filter(Boolean).join(' — '))
                .filter(Boolean)
                .join('\n');
            }
            return '';
          })
          .filter(Boolean)
          .join('\n\n')
      )
      .filter(Boolean);
    return pageTexts.join('\n\n');
  }

  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    return extractReadableTextFromLegacyBinary(buffer);
  }

  // Сквозная связка [02] OCR -> [04] Деловой стиль: поддержка сканов и фото документов
  if (['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'].includes(ext)) {
    const ocrResult = await processPdfOrImageToOffice(buffer, fileName, 'docx');
    return ocrResult.segments
      .map((seg) => (seg.correctedText || seg.originalText || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  // Сквозная связка [03] Аудио/Видео совещания -> [04] Деловой стиль
  if (detectMeetingMediaKind(fileName)) {
    const tmpMedia = path.join(
      os.tmpdir(),
      `harness_bs_media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
    );
    try {
      fs.writeFileSync(tmpMedia, buffer);
      const meeting = await transcribeMeetingMediaFile(tmpMedia, fileName);
      return meeting.transcriptText;
    } finally {
      try {
        if (fs.existsSync(tmpMedia)) fs.unlinkSync(tmpMedia);
      } catch {
        // ignore cleanup error
      }
    }
  }

  throw new Error(
    `Формат «${ext || 'неизвестный'}» не поддерживается. Загрузите документ (.docx, .doc, .odt, .rtf, .txt, .pdf, .xlsx), скан (.png, .jpg) или запись совещания (.mp3, .wav, .m4a, .mp4).`
  );
}

/**
 * Извлекает текст из загруженного документа и сразу преобразует его в вежливый деловой стиль.
 */
export async function processBusinessStyleDocument(
  buffer: Buffer,
  fileName: string
): Promise<BusinessStyleTransformationResult> {
  const extractedText = await extractTextFromDocumentBuffer(buffer, fileName);
  if (!extractedText || extractedText.trim().length === 0) {
    throw new Error(
      `Не удалось извлечь текст из файла «${fileName}». Если это отсканированный PDF, сначала распознайте его через раздел [ 02 ] «Распознать текст».`
    );
  }
  return transformToBusinessStyle(extractedText, fileName);
}
