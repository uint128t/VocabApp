import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  parse,
  sortKey,
  serializeHead,
  serializeSense,
  planInsertEntry,
  planSetChecked,
  planSetSensesChecked,
  planSetEntry,
  planSetSenses,
  planDeleteEntry,
  applyEdits,
} from '../vocab.js';
import { realVocabFile } from './real-vocab.js';

const REAL = readFileSync(realVocabFile(), 'utf8');
const fx = (lines) => lines.join('\n');
const ls = (text) => text.split('\n');
const byWord = (entries) => Object.fromEntries(entries.map((e) => [e.word, e]));
const entryAt = (text, word) => parse(text).entries.find((e) => e.word === word);

test('real Vocabulary.md round-trips losslessly', () => {
  const { entries, stats, errors } = parse(REAL);
  assert.deepEqual(errors, []);
  assert.equal(applyEdits(REAL, []), REAL);
  assert.ok(entries.length > 300);
  assert.equal(stats.total, entries.length);
  assert.equal(stats.checked + stats.unchecked, entries.length);
  assert.equal(stats.missingExample, 0);
  assert.equal(stats.missingDifficulty, 0);

  const lines = ls(REAL);
  for (const e of entries) {
    assert.equal(serializeHead(e), lines[e.lineStart], e.word);
    assert.equal(e.lineEnd, e.lineStart + e.childLines.length, e.word);
    assert.ok(e.word.length > 0);
    assert.ok(e.definition.length > 0);
    assert.ok(e.senses.length > 0, `${e.word} 应该至少有一条义项`);
    for (const s of e.senses) {
      assert.equal(serializeSense(s), lines[s.index], `${e.word} ${s.level}`);
      assert.match(lines[s.index], /^  - \[[ x]\] #[ABC][12] - /, `${e.word} ${s.level} 的义项行格式`);
      assert.equal(typeof s.checked, 'boolean');
    }
  }
});

test('the real file keeps every state on its sense lines', () => {
  const { entries, stats } = parse(REAL);
  assert.ok(
    entries.every((e) => serializeHead(e) === `- ${e.segments.join(' - ')}`),
    '主行不该带勾选框',
  );
  assert.equal(stats.checked, entries.filter((e) => e.senses.every((s) => s.checked)).length);
  assert.equal(stats.senses.checked + stats.senses.unchecked, stats.senses.total);
  assert.equal(stats.senses.total, entries.reduce((n, e) => n + e.senses.length, 0));
});

test('real Vocabulary.md is alphabetized within each chapter', () => {
  const { entries } = parse(REAL);
  const seen = new Map();
  for (const e of entries) {
    assert.match(e.chapter, /^[A-Z]$/);
    const prev = seen.get(e.chapter);
    if (prev !== undefined) {
      assert.ok(
        sortKey(prev.word) <= sortKey(e.word),
        `${prev.word} should not follow ${e.word} in ${e.chapter}`,
      );
    }
    seen.set(e.chapter, e);
  }
  assert.ok(seen.size >= 20);
});

test('sortKey strips everything but letters', () => {
  assert.equal(sortKey("s'mores"), 'smores');
  assert.equal(sortKey('a touch of'), 'atouchof');
  assert.equal(sortKey('dust-up'), 'dustup');
  assert.equal(sortKey('substitute (n.)'), 'substituten');
  assert.equal(sortKey('take ... for granted'), 'takeforgranted');
  assert.equal(sortKey('cliché'), 'cliche');
  assert.ok(sortKey('attentive') < sortKey('attic'));
  assert.ok(sortKey('attic') < sortKey('authentic'));
});

test('parses the entry format: bare head plus one boxed line per sense', () => {
  const t = fx([
    '### A',
    '',
    '- angle',
    '  - [ ] #A2 - the space between two intersecting lines - The angle was 45 degrees.',
    '  - [x] #C1 - to fish - He angled his line carefully.',
    '',
  ]);
  const { entries, errors, stats } = parse(t);
  assert.deepEqual(errors, []);
  const [e] = entries;
  assert.equal(e.word, 'angle');
  assert.equal(e.definition, 'the space between two intersecting lines');
  assert.equal(e.senses.length, 2);
  assert.deepEqual(
    e.senses.map((s) => [s.level, s.definition, s.checked]),
    [
      ['A2', 'the space between two intersecting lines', false],
      ['C1', 'to fish', true],
    ],
  );
  assert.equal(e.difficulty, 'A2');
  assert.equal(e.example, 'The angle was 45 degrees.');
  assert.equal(e.checked, false, '整词掌握 = 所有义项都勾');
  assert.equal(e.childLine, ls(t)[3]);
  assert.equal(serializeHead(e), '- angle');
  assert.equal(serializeSense(e.senses[1]), ls(t)[4]);
  assert.deepEqual(stats.senses, { total: 2, checked: 1, unchecked: 1 });
  assert.equal(stats.checked, 0);
});

test('a word is only mastered when every sense is checked', () => {
  const all = fx(['### A', '', '- angle', '  - [x] #A2 - the space between two lines - The angle was 45 degrees.', '  - [x] #C1 - to fish - He angled his line carefully.', '']);
  const stats = parse(all).stats;
  assert.equal(stats.checked, 1);
  assert.equal(stats.unchecked, 0);
  assert.deepEqual(stats.senses, { total: 2, checked: 2, unchecked: 0 });
  assert.equal(parse(all).entries[0].checked, true);
});

test('a sense line may carry a chinese gloss before the example', () => {
  const t = fx(['### A', '', '- angle', '  - [ ] #A2 - the space between two lines - 角度 - The angle was 45 degrees.', '']);
  const [e] = parse(t).entries;
  assert.deepEqual([e.senses[0].definition, e.senses[0].chinese, e.senses[0].example], [
    'the space between two lines',
    '角度',
    'The angle was 45 degrees.',
  ]);
  assert.equal(serializeSense(e.senses[0]), ls(t)[3]);
});

test('only the new format is accepted', () => {
  const cases = {
    '带框的主行': ['### A', '', '- [ ] absorb - take in', '  - [ ] #B1 - take in - Plants absorb water.', ''],
    '义项行没有框': ['### A', '', '- absorb', '  - #B1 - take in - Plants absorb water.', ''],
    '义项行的框写成 []': ['### A', '', '- absorb', '  - [] #B1 - take in - Plants absorb water.', ''],
    '旧式子行（·）': ['### A', '', '- absorb', '  - [ ] #B1 · Plants absorb water.', ''],
    '义项行缺释义': ['### A', '', '- absorb', '  - [ ] #B1 - Plants absorb water.', ''],
    '孤儿子行': ['### A', '', '', '  - [ ] #B1 - take in - Plants absorb water.', ''],
  };
  for (const [label, lines] of Object.entries(cases)) {
    const { errors } = parse(fx(lines));
    assert.ok(errors.length > 0, `${label} 应该报错`);
  }
});

test('a head with no sense line has no definition', () => {
  const parsed = parse(fx(['### A', '', '- lone', '']));
  assert.deepEqual(
    parsed.errors.map((e) => [e.type, e.line]),
    [['missingDefinition', 3]],
  );
  assert.equal(parsed.entries[0].definition, '');
  assert.equal(parsed.entries[0].checked, false);
});

test('parse reports duplicate words and duplicate chapters', () => {
  const dupWord = fx(['### A', '', '- absorb', '  - [ ] #B1 - take in - Plants absorb water.', '', '### B', '', '- absorb', '  - [ ] #B2 - soak up - The sponge absorbed it.', '']);
  assert.ok(parse(dupWord).errors.some((e) => e.type === 'duplicateWord'));
  assert.ok(planSetChecked(dupWord, 'absorb', true).error);
  assert.ok(planSetEntry(dupWord, 'absorb', { senses: [{ level: 'B1', definition: 'x', example: 'X.' }] }).error);
  assert.ok(planInsertEntry(dupWord, { word: 'absorb', senses: [{ level: 'A1', definition: 'x', example: 'X.' }] }).error);

  const dupChapter = fx(['### A', '', '- absorb', '  - [ ] #B1 - take in - Plants absorb water.', '', '### A', '', '- abyss', '  - [ ] #C2 - deep hole - The ship sank into the abyss.', '']);
  assert.ok(parse(dupChapter).errors.some((e) => e.type === 'duplicateChapter'));
});

test('extra head segments beyond word + definition are dropped, last segment wins', () => {
  const t = fx([
    '### A',
    '',
    '- boast - brag - talk too proudly about oneself',
    '  - [ ] #B1 - talk too proudly - He boasted about it.',
    '',
  ]);
  const parsed = parse(t);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries[0].word, 'boast');
  assert.equal(parsed.entries[0].definition, 'talk too proudly about oneself');
  assert.equal(serializeHead(parsed.entries[0]), '- boast - brag - talk too proudly about oneself');

  const plan = planSetEntry(t, 'boast', {
    senses: [{ level: 'B1', definition: 'talk proudly', example: 'He boasted about it.' }],
  });
  assert.equal(plan.error, undefined);
  assert.deepEqual(ls(applyEdits(t, plan.edits)).slice(2, 4), [
    '- boast',
    '  - [ ] #B1 - talk proudly - He boasted about it.',
  ]);
  assert.equal(planDeleteEntry(t, 'boast').error, undefined);
});

