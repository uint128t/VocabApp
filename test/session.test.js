import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSession } from '../session.js';
import { createStore, createStateFile } from '../store.js';

const FIXTURE =
  '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n- abyss\n  - [ ] #C2 - deep hole - The ship disappeared into the abyss.\n\n### B\n\n- ballpoint\n  - [x] #B1 - a pen - This ballpoint leaks.\n- bump\n  - [ ] #B2 - raised area - There is a bump on the road.\n';

const MULTI =
  '### A\n\n- angle\n  - [ ] #A2 - the space between two lines - The angle was 45 degrees.\n  - [ ] #C1 - to fish - He angled his line carefully.\n';

/** n 个同状态的词，用来试抽词条数的上限。 */
const many = (n, checked) =>
  `### A\n\n${Array.from(
    { length: n },
    (_, i) => `- w${String(i).padStart(2, '0')}\n  - [${checked ? 'x' : ' '}] #B1 - meaning ${i} - Sentence number ${i}.\n`,
  ).join('\n')}`;

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function table(text, { verdicts = [], ai } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-session-'));
  dirs.push(dir);
  const file = path.join(dir, 'Vocabulary.md');
  fs.writeFileSync(file, text);
  const backupDir = path.join(dir, 'backups');
  const store = createStore({ file, backupDir });
  const stateFile = createStateFile({ file: path.join(dir, 'state', 'session.json') });
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
  const make = () => createSession({ store, ai: fakeAi, stateFile, random: () => 0.9 });
  return { dir, file, backupDir, store, stateFile, session: make(), calls, fakeAi, make };
}

const setup = (opts) => table(FIXTURE, opts);

const pass = { pass: true, reason: '到位' };
const fail = { pass: false, reason: '义项跑偏' };
const word = (w, senses = [0]) => ({ word: w, senses });
const sense = (over) => ({
  sense: 0,
  level: 'B1',
  example: 'Plants absorb water.',
  checked: true,
  result: null,
  via: null,
  reason: null,
  attempts: 0,
  attemptsLeft: 3,
  ...over,
});

/** 开一轮学习并把看词段走完，停在测试段。 */
async function learn(exam) {
  await exam.start({ mode: 'learn' });
  for (let i = 0; i < 50 && exam.status().phase === 'study'; i++) exam.nextStudy();
  return exam;
}

/** 交一整张卡：defs 给某条义项一个释义，没给到的填 'x'（要留空就显式给 ''）。 */
const submit = (exam, defs = {}) => {
  const cur = exam.current();
  const answers = cur.senses.map((s) => ({
    sense: s.sense,
    definition: defs[s.sense] !== undefined ? defs[s.sense] : 'x',
  }));
  return exam.answer({ word: cur.word, answers });
};

/** 一直交到这张卡判完，然后把光标推到下一个词。 */
async function finishCard(exam, defs = {}) {
  for (let i = 0; i < 6; i++) {
    const res = await submit(exam, defs);
    if (res.done) {
      exam.advance();
      return res;
    }
  }
  throw new Error('这张卡一直没判完');
}

test('学习抽还有义项没掌握的词，整词入队，开局停在看词段', async () => {
  const { session } = setup();
  const started = await session.start({ mode: 'learn' });
  assert.equal(started.mode, 'learn');
  assert.equal(started.phase, 'study');
  assert.deepEqual(started.queue, [word('abyss'), word('bump')]);
  assert.equal(session.current(), null);
  assert.deepEqual(session.study(), {
    index: 0,
    total: 2,
    word: 'abyss',
    chapter: 'A',
    senses: [
      {
        sense: 0,
        level: 'C2',
        definition: 'deep hole',
        chinese: null,
        example: 'The ship disappeared into the abyss.',
        checked: false,
      },
    ],
  });
});

test('复习抽整词已掌握的词，没有看词段，直接开考', async () => {
  const { session } = setup();
  const started = await session.start({ mode: 'review' });
  assert.equal(started.mode, 'review');
  assert.equal(started.phase, 'test');
  assert.deepEqual(started.queue, [word('absorb'), word('ballpoint')]);
  assert.equal(session.study(), null);
  assert.equal(session.current().word, 'absorb');
  assert.throws(() => session.nextStudy(), (e) => e.code === 'examOutOfOrder');
});

test('一轮的抽词条数有上限：学习 10 个、复习 30 个', async () => {
  const study = table(many(25, false));
  const s1 = await study.session.start({ mode: 'learn' });
  assert.equal(s1.queue.length, 10);

  const review = table(many(35, true));
  const s2 = await review.session.start({ mode: 'review' });
  assert.equal(s2.queue.length, 30);
});

test('池子不够就抽多少算多少，池子是空的直接报错', async () => {
  const { session } = setup();
  const started = await session.start({ mode: 'learn' });
  assert.equal(started.queue.length, 2);

  const allChecked = table(many(3, true));
  await assert.rejects(allChecked.session.start({ mode: 'learn' }), (e) => e.code === 'emptyScope');
  const allOpen = table(many(3, false));
  await assert.rejects(allOpen.session.start({ mode: 'review' }), (e) => {
    assert.equal(e.code, 'emptyScope');
    assert.match(e.message, /整词已掌握/);
    return true;
  });
});

test('mode 不是 learn/review 时直接拒绝', async () => {
  const { session } = setup();
  for (const mode of [undefined, null, '', 'quiz', 'exam', 1]) {
    await assert.rejects(session.start({ mode }), (e) => e.code === 'badMode', String(mode));
  }
});

test('看词段一个一个给，看完最后一个自动进测试段', async () => {
  const { session } = setup();
  await session.start({ mode: 'learn' });
  const first = session.nextStudy();
  assert.equal(first.phase, 'study');
  assert.equal(first.study.word, 'bump');
  assert.equal(first.study.index, 1);
  assert.equal(first.study.total, 2);
  assert.equal(first.current, null);

  const second = session.nextStudy();
  assert.equal(second.phase, 'test');
  assert.equal(second.study, null);
  assert.equal(second.current.word, 'abyss');
});

test('抽中的词整词全考，每条义项单独判', async () => {
  const { session, file } = table(MULTI, { verdicts: [pass, pass] });
  await learn(session);
  assert.deepEqual(session.status().queue, [word('angle', [0, 1])]);
  const cur = session.current();
  assert.equal(cur.senses.length, 2);
  assert.equal(cur.senses[1].example, 'He angled his line carefully.');
  assert.equal(cur.senses[1].level, 'C1');
  assert.ok(!('inScope' in cur.senses[0]));

  const res = await submit(session);
  assert.deepEqual(
    res.results.map((r) => [r.sense, r.pass, r.resolved]),
    [
      [0, true, 'pass'],
      [1, true, 'pass'],
    ],
  );
  assert.equal(res.done, true);
  assert.equal(session.current().done, true);
  assert.deepEqual(session.preview().add, [
    { word: 'angle', sense: 0, level: 'A2' },
    { word: 'angle', sense: 1, level: 'C1' },
  ]);
  const out = await session.commit();
  assert.equal(out.changed, 2);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '### A',
    '',
    '- angle',
    '  - [x] #A2 - the space between two lines - The angle was 45 degrees.',
    '  - [x] #C1 - to fish - He angled his line carefully.',
    '',
  ]);
});

test('一条义项留空就记不会，不花调用', async () => {
  const { session, calls } = setup({ verdicts: [pass] });
  await learn(session);
  const res = await submit(session, { 0: '' });
  assert.deepEqual(res.results, [
    { sense: 0, pass: false, reason: 'blank', resolved: 'fail', via: 'none', attemptsLeft: 0 },
  ]);
  assert.equal(res.done, true);
  assert.equal(res.open, 0);
  assert.equal(calls.length, 0);
  const rec = session.status().records['abyss#0'];
  assert.equal(rec.result, 'fail');
  assert.equal(rec.via, 'none');
  assert.deepEqual(rec.attempts, []);
});

test('一次通过记一次尝试，丢掉 suggestion，并给出下一个词', async () => {
  const { session, calls } = setup({ verdicts: [pass] });
  await learn(session);
  const res = await submit(session);
  assert.deepEqual(res, {
    word: 'abyss',
    results: [{ sense: 0, pass: true, reason: '到位', resolved: 'pass', via: null, attemptsLeft: 0 }],
    done: true,
    open: 0,
    nextWord: 'bump',
  });
  assert.equal(calls[0].opts.exam, true);
  assert.equal(calls[0].input.storedDefinition, undefined);
  assert.ok(!('suggestion' in res.results[0]));
  assert.equal(calls[0].input.targetExample, 'The ship disappeared into the abyss.');
});

test('答错但还有机会时那一行留着，用完三次才判死', async () => {
  const { session, calls } = setup({ verdicts: [fail, fail, fail, pass] });
  await learn(session);
  const first = await submit(session);
  assert.deepEqual(first.results[0], {
    sense: 0,
    pass: false,
    reason: '义项跑偏',
    resolved: null,
    via: null,
    attemptsLeft: 2,
  });
  assert.equal(first.done, false);
  assert.equal(session.current().senses[0].attemptsLeft, 2);

  await submit(session);
  const third = await submit(session);
  assert.deepEqual(third.results[0], {
    sense: 0,
    pass: false,
    reason: '义项跑偏',
    resolved: 'fail',
    via: null,
    attemptsLeft: 0,
  });
  assert.equal(third.done, true);
  assert.equal(calls.length, 3);
  const rec = session.status().records['abyss#0'];
  assert.equal(rec.result, 'fail');
  assert.equal(rec.attempts.length, 3);
});

test('上游报错不算作答，也不消耗机会', async () => {
  const err = Object.assign(new Error('上游返回 500'), { code: 'aiHttp' });
  const { session, calls } = setup({ verdicts: [err, pass] });
  await learn(session);
  await assert.rejects(submit(session), (e) => e.code === 'aiHttp');
  assert.equal(session.status().records['abyss#0'], undefined);
  assert.equal(session.current().senses[0].attemptsLeft, 3);
  await submit(session);
  assert.equal(calls.length, 2);
  assert.equal(session.current().senses[0].result, 'pass');
});

test('上游半路报错时已判出来的先落盘', async () => {
  const err = Object.assign(new Error('上游返回 500'), { code: 'aiHttp' });
  const { session } = table(MULTI, { verdicts: [pass, err] });
  await learn(session);
  await assert.rejects(submit(session), (e) => e.code === 'aiHttp');
  const cur = session.current();
  assert.equal(cur.senses[0].result, 'pass');
  assert.equal(cur.senses[1].result, null);
  assert.equal(cur.done, false);
});

test('看词段不能作答，教学段翻页在复习里被拒', async () => {
  const { session } = setup();
  await session.start({ mode: 'learn' });
  await assert.rejects(session.answer({ word: 'abyss', answers: [] }), (e) => e.code === 'examOutOfOrder');
  await assert.rejects(session.skip('abyss', 0), (e) => e.code === 'examOutOfOrder');
  assert.throws(() => session.advance(), (e) => e.code === 'examOutOfOrder');
});

test('答错词、越界义项或坏 body 都会被拒', async () => {
  const { session } = setup();
  await learn(session);
  await assert.rejects(session.answer({ word: 'bump', answers: [] }), (e) => e.code === 'examOutOfOrder');
  await assert.rejects(
    session.answer({ word: 'abyss', answers: [{ sense: 3, definition: 'x' }] }),
    (e) => e.code === 'badSense',
  );
  await assert.rejects(session.answer({ word: 'abyss', answers: 'x' }), (e) => e.code === 'badAnswers');
  await submit(session, { 0: '' });
  assert.deepEqual(await session.answer({ word: 'abyss', answers: [] }), {
    word: 'abyss',
    results: [],
    done: true,
    open: 0,
    nextWord: 'bump',
  });
});

test('reveal 给整词已判完的义项，一条都没判完时锁着', async () => {
  const { session } = table(MULTI, { verdicts: [pass, fail, fail, fail] });
  await learn(session);
  await assert.rejects(session.reveal('angle'), (e) => e.code === 'examLocked');

  await submit(session, { 1: '' });
  assert.deepEqual(await session.reveal('angle'), {
    word: 'angle',
    senses: [
      {
        sense: 0,
        level: 'A2',
        result: 'pass',
        via: null,
        reason: '到位',
        attempts: 1,
        definition: 'the space between two lines',
        chinese: null,
        example: 'The angle was 45 degrees.',
      },
      {
        sense: 1,
        level: 'C1',
        result: 'fail',
        via: 'none',
        reason: null,
        attempts: 0,
        definition: 'to fish',
        chinese: null,
        example: 'He angled his line carefully.',
      },
    ],
  });
  await assert.rejects(session.reveal('nope'), (e) => e.code === 'wordNotFound');
});

test('「下一个词」在义项还悬着时被拒', async () => {
  const { session } = setup({ verdicts: [fail, pass] });
  await learn(session);
  await submit(session);
  assert.throws(() => session.advance(), (e) => e.code === 'examOpen');
  assert.equal(session.current().word, 'abyss');

  await submit(session);
  const moved = session.advance();
  assert.deepEqual(moved, { ok: true, cursor: 1, finished: false, current: session.current() });
  assert.equal(session.current().word, 'bump');
});

test('学习模式的结算只勾选，判过但没通过的义项不动', async () => {
  const { session, file } = setup({ verdicts: [fail, fail, fail, fail, fail, fail] });
  await learn(session);
  await finishCard(session); // abyss：三次都错 → fail
  await finishCard(session); // bump：同上
  const plan = session.preview();
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.judged, 2);
  assert.equal(plan.total, 2);
  assert.equal(plan.unchanged, 2);

  const before = fs.readFileSync(file);
  const res = await session.commit();
  assert.equal(res.changed, 0);
  assert.equal(res.backup, null);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('复习模式的结算只取消，通过的不补勾', async () => {
  const { session, file } = setup({ verdicts: [pass, fail, fail, fail] });
  await session.start({ mode: 'review' });
  // absorb 通过，ballpoint 打三次错
  await submit(session);
  session.advance();
  await finishCard(session);
  const plan = session.preview();
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove, [{ word: 'ballpoint', sense: 0, level: 'B1' }]);
  assert.equal(plan.unchanged, 1);

  const res = await session.commit();
  assert.equal(res.changed, 1);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[3], '  - [x] #B1 - take in - Plants absorb water.');
  assert.equal(lines[10], '  - [ ] #B1 - a pen - This ballpoint leaks.');
  assert.match(res.backup, /^Vocabulary\./);
  assert.equal(session.status().status, 'settled');
});

test('commit 一次写盘并结算', async () => {
  const { session, file, backupDir } = setup({ verdicts: [pass, pass] });
  await learn(session);
  await finishCard(session);
  await finishCard(session);
  assert.equal(session.current(), null);
  const res = await session.commit();
  assert.match(res.backup, /^Vocabulary\./);
  assert.equal(res.changed, 2);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[5], '  - [x] #C2 - deep hole - The ship disappeared into the abyss.');
  assert.equal(lines[12], '  - [x] #B2 - raised area - There is a bump on the road.');
  assert.deepEqual(fs.readdirSync(backupDir).filter((n) => n.startsWith('Vocabulary.')), [res.backup]);
  assert.equal(session.status().status, 'settled');
  assert.deepEqual(
    session.status().settlement.words.map((w) => w.word).sort(),
    ['abyss', 'bump'],
  );
  assert.equal(session.status().settlement.backup, res.backup);
  await assert.rejects(session.commit(), (e) => e.code === 'examSettled');
});

test('中途被删的词结算时跳过，不卡写盘', async () => {
  const { session, file } = setup({ verdicts: [pass, pass] });
  await learn(session);
  await finishCard(session);
  await finishCard(session);

  fs.writeFileSync(
    file,
    '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n\n### B\n\n- ballpoint\n  - [x] #B1 - a pen - This ballpoint leaks.\n- bump\n  - [ ] #B2 - raised area - There is a bump on the road.\n',
  );
  const res = await session.commit();
  assert.deepEqual(res.skipped, [{ word: 'abyss', sense: 0, reason: 'wordNotFound' }]);
  assert.equal(res.changed, 1);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[10], '  - [x] #B2 - raised area - There is a bump on the road.');
  assert.equal(session.status().status, 'settled');
  assert.deepEqual(session.status().settlement.skipped, [{ word: 'abyss', sense: 0, reason: 'wordNotFound' }]);
});

test('中途被删的词在看词段与测试段都被跨过去', async () => {
  const { session, file } = setup();
  await session.start({ mode: 'learn' });
  assert.equal(session.study().word, 'abyss');
  fs.writeFileSync(file, '### B\n\n- ballpoint\n  - [x] #B1 - a pen - This ballpoint leaks.\n- bump\n  - [ ] #B2 - raised area - There is a bump on the road.\n');
  assert.equal(session.study().word, 'bump');
  assert.equal(session.study().index, 1);
  session.nextStudy();
  assert.equal(session.status().phase, 'test');
  assert.equal(session.current().word, 'bump');
});

test('没有要改的就不写盘', async () => {
  const { session, file, backupDir } = setup({
    verdicts: [pass, pass],
  });
  await session.start({ mode: 'review' });
  // absorb 通过（本来就勾着）、ballpoint 通过（本来也勾着）→ 无事可做
  await submit(session);
  session.advance();
  await submit(session);
  const before = fs.readFileSync(file);
  const res = await session.commit();
  assert.equal(res.backup, null);
  assert.equal(res.changed, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.ok(!fs.existsSync(backupDir));
  assert.equal(session.status().status, 'settled');
  assert.deepEqual(session.status().settlement, { words: [], backup: null, at: session.status().settlement.at });
});

test('状态跨重启还在，看词段也能接着看', async () => {
  const { session, make } = setup({ verdicts: [pass] });
  await session.start({ mode: 'learn' });
  session.nextStudy();
  const reopened = make();
  assert.equal(reopened.status().phase, 'study');
  assert.equal(reopened.study().word, 'bump');
  assert.equal(reopened.status().studyCursor, 1);

  reopened.nextStudy();
  await submit(reopened);
  const again = make();
  assert.equal(again.status().phase, 'test');
  assert.equal(again.current().word, 'abyss');
  assert.equal(again.status().records['abyss#0'].result, 'pass');
});

test('v3 的状态文件被当作没有轮次', async () => {
  const { stateFile, make } = setup();
  stateFile.write({
    version: 3,
    status: 'running',
    mode: 'learn',
    phase: 'test',
    queue: [{ word: 'absorb', senses: [0] }],
    cursor: 0,
    studyCursor: 0,
    records: {},
  });
  const reopened = make();
  assert.equal(reopened.status(), null);
  await assert.rejects(reopened.commit(), (e) => e.code === 'examNotRunning');
  await reopened.start({ mode: 'review' });
  assert.equal(reopened.current().word, 'absorb');
});

test('已经答过题了再开一轮需要 force', async () => {
  const { session } = setup({ verdicts: [pass] });
  await learn(session);
  await finishCard(session);
  await assert.rejects(session.start({ mode: 'review' }), (e) => e.code === 'examRunning');
  await session.start({ mode: 'review', force: true });
  assert.equal(session.current().word, 'absorb');
  assert.deepEqual(session.status().records, {});
});

test('只看过词没答题的重开也要 force', async () => {
  const { session } = setup();
  await session.start({ mode: 'learn' });
  session.nextStudy();
  await assert.rejects(session.start({ mode: 'learn' }), (e) => e.code === 'examRunning');
  await session.start({ mode: 'learn', force: true });
  assert.equal(session.study().word, 'abyss');
});

test('放弃保留记录但词表零改动', async () => {
  const { session, file } = setup({ verdicts: [pass] });
  await learn(session);
  await finishCard(session);
  const before = fs.readFileSync(file);
  await session.abort();
  assert.equal(session.status().status, 'aborted');
  assert.equal(session.current(), null);
  assert.equal(session.study(), null);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('「不会」把一条义项记成不会，不花调用', async () => {
  const { session, calls } = setup({ verdicts: [pass] });
  await learn(session);
  const res = await session.skip('abyss', 0);
  assert.deepEqual(res, {
    word: 'abyss',
    sense: 0,
    resolved: 'fail',
    via: 'skip',
    reason: '你标记为不会',
    done: true,
    open: 0,
    nextWord: 'bump',
  });
  assert.equal(calls.length, 0);
  const rec = session.status().records['abyss#0'];
  assert.equal(rec.result, 'fail');
  assert.equal(rec.via, 'skip');
  assert.deepEqual(rec.attempts, []);
});

test('「不会」乱序、越界或重复都拒', async () => {
  const { session } = setup();
  await learn(session);
  await assert.rejects(session.skip('bump', 0), (e) => e.code === 'examOutOfOrder');
  await assert.rejects(session.skip('abyss', 2), (e) => e.code === 'badSense');
  await session.skip('abyss', 0);
  await assert.rejects(session.skip('abyss', 0), (e) => e.code === 'examDone');
  assert.equal(session.current().word, 'abyss');
  const moved = session.advance();
  assert.equal(moved.cursor, 1);
  assert.equal(session.current().word, 'bump');
});

test('整测式的答题只要释义，例句不传', async () => {
  const { session, calls } = setup({ verdicts: [pass] });
  await learn(session);
  const res = await submit(session);
  assert.equal(res.results[0].resolved, 'pass');
  assert.equal(calls[0].input.userExample, '');
});

test('暂停与继续在看词段也能用', async () => {
  const { session, file } = setup({ verdicts: [pass] });
  await session.start({ mode: 'learn' });
  session.nextStudy();
  const before = fs.readFileSync(file);
  await session.pause();
  assert.equal(session.status().status, 'paused');
  assert.equal(session.status().phase, 'study');
  assert.equal(session.study(), null);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => session.nextStudy(), (e) => e.code === 'examPaused');
  await assert.rejects(session.commit(), (e) => e.code === 'examPaused');

  const resumed = session.resume();
  assert.equal(resumed.phase, 'study');
  assert.equal(resumed.study.word, 'bump');
  assert.equal(session.status().studyCursor, 1);
});

test('暂停且有进度时重开需要 force', async () => {
  const { session } = setup({ verdicts: [pass] });
  await learn(session);
  await finishCard(session);
  await session.pause();
  await assert.rejects(session.start({ mode: 'learn' }), (e) => e.code === 'examRunning');
  await session.start({ mode: 'learn', force: true });
  assert.equal(session.status().status, 'running');
  assert.equal(session.status().phase, 'study');
  assert.deepEqual(session.status().records, {});
});

test('没判完的卡不会漏出表内释义', async () => {
  const { session } = setup({ verdicts: [fail] });
  await learn(session);
  const res = await submit(session);
  const wire = JSON.stringify({ status: session.status(), current: session.current(), res });
  assert.ok(!wire.includes('deep hole'), wire);
  assert.equal(session.current().senses[0].example, 'The ship disappeared into the abyss.');
});

test('作答时能改本轮反馈语言，改动被记住', async () => {
  const { session, calls } = setup({ verdicts: [pass, pass] });
  await learn(session);
  assert.equal(session.status().lang, 'zh');
  await session.answer({ word: 'abyss', answers: [{ sense: 0, definition: 'deep hole' }], lang: 'en' });
  assert.equal(calls[0].opts.lang, 'en');
  assert.equal(session.status().lang, 'en');
  session.advance();
  await session.answer({ word: 'bump', answers: [{ sense: 0, definition: 'raised area' }], lang: 'bogus' });
  assert.equal(session.status().lang, 'en');
  assert.equal(calls[1].opts.lang, 'en');
});

test('setLang 切换本轮语言并落盘', async () => {
  const { session, calls } = setup({ verdicts: [pass] });
  await session.start({ mode: 'learn' });
  assert.deepEqual(session.setLang('en'), { ok: true, lang: 'en' });
  assert.equal(session.status().lang, 'en');
  await session.nextStudy();
  await session.nextStudy();
  await submit(session);
  assert.equal(calls[0].opts.lang, 'en');
  assert.throws(() => session.setLang('fr'), (e) => e.code === 'badLang');
  await session.pause();
  assert.equal(session.setLang('zh').lang, 'zh');

  const other = setup();
  assert.throws(() => other.session.setLang('en'), (e) => e.code === 'examNotRunning');
});
