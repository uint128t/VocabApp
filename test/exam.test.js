import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createExam } from '../exam.js';
import { createStore, createStateFile } from '../store.js';

const FIXTURE =
  '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n- abyss\n  - [ ] #C2 - deep hole - The ship disappeared into the abyss.\n\n### B\n\n- ballpoint\n  - [x] #B1 - a pen - This ballpoint leaks.\n- bump\n  - [ ] #B2 - raised area - There is a bump on the road.\n';

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup({ verdicts = [], ai } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-exam-'));
  dirs.push(dir);
  const file = path.join(dir, 'Vocabulary.md');
  fs.writeFileSync(file, FIXTURE);
  const backupDir = path.join(dir, 'backups');
  const store = createStore({ file, backupDir });
  const stateFile = createStateFile({ file: path.join(dir, 'state', 'exam.json') });
  const calls = [];
  const pending = [...verdicts];
  const fakeAi = ai || {
    async judgeEntry(input, opts) {
      calls.push({ input, opts });
      const v = pending.shift();
      if (v instanceof Error) throw v;
      return v ?? { pass: true, reason: 'ok', suggestion: 'should be dropped' };
    },
  };
  const make = () => createExam({ store, ai: fakeAi, stateFile, random: () => 0.9 });
  return { dir, file, backupDir, store, stateFile, exam: make(), calls, fakeAi, make };
}

const pass = { pass: true, reason: '到位' };
const fail = { pass: false, reason: '义项跑偏' };
const item = (word, sense = 0) => ({ word, sense });
const answerFor = (exam, word, sense = 0) => exam.answer({ word, sense, userDefinition: 'x', userExample: 'y.' });

test('start freezes the queue and current() exposes the word and its sense', async () => {
  const { exam } = setup();
  const started = await exam.start({});
  assert.deepEqual(started.queue, [item('absorb'), item('abyss'), item('ballpoint'), item('bump')]);
  assert.deepEqual(exam.current(), {
    word: 'absorb',
    sense: 0,
    senseCount: 1,
    chapter: 'A',
    example: 'Plants absorb water.',
    attempt: 1,
    maxAttempts: 3,
    index: 0,
    total: 4,
    finished: false,
  });
});

test('every sense of a word is its own question', async () => {
  const multi = '### A\n\n- angle\n  - [ ] #A2 - the space between two lines - The angle was 45 degrees.\n  - [ ] #C1 - to fish - He angled his line carefully.\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-exam-'));
  dirs.push(dir);
  const file = path.join(dir, 'Vocabulary.md');
  fs.writeFileSync(file, multi);
  const store = createStore({ file, backupDir: path.join(dir, 'backups') });
  const calls = [];
  const exam = createExam({
    store,
    ai: { async judgeEntry(input, opts) { calls.push({ input, opts }); return pass; } },
    stateFile: createStateFile({ file: path.join(dir, 'state', 'exam.json') }),
    random: () => 0.9,
  });
  await exam.start({});
  assert.deepEqual(exam.status().queue, [item('angle', 0), item('angle', 1)]);
  assert.equal(exam.current().senseCount, 2);
  assert.equal(exam.current().example, 'The angle was 45 degrees.');

  await answerFor(exam, 'angle', 0);
  assert.equal(exam.current().sense, 1);
  assert.equal(exam.current().example, 'He angled his line carefully.');
  assert.equal(calls[1], undefined);
  await answerFor(exam, 'angle', 1);
  assert.equal(calls[1].input.targetExample, 'He angled his line carefully.');

  assert.deepEqual(exam.preview().add, [
    { word: 'angle', sense: 0, level: 'A2' },
    { word: 'angle', sense: 1, level: 'C1' },
  ]);
  const res = await exam.commit();
  assert.equal(res.changed, 2);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '### A',
    '',
    '- angle',
    '  - [x] #A2 - the space between two lines - The angle was 45 degrees.',
    '  - [x] #C1 - to fish - He angled his line carefully.',
    '',
  ]);
});

test('scope filters the queue', async () => {
  const { exam } = setup();
  await exam.start({ mastery: 'unchecked' });
  assert.deepEqual(exam.status().queue, [item('abyss'), item('bump')]);

  const other = setup();
  await other.exam.start({ chapter: 'A', difficulty: 'B1' });
  assert.deepEqual(other.exam.status().queue, [item('absorb')]);
});

test('an empty scope is rejected', async () => {
  const { exam } = setup();
  await assert.rejects(exam.start({ chapter: 'Z' }), (e) => e.code === 'emptyScope');
  await assert.rejects(exam.start({ difficulty: 'A1' }), (e) => e.code === 'emptyScope');
  await assert.rejects(exam.start({ mastery: 'checked', difficulty: 'C2' }), (e) => e.code === 'emptyScope');
});

