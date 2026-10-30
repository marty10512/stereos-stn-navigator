// Запуск: node --test
// Проверки: корректность значений на учебных документах, обработка отсутствующих
// значений, учёт статуса документа, независимость от имён файлов и синтетические варианты.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const STN = require('../core.js');

const DIR = path.join(__dirname, '..', 'fixtures', 'documents');
const CHECK = '2026-03-10';

function loadFixtures(rename) {
  return fs.readdirSync(DIR).filter(n => n.endsWith('.txt')).sort().map((n, i) => ({
    name: rename ? `file${i}.txt` : n,
    text: fs.readFileSync(path.join(DIR, n), 'utf8'),
  }));
}
const byNo = (r, no) => r.contracts.find(c => c.contractNo === no);

// ---------------------------------------------------------------------------
// Учебные документы
// ---------------------------------------------------------------------------

test('учебные документы: типы, статусы и привязка к договорам', () => {
  const r = STN.analyze(loadFixtures(), { checkDate: CHECK });
  assert.equal(r.documents.length, 6);
  assert.deepEqual(r.contracts.map(c => c.contractNo), ['STN-101', 'STN-102', 'STN-103']);
  assert.deepEqual(r.unlinked, []);
  const kinds = r.documents.map(d => [d.kind, d.status, d.contractNo]);
  assert.deepEqual(kinds, [
    ['contract', 'signed', 'STN-101'],
    ['amendment', 'signed', 'STN-101'],
    ['contract', 'signed', 'STN-102'],
    ['contract', 'signed', 'STN-103'],
    ['letter', 'proposal', 'STN-102'],
    ['amendment_draft', 'draft', 'STN-101'],
  ]);
  assert.equal(r.documents[1].effectiveDate, '2026-03-01');
  assert.equal(r.documents[5].docDate, '2026-03-06');
});

test('STN-101: подписанное ДС меняет сумму и срок, проект — только предложение', () => {
  const r = STN.analyze(loadFixtures(), { checkDate: CHECK });
  const c = byNo(r, 'STN-101');
  assert.equal(c.supplier.value, 'ООО «Вектор Прибор»');

  assert.equal(c.sum.state, 'ok');
  assert.equal(c.sum.value, 1380000);
  assert.equal(c.sum.display, '1 380 000 ₽');
  assert.equal(c.sum.original.value, 1200000);
  assert.equal(c.sum.changedBy.fileName, '02_amendment_signed.txt');
  assert.equal(c.sum.evidence.fileName, '02_amendment_signed.txt');
  assert.match(c.sum.evidence.quote, /1 380 000/);
  // цитата — точная подстрока абзаца исходника
  const doc = r.documents.find(d => d.id === c.sum.evidence.docId);
  assert.ok(doc.paragraphs[c.sum.evidence.paragraphIndex].text.includes(c.sum.evidence.quote));

  assert.equal(c.deadline.value, '2026-04-30');
  assert.equal(c.deadline.original.value, '2026-04-15');
  assert.deepEqual(c.deadline.proposals.map(p => [p.kind, p.value]), [['amendment_draft', '2026-05-10']]);
  assert.deepEqual(c.sum.proposals.map(p => [p.kind, p.value]), [['amendment_draft', 1450000]]);
});

test('STN-102: аванс и срок оплаты не путаются с суммой и сроком поставки; письмо — предложение', () => {
  const r = STN.analyze(loadFixtures(), { checkDate: CHECK });
  const c = byNo(r, 'STN-102');
  assert.equal(c.sum.value, 840000);
  assert.equal(c.sum.changedBy, null);
  assert.equal(c.deadline.value, '2026-03-20');
  assert.deepEqual(c.deadline.proposals.map(p => [p.kind, p.value, p.fileName]), [['letter', '2026-03-27', '05_supplier_email.txt']]);
  assert.equal(c.sum.proposals.length, 0);
});

test('STN-103: суммы нет — «нет данных» с основанием, лимит бюджета не подставляется', () => {
  const r = STN.analyze(loadFixtures(), { checkDate: CHECK });
  const c = byNo(r, 'STN-103');
  assert.equal(c.sum.state, 'no_data');
  assert.equal(c.sum.value, null);
  assert.equal(c.sum.display, 'нет данных');
  assert.match(c.sum.evidence.quote, /определяется спецификацией/);
  assert.equal(c.deadline.value, '2026-04-30');
});

