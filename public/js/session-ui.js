// 学习与复习共用的一套：看词卡、答题卡、轮次进度、结算清单、判定反馈。
// 两个面板的 DOM 只差元素前缀（learn / review），版式与交互完全一样，
// 所以这里按前缀取元素、按 mode 决定这轮属于谁。面板模块自己挂工具栏的监听。

// state 在这里改名引入：下面几个渲染函数都把「本轮状态」当参数叫 state，同名会把它遮住。
import { $, api, toast, state as listState, prefs, LABELS, fillOptions, PANEL_TITLE } from './core.js';
import { answerRow, levelTag } from './sense-ui.js';
import { loadEntries } from './vocab-list.js';

const REFS = ['Start', 'Pause', 'Resume', 'Abort', 'Restart', 'Lang', 'Count', 'CountNum', 'Progress', 'Card', 'Feedback', 'Result'];

// 滑块没给过值时按模式取默认；给过的值记在 localStorage 里，刷新页面不会跳回 10/30。
const DEFAULT_COUNT = { learn: 10, review: 30 };

const readCount = (key, fallback) => {
  const saved = Number(localStorage.getItem(key));
  return Number.isInteger(saved) && saved >= 1 ? saved : fallback;
};

// 判定反馈的固定代码翻成人话，按本轮语言选一套。模型写得出安全点评时，点评会另起一行
// 跟在后面；`unspecified` 那句笼统话在有点评时撤掉，省得两句互相打架。
const REASON_TEXT = {
  zh: {
    ok: '释义到位',
    'sense-off': '义项跑偏了，再想想这个词的核心意思',
    'word-not-used': '句子里没真正用到这个词',
    'example-off': '例句体现的是另一个意思',
    'wrong-pos': '词性用错了',
    spelling: '词形拼得不对',
    partial: '方向对，但没说清核心义',
    unspecified: '没通过（为避免提示答案，不给具体理由）',
  },
  en: {
    ok: 'the definition is on target',
    'sense-off': 'the sense is off — think again about the core meaning',
    'word-not-used': 'the word is not actually used',
    'example-off': 'the example shows a different meaning',
    'wrong-pos': 'wrong part of speech',
    spelling: 'the word form is misspelled',
    partial: 'close, but the core sense is missing',
    unspecified: 'not accepted (reason withheld to avoid hinting)',
  },
};


// 一轮是全局的（同一时刻只有一轮），所以两个面板都挂在这里，动作完了一起刷。
const mounted = [];
const refreshAll = (note, typed) => Promise.all(mounted.map((m) => m.refresh(note, typed)));