test('inserts mid-chapter', () => {
  const t = fx([
    '### A',
    '',
    '- attentive',
    '  - [ ] #B2 - paying attention - She is attentive in class.',
    '- authentic',
    '  - [x] #B1 - real - The painting is authentic.',
    '',
  ]);
  const edit = planInsertEntry(t, {
    word: 'attic',
    senses: [{ level: 'B1', definition: 'space or room just under the roof', example: 'They found the box in the attic.' }],
  });
  assert.equal(edit.type, 'insertBefore');
  assert.deepEqual(ls(applyEdits(t, [edit])), [
    '### A',
    '',
    '- attentive',
    '  - [ ] #B2 - paying attention - She is attentive in class.',
    '- attic',
    '  - [ ] #B1 - space or room just under the roof - They found the box in the attic.',
    '- authentic',
    '  - [x] #B1 - real - The painting is authentic.',
    '',
  ]);
});

test('creates a new chapter between neighbours', () => {
  const t = fx(['### J', '', '- journalist', '  - [x] #B1 - writes news - The journalist filed the story.', '', '### L', '', '- lawn', '  - [x] #A2 - area of grass - She mowed the lawn.', '']);
  const edit = planInsertEntry(t, {
    word: 'kettle',
    senses: [{ level: 'A2', definition: 'container for boiling water', example: 'She boiled the kettle twice.' }],
  });
  assert.deepEqual(ls(applyEdits(t, [edit])), [
    '### J',
    '',
    '- journalist',
    '  - [x] #B1 - writes news - The journalist filed the story.',
    '',
    '### K',
    '',
    '- kettle',
    '  - [ ] #A2 - container for boiling water - She boiled the kettle twice.',
    '',
    '### L',
    '',
    '- lawn',
    '  - [x] #A2 - area of grass - She mowed the lawn.',
    '',
  ]);
});

