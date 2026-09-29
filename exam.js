import { parse, planSetSensesChecked, applyEdits } from './vocab.js';

const MAX_ATTEMPTS = 3;
let seq = 0;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const keyOf = (item) => `${item.word}#${item.sense}`;

function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cleanScope(scope) {
  const out = {};
  for (const key of ['chapter', 'difficulty', 'mastery', 'q']) {
    const value = scope[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

function matches(target, scope) {
  if (scope.chapter && target.chapter !== scope.chapter) return false;
  if (scope.difficulty && target.level !== scope.difficulty) return false;
  if (scope.mastery === 'unchecked' && target.checked) return false;
  if (scope.mastery === 'checked' && !target.checked) return false;
  if (scope.q) {
    const q = scope.q.toLowerCase();
    if (!`${target.word} ${target.definition}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

const STATE_VERSION = 2;

export function createExam({ store, ai, stateFile, random = Math.random }) {
  // 只认当前版本的状态文件；旧版本（v1 的「词」队列）直接当作没有进行中的轮次。
  const load = () => {
    const state = stateFile.read();
    return state && state.version === STATE_VERSION ? state : null;
  };

  const save = (state) => {
    state.version = STATE_VERSION;
    state.updatedAt = new Date().toISOString();
    stateFile.write(state);
    return state;
  };

  const entries = () => parse(store.readFile()).entries;

  const findEntry = (word) => entries().find((e) => e.word === word);

  const targets = () => {
    const out = [];
    for (const entry of entries()) {
      entry.senses.forEach((sense, i) => {
        out.push({
          word: entry.word,
          sense: i,
          count: entry.senses.length,
          chapter: entry.chapter,
          level: sense.level,
          definition: sense.definition,
          example: sense.example,
          checked: sense.checked,
        });
      });
    }
    return out;
  };

  const mustState = () => {
    const state = load();
    if (!state) throw err('examNotRunning', '当前没有进行中的考试');
    return state;
  };

  const running = () => {
    const state = mustState();
    if (state.status === 'paused') throw err('examPaused', '本轮已暂停，点「继续本轮」接着考');
    if (state.status !== 'running') throw err('examSettled', '本次考试已经结算或放弃');
    return state;
  };

  function status() {
    return load();
  }

  function current() {
    const state = load();
    if (!state || state.status !== 'running' || state.cursor >= state.queue.length) return null;
    const item = state.queue[state.cursor];
    const entry = findEntry(item.word);
    const sense = entry ? entry.senses[item.sense] ?? null : null;
    const used = state.records[keyOf(item)]?.attempts.length ?? 0;
    return {
      word: item.word,
      sense: item.sense,
      senseCount: entry ? entry.senses.length : 1,
      chapter: entry?.chapter ?? null,
      example: sense?.example ?? '',
      attempt: used + 1,
      maxAttempts: state.maxAttempts,
      index: state.cursor,
      total: state.queue.length,
      finished: false,
    };
  }

  async function start(scope = {}) {
    const previous = load();
    const touched =
      previous && (previous.status === 'running' || previous.status === 'paused') &&
      (previous.cursor > 0 || Object.keys(previous.records).length > 0);
    if (touched && !scope.force) {
      throw err('examRunning', '已有考试进行中，需要先结算、放弃，或明确重开');
    }
    const picked = cleanScope(scope);
    const queue = shuffle(
      targets()
        .filter((t) => matches(t, picked))
        .map((t) => ({ word: t.word, sense: t.sense })),
      random,
    );
    if (!queue.length) throw err('emptyScope', '没有符合条件的义项');

    const state = {
      version: STATE_VERSION,
      id: `exam-${Date.now().toString(36)}-${++seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      status: 'running',
      scope: picked,
      model: typeof scope.model === 'string' && scope.model ? scope.model : null,
      lang: scope.lang === 'en' ? 'en' : 'zh',
      maxAttempts: MAX_ATTEMPTS,
      queue,
      cursor: 0,
      records: {},
    };
    return save(state);
  }

  async function answer({ word, sense, userDefinition, userExample, lang }) {
    const state = running();
    if (typeof userDefinition !== 'string' || !userDefinition.trim()) throw err('badAnswer', '释义不能为空');
    const example = typeof userExample === 'string' ? userExample.trim() : '';
    if (lang === 'zh' || lang === 'en') state.lang = lang;
    if (state.cursor >= state.queue.length) throw err('examFinished', '所有词都已作答，请结算或放弃');
    const expected = state.queue[state.cursor];
    if (keyOf({ word, sense: Number.isInteger(sense) ? sense : 0 }) !== keyOf(expected)) {
      throw err('examOutOfOrder', `当前应该答：${expected.word}`);
    }

    const definition = userDefinition.trim();
    const entry = findEntry(expected.word);
    const verdict = await ai.judgeEntry(
      {
        word: expected.word,
        userDefinition: definition,
        userExample: example,
        targetExample: entry ? entry.senses[expected.sense]?.example ?? '' : '',
      },
      { model: state.model, lang: state.lang, exam: true },
    );

    const key = keyOf(expected);
    const record = state.records[key] ?? { attempts: [], result: null };
    record.attempts.push({
      userDefinition: definition,
      userExample: example,
      pass: verdict.pass,
      reason: verdict.reason,
      at: new Date().toISOString(),
    });
    const resolved = verdict.pass ? 'pass' : record.attempts.length >= state.maxAttempts ? 'fail' : null;
    if (resolved) record.result = resolved;
    state.records[key] = record;
    if (resolved) state.cursor += 1;
    save(state);

    return {
      word: expected.word,
      sense: expected.sense,
      pass: verdict.pass,
      reason: verdict.reason,
      resolved,
      attemptsLeft: resolved ? 0 : state.maxAttempts - record.attempts.length,
      next: state.cursor < state.queue.length ? state.queue[state.cursor] : null,
    };
  }

  async function skip(word, sense) {
    const state = running();
    if (state.cursor >= state.queue.length) throw err('examFinished', '所有词都已作答，请结算或放弃');
    const expected = state.queue[state.cursor];
    if (keyOf({ word, sense: Number.isInteger(sense) ? sense : 0 }) !== keyOf(expected)) {
      throw err('examOutOfOrder', `当前应该答：${expected.word}`);
    }

    const record = state.records[keyOf(expected)] ?? { attempts: [], result: null };
    record.result = 'fail';
    record.via = 'skip';
    state.records[keyOf(expected)] = record;
    state.cursor += 1;
    save(state);

    return {
      word: expected.word,
      sense: expected.sense,
      resolved: 'fail',
      via: 'skip',
      reason: '你标记为不会',
      next: state.cursor < state.queue.length ? state.queue[state.cursor] : null,
    };
  }

  async function reveal(word, sense = 0) {
    const state = mustState();
    const index = Number.isInteger(sense) ? sense : 0;
    const record = state.records[keyOf({ word, sense: index })];
    if (!record?.result) throw err('examLocked', '该词还没结束，暂时不能看表内释义与例句');
    const entry = findEntry(word);
    const target = entry ? entry.senses[index] ?? null : null;
    if (!entry || !target) throw err('wordNotFound', `词表里已经没有 ${word} 的这条义项`);
    return {
      word,
      sense: index,
      level: target.level,
      result: record.result,
      attempts: record.attempts.length,
      definition: target.definition || entry.definition,
      chinese: target.chinese ?? entry.chinese ?? null,
      example: target.example,
    };
  }

  function preview() {
    const state = mustState();
    const byWord = new Map(entries().map((e) => [e.word, e]));
    const add = [];
    const remove = [];
    const skipped = [];
    let unchanged = 0;
    for (const item of state.queue) {
      const record = state.records[keyOf(item)];
      if (!record?.result) continue;
      const sense = byWord.has(item.word) ? byWord.get(item.word).senses[item.sense] : null;
      if (!sense) {
        skipped.push({ word: item.word, sense: item.sense, reason: 'wordNotFound' });
        continue;
      }
      const shown = { word: item.word, sense: item.sense, level: sense.level };
      const shouldCheck = record.result === 'pass';
      if (sense.checked === shouldCheck) unchanged += 1;
      else if (shouldCheck) add.push(shown);
      else remove.push(shown);
    }
    return { add, remove, unchanged, skipped, total: state.queue.length };
  }

  async function commit() {
    const state = running();
    const plan = preview();
    const wanted = [
      ...plan.add.map((item) => ({ ...item, checked: true })),
      ...plan.remove.map((item) => ({ ...item, checked: false })),
    ];
    if (!wanted.length) {
      state.status = 'settled';
      state.settlement = { words: [], backup: null, at: new Date().toISOString() };
      save(state);
      return { ...plan, backup: null, changed: 0, state };
    }

    return store.enqueue(() => {
      const text = store.readFile();
      const edits = [];
      const skipped = [...plan.skipped];
      const byWord = new Map();
      for (const item of wanted) {
        if (!byWord.has(item.word)) byWord.set(item.word, []);
        byWord.get(item.word).push({ index: item.sense, checked: item.checked });
      }
      let written = 0;
      for (const [word, states] of byWord) {
        const plan2 = planSetSensesChecked(text, word, states);
        if (plan2.error) {
          for (const s of states) skipped.push({ word, sense: s.index, reason: plan2.error.code });
          continue;
        }
        if (plan2.noop) continue;
        edits.push(...plan2.edits);
        written += states.length;
      }
      const backup = edits.length ? store.writeWithBackup(applyEdits(text, edits)).backup : null;
      state.status = 'settled';
      state.settlement = {
        words: [...plan.add, ...plan.remove],
        skipped,
        backup,
        at: new Date().toISOString(),
      };
      save(state);
      return { ...plan, skipped, backup, changed: written, state };
    });
  }

  async function abort() {
    const state = mustState();
    if (state.status === 'running' || state.status === 'paused') {
      state.status = 'aborted';
      save(state);
    }
    return { ok: true };
  }

  function setLang(lang) {
    const state = mustState();
    if (state.status !== 'running' && state.status !== 'paused') throw err('examSettled', '本次考试已经结算或放弃');
    if (lang !== 'zh' && lang !== 'en') throw err('badLang', '反馈语言只能是 zh 或 en');
    state.lang = lang;
    save(state);
    return { ok: true, lang };
  }

  function pause() {
    const state = running();
    state.status = 'paused';
    save(state);
    return { ok: true, done: state.cursor, total: state.queue.length };
  }

  function resume() {
    const state = mustState();
    if (state.status !== 'paused') throw err('examNotPaused', '没有暂停中的考试');
    state.status = 'running';
    save(state);
    return { ok: true, done: state.cursor, total: state.queue.length, current: current() };
  }

  return { start, status, current, answer, skip, reveal, pause, resume, setLang, preview, commit, abort };
}
