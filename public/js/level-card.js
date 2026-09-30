// 定档依据方块：收起来只有一行摘要，点开是方框形式的逐步依据——查表每一步命中了什么、
// AI 的几次回答、最后的综合。加词（草稿卡）与词表（就地编辑、重构预览、重定档位）都用它，
// 所以单独一个模块，谁也不依赖谁。
//
// 它不认识 CEFR 常量也不发请求：调用方把 level / vote / trace 递进来，改的时候再递一次。

const CARET = '▸';

function stepBox(title, detail) {
  const box = document.createElement('div');
  box.className = 'step-box';
  const name = document.createElement('b');
  name.textContent = title;
  const value = document.createElement('span');
  value.textContent = detail;
  box.append(name, value);
  return box;
}

function tiersText(tiers) {
  if (!tiers || !tiers.length) return '没有可查的表';
  const hits = tiers.filter((t) => t.plain || t.pos.length);
  if (!hits.length) return '四张表都没命中';
  return hits
    .map((t) => {
      const head = `${t.source} ${t.plain || t.pos[0].level}`;
      return t.pos.length ? `${head}（按词性：${t.pos.map((p) => `${p.pos} ${p.level}`).join('、')}）` : head;
    })
    .join(' · ');
}

function derivedText(list) {
  if (!list || !list.length) return '没有可拆的形式';
  const hits = list.filter((x) => x.level);
  const misses = list.filter((x) => !x.level);
  if (!hits.length) return `没命中（试过 ${misses.map((x) => x.form).join('、')}）`;
  const found = hits.map((x) => `${x.form} → ${x.source} ${x.level}`).join(' · ');
  return misses.length ? `${found}（另试过 ${misses.map((x) => x.form).join('、')}）` : found;
}

function freqText(trace) {
  if (!trace || !trace.rank) return '不在 2 万常用词内';
  return `第 ${trace.rank} 位 → 按区间推算 ${trace.band || '—'}`;
}

function voteBox(value) {
  const box = document.createElement('i');
  box.className = value ? 'vote-box' : 'vote-box empty';
  box.textContent = value || '空';
  return box;
}

export function levelCard({ level = null, vote = null, trace = null, error = null, note = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'level-card';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'level-head';
  const caret = document.createElement('i');
  caret.className = 'level-caret';
  caret.textContent = CARET;
  const tag = document.createElement('span');
  tag.className = 'tag';
  const summary = document.createElement('span');
  summary.className = 'level-summary';
  head.append(caret, tag, summary);

  const body = document.createElement('div');
  body.className = 'level-body';
  body.hidden = true;

  const steps = document.createElement('div');
  steps.className = 'step-boxes';
  const votes = document.createElement('div');
  votes.className = 'vote-row';
  const verdict = document.createElement('div');
  verdict.className = 'step-box verdict';

  body.append(steps, votes, verdict);
  wrap.append(head, body);

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    wrap.classList.toggle('open', !body.hidden);
  });

  function update(next = {}) {
    const state = { level, vote, trace, error, note, ...next };
    const votes5 = state.vote?.votes || [];
    const level_ = state.level || state.vote?.level || null;

    tag.textContent = level_ ? `#${level_}` : '#—';
    if (level_) tag.dataset.level = level_;
    else delete tag.dataset.level;
    summary.textContent = [
      state.vote
        // 一共问了几票看 votes 本身，别把票数写死在这儿（票数改过一次了）。
        ? `一致 ${state.vote.agree}/${state.vote.valid}${
            votes5.length > state.vote.valid ? `（${votes5.length - state.vote.valid} 票空）` : ''
          }`
        : null,
      state.error ? `定档失败：${state.error}` : null,
      !state.vote && !state.error
        ? state.note || (level_ ? '表里现有的档位，没有定档记录' : '还没定档')
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    body.classList.toggle('bad', Boolean(state.error));

    steps.replaceChildren(
      stepBox('① 逐表直查', tiersText(state.trace?.tiers)),
      stepBox('② 词形归并', derivedText(state.trace?.lemma)),
      stepBox('③ 词根推测', derivedText(state.trace?.root)),
      stepBox('④ 常用度', freqText(state.trace)),
    );

    votes.replaceChildren();
    const label = document.createElement('b');
    label.textContent = votes5.length ? `AI ${votes5.length} 票` : 'AI 投票';
    votes.append(label);
    const boxes = document.createElement('span');
    boxes.className = 'vote-boxes';
    for (const v of votes5) boxes.append(voteBox(v));
    if (!votes5.length) {
      const none = document.createElement('span');
      none.className = 'vote-none';
      none.textContent = '还没跑';
      boxes.append(none);
    }
    votes.append(boxes);

    verdict.replaceChildren();
    const vLabel = document.createElement('b');
    vLabel.textContent = '综合';
    const vText = document.createElement('span');
    vText.textContent = state.vote
      ? `均值 ${state.vote.mean} → ${state.vote.level} · ${state.vote.agree}/${state.vote.valid} 票一致`
      : '等投票回来才有结论';
    verdict.append(vLabel, vText);
    return state;
  }

  update({});
  wrap.api = { update };
  return wrap;
}
