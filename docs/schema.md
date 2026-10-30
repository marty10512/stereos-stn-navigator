# Контракт данных между `core.js` и `index.html`

`core.js` — чистая логика без DOM и без I/O. Подключается классическим `<script src="core.js">` (не module), в браузере кладёт API в `window.STN`; в Node экспортирует через `module.exports` (для `node --test`).

## API

```js
STN.analyze(files, { checkDate })  // -> Result
STN.answer(result, question)        // -> Answer
STN.QUESTIONS                       // -> массив описаний вопросов для UI
STN.formatDate(iso)                 // 'YYYY-MM-DD' -> 'DD.MM.YYYY'
STN.formatMoney(n)                  // 1380000 -> '1 380 000 ₽'
STN.FIELDS                          // реестр полей; ключи = поля ContractView помимо supplier/buyer (sum, deadline, …)
STN.parseDocument(file, id)         // -> ParsedDoc
STN.findField(fieldId, paragraphs)  // -> находки { kind: 'value'|'change'|'absent'|'unparsed', value, paragraphIndex, quote }
STN.toISO('DD.MM.YYYY')             // -> 'YYYY-MM-DD' | null
```

- `files`: `Array<{ name: string, text: string }>` — имя и содержимое загруженных TXT.
- `checkDate`: строка `'YYYY-MM-DD'`, дата проверки (по умолчанию в UI — `2026-03-10`).

## Типы

```ts
type Result = {
  checkDate: string;              // 'YYYY-MM-DD'
  documents: ParsedDoc[];         // все документы в порядке загрузки
  contracts: ContractView[];      // по одному на договор, отсортированы по номеру
  unlinked: ParsedDoc[];          // документы, не привязанные ни к одному договору (показывать как «нужна проверка»)
};

type ParsedDoc = {
  id: string;                     // 'd0', 'd1', ... по порядку загрузки
  name: string;                   // имя файла
  kind: 'contract' | 'amendment' | 'amendment_draft' | 'letter' | 'unknown';
  kindLabel: string;              // 'Договор' | 'Допсоглашение' | 'Проект допсоглашения' | 'Письмо' | 'Не распознан'
  status: 'signed' | 'draft' | 'proposal' | 'unknown';
  statusLabel: string;            // 'Подписано обеими сторонами' | 'Проект, не подписано' | 'Предложение, не согласовано' | 'Статус не определён'
  contractNo: string | null;      // номер договора, к которому относится документ ('STN-101')
  docDate: string | null;         // ISO
  effectiveDate: string | null;   // ISO, дата вступления в силу (для допсоглашений)
  paragraphs: Paragraph[];        // абзацы исходника с позициями — для просмотра и перехода
  warnings: string[];             // что не удалось разобрать (текст для пользователя)
};

type Paragraph = { index: number; text: string; start: number; end: number };

type Evidence = {
  docId: string;
  fileName: string;
  paragraphIndex: number;         // индекс абзаца в ParsedDoc.paragraphs
  quote: string;                  // точная цитата (подстрока абзаца)
};

type FieldValue = {
  state: 'ok' | 'no_data' | 'needs_review';
  value: number | string | null;  // sum: число в рублях; deadline: 'YYYY-MM-DD'; supplier/buyer: строка
  display: string;                // '1 380 000 ₽' | '30.04.2026' | 'нет данных' | 'нужна проверка'
  evidence: Evidence | null;      // основание действующего значения
  original: { value: any; display: string; evidence: Evidence } | null;  // исходное значение договора, если изменено
  changedBy: { docId: string; fileName: string; effectiveDate: string | null } | null;  // каким документом изменено
  note: string | null;            // пояснение к «нет данных» / «нужна проверка» / «изменено»
  proposals: Proposal[];          // несогласованные предложения по этому полю
};

type Proposal = {
  docId: string;
  fileName: string;
  kind: 'amendment_draft' | 'letter' | 'amendment_not_effective' | 'amendment_unsigned' | 'amendment_unclear';
  kindLabel: string;              // 'Проект допсоглашения' | 'Письмо поставщика' | 'Допсоглашение подписано, вступает в силу DD.MM.YYYY — позже даты проверки'
                                  // | 'Допсоглашение подписано DD.MM.YYYY — позже даты проверки' | 'Допсоглашение, подписание не подтверждено'
                                  // | 'Допсоглашение подписано, дата вступления в силу не найдена'
  value: any;
  display: string;
  evidence: Evidence;
  note: string | null;
};

type ContractView = {
  contractNo: string;
  contractDocId: string | null;   // null, если договора нет, а есть только документы к нему
  supplier: FieldValue;
  buyer: FieldValue;
  sum: FieldValue;
  deadline: FieldValue;
  relatedDocIds: string[];        // все документы, относящиеся к договору (включая сам договор)
  flags: string[];                // общие предупреждения по договору (текст для пользователя)
};
```

## Вопросы

```ts
STN.QUESTIONS: Array<{
  id: 'deadline' | 'sum' | 'before';
  label: string;                  // шаблон с {contractNo} / {date} / {checkDate}
  params: Array<'contractNo' | 'date'>;
}>

STN.answer(result, { id: 'deadline', contractNo })  // срок по договору на дату проверки
STN.answer(result, { id: 'sum', contractNo })       // сумма договора
STN.answer(result, { id: 'before', date })          // поставки раньше date + несогласованные изменения срока

type Answer = {
  text: string;                   // готовый ответ одной-двумя фразами
  items: Array<{
    contractNo: string;
    field: FieldValue;            // поле, на которое ссылается ответ (deadline или sum)
    unconfirmedDeadlineChange: boolean;  // есть ли несогласованные предложения по сроку
  }>;
};
```

Четыре вопроса ТЗ покрываются так: 1 — `deadline` STN-101; 2 — `sum` STN-102; 3 — `sum` STN-103; 4 — `before` с датой 2026-04-01.

## Правила, которые реализует core (для понимания UI)

- Условия договора меняет только документ `kind='amendment'` со `status='signed'` и `effectiveDate <= checkDate`.
- Подписанное ДС с датой подписания или вступления в силу позже даты проверки → `amendment_not_effective` (в ответах — «подписано, но ещё не действует», не «несогласованное»).
- Проект ДС и письмо → предложения, таблицу не меняют.
- Значения не найдены → `no_data`; противоречие или неясность → `needs_review` с `note`.
- Никакие имена файлов и конкретные значения в код не вшиты.