test('creates a chapter before the first one', () => {
  const t = fx(['### B', '', '- ballpoint', '  - [x] #B1 - a pen with a metal ball tip - This ballpoint leaks.', '']);
  const edit = planInsertEntry(t, {
    word: 'abyss',
    senses: [{ level: 'B2', definition: 'deep hole', example: 'He stared into the dark abyss.' }],
  });
  assert.deepEqual(ls(applyEdits(t, [edit])), [
    '### A',
    '',
    '- abyss',
    '  - [ ] #B2 - deep hole - He stared into the dark abyss.',
    '',
    '### B',
    '',
    '- ballpoint',
    '  - [x] #B1 - a pen with a metal ball tip - This ballpoint leaks.',
    '',
  ]);
});

test('appends at chapter end and at end of file', () => {
  const t = fx(['### B', '', '- ballpoint', '  - [x] #B1 - a pen - This pen leaks.', '', '### C', '', '- couch', '  - [x] #A2 - sofa - They sat on the couch.', '']);
  const byline = applyEdits(t, [
    planInsertEntry(t, { word: 'byline', senses: [{ level: 'C1', definition: 'line above an article', example: 'The article carried a famous byline.' }] }),
  ]);
  assert.deepEqual(ls(byline).slice(0, 6), [
    '### B',
    '',
    '- ballpoint',
    '  - [x] #B1 - a pen - This pen leaks.',
    '- byline',
    '  - [ ] #C1 - line above an article - The article carried a famous byline.',
  ]);

  const y = fx(['### Y', '', '- yield', '  - [ ] #B2 - give way - Drivers must yield.', '']);
  const out = applyEdits(y, [
    planInsertEntry(y, { word: 'yolk', senses: [{ level: 'B1', definition: 'yellow part of an egg', example: 'He separated the white from the yolk.' }] }),
  ]);
  assert.deepEqual(ls(out), [
    '### Y',
    '',
    '- yield',
    '  - [ ] #B2 - give way - Drivers must yield.',
    '- yolk',
    '  - [ ] #B1 - yellow part of an egg - He separated the white from the yolk.',
    '',
  ]);
  assert.ok(out.endsWith('\n'));
  assert.ok(!out.endsWith('\n\n'));
});

