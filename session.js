import { parse, planSetSensesChecked, applyEdits } from './vocab.js';

const MAX_ATTEMPTS = 3;
// 一轮抽多少个词：学习看 10 个，复习抽 30 个。
const COUNT = { learn: 10, review: 30 };
const MODES = ['learn', 'review'];
// v4：按模式分池（learn 抽未掌握、review 抽已掌握），学习模式多了「先看后考」两段。
// v3 及更早的状态文件直接当作没有进行中的轮次。
const STATE_VERSION = 4;
let seq = 0;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const keyOf = (word, sense) => `${word}#${sense}`;

function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createSession({ store, ai, stateFile, random = Math.random }) {
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
  const wordIndex = () => new Map(entries().map((e) => [e.word, e]));

  // 抽词按词级：整词都掌握了才算「已认识」，复习抽它、学习避开它。
  const pool = (mode) => {
    const want = mode === 'review';
    return entries().filter((e) => Boolean(e.checked) === want);
  };

  const mustState = () => {
    const state = load();
    if (!state) throw err('examNotRunning', '当前没有进行中的轮次');
    return state;
  };

  const running = () => {
    const state = mustState();
    if (state.status === 'paused') throw err('examPaused', '本轮已暂停，点「继续本轮」接着考');
    if (state.status !== 'running') throw err('examSettled', '本轮已经结算或放弃');
    return state;
  };

  // 中途被删掉的词在队列里留着，但轮到它时直接跨过去。
  const openIndex = (state, byWord) => {
    let i = state.cursor;
    while (i < state.queue.length && !byWord.has(state.queue[i].word)) i += 1;
    return i;
  };

  const studyIndex = (state, byWord) => {
    let i = state.studyCursor;
    while (i < state.queue.length && !byWord.has(state.queue[i].word)) i += 1;
    return i;
  };

  const nextWordAfter = (state, byWord, from) => {
    for (let i = from + 1; i < state.queue.length; i += 1) {
      if (byWord.has(state.queue[i].word)) return state.queue[i].word;
    }
    return null;
  };

  // 测试段的一张卡：这个词的全部义项都摆出来，释义遮住。
  function cardOf(item, state, byWord) {
    const entry = byWord.get(item.word) ?? null;
    const senses = (entry ? entry.senses : []).map((sense, i) => {
      const rec = state.records[keyOf(item.word, i)];
      const attempts = rec ? rec.attempts.length : 0;
      return {
        sense: i,
        level: sense.level,
        example: sense.example,
        checked: Boolean(sense.checked),
        result: rec && rec.result ? rec.result : null,
        via: rec && rec.via ? rec.via : null,
        reason: rec && rec.attempts.length ? rec.attempts[rec.attempts.length - 1].reason : null,
        attempts,
        attemptsLeft: rec && rec.result ? 0 : Math.max(0, state.maxAttempts - attempts),
      };
    });
    const open = senses.filter((s) => !s.result).length;
    return { word: item.word, chapter: entry ? entry.chapter : null, senses, open, done: open === 0 };
  }

  // 看词段的一张卡：整词的义项与例句都摊开，不遮释义、不判分。
  function studyCardOf(state, byWord) {
    const i = studyIndex(state, byWord);
    const item = state.queue[i];
    if (!item) return null;
    const entry = byWord.get(item.word);
    return {
      index: i,
      total: state.queue.length,
      word: item.word,
      chapter: entry.chapter,
      senses: entry.senses.map((sense, k) => ({
        sense: k,
        level: sense.level,
        definition: sense.definition || entry.definition,
        chinese: sense.chinese ?? null,
        example: sense.example,
        checked: Boolean(sense.checked),
      })),
    };
  }

  function status() {
    return load();
  }

  function current() {
    const state = load();
    if (!state || state.status !== 'running' || state.phase !== 'test') return null;
    const byWord = wordIndex();
    const i = openIndex(state, byWord);
    if (i >= state.queue.length) return null;
    return {
      ...cardOf(state.queue[i], state, byWord),
      index: i,
      total: state.queue.length,
      maxAttempts: state.maxAttempts,
    };
  }

  function study() {
    const state = load();
    if (!state || state.status !== 'running' || state.phase !== 'study') return null;
    return studyCardOf(state, wordIndex());
  }

  async function start(scope = {}) {
    const mode = scope.mode;
    if (!MODES.includes(mode)) throw err('badMode', 'mode 只能是 learn 或 review');
    const previous = load();
    const touched =
      previous && (previous.status === 'running' || previous.status === 'paused') &&
      (previous.cursor > 0 || previous.studyCursor > 0 || Object.keys(previous.records).length > 0);
    if (touched && !scope.force) {
      throw err('examRunning', '已有轮次进行中，需要先结算、放弃，或明确重开');
    }

    // 词级抽词，抽中后这个词的全部义项都进队列。
    const drawn = pool(mode).map((entry) => ({
      word: entry.word,
      senses: entry.senses.map((_, i) => i),
    }));
    const queue = shuffle(drawn, random).slice(0, COUNT[mode]);
    if (!queue.length) {
      throw err('emptyScope', mode === 'review' ? '还没有整词已掌握的词可以复习' : '没有还有义项没掌握的词可以学');
    }

    const state = {
      version: STATE_VERSION,
      id: `session-${Date.now().toString(36)}-${++seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      status: 'running',
      mode,
      phase: mode === 'review' ? 'test' : 'study',
      model: typeof scope.model === 'string' && scope.model ? scope.model : null,
      lang: scope.lang === 'en' ? 'en' : 'zh',
      maxAttempts: MAX_ATTEMPTS,
      queue,
      cursor: 0,
      studyCursor: 0,
      records: {},
    };
    return save(state);
  }

  // 看词段翻到下一个词；看完最后一个自动进测试段。
  function nextStudy() {
    const state = running();
    if (state.phase !== 'study') throw err('examOutOfOrder', '本轮没有看词这一段');
    const byWord = wordIndex();
    let next = studyIndex(state, byWord) + 1;
    while (next < state.queue.length && !byWord.has(state.queue[next].word)) next += 1;
    state.studyCursor = next;
    if (next >= state.queue.length) state.phase = 'test';
    save(state);
    return { ok: true, phase: state.phase, study: studyCardOf(state, byWord), current: current() };
  }

  // 交一整张卡：answers 里给了释义的逐条判，没给到的（留空）按「不会」记账。
  async function answer({ word, answers, lang }) {
    const state = running();
    if (state.phase !== 'test') throw err('examOutOfOrder', '先把这一轮要看的词看完，再开始测试');
    if (lang === 'zh' || lang === 'en') state.lang = lang;
    const byWord = wordIndex();
    const i = openIndex(state, byWord);
    if (i >= state.queue.length) throw err('examFinished', '所有词都已作答，请结算或放弃');
    const item = state.queue[i];
    if ((typeof word === 'string' ? word.trim() : '') !== item.word) {
      throw err('examOutOfOrder', `当前应该答：${item.word}`);
    }
    if (!Array.isArray(answers)) throw err('badAnswers', 'answers 必须是数组');
    const entry = byWord.get(item.word);
    if (!entry) throw err('wordNotFound', `词表里已经没有 ${item.word}`);

    const said = new Map();
    for (const row of answers) {
      const sense = row && Number.isInteger(row.sense) ? row.sense : null;
      if (sense === null || !item.senses.includes(sense)) {
        throw err('badSense', `义项序号不在本轮范围：${row && row.sense}`);
      }
      said.set(sense, typeof row.definition === 'string' ? row.definition.trim() : '');
    }

    const results = [];
    try {
      for (const sense of item.senses) {
        const key = keyOf(item.word, sense);
        const rec = state.records[key] ?? { attempts: [], result: null };
        if (rec.result) continue;
        const definition = said.get(sense) || '';
        if (!definition) {
          rec.result = 'fail';
          rec.via = 'none';
          state.records[key] = rec;
          results.push({ sense, pass: false, reason: 'blank', resolved: 'fail', via: 'none', attemptsLeft: 0 });
          continue;
        }
        const verdict = await ai.judgeEntry(
          {
            word: item.word,
            userDefinition: definition,
            userExample: '',
            targetExample: entry.senses[sense] ? entry.senses[sense].example : '',
          },
          { model: state.model, lang: state.lang, exam: true },
        );
        rec.attempts.push({
          userDefinition: definition,
          userExample: '',
          pass: verdict.pass,
          reason: verdict.reason,
          at: new Date().toISOString(),
        });
        const resolved = verdict.pass ? 'pass' : rec.attempts.length >= state.maxAttempts ? 'fail' : null;
        if (resolved) rec.result = resolved;
        state.records[key] = rec;
        results.push({
          sense,
          pass: verdict.pass,
          reason: verdict.reason,
          resolved,
          via: null,
          attemptsLeft: resolved ? 0 : state.maxAttempts - rec.attempts.length,
        });
      }
    } catch (e) {
      // 上游半路出错：已经判出来的先落盘，重交时不会重复判。
      save(state);
      throw e;
    }
    save(state);
    const card = cardOf(item, state, byWord);
    return {
      word: item.word,
      results,
      done: card.done,
      open: card.open,
      nextWord: nextWordAfter(state, byWord, i),
    };
  }

  // 「不会」= 原来那个 SKIP：这条义项直接算不会，不花模型调用。
  async function skip(word, sense) {
    const state = running();
    if (state.phase !== 'test') throw err('examOutOfOrder', '先把这一轮要看的词看完，再开始测试');
    const byWord = wordIndex();
    const i = openIndex(state, byWord);
    if (i >= state.queue.length) throw err('examFinished', '所有词都已作答，请结算或放弃');
    const item = state.queue[i];
    if ((typeof word === 'string' ? word.trim() : '') !== item.word) {
      throw err('examOutOfOrder', `当前应该答：${item.word}`);
    }
    const index = Number.isInteger(sense) ? sense : 0;
    if (!item.senses.includes(index)) throw err('badSense', `义项序号不在本轮范围：${index}`);
    const key = keyOf(item.word, index);
    const rec = state.records[key] ?? { attempts: [], result: null };
    if (rec.result) throw err('examDone', '这条义项已经判完了');
    rec.result = 'fail';
    rec.via = 'skip';
    state.records[key] = rec;
    save(state);
    const card = cardOf(item, state, byWord);
    return {
      word: item.word,
      sense: index,
      resolved: 'fail',
      via: 'skip',
      reason: '你标记为不会',
      done: card.done,
      open: card.open,
      nextWord: nextWordAfter(state, byWord, i),
    };
  }

  // 整张卡判完了才允许翻页（没判完的义项留在卡上）。
  function advance() {
    const state = running();
    if (state.phase !== 'test') throw err('examOutOfOrder', '先把这一轮要看的词看完，再开始测试');
    const byWord = wordIndex();
    const i = openIndex(state, byWord);
    if (i < state.queue.length && !cardOf(state.queue[i], state, byWord).done) {
      throw err('examOpen', '这个词还有义项没判完，判完或标「不会」再往下走');
    }
    state.cursor = i + 1;
    save(state);
    return {
      ok: true,
      cursor: state.cursor,
      finished: state.cursor >= state.queue.length,
      current: current(),
    };
  }

  async function reveal(word) {
    const state = mustState();
    const entry = wordIndex().get(word);
    if (!entry) throw err('wordNotFound', `词表里已经没有 ${word}`);
    const senses = [];
    entry.senses.forEach((sense, i) => {
      const rec = state.records[keyOf(word, i)];
      if (!rec || !rec.result) return;
      senses.push({
        sense: i,
        level: sense.level,
        result: rec.result,
        via: rec.via ?? null,
        reason: rec.attempts.length ? rec.attempts[rec.attempts.length - 1].reason : null,
        attempts: rec.attempts.length,
        definition: sense.definition || entry.definition,
        chinese: sense.chinese ?? null,
        example: sense.example,
      });
    });
    if (!senses.length) throw err('examLocked', '这个词还没有判完的义项，暂时不能看表内释义与例句');
    return { word, senses };
  }

  // 结算方向由模式定：学习只勾选、复习只取消，方向反过来的那半边一律不动。
  function preview() {
    const state = mustState();
    const byWord = wordIndex();
    const review = state.mode === 'review';
    const add = [];
    const remove = [];
    const skipped = [];
    let unchanged = 0;
    let judged = 0;
    let total = 0;
    for (const item of state.queue) {
      const entry = byWord.get(item.word);
      for (const sense of item.senses) {
        total += 1;
        const rec = state.records[keyOf(item.word, sense)];
        if (!rec?.result) continue;
        judged += 1;
        const target = entry ? entry.senses[sense] : null;
        if (!target) {
          skipped.push({ word: item.word, sense, reason: 'wordNotFound' });
          continue;
        }
        const want = review ? (rec.result === 'fail' ? false : null) : rec.result === 'pass' ? true : null;
        if (want === null || Boolean(target.checked) === want) {
          unchanged += 1;
          continue;
        }
        const shown = { word: item.word, sense, level: target.level };
        if (want) add.push(shown);
        else remove.push(shown);
      }
    }
    return { add, remove, unchanged, skipped, judged, total };
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
    if (state.status !== 'running' && state.status !== 'paused') throw err('examSettled', '本轮已经结算或放弃');
    if (lang !== 'zh' && lang !== 'en') throw err('badLang', '反馈语言只能是 zh 或 en');
    state.lang = lang;
    save(state);
    return { ok: true, lang };
  }

  function pause() {
    const state = running();
    state.status = 'paused';
    save(state);
    return { ok: true, phase: state.phase, done: state.cursor, total: state.queue.length };
  }

  function resume() {
    const state = mustState();
    if (state.status !== 'paused') throw err('examNotPaused', '没有暂停中的轮次');
    state.status = 'running';
    save(state);
    return {
      ok: true,
      phase: state.phase,
      done: state.cursor,
      total: state.queue.length,
      current: current(),
      study: study(),
    };
  }

  return {
    start,
    status,
    current,
    study,
    nextStudy,
    answer,
    skip,
    advance,
    reveal,
    pause,
    resume,
    setLang,
    preview,
    commit,
    abort,
  };
}