export function mountRound({ prefix, mode }) {
  // 键名只把首字母变小写（CountNum → countNum）。整段小写会把多词的名字变成 countnum，
  // 用 r.countNum 取到的就是 undefined，而且要等到某个渲染分支才炸。
  const ref = (name) => {
    const el = $(`#${prefix}${name}`);
    if (!el) throw new Error(`轮次面板缺元素：#${prefix}${name}`);
    return el;
  };
  const r = Object.fromEntries(REFS.map((name) => [name[0].toLowerCase() + name.slice(1), ref(name)]));
  fillOptions(r.lang, LABELS.lang);
  const countKey = `vocab-count-${mode}`;

  // 抽词滑块：上限跟着池子走（复习抽「掌握过一些」的，学习抽「还有义项没掌握」的——部分掌握两边都算），
  // 池子不足时浏览器自己把滑块夹在上限上，服务端那边也会再截一次。部分掌握两个池子都进，
  // 所以它的词会被算两次——那正是它的两份用处。
  function poolSize() {
    const want = mode === 'review' ? 'none' : 'full';
    return listState.entries.filter((e) => e.mastery !== want).length;
  }

  // 滑块与数字框是同一个值的两种输入：拖动同步数字框，填数字同步滑块，两边都落盘。
  // 越界的数字在这里夹到 1–池子 之间（填得比池子大就是想全抽，夹上去比弹回去好懂）。
  function applyCount(raw) {
    const max = Math.max(1, poolSize());
    if (!Number.isFinite(raw)) return false;
    const value = Math.min(Math.max(Math.round(raw), 1), max);
    r.count.value = String(value);
    r.countNum.value = String(value);
    localStorage.setItem(countKey, String(value));
    return true;
  }

  function syncCount() {
    const pool = poolSize();
    const max = Math.max(1, pool);
    const value = Math.min(readCount(countKey, DEFAULT_COUNT[mode]), max);
    r.count.max = String(max);
    r.countNum.max = String(max);
    r.count.value = String(value);
    r.countNum.value = String(value);
    return value;
  }

  r.count.addEventListener('input', () => applyCount(Number(r.count.value)));
  r.countNum.addEventListener('input', () => {
    // 正在删旧值重打的时候框是空的，这时别动滑块，等他打完或者失焦。
    if (r.countNum.value.trim() === '') return;
    applyCount(Number(r.countNum.value));
  });
  r.countNum.addEventListener('change', () => {
    // 填了非数字或空着离开：回填当前有效值，别把一个坏值留在框里。
    if (!r.countNum.value.trim() || !Number.isFinite(Number(r.countNum.value))) syncCount();
    else applyCount(Number(r.countNum.value));
  });

  function renderFeedback(note) {
    const box = r.feedback;
    box.innerHTML = '';
    if (!note) {
      box.hidden = true;
      return;
    }
    box.className = 'job-result';
    const line = document.createElement('p');
    line.className = 'quiz-hint';
    line.textContent = note;
    box.append(line);
    box.hidden = false;
  }

  function renderProgress(state, plan, current, study) {
    if (!state) {
      r.progress.textContent = '';
      return;
    }
    // 结算与放弃是终局：这两个状态下这一行没东西可交代（面板上也没事可做），回到面板再念一遍
    // 「已判 8/8 · 已结算」只是噪音。写回了几处、备份是哪份，在结算那一下由 toast 报过。
    if (state.status !== 'running' && state.status !== 'paused') {
      r.progress.textContent = '';
      return;
    }
    const done = `已判 ${plan.judged}/${plan.total} 条义项`;
    if (state.mode !== mode) {
      // 只有那一轮还在跑才在这里提醒；整轮都判完了就说去结算，别再说「接着做」。
      const label = PANEL_TITLE[state.mode];
      r.progress.textContent =
        plan.total > 0 && plan.judged === plan.total
          ? `${label}模式的那一轮已经判完（${done}），去「${label}」面板结算`
          : `${label}模式的那一轮${state.status === 'paused' ? '还暂停着' : '还没结束'}（${done}），去「${label}」面板接着做`;
      return;
    }
    const where = study ? ` · 看第 ${study.index + 1}/${study.total} 个词` : current ? ` · 第 ${current.index + 1}/${current.total} 个词` : '';
    r.progress.textContent = `${done}${where}${state.status === 'paused' ? ' · 已暂停' : ''}`;
  }

  function syncControls(state) {
    const mine = state && state.mode === mode;
    const running = mine && state.status === 'running';
    const paused = mine && state.status === 'paused';
    // 本轮还在跑的时候「开始」没有意义，要重来点「放弃并重开」。
    r.start.hidden = Boolean(running || paused);
    r.pause.hidden = !running;
    r.resume.hidden = !paused;
    r.abort.hidden = !running && !paused;
    r.restart.hidden = !running && !paused;
    // 本轮的语言以服务端记的为准；没有本轮时回到设置里的默认值。这一格归这个面板管——
    // 设置页保存后只负责触发刷新，不直接改它，否则会把这轮正用着的语言悄悄换掉。
    if (state && mine) r.lang.value = state.lang;
    else r.lang.value = prefs.lang;
  }

  // 看词段：整词的义项与例句摊开，一次一个词。
  function renderStudy(study) {
    const head = document.createElement('div');
    head.className = 'quiz-head';
    const title = document.createElement('strong');
    title.textContent = study.word;
    const meta = document.createElement('span');
    meta.className = 'card-status';
    meta.textContent = `第 ${study.index + 1}/${study.total} 个词`;
    head.append(title, meta);

    const hint = document.createElement('p');
    hint.className = 'quiz-hint';
    hint.textContent = '先看一遍这个词的每条义项与例句，记住了再点「下一个」。看完这一轮的全部词才会开始测试。';

    const list = document.createElement('div');
    list.className = 'answer-list';
    study.senses.forEach((sense, i) => {
      const row = document.createElement('div');
      row.className = 'answer-row';
      const rowHead = document.createElement('div');
      rowHead.className = 'answer-head';
      const label = document.createElement('span');
      label.className = 'answer-label';
      label.textContent = `义项 ${i + 1}`;
      rowHead.append(label, levelTag(sense.level));
      if (sense.checked) {
        const flag = document.createElement('span');
        flag.className = 'answer-flag';
        flag.textContent = '已掌握';
        rowHead.append(flag);
      }
      const def = document.createElement('p');
      def.className = 'study-def';
      def.textContent = sense.definition || '（缺释义）';
      if (sense.chinese) {
        const zh = document.createElement('span');
        zh.className = 'zh';
        zh.textContent = ` ${sense.chinese}`;
        def.append(zh);
      }
      const ex = document.createElement('p');
      ex.className = 'sense-ex';
      ex.textContent = sense.example || '（这条没有例句）';
      row.append(rowHead, def, ex);
      list.append(row);
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn primary';
    next.textContent = study.index + 1 >= study.total ? '开始测试这些词' : '下一个 →';
    next.addEventListener('click', async () => {
      next.disabled = true;
      try {
        const res = await api('/api/session/study/next', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await refreshAll(res.phase === 'test' ? '看完了，开始闭卷测这轮的词' : null);
      } catch (e) {
        next.disabled = false;
        toast(e.message, 'bad');
      }
    });

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(next);
    r.card.append(head, hint, list, actions);
  }

  // 测试段：一个词一张卡，闭卷写英文释义。
  async function renderCard(state, current, typed, seq) {
    const lang = r.lang.value === 'en' ? 'en' : 'zh';
    // 一条义项都还没判出来时后端会挡（闭卷，不给看表内释义），所以干脆不问。
    const answers = current.senses.some((s) => s.result)
      ? await api('/api/session/reveal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: current.word }),
        })
          .then((res) => new Map(res.senses.map((s) => [s.sense, s])))
          .catch(() => new Map())
      : new Map();

    const head = document.createElement('div');
    head.className = 'quiz-head';
    const title = document.createElement('strong');
    title.textContent = current.word;
    const meta = document.createElement('span');
    meta.className = 'card-status';
    meta.textContent = [`第 ${current.index + 1}/${current.total} 个词`, `${current.senses.length} 条义项`].join(' · ');
    head.append(title, meta);

    const hint = document.createElement('p');
    hint.className = 'quiz-hint';
    hint.textContent = '闭卷：不查表。每条义项填一条英文释义；留空或点「不会」都按不会计入结算。';

    const list = document.createElement('div');
    list.className = 'answer-list';
    const rows = [];

    const giveUp = async (sense) => {
      try {
        await api('/api/session/skip', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: current.word, sense }),
        });
        await refreshAll();
      } catch (e) {
        toast(e.message, 'bad');
      }
    };

    current.senses.forEach((sense, i) => {
      const row = answerRow({
        label: `义项 ${i + 1}`,
        level: sense.level,
        example: sense.example,
      });
      row.api.sense = i;

      if (sense.result) {
        row.api.input.remove();
        row.api.exampleInput.remove();
        const badge = document.createElement('span');
        badge.className = `badge ${sense.result === 'pass' ? 'pass' : 'fail'}`;
        // 徽章只说结论，「怎么算出来的」留给下面那行理由（你标记为不会 / 这条留空）。
        badge.textContent = sense.result === 'pass' ? 'PASS' : 'FAIL';
        row.api.head.append(badge);
      } else {
        if (sense.attempts) {
          const left = document.createElement('span');
          left.className = 'answer-flag';
          left.textContent = `还剩 ${sense.attemptsLeft} 次`;
          row.api.head.append(left);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'edit-btn';
        btn.textContent = '不会';
        btn.addEventListener('click', () => giveUp(i));
        row.api.head.append(btn);
        row.api.input.dataset.sense = String(i);
        row.api.exampleInput.dataset.sense = String(i);
        row.api.input.value = typed[i]?.def ?? '';
        row.api.exampleInput.value = typed[i]?.example ?? '';
      }

      if (sense.result || sense.reason) {
        const shown = answers.get(i);
        const box = row.api.result;
        box.hidden = false;
        box.className = `answer-result ${sense.result === 'pass' ? 'pass' : 'fail'}`;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = sense.result ? (sense.result === 'pass' ? 'PASS' : 'FAIL') : '再试一次';
        const reason = document.createElement('p');
        const fixed = sense.reason ? REASON_TEXT[lang][sense.reason] || REASON_TEXT[lang].unspecified : null;
        reason.textContent = [
          sense.via === 'skip' ? '你标记为不会' : sense.via === 'none' ? '这条留空，记为不会' : null,
          sense.reason === 'unspecified' && sense.suggestion ? null : fixed,
        ]
          .filter(Boolean)
          .join(' · ');
        box.append(badge);
        if (reason.textContent) box.append(reason);
        if (sense.suggestion) {
          const sug = document.createElement('p');
          sug.className = 'suggestion';
          sug.textContent = `点评：${sense.suggestion}`;
          box.append(sug);
        }
        if (shown) {
          const stored = document.createElement('p');
          stored.className = 'stored';
          stored.textContent = `表内：${shown.level ? `#${shown.level} · ` : ''}${shown.definition}${
            shown.chinese ? ` · ${shown.chinese}` : ''
          }${shown.example ? ` · ${shown.example}` : ''}`;
          box.append(stored);
        }
      }

      list.append(row.api.row);
      rows.push(row);
    });

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn primary';
    submit.textContent = '提交判定';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn';
    next.textContent = '下一个词 →';
    next.hidden = !current.done;
    submit.hidden = current.done;
    next.addEventListener('click', async () => {
      try {
        await api('/api/session/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await refreshAll();
      } catch (e) {
        toast(e.message, 'bad');
      }
    });

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(next, submit);
    // 等 reveal 的这段时间里可能又刷新过一次（清空 + 重新渲染），那这张卡就作废了。
    if (seq !== renderSeq) return;
    r.card.append(head, hint, list, actions);

    submit.addEventListener('click', async () => {
      const payload = rows
        .filter((row) => row.api.input && row.api.input.isConnected)
        .map((row) => ({
          sense: row.api.sense,
          definition: row.api.input.value.trim(),
          example: row.api.exampleInput.value.trim(),
        }));
      submit.disabled = true;
      try {
        const res = await api('/api/session/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: current.word, answers: payload, lang: r.lang.value }),
        });
        const kept = {};
        for (const row of res.results) {
          if (row.resolved) continue;
          const sent = payload.find((p) => p.sense === row.sense) || { definition: '', example: '' };
          kept[row.sense] = { def: sent.definition, example: sent.example };
        }
        await refreshAll(res.done ? '这个词判完了，点「下一个词」继续' : '还有义项没判完，改一改可以再交一次', kept);
      } catch (e) {
        toast(`提交失败：${e.message}`, 'bad');
        await refreshAll();
      }
    });
  }

  // 结算：先出清单，勾选确认后一次写回。
  function renderSettle(state, plan, current) {
    const box = r.result;
    box.innerHTML = '';
    if (!state || state.mode !== mode) {
      box.hidden = true;
      return;
    }
    const changed = plan.add.length + plan.remove.length;
    const head = document.createElement('p');
    head.className = 'quiz-hint';

    if (state.status !== 'running') {
      // 结算完、放弃完就收声：这两个状态没有可做的事，写回了几处、备份是哪份在动作那一瞬间
      // 已经用 toast 报过，再回到面板不必重播一遍。只有暂停还摆着——那是在等你点「继续本轮」。
      if (state.status === 'paused') {
        head.textContent = `本轮已暂停 · 已判 ${plan.judged}/${plan.total} 条义项，点「继续本轮」接着做`;
        box.append(head);
        box.hidden = false;
      } else {
        box.hidden = true;
      }
      return;
    }

    head.textContent = `${PANEL_TITLE[mode]}本轮共 ${plan.total} 条义项，已判 ${plan.judged} 条${
      current ? '，可以接着做，也可以随时结算已完成的部分' : '，核对清单后结算'
    }`;
    box.append(head);

    const row = (item, label) => {
      const line = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${item.word} · 义项 ${item.sense + 1}`;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.level ? `${label} · #${item.level}` : label;
      line.append(strong, tag);
      return line;
    };
    const list = document.createElement('div');
    list.className = 'preview';
    for (const item of plan.add) list.append(row(item, '将勾选'));
    for (const item of plan.remove) list.append(row(item, '将取消'));
    for (const s of plan.skipped) {
      const line = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = s.word;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `跳过：${s.reason}`;
      line.append(strong, tag);
      list.append(line);
    }
    if (!changed && !plan.skipped.length) {
      const line = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = '勾选状态无需改动';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '无改动';
      line.append(strong, tag);
      list.append(line);
    }
    box.append(list);

    const confirm = document.createElement('input');
    confirm.type = 'checkbox';
    const confirmWrap = document.createElement('label');
    confirmWrap.className = 'row-inline';
    confirmWrap.append(confirm, document.createTextNode(' 已核对清单，确认写回词表'));

    const commit = document.createElement('button');
    commit.type = 'button';
    commit.className = changed ? 'btn primary' : 'btn';
    commit.textContent = changed ? '结算并写回' : '标记为已结算';
    commit.disabled = changed > 0;
    confirm.addEventListener('change', () => {
      commit.disabled = changed > 0 && !confirm.checked;
    });
    commit.addEventListener('click', async () => {
      commit.disabled = true;
      try {
        const res = await api('/api/session/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        toast(res.changed ? `已写回 ${res.changed} 处勾选 · 备份 ${res.backup}` : '已结算，词表未改动');
        await Promise.all([refreshAll(), loadEntries()]);
      } catch (e) {
        commit.disabled = false;
        toast(e.message, 'bad');
      }
    });
    box.append(confirmWrap, commit);
    box.hidden = false;
  }

  // 重渲染会把还没提交的输入清空（点某行的「不会」会整卡重画，暂停再继续也会），
  // 所以按词把在编辑的内容存下来，渲染时再填回去。
  const pending = new Map();
  let shownWord = null;

  function stashTyped() {
    if (!shownWord) return;
    const out = {};
    for (const input of r.card.querySelectorAll('.answer-input, .answer-example-input')) {
      const sense = Number(input.dataset.sense);
      if (!Number.isInteger(sense)) continue;
      const slot = (out[sense] ||= {});
      if (input.classList.contains('answer-example-input')) slot.example = input.value;
      else slot.def = input.value;
    }
    pending.set(shownWord, out);
  }

  const typedFor = (word, extra) => ({ ...(pending.get(word) || {}), ...extra });

  // 同一时刻只认最后一次刷新：refresh 中间要 await 一次 reveal，两次刷新叠在一起的话
  // 两边都会往卡里 append，屏幕上就出现两张一样的卡（监听器也跟着翻倍）。每次刷新领个号，
  // append 之前对一下号。
  let renderSeq = 0;

  async function refresh(note, typed = {}) {
    stashTyped();
    let view;
    try {
      view = await api('/api/session');
    } catch (e) {
      toast(e.message, 'bad');
      return;
    }
    const { state: round, current, study, preview } = view;
    syncCount();
    const mine = round && round.mode === mode;
    syncControls(round);
    renderProgress(round, preview || { judged: 0, total: 0 }, mine ? current : null, mine ? study : null);

    const seq = ++renderSeq;
    r.card.innerHTML = '';
    shownWord = null;
    if (!mine || (!study && !current)) {
      r.card.hidden = true;
    } else {
      r.card.hidden = false;
      if (study) {
        renderStudy(study);
      } else {
        shownWord = current.word;
        await renderCard(round, current, typedFor(current.word, typed), seq);
      }
    }

    renderFeedback(round && mine ? note : null);
    renderSettle(
      round && mine ? round : null,
      preview || { add: [], remove: [], skipped: [], judged: 0, total: 0 },
      current,
    );
  }

  async function start(force) {
    const count = syncCount();
    try {
      await api('/api/session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, count, model: $('#model').value, lang: r.lang.value, force }),
      });
      pending.clear();
      renderFeedback(null);
      toast(force ? `已放弃旧的并重开一轮${PANEL_TITLE[mode]}` : `${PANEL_TITLE[mode]}轮次开始`);
      await refreshAll();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  async function act(path, okText) {
    try {
      await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (okText) toast(okText);
      await refreshAll();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  const round = {
    refresh,
    start,
    pause: () => act('/api/session/pause', '本轮已暂停，进度已保存'),
    resume: () => act('/api/session/resume', '本轮已继续'),
    abort: () => act('/api/session/abort', '已放弃本轮，词表未改动'),
    async setLang(lang) {
      try {
        await api('/api/session/lang', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang }),
        });
        toast(`本轮反馈语言已切为 ${lang === 'en' ? 'English' : '中文'}`);
      } catch {
        // 没有进行中的轮次，值留给下一次「开始」
      }
    },
  };
  mounted.push(round);
  return round;
}