test('четыре вопроса ТЗ', () => {
  const r = STN.analyze(loadFixtures(), { checkDate: CHECK });
  const q1 = STN.answer(r, { id: 'deadline', contractNo: 'STN-101' });
  assert.match(q1.text, /30\.04\.2026/);
  assert.match(q1.text, /в договоре было 15\.04\.2026/);
  assert.match(q1.text, /10\.05\.2026 \(проект допсоглашения/);

  assert.match(STN.answer(r, { id: 'sum', contractNo: 'STN-102' }).text, /840 000 ₽/);
  assert.match(STN.answer(r, { id: 'sum', contractNo: 'STN-103' }).text, /нет данных/);

  const q4 = STN.answer(r, { id: 'before', date: '2026-04-01' });
  assert.match(q4.text, /раньше 01\.04\.2026 .*: STN-102 \(20\.03\.2026\)/);
  assert.match(q4.text, /Несогласованные изменения срока: STN-102 — 27\.03\.2026 \(письмо поставщика/);
  assert.doesNotMatch(q4.text, /STN-101 \(20|STN-103 \(20/);
  assert.deepEqual(q4.items.map(i => [i.contractNo, i.unconfirmedDeadlineChange]), [['STN-102', true]]);
});

test('результат не зависит от имён файлов и порядка загрузки', () => {
  const a = STN.analyze(loadFixtures(false), { checkDate: CHECK });
  const b = STN.analyze(loadFixtures(true).reverse(), { checkDate: CHECK });
  const strip = r => r.contracts.map(c => [c.contractNo, c.sum.state, c.sum.value, c.deadline.state, c.deadline.value, c.deadline.proposals.map(p => p.value), c.sum.proposals.map(p => p.value)]);
  assert.deepEqual(strip(a), strip(b));
});

test('дата проверки раньше вступления ДС в силу — действует исходная редакция', () => {
  const r = STN.analyze(loadFixtures(), { checkDate: '2026-02-20' });
  const c = byNo(r, 'STN-101');
  assert.equal(c.sum.value, 1200000);
  assert.equal(c.deadline.value, '2026-04-15');
  assert.ok(c.sum.proposals.some(p => p.kind === 'amendment_not_effective' && p.value === 1380000));
});

// ---------------------------------------------------------------------------
// Синтетические варианты: «на встрече изменим одно поле и загрузим новый договор»
// ---------------------------------------------------------------------------

const contract = (no, supplier, sum, deadline, extra = '') => `ДОГОВОР ПОСТАВКИ № ${no}
Дата: 01.02.2026
Статус: подписан обеими сторонами 01.02.2026.

1.1. Покупатель: ООО «Тест». Поставщик: ${supplier}.
1.2. Предмет: поставка товара.

2.1. Общая стоимость поставки составляет ${sum} рублей, включая НДС.
2.2. Авансовый платеж составляет 10 000 рублей и входит в общую стоимость по пункту 2.1.

3.1. Поставщик обязуется поставить товар не позднее ${deadline}.
3.2. Оплата производится не позднее 31.12.2026. Этот срок является сроком оплаты, а не поставки.
${extra}
5.1. Изменения условий действуют после подписания дополнительного соглашения обеими сторонами.
`;

const amendment = (n, no, { status = 'подписано обеими сторонами 05.03.2026.', effective = '4. Настоящее соглашение вступает в силу 05.03.2026.', sum, deadline, head = 'ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ' } = {}) => `${head} № ${n} К ДОГОВОРУ ${no}
Дата: 05.03.2026
Статус: ${status}

${sum ? `1. Пункт 2.1 договора изложить в следующей редакции: «Общая стоимость поставки составляет ${sum} рублей, включая НДС».` : ''}
${deadline ? `2. Пункт 3.1 договора изложить в следующей редакции: «Поставщик обязуется поставить товар не позднее ${deadline}».` : ''}
3. Остальные условия договора остаются без изменений.
${effective}
`;

test('изменённое поле в договоре отражается в таблице', () => {
  const r = STN.analyze([{ name: 'x.txt', text: contract('STN-777', 'ООО «Ромашка»', '2 500 000', '25.03.2026') }], { checkDate: CHECK });
  const c = byNo(r, 'STN-777');
  assert.equal(c.supplier.value, 'ООО «Ромашка»');
  assert.equal(c.sum.value, 2500000);
  assert.equal(c.deadline.value, '2026-03-25');
  assert.match(STN.answer(r, { id: 'before', date: '2026-04-01' }).text, /STN-777 \(25\.03\.2026\)/);
});

test('подписанное ДС с датой вступления в силу позже даты проверки не применяется', () => {
  const files = [
    { name: 'c.txt', text: contract('A-1', 'ООО «А»', '100 000', '01.06.2026') },
    { name: 'a.txt', text: amendment(1, 'A-1', { sum: '150 000', effective: '4. Настоящее соглашение вступает в силу 01.04.2026.' }) },
  ];
  const c = byNo(STN.analyze(files, { checkDate: CHECK }), 'A-1');
  assert.equal(c.sum.value, 100000);
  assert.equal(c.sum.state, 'ok');
  assert.deepEqual(c.sum.proposals.map(p => [p.kind, p.value]), [['amendment_not_effective', 150000]]);
  // а к 01.05.2026 — применяется
  const later = byNo(STN.analyze(files, { checkDate: '2026-05-01' }), 'A-1');
  assert.equal(later.sum.value, 150000);
  assert.equal(later.sum.changedBy.fileName, 'a.txt');
});

test('ДС без подтверждённого подписания → «нужна проверка», значение не применяется', () => {
  const files = [
    { name: 'c.txt', text: contract('B-1', 'ООО «Б»', '100 000', '01.06.2026') },
    { name: 'a.txt', text: amendment(1, 'B-1', { deadline: '15.06.2026', status: 'подписано поставщиком, ожидает подписи покупателя.' }) },
  ];
  const c = byNo(STN.analyze(files, { checkDate: CHECK }), 'B-1');
  assert.equal(c.deadline.state, 'needs_review');
  assert.equal(c.deadline.value, '2026-06-01');
  assert.equal(c.deadline.proposals[0].kind, 'amendment_unsigned');
  assert.equal(c.sum.state, 'ok');
});

test('цепочка из двух подписанных ДС: действует более позднее по дате вступления в силу', () => {
  const files = [
    { name: 'c.txt', text: contract('C-1', 'ООО «В»', '100 000', '01.06.2026') },
    { name: 'a2.txt', text: amendment(2, 'C-1', { sum: '300 000', status: 'подписано обеими сторонами 08.03.2026.', effective: '4. Настоящее соглашение вступает в силу 08.03.2026.' }) },
    { name: 'a1.txt', text: amendment(1, 'C-1', { sum: '200 000', status: 'подписано обеими сторонами 01.03.2026.', effective: '4. Настоящее соглашение вступает в силу 01.03.2026.' }) },
  ];
  const c = byNo(STN.analyze(files, { checkDate: CHECK }), 'C-1');
  assert.equal(c.sum.value, 300000);
  assert.equal(c.sum.changedBy.fileName, 'a2.txt');
  assert.equal(c.sum.original.value, 100000);
});

test('договор без суммы и без срока → «нет данных», а не выдуманное значение', () => {
  const text = `ДОГОВОР ПОСТАВКИ № D-1
Дата: 01.02.2026
Статус: подписан обеими сторонами 01.02.2026.

1.1. Покупатель: ООО «Тест». Поставщик: ООО «Г».
2.1. Общая стоимость определяется спецификацией в приложении № 1.
2.2. Лимит закупки по внутреннему бюджету покупателя — 999 000 рублей. Этот лимит не является согласованной стоимостью договора.
3.1. Срок поставки не установлен и согласуется дополнительно.
`;
  const c = byNo(STN.analyze([{ name: 'd.txt', text }], { checkDate: CHECK }), 'D-1');
  assert.equal(c.sum.state, 'no_data');
  assert.equal(c.deadline.state, 'no_data');
  assert.equal(c.deadline.value, null);
});

test('письмо со словами «не подписано» не считается подписанным документом', () => {
  const text = `ПИСЬМО ПОСТАВЩИКА
Дата: 05.03.2026
Тема: договор E-1

Предлагаем перенести срок поставки с 20.03.2026 на 30.03.2026. Дополнительное соглашение подписано обеими сторонами не было.
`;
  const files = [{ name: 'c.txt', text: contract('E-1', 'ООО «Д»', '100 000', '20.03.2026') }, { name: 'l.txt', text }];
  const c = byNo(STN.analyze(files, { checkDate: CHECK }), 'E-1');
  assert.equal(c.deadline.value, '2026-03-20');
  assert.deepEqual(c.deadline.proposals.map(p => [p.kind, p.value]), [['letter', '2026-03-30']]);
});

test('ДС к незагруженному договору и нераспознанный документ не теряются', () => {
  const files = [
    { name: 'a.txt', text: amendment(1, 'Z-9', { sum: '500 000' }) },
    { name: 'junk.txt', text: 'Просто заметка без структуры.' },
  ];
  const r = STN.analyze(files, { checkDate: CHECK });
  const c = byNo(r, 'Z-9');
  assert.equal(c.contractDocId, null);
  assert.ok(c.flags.some(f => /не загружен/.test(f)));
  assert.equal(c.sum.state, 'ok');
  assert.equal(c.sum.value, 500000);
  assert.equal(r.unlinked.length, 1);
  assert.equal(r.unlinked[0].kind, 'unknown');
});

test('пустой ввод и некорректные даты', () => {
  const r = STN.analyze([], { checkDate: CHECK });
  assert.deepEqual(r.contracts, []);
  assert.equal(STN.toISO('31.02.2026'), null);
  assert.equal(STN.toISO('10.03.2026'), '2026-03-10');
  assert.equal(STN.formatMoney(1380000), '1 380 000 ₽');
  assert.equal(STN.formatDate('2026-04-30'), '30.04.2026');
});
