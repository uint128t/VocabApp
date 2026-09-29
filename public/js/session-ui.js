// 学习与复习共用的一套：看词卡、答题卡、轮次进度、结算清单、判定反馈。
// 两个面板的 DOM 只差元素前缀（learn / review），版式与交互完全一样，
// 所以这里按前缀取元素、按 mode 决定这轮属于谁。面板模块自己挂工具栏的监听。

import { $, api, toast } from './core.js';
import { answerRow, levelTag } from './sense-ui.js';
import { loadEntries } from './vocab-list.js';

const REFS = ['Start', 'Pause', 'Resume', 'Abort', 'Restart', 'Lang', 'Progress', 'Card', 'Feedback', 'Result'];

// 判定反馈的固定代码翻成人话，按本轮语言选一套。
const REASON_TEXT = {
  zh: {
    ok: '释义到位',
    'sense-off': '义项跑偏了，再想想这个词的核心意思',
    'word-not-used': '句子里没真正用到这个词',
    'wrong-pos': '词性用错了',
    spelling: '词形拼得不对',
    partial: '方向对，但没说清核心义',
    unspecified: '没通过（为避免提示答案，不给具体理由）',
  },
  en: {
    ok: 'the definition is on target',
    'sense-off': 'the sense is off — think again about the core meaning',
    'word-not-used': 'the word is not actually used',
    'wrong-pos': 'wrong part of speech',
    spelling: 'the word form is misspelled',
    partial: 'close, but the core sense is missing',
    unspecified: 'not accepted (reason withheld to avoid hinting)',
  },
};

const MODE_LABEL = { learn: '学习', review: '复习' };

// 一轮是全局的（同一时刻只有一轮），所以两个面板都挂在这里，动作完了一起刷。
const mounted = [];
const refreshAll = (note, typed) => Promise.all(mounted.map((m) => m.refresh(note, typed)));

export function mountRound({ prefix, mode }) {
  const r = Object.fromEntries(REFS.map((name) => [name.toLowerCase(), $(`#${prefix}${name}`)]));

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
    const done = `已判 ${plan.judged}/${plan.total} 条义项`;
    const tail = state.status === 'paused' ? ' · 已暂停' : state.status === 'settled' ? ' · 已结算' : state.status === 'running' ? '' : ' · 已放弃';
    if (state.mode !== mode) {
      r.progress.textContent = `${MODE_LABEL[state.mode]}模式的那一轮还没结束（${done}），去「${MODE_LABEL[state.mode]}」面板接着做`;
      return;
    }
    const where = study ? ` · 看第 ${study.index + 1}/${study.total} 个词` : current ? ` · 第 ${current.index + 1}/${current.total} 个词` : '';
    r.progress.textContent = `${done}${where}${tail}`;
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
    // 本轮的语言以服务端记的为准；没有本轮时保留下拉里选的值（初值来自设置）。
    if (state && mine) r.lang.value = state.lang;
  }

  // 看词段：整词的义项与例句摊开，一次一个词。
  function renderStudy(study) {    const head = document.createElement('div');
    head.className = 'quiz-head';
    const title = document.createElement('strong');
    title.textContent = study.word;
    const meta = document.createElement('span');
    meta.className = 'card-status';
    meta.textContent = [`### ${study.chapter}`, `第 ${study.index + 1}/${study.total} 个词`].join(' · ');
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
  async function renderCard(state, current, typed) {
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
    meta.textContent = [
      `### ${current.chapter}`,
      `第 ${current.index + 1}/${current.total} 个词`,
      `${current.senses.length} 条义项`,
    ].join(' · ');
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
        const badge = document.createElement('span');
        badge.className = `badge ${sense.result === 'pass' ? 'pass' : 'fail'}`;
        badge.textContent = sense.result === 'pass' ? 'PASS' : sense.via === 'skip' ? '不会' : sense.via === 'none' ? '不会（留空）' : 'FAIL';
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
        row.api.input.value = typed[i] ?? '';
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
        reason.textContent = [
          sense.via === 'skip' ? '你标记为不会' : sense.via === 'none' ? '这条留空，记为不会' : null,
          sense.reason ? REASON_TEXT[lang][sense.reason] || REASON_TEXT[lang].unspecified : null,
        ]
          .filter(Boolean)
          .join(' · ');
        box.append(badge, reason);
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
    r.card.append(head, hint, list, actions);

    submit.addEventListener('click', async () => {
      const payload = rows
        .filter((row) => row.api.input && row.api.input.isConnected)
        .map((row) => ({ sense: row.api.sense, definition: row.api.input.value.trim() }));
      submit.disabled = true;
      try {
        const res = await api('/api/session/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: current.word, answers: payload, lang: r.lang.value }),
        });
        const kept = {};
        for (const row of res.results) {
          if (!row.resolved) kept[row.sense] = (payload.find((p) => p.sense === row.sense) || {}).definition || '';
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
      if (state.status === 'paused') {
        head.textContent = `本轮已暂停 · 已判 ${plan.judged}/${plan.total} 条义项，点「继续本轮」接着做`;
      } else if (state.status === 'settled') {
        const s = state.settlement;
        head.textContent = s
          ? `本轮已结算 · 写回 ${s.words.length} 处勾选 · ${s.backup ? `备份 ${s.backup}` : '无需写盘'}${
              s.skipped?.length ? ` · 跳过 ${s.skipped.length}` : ''
            }`
          : `本轮已结算 · 当时判定 ${plan.judged} 条义项`;
      } else {
        head.textContent = `本轮已放弃 · 词表未改动（当时已判 ${plan.judged} 条义项）`;
      }
      box.append(head);
      box.hidden = false;
      return;
    }

    head.textContent = `${MODE_LABEL[mode]}本轮共 ${plan.total} 条义项，已判 ${plan.judged} 条${
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
    for (const input of r.card.querySelectorAll('.answer-input')) {
      const sense = Number(input.dataset.sense);
      if (Number.isInteger(sense) && input.value) out[sense] = input.value;
    }
    pending.set(shownWord, out);
  }

  const typedFor = (word, extra) => ({ ...(pending.get(word) || {}), ...extra });

  async function refresh(note, typed = {}) {
    stashTyped();
    let view;
    try {
      view = await api('/api/session');
    } catch (e) {
      toast(e.message, 'bad');
      return;
    }
    const { state, current, study, preview } = view;
    const mine = state && state.mode === mode;
    syncControls(state);
    renderProgress(state, preview || { judged: 0, total: 0 }, mine ? current : null, mine ? study : null);

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
        await renderCard(state, current, typedFor(current.word, typed));
      }
    }

    renderFeedback(state && mine ? note : null);
    renderSettle(
      state && mine ? state : null,
      preview || { add: [], remove: [], skipped: [], judged: 0, total: 0 },
      current,
    );
  }

  async function start(force) {
    try {
      await api('/api/session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, model: $('#model').value, lang: r.lang.value, force }),
      });
      pending.clear();
      renderFeedback(null);
      toast(force ? `已放弃旧的并重开一轮${MODE_LABEL[mode]}` : `${MODE_LABEL[mode]}轮次开始`);
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