test('writes several senses and the optional chinese in one insert', () => {
  const t = fx(['### M', '', '- mood', '  - [x] #B1 - feeling - Her mood improved.', '']);
  const edit = planInsertEntry(t, {
    word: 'mow',
    checked: true,
    senses: [
      { level: 'A2', definition: 'cut grass', chinese: '割草', example: 'He mows the lawn every Saturday.', checked: true },
      { level: 'B1', definition: 'cut down a large area of grass', example: 'They mowed the whole field in a day.', checked: false },
    ],
  });
  assert.deepEqual(ls(applyEdits(t, [edit])).slice(4, 7), [
    '- mow',
    '  - [x] #A2 - cut grass - 割草 - He mows the lawn every Saturday.',
    '  - [ ] #B1 - cut down a large area of grass - They mowed the whole field in a day.',
  ]);
});

test('inserts accept a single sense given through the flat fields', () => {
  const t = fx(['### A', '', '- attentive', '  - [ ] #B2 - paying attention - She is attentive.', '']);
  const edit = planInsertEntry(t, {
    word: 'attic',
    definition: 'space under the roof',
    difficulty: 'B1',
    example: 'They found the box in the attic.',
    chinese: '阁楼',
  });
  assert.equal(edit.error, undefined);
  assert.deepEqual(ls(applyEdits(t, [edit])).slice(4, 6), [
    '- attic',
    '  - [ ] #B1 - space under the roof - 阁楼 - They found the box in the attic.',
  ]);
});

test('inserts reject duplicates and invalid fields', () => {
  const t = fx(['### A', '', '- absorb', '  - [x] #B1 - take in - Plants absorb water.', '']);
  assert.equal(planInsertEntry(t, { word: 'Absorb', senses: [{ level: 'B1', definition: 'take in', example: 'X.' }] }).error.code, 'wordExists');
  const cases = [
    [{ word: 'bench' }, 'badSenses'],
    [{ word: 'bench', senses: [{ level: 'B7', definition: 'long seat', example: 'Sit here.' }] }, 'badDifficulty'],
    [{ word: 'bench', senses: [{ level: 'B1', definition: '', example: 'Sit here.' }] }, 'badDefinition'],
    [{ word: 'bench', senses: [{ level: 'B1', definition: 'a - b', example: 'Sit here.' }] }, 'badDefinition'],
    [{ word: 'bench', senses: [{ level: 'B1', definition: 'long seat', example: ' ' }] }, 'badExample'],
    [{ word: 'bench', senses: [{ level: 'B1', definition: 'long seat', example: 'Sit here.', checked: 'yes' }] }, 'badChecked'],
    [{ word: 'bench', senses: [{ level: 'B1', definition: 'long seat', example: 'Sit here.', chinese: 'not chinese' }] }, 'badChinese'],
    [{ word: 'bench', definition: 'long seat', difficulty: 'B1', example: 'Sit here.', chinese: 'a seat' }, 'badChinese'],
    [{ word: 'a\nb', definition: 'x', difficulty: 'B1', example: 'X.' }, 'badWord'],
  ];
  for (const [entry, code] of cases) {
    assert.equal(planInsertEntry(t, entry).error.code, code, JSON.stringify(entry));
  }
});

test('sense checkbox writes flip exactly one box character', () => {
  const t = fx(['### A', '', '- absorb', '  - [x] #B1 - take in - Plants absorb water.', '']);
  const set = (text, on) => planSetSensesChecked(text, 'absorb', [{ index: 0, checked: on }]);
  const plan = set(t, false);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.noop, false);
  assert.equal(plan.edits[0].lineStart, 3);
  assert.equal(plan.edits[0].newText, '  - [ ] #B1 - take in - Plants absorb water.');
  assert.equal(plan.edits[0].newText.length, ls(t)[3].length);
  const out = applyEdits(t, plan.edits);
  assert.equal(out, fx(['### A', '', '- absorb', '  - [ ] #B1 - take in - Plants absorb water.', '']));
  assert.equal(applyEdits(out, set(out, true).edits), t);
  assert.equal(set(out, false).noop, true);
  assert.deepEqual(set(out, false).edits, []);
  assert.equal(parse(out).stats.checked, 0);
  assert.equal(parse(out).stats.unchecked, 1);
});

