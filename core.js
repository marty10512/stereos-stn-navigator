/*
 * core.js — логика проверки условий договоров поставки.
 *
 * Чистые функции: без DOM, без файловой системы, без сети.
 *   браузер: <script src="core.js"></script> → window.STN
 *   Node:    const STN = require('./core.js')
 *
 * Подход — правила и регулярные выражения по абзацам и предложениям документа.
 * Никакие имена файлов, номера договоров, суммы и даты в код не вшиты:
 * всё извлекается из загруженного текста. Контракт данных — docs/schema.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Утилиты: даты, деньги, разбиение текста
  // ---------------------------------------------------------------------------

  const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})/;
  // «1 200 000 (один миллион двести тысяч) рублей», «252 000 рублей», «900000 руб.»
  const MONEY_RE_G = /(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,\d{2})?(?:\s*\([^)]*\))?\s*(?:руб|₽)/gi;

  /** 'DD.MM.YYYY' → 'YYYY-MM-DD' или null, если дата некорректна. */
  function toISO(ddmmyyyy) {
    const m = DATE_RE.exec(ddmmyyyy || '');
    if (!m) return null;
    const [, d, mo, y] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    if (isNaN(dt.getTime()) || dt.getUTCDate() !== +d || dt.getUTCMonth() !== +mo - 1) return null;
    return `${y}-${mo}-${d}`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  function parseMoney(s) {
    const digits = String(s || '').replace(/\D/g, '');
    return digits ? parseInt(digits, 10) : null;
  }

  function formatMoney(n) {
    if (n == null) return '';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  }

  /** Абзац = непустая строка исходника; позиции — для перехода к тексту. */
  function splitParagraphs(text) {
    const out = [];
    const re = /[^\n]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const trimmed = m[0].trim();
      if (trimmed === '') continue;
      const start = m.index + m[0].indexOf(trimmed);
      out.push({ index: out.length, text: trimmed, start, end: start + trimmed.length });
    }
    return out;
  }

  /** Предложения внутри абзаца. Точка внутри даты (05.02.2026) предложение не завершает. */
  function splitSentences(text) {
    return text.split(/(?<=[.!?»])\s+(?=[А-ЯЁA-Z«(\d])/).map(s => s.trim()).filter(Boolean);
  }

  /** Одно уникальное значение из списка кандидатов; несколько разных → null (поле уйдёт в «нужна проверка»). */
  function uniqueOrNull(values) {
    const u = [...new Set(values.filter(v => v != null))];
    return u.length === 1 ? u[0] : null;
  }

  function lastMatch(re, s) {
    let last = null, m;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = g.exec(s)) !== null) last = m;
    return last;
  }

  // ---------------------------------------------------------------------------
  // Реестр полей. Чтобы добавить поле (например, ставку неустойки), достаточно
  // описать его здесь. Обязательны: label, format, isClause (предложение с действующей
  // редакцией), parseClause (значение из него). Необязательны: isDistractor (похожее
  // упоминание, которое надо пропустить), isAbsent (явное «не указано»), isChange и
  // parseChange (предложение об изменении), isIncrement (приращение «на N» → проверка).
  // Таблица и список предложений в index.html подхватывают новое поле по ключу; вопрос о нём —
  // запись в QUESTIONS и ветка в answer(). Без isChange изменения поля в ДС не распознаются.
  // ---------------------------------------------------------------------------

  const FIELDS = {
    sum: {
      label: 'Сумма договора',
      format: formatMoney,
      // Упоминание суммы, которая не является суммой договора: аванс, лимит, неустойка.
      isDistractor: s => /(аванс|лимит|неустойк|штраф|не\s+является\s+(согласованной\s+)?стоимостью)/i.test(s.split(/составляет/i)[0]),
      // «Общая стоимость … не указана / определяется спецификацией (приложением)».
      isAbsent: s => /стоимост/i.test(s) && /(не\s+указан|не\s+установлен|не\s+определен|определяется\s+(спецификацией|приложением))/i.test(s),
      // Действующая редакция: «Общая стоимость поставки составляет 1 200 000 … рублей».
      isClause: s => /(общ(ая|ую|ей)\s+стоимост|цена\s+договора|стоимость\s+договора)/i.test(s) && /составляет/i.test(s),
      // Предложение или изменение: «изменить общую стоимость … на 1 450 000 рублей».
      // «увеличить стоимость на 150 000 рублей» — приращение, итог без исходного значения не посчитать → «нужна проверка».
      isIncrement: s => /стоимост/i.test(s) && /(увелич|уменьш)[а-яё]*\s/i.test(s) && /\sна\s+\d/.test(s),
      isChange: s => /стоимост/i.test(s) && /(изменить|установить|перенести|составит\b)/i.test(s) && /\sна\s+\d/.test(s),
      // Все суммы вида «составляет N … рублей» в предложении; две разные (старая и новая редакция) → null → «нужна проверка».
      parseClause: s => uniqueOrNull([...s.matchAll(/составляет\s+(?:[а-яё\s]+\()?(\d[\d\s]*)(?:,\d{2})?\)?\s*(?:\([^)]*\))?\s*(?:руб|₽)/gi)].map(m => parseMoney(m[1]))),
      parseChange: s => { const m = lastMatch(MONEY_RE_G, s); return m ? parseMoney(m[1]) : null; },
    },
    deadline: {
      label: 'Срок поставки',
      format: formatDate,
      // Сроки оплаты и приёмки — не срок поставки.
      isDistractor: s => /(оплат|приемк|приёмк|платеж|платёж)/i.test(s) && !/обязуется\s+поставить/i.test(s) && !/срок[а-яё]*\s+поставки\s*[—:–-]/i.test(s),
      isAbsent: s => /срок[а-яё]*\s+поставки/i.test(s) && /не\s+(указан|установлен|определ)/i.test(s),
      // «Поставщик обязуется поставить … не позднее 15.04.2026» / «Срок поставки — до 15.04.2026».
      isClause: s => /(обязуется\s+поставить|поставить\s+[^.]*?не\s+позднее|срок[а-яё]*\s+поставки\s*[—:–-]?\s*(не\s+позднее\s+|до\s+)?\d{2}\.\d{2}\.\d{4})/i.test(s),
      // «перенести срок поставки с 20.03.2026 на 27.03.2026», «изменить срок поставки на 10.05.2026».
      isChange: s => /(срок[а-яё]*\s+поставки|поставить)/i.test(s) && /\s(на|до)\s+\d{2}\.\d{2}\.\d{4}/.test(s),
      parseClause: s => {
        // Все даты при «не позднее», «до» и «Срок поставки:»; даты об оплате, авансе или приёмке отбрасываем.
        // Две разные даты поставки в одном предложении (старая и новая редакция, две партии) → null → «нужна проверка».
        const dates = [...s.matchAll(/(?:не\s+позднее|до|срок[а-яё]*\s+поставки\s*[—:–-])\s*(\d{2}\.\d{2}\.\d{4})/gi)]
          .filter(m => !/(оплат|платеж|платёж|аванс|приемк|приёмк)[^.]{0,40}$/i.test(s.slice(0, m.index)))
          .map(m => toISO(m[1]));
        return uniqueOrNull(dates);
      },
      parseChange: s => { const m = /(?:срок[а-яё]*\s+поставки|поставить)[^]*?\s(?:на|до)\s+(\d{2}\.\d{2}\.\d{4})/i.exec(s); return m ? toISO(m[1]) : null; },
    },
  };

  const FIELD_IDS = Object.keys(FIELDS);
  for (const f of Object.values(FIELDS)) {
    f.isDistractor = f.isDistractor || (() => false);
    f.isAbsent = f.isAbsent || (() => false);
    f.isChange = f.isChange || (() => false);
    f.isIncrement = f.isIncrement || (() => false);
    f.parseChange = f.parseChange || (() => null);
  }

  /**
   * Извлечь из абзацев документа все упоминания поля.
   * Возвращает массив находок: { kind, value, paragraphIndex, quote }, где kind:
   *   'value'    — действующая редакция со значением;
   *   'change'   — предложение или изменение («изменить … на N»);
   *   'absent'   — явное «не указано / определяется спецификацией» → «нет данных»;
   *   'unparsed' — пункт о поле найден, значение не извлечено (приращение, две даты, свободная формулировка) → «нужна проверка».
   * Для абзаца «изложить в следующей редакции: «…»» достаточно общего разбора по
   * предложениям: цитата новой редакции содержит ту же формулировку, что и договор.
   */
  function findField(fieldId, paragraphs) {
    const f = FIELDS[fieldId];
    const hits = [];
    for (const p of paragraphs) {
      for (const s of splitSentences(p.text)) {
        if (f.isAbsent(s)) { hits.push({ kind: f.parseClause(s) != null ? 'unparsed' : 'absent', value: null, paragraphIndex: p.index, quote: s }); continue; }
        if (f.isDistractor(s)) continue;
        if (f.isClause(s)) {
          const value = f.parseClause(s);
          if (value != null) { hits.push({ kind: 'value', value, paragraphIndex: p.index, quote: s }); continue; }
          hits.push({ kind: 'unparsed', value: null, paragraphIndex: p.index, quote: s }); continue;
        }
        if (f.isIncrement(s)) { hits.push({ kind: 'unparsed', value: null, paragraphIndex: p.index, quote: s }); continue; }
        if (f.isChange(s)) {
          const value = f.parseChange(s);
          hits.push({ kind: value != null ? 'change' : 'unparsed', value, paragraphIndex: p.index, quote: s });
        }
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------------------
  // Разбор документа: тип, статус, номер договора, даты, стороны
  // ---------------------------------------------------------------------------

  const KIND_LABELS = {
    contract: 'Договор',
    amendment: 'Допсоглашение',
    amendment_draft: 'Проект допсоглашения',
    letter: 'Письмо',
    unknown: 'Не распознан',
  };
  const STATUS_LABELS = {
    signed: 'Подписано обеими сторонами',
    draft: 'Проект, не подписано',
    proposal: 'Предложение, не согласовано',
    unknown: 'Статус не определён',
  };

  function detectKind(paragraphs) {
    const head = paragraphs.slice(0, 3).map(p => p.text).join('\n');
    if (/^ПРОЕКТ\s+ДОПОЛНИТЕЛЬНОГО\s+СОГЛАШЕНИЯ/im.test(head)) return 'amendment_draft';
    if (/^ДОПОЛНИТЕЛЬНОЕ\s+СОГЛАШЕНИЕ/im.test(head)) return 'amendment';
    if (/^ДОГОВОР/im.test(head)) return 'contract';
    if (/^ПИСЬМО/im.test(head) || /^(От|Кому|Тема):/im.test(head)) return 'letter';
    return 'unknown';
  }

  /** Номер документа из заголовка: «ДОГОВОР ПОСТАВКИ № STN-101» → 'STN-101'. */
  function ownNumber(paragraphs) {
    const head = paragraphs[0] ? paragraphs[0].text : '';
    const m = /№\s*([^\s,;]+)/.exec(head);
    return m ? m[1].replace(/[.,;:]+$/, '') : null;
  }

  /** Ссылка на договор из документа, который к нему относится (ДС, проект, письмо). */
  function referencedContract(paragraphs) {
    const head = paragraphs.slice(0, 6).map(p => p.text).join('\n');
    // Номер обязан содержать цифру: иначе «от … г.» или «поставки товаров» дают фантомный договор «Г» / «ТОВАРОВ».
    const pre = String.raw`(?:поставки\s+)?(?:(?!от\s)[а-яё]+\s+)?(?:от\s+\d{2}\.\d{2}\.\d{4}\s*(?:г\.?\s*)?)?(?:№\s*)?`;
    const m = new RegExp(String.raw`к\s+договору\s+` + pre + String.raw`([^\s,;]*\d[^\s,;]*)`, 'i').exec(head);
    if (m) return m[1].replace(/[.,;:]+$/, '');
    // Письмо с двумя разными договорами — не угадываем, документ уходит в «не привязан».
    const all = [...paragraphs.map(p => p.text).join('\n').matchAll(new RegExp(String.raw`договор[а-яё]*\s+` + pre + String.raw`([A-Za-zА-Яа-я]{0,8}-?\d[A-Za-zА-Яа-яЁё0-9\-\/]*)`, 'gi'))];
    return uniqueOrNull(all.map(x => x[1].replace(/[.,;:]+$/, '')));
  }

  function detectStatus(kind, paragraphs) {
    const statusLine = paragraphs.find(p => /^Статус(\s+[а-яё]+)?:/i.test(p.text));
    const signedRe = /(?<!не\s)подписан[оа]?\s+обеими\s+сторонами(?:\s+(\d{2}\.\d{2}\.\d{4}))?/i;
    if (statusLine) {
      const t = statusLine.text;
      if (/не\s+подписан|проект|на\s+согласовании|не\s+согласован/i.test(t)) return { status: 'draft', signedDate: null, paragraphIndex: statusLine.index };
      const m = signedRe.exec(t);
      if (m) return { status: 'signed', signedDate: m[1] ? toISO(m[1]) : null, paragraphIndex: statusLine.index };
      return { status: 'unknown', signedDate: null, paragraphIndex: statusLine.index };
    }
    if (kind === 'letter') return { status: 'proposal', signedDate: null, paragraphIndex: null };
    if (kind === 'amendment_draft') return { status: 'draft', signedDate: null, paragraphIndex: null };
    for (const p of paragraphs) {
      const m = signedRe.exec(p.text);
      if (m) return { status: 'signed', signedDate: m[1] ? toISO(m[1]) : null, paragraphIndex: p.index };
    }
    return { status: 'unknown', signedDate: null, paragraphIndex: null };
  }

  function detectDocDate(paragraphs) {
    const p = paragraphs.find(p => /^Дата(\s+[а-яё]+)?:/i.test(p.text));
    return p ? toISO(p.text) : null;
  }

  /** Дата вступления в силу: «вступает в силу 01.03.2026» или «с момента подписания». */
  function detectEffectiveDate(paragraphs, signedDate) {
    for (const p of paragraphs) {
      const m = /вступ[а-яё]+\s+в\s+силу\s+(?:с\s+)?(\d{2}\.\d{2}\.\d{4})/i.exec(p.text);
      if (m) return { date: toISO(m[1]), paragraphIndex: p.index };
      if (/вступ[а-яё]+\s+в\s+силу\s+(со?\s+)?(момента|даты|дня)\s+(его\s+)?подписания/i.test(p.text) && signedDate) {
        return { date: signedDate, paragraphIndex: p.index };
      }
    }
    return { date: null, paragraphIndex: null };
  }

  function detectParty(paragraphs, role) {
    const re = new RegExp(role + ':\\s*(.+?)(?:(?<![А-ЯЁA-Z])\\.)?(?=\\s+(?:Покупатель|Поставщик):|\\s*$)', 'i');
    for (const p of paragraphs) {
      const m = re.exec(p.text);
      if (m) return { value: m[1].trim(), paragraphIndex: p.index, quote: m[0].trim() };
    }
    return null;
  }

  function parseDocument(file, id) {
    const paragraphs = splitParagraphs(String(file.text || ''));
    const kind = detectKind(paragraphs);
    const st = detectStatus(kind, paragraphs);
    const eff = kind === 'amendment' || kind === 'amendment_draft' ? detectEffectiveDate(paragraphs, st.signedDate) : { date: null, paragraphIndex: null };
    const contractNo = kind === 'contract' ? ownNumber(paragraphs) : referencedContract(paragraphs);
    const warnings = [];
    if (kind === 'unknown') warnings.push('Тип документа не распознан: ожидается договор, допсоглашение, проект допсоглашения или письмо.');
    if (!contractNo) warnings.push(kind === 'contract' ? 'Номер договора не найден в заголовке.' : 'Не найдена ссылка на договор, к которому относится документ.');
    if (kind === 'contract' && st.status !== 'signed') warnings.push('Подписание договора обеими сторонами не подтверждено текстом.');
    if (kind === 'amendment' && st.status === 'unknown') warnings.push('Статус подписания допсоглашения не найден.');
    if (kind === 'amendment' && st.status === 'signed' && !eff.date) warnings.push('Дата вступления допсоглашения в силу не найдена.');

    return {
      id, name: file.name, kind, kindLabel: KIND_LABELS[kind],
      status: st.status, statusLabel: STATUS_LABELS[st.status],
      contractNo, docDate: detectDocDate(paragraphs), signedDate: st.signedDate,
      effectiveDate: eff.date, paragraphs, warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Сборка состояния договора на дату проверки
  // ---------------------------------------------------------------------------

  function evidence(doc, hit) {
    return { docId: doc.id, fileName: doc.name, paragraphIndex: hit.paragraphIndex, quote: hit.quote };
  }

  function emptyField() {
    return { state: 'no_data', value: null, display: 'нет данных', evidence: null, original: null, changedBy: null, note: null, proposals: [] };
  }

  function okField(value, display, ev) {
    return { state: 'ok', value, display, evidence: ev, original: null, changedBy: null, note: null, proposals: [] };
  }

  function reviewField(field, note) {
    field.state = 'needs_review';
    field.display = 'нужна проверка';
    field.note = field.note ? field.note + ' ' + note : note;
    return field;
  }

  /** Значение поля из текста договора (без учёта допсоглашений). */
  function baseField(fieldId, doc) {
    const f = FIELDS[fieldId];
    const field = emptyField();
    if (!doc) { field.note = 'Договор не загружен.'; return field; }
    const hits = findField(fieldId, doc.paragraphs);
    const values = hits.filter(h => h.kind === 'value');
    const absent = hits.filter(h => h.kind === 'absent');
    const distinct = [...new Set(values.map(h => h.value))];

    if (distinct.length === 1 && absent.length === 0) {
      return okField(distinct[0], f.format(distinct[0]), evidence(doc, values[0]));
    }
    if (distinct.length === 0 && absent.length > 0) {
      field.evidence = evidence(doc, absent[0]);
      field.note = 'В договоре значение не указано.';
      return field;
    }
    const unparsed = hits.filter(h => h.kind === 'unparsed');
    if (distinct.length === 0 && unparsed.length) { field.evidence = evidence(doc, unparsed[0]); return reviewField(field, 'Пункт найден, но значение не удалось извлечь (формулировка или относительный срок).'); }
    if (distinct.length === 0) {
      field.note = `В тексте договора не найдено: ${f.label.toLowerCase()}.`;
      return field;
    }
    // Несколько разных значений или значение рядом с оговоркой об отсутствии.
    field.evidence = evidence(doc, values[0]);
    return reviewField(field, `В договоре найдено несколько формулировок (${hits.length}); разрешить вручную.`);
  }

  /** Подписанное ДС применяется, только если вступило в силу к дате проверки. */
  function classifyAmendment(doc, checkDate) {
    if (doc.kind === 'amendment_draft' || doc.status === 'draft') return { apply: false, kind: 'amendment_draft', label: 'Проект допсоглашения', review: false };
    if (doc.status !== 'signed') return { apply: false, kind: 'amendment_unsigned', label: 'Допсоглашение, подписание не подтверждено', review: true };
    const signed = doc.signedDate || doc.docDate; // без даты в «Статус:» ДС не подписано раньше своей даты
    if (signed && signed > checkDate) return { apply: false, kind: 'amendment_not_effective', label: `Допсоглашение подписано ${formatDate(signed)} — позже даты проверки`, review: false };
    if (!doc.effectiveDate) return { apply: false, kind: 'amendment_unclear', label: 'Допсоглашение подписано, дата вступления в силу не найдена', review: true };
    if (doc.effectiveDate > checkDate) return { apply: false, kind: 'amendment_not_effective', label: `Допсоглашение подписано, вступает в силу ${formatDate(doc.effectiveDate)} — позже даты проверки`, review: false };
    return { apply: true, kind: 'amendment', label: 'Допсоглашение', review: false };
  }

  function buildContract(contractNo, docs, checkDate) {
    const contracts = docs.filter(d => d.kind === 'contract');
    const contractDoc = contracts[0] || null;
    const flags = [];
    if (contracts.length > 1) flags.push(`Загружено ${contracts.length} документа с номером договора ${contractNo}; использован ${contractDoc.name}.`);
    if (!contractDoc) flags.push('Сам договор не загружен — показаны только относящиеся к нему документы.');
    if (contractDoc && contractDoc.status !== 'signed') flags.push(`${contractDoc.name}: подписание договора обеими сторонами не подтверждено текстом — условия предварительные.`);

    const view = {
      contractNo, contractDocId: contractDoc ? contractDoc.id : null,
      supplier: emptyField(), buyer: emptyField(), sum: null, deadline: null,
      relatedDocIds: docs.map(d => d.id), flags,
    };
    for (const [key, role] of [['supplier', 'Поставщик'], ['buyer', 'Покупатель']]) {
      const p = contractDoc ? detectParty(contractDoc.paragraphs, role) : null;
      view[key] = p ? okField(p.value, p.value, evidence(contractDoc, p)) : emptyField();
      if (!p) view[key].note = contractDoc ? `В договоре не найдено: ${role.toLowerCase()}.` : 'Договор не загружен.';
    }
    for (const fieldId of FIELD_IDS) view[fieldId] = baseField(fieldId, contractDoc);
    if (contracts.length > 1) for (const fieldId of FIELD_IDS) reviewField(view[fieldId], 'Несколько документов с этим номером договора.');

    // Допсоглашения по возрастанию даты вступления в силу (если её нет — по дате документа); позднее перекрывает раннее.
    const amendments = docs.filter(d => d.kind === 'amendment' || d.kind === 'amendment_draft')
      .map(d => ({ doc: d, cls: classifyAmendment(d, checkDate) }))
      .sort((a, b) => String(a.doc.effectiveDate || a.doc.docDate || '').localeCompare(String(b.doc.effectiveDate || b.doc.docDate || '')));

    for (const { doc, cls } of amendments) {
      let touched = 0;
      const unparsedFields = [];
      for (const fieldId of FIELD_IDS) {
        const f = FIELDS[fieldId];
        const allHits = findField(fieldId, doc.paragraphs).filter(h => h.kind !== 'absent');
        const hits = allHits.filter(h => h.kind !== 'unparsed');
        if (hits.length === 0) {
          if (allHits.length) unparsedFields.push({ fieldId, hit: allHits[0] });
          continue;
        }
        touched++;
        const field = view[fieldId];
        const distinct = [...new Set(hits.map(h => h.value))];
        if (cls.apply) {
          if (distinct.length > 1) { reviewField(field, `В ${doc.name} несколько разных значений поля.`); continue; }
          const sameDate = amendments.find(a => a.doc !== doc && a.cls.apply && a.doc.effectiveDate === doc.effectiveDate
            && findField(fieldId, a.doc.paragraphs).some(h => h.kind !== 'absent' && h.value !== distinct[0]));
          if (!field.original && field.evidence) field.original = { value: field.value, display: field.display, evidence: field.evidence };
          field.state = 'ok'; field.value = distinct[0]; field.display = f.format(distinct[0]);
          field.evidence = evidence(doc, hits[0]);
          field.changedBy = { docId: doc.id, fileName: doc.name, effectiveDate: doc.effectiveDate };
          field.note = `Изменено допсоглашением ${doc.name}, в силе с ${formatDate(doc.effectiveDate)}.`;
          if (sameDate) reviewField(field, `Два подписанных допсоглашения с одной датой вступления в силу задают разные значения.`);
        } else {
          for (const h of hits) {
            field.proposals.push({ docId: doc.id, fileName: doc.name, kind: cls.kind, kindLabel: cls.label, value: h.value, display: f.format(h.value), evidence: evidence(doc, h), note: cls.review ? 'Статус документа не позволяет применить изменение автоматически.' : null });
          }
          if (cls.review) reviewField(field, `${cls.label} (${doc.name}).`);
        }
      }
      // Пункт про поле найден, но значение не извлечено (приращение, замена даты «в кавычках», свободная формулировка).
      for (const { fieldId, hit } of unparsedFields) {
        if (cls.apply) { view[fieldId].evidence = view[fieldId].evidence || evidence(doc, hit); reviewField(view[fieldId], `В ${doc.name} условие изменено, но новое значение не удалось извлечь: «${hit.quote}»`); }
        else flags.push(`${doc.name}: предлагаемое изменение не распознано — «${hit.quote}».`);
      }
      if (touched === 0 && unparsedFields.length === 0) {
        if (cls.apply) for (const fieldId of FIELD_IDS) reviewField(view[fieldId], `Подписанное допсоглашение ${doc.name} вступило в силу, но его изменения не распознаны.`);
        else flags.push(`${doc.name}: документ относится к договору, но изменяемые условия не распознаны — проверьте вручную.`);
      }
    }

    // Письма: всегда только сведения для проверки.
    for (const doc of docs.filter(d => d.kind === 'letter')) {
      let touched = 0;
      for (const fieldId of FIELD_IDS) {
        const f = FIELDS[fieldId];
        for (const h of findField(fieldId, doc.paragraphs).filter(h => h.kind === 'change')) {
          touched++;
          view[fieldId].proposals.push({ docId: doc.id, fileName: doc.name, kind: 'letter', kindLabel: 'Письмо поставщика', value: h.value, display: f.format(h.value), evidence: evidence(doc, h), note: 'Предложение не согласовано: допсоглашение не подписано.' });
        }
      }
      if (touched === 0) flags.push(`${doc.name}: письмо относится к договору, предлагаемые изменения не распознаны — проверьте вручную.`);
    }

    for (const doc of docs.filter(d => d.kind === 'unknown')) {
      flags.push(`${doc.name}: тип документа не распознан — проверьте вручную.`);
    }
    return view;
  }

  /**
   * Главная функция. files: [{ name, text }], options: { checkDate: 'YYYY-MM-DD' }.
   */
  function analyze(files, options) {
    const checkDate = (options && options.checkDate) || new Date().toISOString().slice(0, 10);
    const documents = (files || []).map((f, i) => parseDocument(f, 'd' + i));
    const byContract = new Map();
    const unlinked = [];
    for (const d of documents) {
      if (!d.contractNo) { unlinked.push(d); continue; }
      if (!byContract.has(d.contractNo)) byContract.set(d.contractNo, []);
      byContract.get(d.contractNo).push(d);
    }
    const contracts = [...byContract.keys()].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))
      .map(no => buildContract(no, byContract.get(no), checkDate));
    return { checkDate, documents, contracts, unlinked };
  }

  // ---------------------------------------------------------------------------
  // Ответы на вопросы пользователя
  // ---------------------------------------------------------------------------

  const QUESTIONS = [
    { id: 'deadline', label: 'Какой срок поставки действует по договору {contractNo} на {checkDate}?', params: ['contractNo'] },
    { id: 'sum', label: 'Какова сумма договора {contractNo}?', params: ['contractNo'] },
    { id: 'before', label: 'По каким договорам поставка запланирована раньше {date} и есть ли несогласованные изменения срока?', params: ['date'] },
  ];

  /** Подписанное ДС с будущей датой — не «несогласованное предложение», а ещё не действующее изменение. */
  const isPending = p => p.kind === 'amendment_not_effective';
  const unconfirmed = field => field.proposals.filter(p => !isPending(p));
  const listProposals = ps => ps.map(p => `${p.display} (${p.kindLabel.toLowerCase()}, ${p.fileName})`).join('; ');

  function describeProposals(field) {
    let s = '';
    const u = unconfirmed(field), pend = field.proposals.filter(isPending);
    if (u.length) s += ' Несогласованные предложения: ' + listProposals(u) + '.';
    if (pend.length) s += ' Подписано, но ещё не действует: ' + listProposals(pend) + '.';
    return s;
  }

  function describeField(label, field) {
    if (field.state === 'no_data') return `${label}: нет данных. ${field.note || ''}`.trim();
    if (field.state === 'needs_review') return `${label}: нужна проверка. ${field.note || ''}`.trim();
    let s = `${label}: ${field.display}`;
    if (field.changedBy) s += ` (изменено документом ${field.changedBy.fileName}, в силе с ${formatDate(field.changedBy.effectiveDate)}; в договоре было ${field.original ? field.original.display : '—'})`;
    return s + '.';
  }

  function answer(result, q) {
    const items = [];
    const withChange = c => ({ contractNo: c.contractNo, field: c.deadline, unconfirmedDeadlineChange: unconfirmed(c.deadline).length > 0 });

    if (q.id === 'deadline' || q.id === 'sum') {
      const c = result.contracts.find(x => x.contractNo === q.contractNo);
      if (!c) return { text: `Договор ${q.contractNo || ''} не загружен.`, items };
      const field = q.id === 'deadline' ? c.deadline : c.sum;
      const label = q.id === 'deadline' ? `Срок поставки по договору ${c.contractNo} на ${formatDate(result.checkDate)}` : `Сумма договора ${c.contractNo}`;
      items.push({ contractNo: c.contractNo, field, unconfirmedDeadlineChange: q.id === 'deadline' && unconfirmed(field).length > 0 });
      return { text: describeField(label, field) + describeProposals(field), items };
    }

    if (q.id === 'before') {
      const date = q.date;
      if (!date) return { text: 'Укажите дату.', items };
      const earlier = result.contracts.filter(c => c.deadline.state === 'ok' && c.deadline.value < date);
      const review = result.contracts.filter(c => c.deadline.state === 'needs_review');
      const noData = result.contracts.filter(c => c.deadline.state === 'no_data');
      const later = result.contracts.filter(c => c.deadline.state === 'ok' && c.deadline.value >= date);
      const parts = [];
      if (earlier.length) {
        parts.push(`Поставка раньше ${formatDate(date)} запланирована по договорам: ` + earlier.map(c => `${c.contractNo} (${c.deadline.display})`).join(', ') + '.');
        const changed = earlier.filter(c => unconfirmed(c.deadline).length);
        parts.push(changed.length
          ? 'Несогласованные изменения срока: ' + changed.map(c => `${c.contractNo} — ` + listProposals(unconfirmed(c.deadline))).join('; ') + '.'
          : 'Несогласованных изменений срока по этим договорам нет.');
      } else {
        parts.push(`Договоров с поставкой раньше ${formatDate(date)} не найдено.`);
      }
      if (later.length) parts.push('Позже этой даты: ' + later.map(c => `${c.contractNo} (${c.deadline.display}${unconfirmed(c.deadline).length ? ', есть несогласованное предложение ' + unconfirmed(c.deadline).map(p => p.display).join(', ') : ''})`).join(', ') + '.');
      const pending = earlier.concat(later).filter(c => c.deadline.proposals.some(isPending));
      if (pending.length) parts.push('Подписано, но ещё не действует: ' + pending.map(c => `${c.contractNo} — ` + listProposals(c.deadline.proposals.filter(isPending))).join('; ') + '.');
      if (result.unlinked.length) parts.push('Не привязаны к договорам и не учтены: ' + result.unlinked.map(d => d.name).join(', ') + '.');
      if (review.length) parts.push('Требуют проверки: ' + review.map(c => c.contractNo).join(', ') + '.');
      if (noData.length) parts.push('Срок не найден: ' + noData.map(c => c.contractNo).join(', ') + '.');
      earlier.forEach(c => items.push(withChange(c)));
      return { text: parts.join(' '), items };
    }
    return { text: 'Неизвестный вопрос.', items };
  }

  return { analyze, answer, QUESTIONS, FIELDS, formatDate, formatMoney, parseDocument, findField, toISO };
});