test('a pass records one attempt, drops the suggestion and moves on', async () => {
  const { exam, calls } = setup({ verdicts: [pass] });
  await exam.start({});
  const res = await answerFor(exam, 'absorb');
  assert.deepEqual(res, {
    word: 'absorb',
    sense: 0,
    pass: true,
    reason: '到位',
    resolved: 'pass',
    attemptsLeft: 0,
    next: item('abyss'),
  });
  assert.equal(calls[0].opts.exam, true);
  assert.equal(calls[0].input.storedDefinition, undefined);
  assert.ok(!('suggestion' in res));
});

test('three failed attempts mark the word failed and stop asking', async () => {
  const { exam, calls } = setup({ verdicts: [fail, fail, fail, pass] });
  await exam.start({});
  const first = await answerFor(exam, 'absorb');
  assert.equal(first.attemptsLeft, 2);
  await answerFor(exam, 'absorb');
  const third = await answerFor(exam, 'absorb');
  assert.deepEqual(third, {
    word: 'absorb',
    sense: 0,
    pass: false,
    reason: '义项跑偏',
    resolved: 'fail',
    attemptsLeft: 0,
    next: item('abyss'),
  });
  assert.equal(calls.length, 3);
  assert.equal(exam.current().word, 'abyss');
  const rec = exam.status().records['absorb#0'];
  assert.equal(rec.result, 'fail');
  assert.equal(rec.attempts.length, 3);
});

test('an upstream failure does not consume an attempt', async () => {
  const err = Object.assign(new Error('上游返回 500'), { code: 'aiHttp' });
  const { exam, calls } = setup({ verdicts: [err, pass] });
  await exam.start({});
  await assert.rejects(answerFor(exam, 'absorb'), (e) => e.code === 'aiHttp');
  assert.equal(exam.current().attempt, 1);
  assert.equal(exam.status().records['absorb#0'], undefined);
  await answerFor(exam, 'absorb');
  assert.equal(calls.length, 2);
  assert.equal(exam.current().word, 'abyss');
});

test('answering a word that is not current is rejected', async () => {
  const { exam } = setup();
  await exam.start({});
  await assert.rejects(answerFor(exam, 'bump'), (e) => e.code === 'examOutOfOrder');
  await assert.rejects(answerFor(exam, 'absorb', 1), (e) => e.code === 'examOutOfOrder');
  await assert.rejects(exam.answer({ word: 'absorb', userDefinition: '', userExample: 'y.' }), (e) => e.code === 'badAnswer');
});

test('reveal is locked until the word is resolved', async () => {
  const { exam } = setup({ verdicts: [pass] });
  await exam.start({});
  await assert.rejects(exam.reveal('absorb'), (e) => e.code === 'examLocked');
  await answerFor(exam, 'absorb');
  assert.deepEqual(await exam.reveal('absorb'), {
    word: 'absorb',
    sense: 0,
    level: 'B1',
    result: 'pass',
    attempts: 1,
    definition: 'take in',
    chinese: null,
    example: 'Plants absorb water.',
  });
});

test('preview compares results against the current checkboxes', async () => {
  const { exam } = setup({ verdicts: [fail, fail, fail, pass, pass, pass] });
  await exam.start({});
  for (let i = 0; i < 6; i++) await answerFor(exam, exam.current().word);
  assert.equal(exam.current(), null);
  assert.deepEqual(exam.preview(), {
    add: [item('abyss'), item('bump')].map((x) => ({ ...x, level: x.word === 'abyss' ? 'C2' : 'B2' })),
    remove: [{ word: 'absorb', sense: 0, level: 'B1' }],
    unchanged: 1,
    skipped: [],
    total: 4,
  });
});

test('commit writes once and settles', async () => {
  const { exam, file, backupDir } = setup({ verdicts: [fail, fail, fail, pass, pass, pass] });
  await exam.start({});
  for (let i = 0; i < 6; i++) await answerFor(exam, exam.current().word);
  const res = await exam.commit();
  assert.match(res.backup, /^Vocabulary\./);
  assert.equal(res.changed, 3);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[2], '- absorb');
  assert.equal(lines[3], '  - [ ] #B1 - take in - Plants absorb water.');
  assert.equal(lines[5], '  - [x] #C2 - deep hole - The ship disappeared into the abyss.');
  assert.equal(lines[12], '  - [x] #B2 - raised area - There is a bump on the road.');
  assert.deepEqual(fs.readdirSync(backupDir).filter((n) => n.startsWith('Vocabulary.')), [res.backup]);
  assert.equal(exam.status().status, 'settled');
  assert.deepEqual(
    exam.status().settlement.words.map((w) => w.word).sort(),
    ['absorb', 'abyss', 'bump'],
  );
  assert.equal(exam.status().settlement.backup, res.backup);
  await assert.rejects(exam.commit(), (e) => e.code === 'examSettled');
});