test('sense checkbox writes validate their input', () => {
  const t = fx(['### A', '', '- absorb', '  - [x] #B1 - take in - Plants absorb water.', '']);
  const set = (text, word, index, checked) => planSetSensesChecked(text, word, [{ index, checked }]);
  assert.equal(set(t, 'abyss', 0, true).error.code, 'wordNotFound');
  assert.equal(set(t, 'absorb', 1, true).error.code, 'badSense');
  assert.equal(set(t, 'absorb', -1, true).error.code, 'badSense');
  assert.equal(set(t, 'absorb', 0, 'yes').error.code, 'badChecked');
  const head = fx(['### A', '', '- lone', '']);
  assert.equal(set(head, 'lone', 0, true).error.code, 'parseErrors');
  const flat = fx(['### A', '', '- lone - on one\'s own', '']);
  assert.equal(set(flat, 'lone', 0, true).error.code, 'noSenses');
});

test('分隔符与方括号从写入路径上就被挡住', () => {
  const t = fx(['### A', '', '- absorb', '  - [x] #B1 - take in - Plants absorb water.', '']);
  const entry = (patch) => ({ word: 'bench', senses: [{ level: 'B1', definition: 'long seat', example: 'Sit here.' }], ...patch });
  // 例句里带「 - 」会被序列化拆错：写进去是 `… - long seat - The score was 3 - 2.`，
  // 再读回来例句只剩「2.」，释义变成「long seat - The score was 3」。
  assert.equal(planInsertEntry(t, entry({ senses: [{ level: 'B1', definition: 'long seat', example: 'The score was 3 - 2.' }] })).error.code, 'badExample');
  // 词头带方括号会写成「- [x] atom」，那是带框主行的形状，整张表从此读不出来。
  for (const word of ['[x] atom', 'a]b', '[atom']) {
    assert.equal(planInsertEntry(t, entry({ word })).error.code, 'badWord', word);
  }
  assert.equal(planInsertEntry(t, entry({})).error, undefined);
  const broken = fx(['### A', '', '- bench', '  - [ ] #B1 - long seat - The score was 3 - 2.', '']);
  assert.equal(parse(broken).entries[0].senses[0].example, '2.');
});

test('the word level toggle sets every sense at once', () => {
  const t = fx(['### A', '', '- angle', '  - [ ] #A2 - the space between two lines - The angle was 45 degrees.', '  - [x] #C1 - to fish - He angled his line carefully.', '']);
  const on = planSetChecked(t, 'angle', true);
  const after = applyEdits(t, on.edits);
  assert.deepEqual(ls(after), [
    '### A',
    '',
    '- angle',
    '  - [x] #A2 - the space between two lines - The angle was 45 degrees.',
    '  - [x] #C1 - to fish - He angled his line carefully.',
    '',
  ]);
  assert.equal(parse(after).entries[0].checked, true);
  assert.equal(planSetChecked(after, 'angle', true).noop, true);

  const off = applyEdits(after, planSetChecked(after, 'angle', false).edits);
  assert.equal(parse(off).stats.checked, 0);
  assert.deepEqual(parse(off).entries[0].senses.map((s) => s.checked), [false, false]);
});

test('settling several senses of one word takes one plan and skips noops', () => {
  const t = fx(['### A', '', '- angle', '  - [ ] #A2 - the space between two lines - The angle was 45 degrees.', '  - [ ] #C1 - to fish - He angled his line carefully.', '']);
  const both = planSetSensesChecked(t, 'angle', [
    { index: 0, checked: true },
    { index: 1, checked: true },
  ]);
  assert.equal(both.edits.length, 2);
  assert.deepEqual(parse(applyEdits(t, both.edits)).entries[0].senses.map((s) => s.checked), [true, true]);
  assert.equal(planSetSensesChecked(t, 'angle', []).noop, true);
  assert.equal(planSetSensesChecked(t, 'angle', [{ index: 9, checked: true }]).error.code, 'badSense');
  assert.equal(planSetSensesChecked(t, 'angle', [{ index: 0, checked: 'x' }]).error.code, 'badChecked');
});

const EDIT_FIXTURE = fx([
  '### A',
  '',
  '- absorb',
  '  - [ ] #B1 - take in - Plants absorb water through their roots.',
  '- band',
  '  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.',
  '- cliché',
  '  - [x] #C1 - overused phrase - His speech was full of clichés.',
  '',
]);

test('planSetEntry rewrites the sense block and only what changed', () => {
  const onlyExample = planSetEntry(EDIT_FIXTURE, 'absorb', {
    senses: [{ level: 'B1', definition: 'take in', example: 'The sponge absorbed the spill.' }],
  });
  assert.equal(onlyExample.edits.length, 1);
  assert.equal(onlyExample.noop, false);
  assert.deepEqual(ls(applyEdits(EDIT_FIXTURE, onlyExample.edits)).slice(3, 5), [
    '  - [ ] #B1 - take in - The sponge absorbed the spill.',
    '- band',
  ]);

  const nothing = planSetEntry(EDIT_FIXTURE, 'absorb', {
    senses: [{ level: 'B1', definition: 'take in', example: 'Plants absorb water through their roots.' }],
  });
  assert.deepEqual(nothing.edits, []);
  assert.equal(nothing.noop, true);
});

test('planSetEntry handles the chinese segment when asked', () => {
  const drop = planSetEntry(EDIT_FIXTURE, 'band', {
    senses: [{ level: 'B1', definition: 'range; strip', chinese: null, example: 'A band of rain moved in.' }],
  });
  assert.equal(ls(applyEdits(EDIT_FIXTURE, drop.edits))[5], '  - [ ] #B1 - range; strip - A band of rain moved in.');

  const add = planSetEntry(EDIT_FIXTURE, 'absorb', {
    senses: [{ level: 'B1', definition: 'take in', chinese: '吸收', example: 'Plants absorb water through their roots.' }],
  });
  assert.equal(ls(applyEdits(EDIT_FIXTURE, add.edits))[3], '  - [ ] #B1 - take in - 吸收 - Plants absorb water through their roots.');
});

test('planSetEntry keeps the senses it was not asked to change', () => {
  const three = fx(['### A', '', '- yield', '  - [ ] #B2 - give way - Drivers must yield.', '  - [ ] #C1 - produce a crop - The farm yields vegetables.', '  - [ ] #C1 - money produced - The investment yielded a lot.', '']);
  const plan = planSetEntry(three, 'yield', { definition: 'give way to another vehicle', difficulty: 'B2', example: 'Drivers must yield to pedestrians.' });
  const lines = ls(applyEdits(three, plan.edits));
  assert.deepEqual(lines.slice(2, 6), [
    '- yield',
    '  - [ ] #B2 - give way to another vehicle - Drivers must yield to pedestrians.',
    '  - [ ] #C1 - produce a crop - The farm yields vegetables.',
    '  - [ ] #C1 - money produced - The investment yielded a lot.',
  ]);
});

test('planSetEntry can add and drop senses and refuses bad targets', () => {
  const plan = planSetEntry(EDIT_FIXTURE, 'absorb', {
    senses: [
      { level: 'B1', definition: 'take in', chinese: '吸收', example: 'Plants absorb water.' },
      { level: 'C1', definition: 'hold attention', example: 'The lecture absorbed her completely.' },
    ],
  });
  assert.deepEqual(ls(applyEdits(EDIT_FIXTURE, plan.edits)).slice(2, 6), [
    '- absorb',
    '  - [ ] #B1 - take in - 吸收 - Plants absorb water.',
    '  - [ ] #C1 - hold attention - The lecture absorbed her completely.',
    '- band',
  ]);

  assert.equal(planSetEntry(EDIT_FIXTURE, 'nope', { definition: 'x', difficulty: 'B1', example: 'Y.' }).error.code, 'wordNotFound');
  for (const patch of [
    { definition: '', difficulty: 'B1', example: 'Y.' },
    { definition: 'd', difficulty: 'B7', example: 'Y.' },
    { definition: 'd', difficulty: 'B1', example: ' ' },
    { definition: 'd', difficulty: 'B1', example: 'Y.', checked: 'yes' },
    { definition: 'd', difficulty: 'B1', example: 'Y.', chinese: '  ' },
    { definition: 'd', difficulty: 'B1', example: 'Y.', chinese: 'not chinese' },
    { senses: [{ level: 'B1', definition: 'd', example: 'Y.' }], checked: 'yes' },
  ]) {
    assert.ok(planSetEntry(EDIT_FIXTURE, 'absorb', patch).error, JSON.stringify(patch));
  }
});