test('a word deleted mid-round is skipped at settlement instead of breaking the write', async () => {
  const { exam, file } = setup({ verdicts: [fail, fail, fail, pass, pass, pass] });
  await exam.start({});
  for (let i = 0; i < 6; i++) await answerFor(exam, exam.current().word);

  fs.writeFileSync(
    file,
    '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n\n### B\n\n- ballpoint\n  - [x] #B1 - a pen - This ballpoint leaks.\n- bump\n  - [ ] #B2 - raised area - There is a bump on the road.\n',
  );
  const res = await exam.commit();
  assert.deepEqual(res.skipped, [{ word: 'abyss', sense: 0, reason: 'wordNotFound' }]);
  assert.equal(res.changed, 2);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[3], '  - [ ] #B1 - take in - Plants absorb water.');
  assert.equal(lines[10], '  - [x] #B2 - raised area - There is a bump on the road.');
  assert.equal(exam.status().status, 'settled');
  assert.deepEqual(exam.status().settlement.skipped, [{ word: 'abyss', sense: 0, reason: 'wordNotFound' }]);
});

test('commit with nothing to change does not write', async () => {
  const { exam, file, backupDir } = setup({
    verdicts: [pass, fail, fail, fail, pass, fail, fail, fail],
  });
  await exam.start({});
  for (let i = 0; i < 8; i++) await answerFor(exam, exam.current().word);
  const before = fs.readFileSync(file);
  const res = await exam.commit();
  assert.equal(res.backup, null);
  assert.equal(res.changed, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.ok(!fs.existsSync(backupDir));
  assert.equal(exam.status().status, 'settled');
  assert.deepEqual(exam.status().settlement, { words: [], backup: null, at: exam.status().settlement.at });
});

test('state survives a restart', async () => {
  const { exam, calls, fakeAi, stateFile, store, make } = setup({ verdicts: [pass] });
  await exam.start({});
  await answerFor(exam, 'absorb');
  const reopened = make();
  assert.equal(reopened.current().word, 'abyss');
  assert.equal(reopened.status().records['absorb#0'].result, 'pass');
  assert.equal(reopened.status().cursor, 1);
});

test('a v1 state file is ignored instead of being read as a current round', async () => {
  const { stateFile, make } = setup();
  stateFile.write({
    version: 1,
    status: 'running',
    lang: 'zh',
    maxAttempts: 3,
    scope: {},
    model: null,
    queue: ['absorb', 'abyss'],
    cursor: 1,
    records: { absorb: { attempts: [{ pass: true }], result: 'pass' } },
  });
  const reopened = make();
  assert.equal(reopened.status(), null);
  await assert.rejects(reopened.commit(), (e) => e.code === 'examNotRunning');
  await reopened.start({});
  assert.equal(reopened.current().word, 'absorb');
});

test('starting over requires force once answers exist', async () => {
  const { exam } = setup({ verdicts: [pass, pass] });
  await exam.start({});
  await answerFor(exam, 'absorb');
  await assert.rejects(exam.start({}), (e) => e.code === 'examRunning');
  await exam.start({ force: true });
  assert.equal(exam.current().word, 'absorb');
  assert.deepEqual(exam.status().records, {});
});

test('abort keeps the record but changes nothing', async () => {
  const { exam, file } = setup({ verdicts: [pass] });
  await exam.start({});
  await answerFor(exam, 'absorb');
  const before = fs.readFileSync(file);
  await exam.abort();
  assert.equal(exam.status().status, 'aborted');
  assert.equal(exam.current(), null);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('skip marks the word unknown without spending a call', async () => {
  const { exam, calls } = setup({ verdicts: [pass] });
  await exam.start({});
  const res = await exam.skip('absorb');
  assert.deepEqual(res, {
    word: 'absorb',
    sense: 0,
    resolved: 'fail',
    via: 'skip',
    reason: '你标记为不会',
    next: item('abyss'),
  });
  assert.equal(calls.length, 0);
  const rec = exam.status().records['absorb#0'];
  assert.equal(rec.result, 'fail');
  assert.equal(rec.via, 'skip');
  assert.deepEqual(rec.attempts, []);
});

test('skip is rejected out of order and for a word already resolved', async () => {
  const { exam } = setup({ verdicts: [pass] });
  await exam.start({});
  await assert.rejects(exam.skip('bump'), (e) => e.code === 'examOutOfOrder');
  const first = await exam.skip('absorb');
  assert.deepEqual(first.next, item('abyss'));
  await assert.rejects(exam.skip('absorb'), (e) => e.code === 'examOutOfOrder');
});

test('the example is optional during an exam round', async () => {
  const { exam, calls } = setup({ verdicts: [pass] });
  await exam.start({});
  const res = await exam.answer({ word: 'absorb', userDefinition: 'take in', userExample: '   ' });
  assert.equal(res.resolved, 'pass');
  assert.equal(calls[0].input.userExample, '');
  await assert.rejects(
    exam.answer({ word: 'abyss', userDefinition: '  ', userExample: 'x.' }),
    (e) => e.code === 'badAnswer',
  );
});

test('a skipped checked word lands in the remove list', async () => {
  const { exam, calls } = setup({ verdicts: [pass, pass, pass] });
  await exam.start({});
  await exam.skip('absorb');
  assert.deepEqual(exam.preview().remove, [{ word: 'absorb', sense: 0, level: 'B1' }]);
  assert.equal(exam.current().word, 'abyss');
  for (let i = 0; i < 3; i++) await answerFor(exam, exam.current().word);
  assert.equal(calls.length, 3);
});

test('pause keeps everything and resume continues exactly where it stopped', async () => {
  const { exam, file } = setup({ verdicts: [pass, pass] });
  await exam.start({});
  await answerFor(exam, 'absorb');
  const before = fs.readFileSync(file);
  await exam.pause();
  assert.equal(exam.status().status, 'paused');
  assert.equal(exam.current(), null);
  assert.equal(exam.status().cursor, 1);
  assert.deepEqual(exam.status().records['absorb#0'].result, 'pass');
  assert.deepEqual(fs.readFileSync(file), before);

  await assert.rejects(answerFor(exam, 'abyss'), (e) => e.code === 'examPaused');
  await assert.rejects(exam.commit(), (e) => e.code === 'examPaused');

  await exam.resume();
  assert.equal(exam.status().status, 'running');
  assert.equal(exam.current().word, 'abyss');
  assert.equal(exam.status().cursor, 1);
  await answerFor(exam, 'abyss');
  assert.equal(exam.current().word, 'ballpoint');
});

test('a paused round with progress needs force to restart', async () => {
  const { exam } = setup({ verdicts: [pass] });
  await exam.start({});
  await answerFor(exam, 'absorb');
  await exam.pause();
  await assert.rejects(exam.start({}), (e) => e.code === 'examRunning');
  await exam.start({ force: true });
  assert.equal(exam.status().status, 'running');
  assert.deepEqual(exam.status().records, {});

  const other = setup({ verdicts: [pass] });
  await other.exam.start({});
  await other.exam.pause();
  await other.exam.abort();
  assert.equal(other.exam.status().status, 'aborted');
});
test('unfinished words never leak the stored definition', async () => {
  const { exam } = setup({ verdicts: [fail] });
  await exam.start({});
  const res = await answerFor(exam, 'absorb');
  const wire = JSON.stringify({ status: exam.status(), current: exam.current(), res });
  assert.ok(!wire.includes('take in'), wire);
  assert.equal(exam.current().example, 'Plants absorb water.');
});

test('the feedback language can be switched mid-round and is remembered', async () => {
  const { exam, calls } = setup({ verdicts: [pass, pass, pass] });
  await exam.start({});
  assert.equal(exam.status().lang, 'zh');
  await exam.answer({ word: 'absorb', userDefinition: 'take in', userExample: '', lang: 'en' });
  assert.equal(calls[0].opts.lang, 'en');
  assert.equal(exam.status().lang, 'en');
  await exam.answer({ word: 'abyss', userDefinition: 'deep hole', userExample: '' });
  assert.equal(calls[1].opts.lang, 'en');
  await exam.answer({ word: 'ballpoint', userDefinition: 'a pen', userExample: '', lang: 'bogus' });
  assert.equal(exam.status().lang, 'en');
  assert.equal(calls[2].opts.lang, 'en');
});

test('setLang switches the round language and persists it', async () => {
  const { exam, calls } = setup({ verdicts: [pass, pass] });
  await exam.start({});
  assert.deepEqual(exam.setLang('en'), { ok: true, lang: 'en' });
  assert.equal(exam.status().lang, 'en');
  await answerFor(exam, 'absorb');
  assert.equal(calls[0].opts.lang, 'en');
  assert.throws(() => exam.setLang('fr'), (e) => e.code === 'badLang');
  await exam.pause();
  assert.equal(exam.setLang('zh').lang, 'zh');

  const other = setup();
  assert.throws(() => other.exam.setLang('en'), (e) => e.code === 'examNotRunning');
});