test('planSetEntry on the real file changes exactly one line', () => {
  const { entries } = parse(REAL);
  const target = entries.find((e) => e.senses.length === 1);
  assert.ok(target, '真表里应该还有单义项条目');
  const plan = planSetEntry(REAL, target.word, {
    senses: [{ level: target.senses[0].level, definition: target.senses[0].definition, chinese: target.senses[0].chinese, example: 'Absorb the details before deciding.' }],
  });
  assert.equal(plan.error, undefined);
  const out = applyEdits(REAL, plan.edits);
  const a = ls(REAL);
  const b = ls(out);
  assert.equal(b.length, a.length);
  const changed = a.reduce((acc, line, i) => (line === b[i] ? acc : [...acc, i]), []);
  assert.equal(changed.length, 1);
  assert.equal(changed[0], target.senses[0].index);
  assert.ok(b[changed[0]].endsWith('Absorb the details before deciding.'));
  assert.equal(parse(out).errors.length, 0);
});

test('planSetSenses rewrites the whole block and keeps each checkbox', () => {
  const t = fx(['### A', '', '- angle', '  - [x] #A2 - the space between two lines - The angle was 45 degrees.', '']);
  const added = planSetSenses(t, 'angle', [
    { level: 'A2', definition: 'the space between two lines', example: 'The angle was 45 degrees.' },
    { level: 'C1', definition: 'to fish', example: 'He angled his line carefully.' },
  ]);
  assert.equal(added.error, undefined);
  assert.deepEqual(ls(applyEdits(t, added.edits)), [
    '### A',
    '',
    '- angle',
    '  - [x] #A2 - the space between two lines - The angle was 45 degrees.',
    '  - [x] #C1 - to fish - He angled his line carefully.',
    '',
  ]);
  const fewer = planSetSenses(t, 'angle', [{ level: 'A1', definition: 'sharp corner', example: 'The angle was sharp.' }]);
  const out = applyEdits(t, fewer.edits);
  assert.equal(out.includes('C1'), false);
  assert.equal(out.includes('  - [x] #A1 - sharp corner - The angle was sharp.'), true);
  assert.ok(planSetSenses(t, 'angle', []).error);
  assert.ok(planSetSenses(t, 'angle', [{ level: 'B7', definition: 'x', example: 'X.' }]).error);
  assert.ok(planSetSenses(t, 'angle', [{ level: 'B1', definition: 'x', example: '  ' }]).error);
  assert.ok(planSetSenses(t, 'angle', [{ level: 'B1', example: 'X.' }]).error, '义项必须有释义');
});

test('planDeleteEntry removes the head and every sense line', () => {
  const plan = planDeleteEntry(EDIT_FIXTURE, 'absorb');
  assert.equal(plan.error, undefined);
  assert.equal(plan.removed, 2);
  const out = applyEdits(EDIT_FIXTURE, plan.edits);
  assert.equal(out, fx(['### A', '', '- band', '  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.', '- cliché', '  - [x] #C1 - overused phrase - His speech was full of clichés.', '']));
  assert.equal(parse(out).stats.total, 2);
  assert.equal(parse(out).errors.length, 0);

  const multi = fx(['### A', '', '- yield', '  - [ ] #B2 - give way - Drivers must yield.', '  - [ ] #C1 - produce a crop - The farm yields vegetables.', '']);
  assert.equal(planDeleteEntry(multi, 'yield').removed, 3);
  assert.equal(planDeleteEntry(multi, 'nope').error.code, 'wordNotFound');
});

test('planDeleteEntry keeps CRLF endings and refuses dirty files', () => {
  const crlf = EDIT_FIXTURE.replace(/\n/g, '\r\n');
  const out = applyEdits(crlf, planDeleteEntry(crlf, 'absorb').edits);
  assert.ok(out.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(out), '换行必须仍是 CRLF');
  assert.ok(!out.includes('absorb'));
  assert.equal(out.replaceAll('\r\n', '\n'), applyEdits(EDIT_FIXTURE, planDeleteEntry(EDIT_FIXTURE, 'absorb').edits));

  const dup = fx(['### A', '', '- absorb', '  - [ ] #B1 - take in - Plants absorb water.', '- absorb', '  - [ ] #B2 - soak up - It absorbed the spill.', '']);
  assert.equal(planDeleteEntry(dup, 'absorb').error.code, 'parseErrors');
});

test('planDeleteEntry on the real file drops the head and its senses', () => {
  const plan = planDeleteEntry(REAL, 'absorb');
  const out = applyEdits(REAL, plan.edits);
  assert.equal(ls(out).length, ls(REAL).length - plan.removed);
  assert.ok(!out.includes('- absorb'));
  const after = parse(out);
  assert.equal(after.errors.length, 0);
  assert.equal(after.stats.total, parse(REAL).stats.total - 1);
});

test('applyEdits rejects out-of-range and conflicting edits', () => {
  const t = fx(['### A', '', '- absorb', '  - [ ] #B1 - take in - Plants absorb water.', '']);
  assert.throws(() => applyEdits(t, [{ type: 'replace', lineStart: -1, lineEnd: 0, newText: 'x', word: 'a' }]));
  assert.throws(() => applyEdits(t, [{ type: 'replace', lineStart: 2, lineEnd: 9, newText: 'x', word: 'a' }]));
  assert.throws(() =>
    applyEdits(t, [
      { type: 'replace', lineStart: 0, lineEnd: 2, newText: 'x', word: 'a' },
      { type: 'replace', lineStart: 2, lineEnd: 3, newText: 'y', word: 'b' },
    ]),
  );
  assert.throws(() =>
    applyEdits(t, [
      { type: 'replace', lineStart: 0, lineEnd: 3, newText: 'x', word: 'a' },
      { type: 'insertBefore', lineStart: 2, lineEnd: 2, newText: 'y', word: 'b' },
    ]),
  );
});

test('applyEdits applies several edits without shifting', () => {
  const t = fx([
    '### A',
    '',
    '- absorb',
    '  - [ ] #B1 - take in - Plants absorb water.',
    '- abyss',
    '  - [ ] #C2 - deep hole - The ship sank.',
    '',
    '### B',
    '',
    '- ballpoint',
    '  - [x] #A2 - a pen - This pen leaks.',
    '',
  ]);
  const edits = [
    planSetEntry(t, 'absorb', { senses: [{ level: 'B1', definition: 'take in', example: 'Plants absorb water through their roots.' }] }),
    ...planSetChecked(t, 'abyss', true).edits,
    planSetEntry(t, 'ballpoint', { senses: [{ level: 'A2', definition: 'a pen', example: 'This pen leaks a lot.' }] }),
  ].flatMap((x) => x.edits ?? [x]);
  const out = applyEdits(t, edits);
  assert.deepEqual(ls(out), [
    '### A',
    '',
    '- absorb',
    '  - [ ] #B1 - take in - Plants absorb water through their roots.',
    '- abyss',
    '  - [x] #C2 - deep hole - The ship sank.',
    '',
    '### B',
    '',
    '- ballpoint',
    '  - [x] #A2 - a pen - This pen leaks a lot.',
    '',
  ]);
  assert.equal(parse(out).errors.length, 0);
});

test('applyEdits keeps CRLF endings', () => {
  const t = '### A\r\n\r\n- absorb\r\n  - [ ] #B1 - take in - Plants absorb water.\r\n';
  const out = applyEdits(t, [
    planSetEntry(t, 'absorb', { senses: [{ level: 'B1', definition: 'take in', example: 'Plants soak up water.' }] }).edits,
  ].flat());
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(parse(out).entries[0].senses[0].example, 'Plants soak up water.');
});

test('vocab.js exposes the word index and the raw lines for reads', () => {
  const t = fx(['### A', '', '- absorb', '  - [ ] #B1 - take in - Plants absorb water.', '']);
  const [e] = parse(t).entries;
  assert.equal(e.index, 0);
  assert.equal(e.raw, '- absorb');
  assert.equal(e.senses[0].raw, ls(t)[3]);
  assert.deepEqual(e.childLines, [ls(t)[3]]);
  assert.equal(byWord(parse(t).entries).absorb.word, 'absorb');
  assert.equal(entryAt(t, 'absorb').senses[0].index, 3);
});
