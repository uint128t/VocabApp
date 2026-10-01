// 词表面板：统计与侧栏概览、列表渲染、就地编辑、复选与批量操作、重构建议面板、
// 以及条目右下角的「考这个词」。

import { $, CEFR, state, api, toast, text, fillSelect, inChunks, usageMeter, estimate } from './core.js';
import { senseRow, readSenses, levelSourceLine, answerRow, voteAll, applyVote } from './sense-ui.js';
import { levelCard } from './level-card.js';
import { settings } from './settings-panel.js';

// 掌握状态三档的说法只有这一处：标签、筛选、行内文案都从这里取。
const MASTERY_TEXT = { full: '完全掌握', partial: '部分掌握', none: '不掌握' };

function visibleEntries() {
  const q = $('#q').value.trim().toLowerCase();
  const chapter = $('#chapter').value;
  const difficulty = $('#difficulty').value;
  const mastery = $('#mastery').value;
  return state.entries.filter((e) => {
    if (chapter && e.chapter !== chapter) return false;
    if (difficulty && !(e.senses || []).some((s) => s.level === difficulty)) return false;
    if (mastery && e.mastery !== mastery) return false;
    if (q && !text(e.word, e.definition, e.chinese).toLowerCase().includes(q)) return false;
    return true;
  });
}

function statTile(label, value, total, kind = '') {
  const box = document.createElement('div');
  box.className = kind ? `stat ${kind}` : 'stat';
  const b = document.createElement('b');
  b.textContent = String(value);
  box.append(b);
  if (total !== null) {
    const i = document.createElement('i');
    i.textContent = `/ ${total}`;
    box.append(i);
  }
  const span = document.createElement('span');
  span.textContent = label;
  box.append(span);
  return box;
}

// 侧栏底部那两行共用这一套：一行字 + 一根条。条上按比例画色段，剩下的留白就是还没掌握的那截
// （所以「不掌握」不单独着色，跟义项那行的口径一样）。
function ovRow(text) {
  const row = document.createElement('div');
  row.className = 'ov-row';
  const span = document.createElement('span');
  span.textContent = text;
  row.append(span);
  return row;
}

function ovBar(segments, total) {
  const track = document.createElement('div');
  track.className = 'ov-bar';
  for (const [kind, n] of segments) {
    if (!n) continue;
    const seg = document.createElement('i');
    if (kind) seg.className = kind;
    seg.style.width = `${total ? (n / total) * 100 : 0}%`;
    track.append(seg);
  }
  return track;
}

function renderStats() {
  const s = state.stats;
  const n = s.senses || { total: 0, checked: 0, unchecked: 0 };
  $('#stats').replaceChildren(
    statTile('词', s.total, null),
    statTile('条义项', n.total, null),
    statTile('完全掌握', s.full, s.total, 'ok'),
    statTile('部分掌握', s.partial, s.total, 'partial'),
    statTile('不掌握', s.none, s.total),
    statTile('已掌握义项', n.checked, n.total, 'ok'),
    statTile('未掌握义项', n.unchecked, n.total),
  );
  const head = document.createElement('div');
  head.className = 'ov-head';
  head.textContent = `共 ${s.total} 词 · ${n.total} 条义项`;
  $('#overview').replaceChildren(
    head,
    ovRow(`完全 ${s.full} · 部分 ${s.partial} · 不掌握 ${s.none}`),
    ovBar([['full', s.full], ['partial', s.partial]], s.total),
    ovRow(`已掌握义项 ${n.checked} / ${n.total}`),
    ovBar([['', n.checked]], n.total),
  );
}

function editForm(entry, li) {
  const form = document.createElement('div');
  form.className = 'edit-form';

  const list = document.createElement('div');
  list.className = 'sense-list';
  const senses = entry.senses.map((s, i) =>
    i === 0 && !s.definition && !s.chinese && entry.definition
      ? { ...s, definition: entry.definition, checked: s.checked === undefined ? entry.mastery === 'full' : s.checked }
      : s,
  );
  for (const sense of senses) list.append(senseRow(entry, sense, { withCheck: true }));

  // 表里只存了档位本身，查表过程没落盘；补一次只查表的请求，把逐步命中填进每行的依据方块。
  api('/api/level/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ words: [entry.word] }),
  })
    .then((res) => {
      const trace = res.items[0]?.trace;
      if (!trace) return;
      for (const row of list.querySelectorAll('.sense-item')) row.api?.card?.api?.update({ trace });
    })
    .catch(() => {});

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn ghost';
  add.textContent = '+ 添加义项';
  add.addEventListener('click', () =>
    list.append(senseRow(entry, { level: null, definition: '', example: '', checked: false }, { withCheck: true })),
  );

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = senses.every((s) => s.checked);
  const mastery = document.createElement('label');
  mastery.className = 'row-inline';
  mastery.title = '勾上 = 这个词的每条义项都算掌握（完全掌握）；只勾一部分就是部分掌握';
  mastery.append(chk, document.createTextNode(' 全部义项已掌握'));
  chk.addEventListener('change', () => {
    for (const box of list.querySelectorAll('.sense-check')) box.checked = chk.checked;
  });

  const msg = document.createElement('span');
  msg.className = 'edit-msg';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn primary';
  save.textContent = '保存';

  cancel.addEventListener('click', () => li.replaceWith(entryNode(entry)));
  save.addEventListener('click', async () => {
    const rows = readSenses(list);
    if (!rows.length) {
      msg.textContent = '至少保留一条义项';
      msg.className = 'edit-msg bad';
      return;
    }
    const blank = rows.findIndex((r) => !r.example);
    if (blank >= 0) {
      msg.textContent = `第 ${blank + 1} 条义项缺例句`;
      msg.className = 'edit-msg bad';
      return;
    }
    const empty = rows.findIndex((r) => !r.definition);
    if (empty >= 0) {
      msg.textContent = `第 ${empty + 1} 条义项缺释义`;
      msg.className = 'edit-msg bad';
      return;
    }
    const noLevel = rows.findIndex((r) => !r.level);
    if (noLevel >= 0) {
      msg.textContent = `第 ${noLevel + 1} 条义项还没定档，先选一个`;
      msg.className = 'edit-msg bad';
      return;
    }
    save.disabled = true;
    msg.textContent = '保存中…';
    msg.className = 'edit-msg';
    try {
      const res = await api('/api/commit-edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word: entry.word, checked: rows.every((r) => r.checked), senses: rows }),
      });
      toast(res.noop ? `${entry.word} 没有变化，未写盘` : `${entry.word} 已更新${res.backup ? ` · 备份 ${res.backup}` : ''}`);
      await loadEntries();
    } catch (e) {
      save.disabled = false;
      msg.textContent = `失败：${e.message}`;
      msg.className = 'edit-msg bad';
    }
  });

  const actions = document.createElement('div');
  actions.className = 'sense-actions';
  actions.append(add, mastery, cancel, save, msg);
  form.append(list, actions);
  return form;
}

async function setSenseChecked(word, index, checked, box) {
  box.disabled = true;
  try {
    await api('/api/set-checked', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word, sense: index, checked }),
    });
    toast(`${word}${index ? ` 第 ${index + 1} 条义项` : ''}${checked ? ' 已勾选' : ' 已取消勾选'}`);
    await loadEntries();
  } catch (e) {
    box.checked = !checked;
    box.disabled = false;
    toast(e.message, 'bad');
  }
}

// 词表行有两副面孔。正常模式只留义项行自带的勾选框（那是写盘开关）；
// 复选模式下义项行不出框、词头前面出一个多选框，行尾的编辑/删除一并收起。
let selectionMode = false;

function entryNode(e) {
  const li = document.createElement('li');
  // 完全掌握的词头压暗（早就认识的不用反复看）；三档的区分靠词头后面那枚标签。
  li.className = text('entry', e.mastery === 'full' && 'checked');

  const word = document.createElement('span');
  word.className = 'word';
  word.textContent = e.word;

  const def = document.createElement('span');
  def.className = 'def';
  def.textContent = e.definition || '（缺释义）';

  const head = document.createElement('div');
  head.className = 'head';
  if (selectionMode) {
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.checked = selected.has(e.word);
    pick.addEventListener('change', () => toggleSelected(e.word, pick.checked));
    head.append(pick);
  }
  head.append(word, def);
  if (e.chinese) {
    const zh = document.createElement('span');
    zh.className = 'zh';
    zh.textContent = e.chinese;
    head.append(zh);
  }

  // 词头这行标掌握状态、不标档位：档位是按义项来的，只写在义项行上。部分掌握顺带写
  // 「勾了几条 / 共几条」，一眼能看出还差多少。
  const masteryTag = document.createElement('span');
  masteryTag.className = 'tag';
  masteryTag.dataset.mastery = e.mastery;
  masteryTag.textContent =
    e.mastery === 'partial'
      ? `${MASTERY_TEXT.partial} ${e.senses.filter((s) => s.checked).length}/${e.senses.length}`
      : MASTERY_TEXT[e.mastery];
  head.append(masteryTag);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'edit-btn';
  edit.textContent = '编辑';
  edit.addEventListener('click', () => li.replaceChildren(editForm(e, li)));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete-btn';
  del.textContent = '删除';
  let armTimer;
  const disarm = () => {
    clearTimeout(armTimer);
    del.textContent = '删除';
    del.classList.remove('armed');
  };
  del.addEventListener('click', () => {
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      del.textContent = `确认删除 ${e.word}`;
      armTimer = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    del.disabled = true;
    api('/api/commit-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: e.word }),
    })
      .then((res) => {
        state.entries = state.entries.filter((x) => x.word !== e.word);
        state.stats = res.stats;
        renderStats();
        renderList();
        toast(`已删除 ${res.word} · 备份 ${res.backup}`);
      })
      .catch((e2) => {
        del.disabled = false;
        toast(`删除失败：${e2.message}`, 'bad');
      });
  });

  if (!selectionMode) {
    const actions = document.createElement('div');
    actions.className = 'head-actions';
    actions.append(edit, del);
    head.append(actions);
  }

  li.append(head);

  const senses = e.senses;
  senses.forEach((sense, i) => {
    const row = document.createElement('div');
    row.className = text('child', !sense.example && 'empty');

    if (!selectionMode) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'sense-check';
      check.checked = Boolean(sense.checked);
      check.title = senses.length > 1 ? `第 ${i + 1} 条义项是否掌握` : '是否已掌握';
      check.addEventListener('change', () => setSenseChecked(e.word, i, check.checked, check));
      row.append(check);
    }

    if (sense.level) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.dataset.level = sense.level;
      tag.textContent = `#${sense.level}`;
      row.append(tag, document.createTextNode(' '));
    }
    if (sense.definition) {
      const def = document.createElement('span');
      def.className = 'sense-def';
      def.textContent = sense.definition;
      row.append(def, document.createTextNode(' — '));
    }
    if (sense.chinese) {
      const zh = document.createElement('span');
      zh.className = 'zh';
      zh.textContent = sense.chinese;
      row.append(zh, document.createTextNode(' '));
    }
    const ex = document.createElement('span');
    ex.className = 'sense-ex';
    ex.textContent = sense.example || '缺例句';
    row.append(ex);
    li.append(row);
  });

  if (!selectionMode) {
    const foot = document.createElement('div');
    foot.className = 'entry-foot';
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'edit-btn';
    check.textContent = '考这个词';
    check.addEventListener('click', () => li.replaceChildren(wordCheckCard(e, li)));
    foot.append(check);
    li.append(foot);
  }
  return li;
}

// 「考这个词」：就地展开答题卡，逐条填释义、逐条判定。
// 判定从不写盘；通过的义项旁给一颗「勾选为已掌握」，点它才写。
// 写盘后不立刻重画整表（否则卡片会被冲掉），先记在 possibleDirty 上，
// 等关掉卡片再刷新列表与统计。
function wordCheckCard(e, li) {
  const card = document.createElement('div');
  card.className = 'check-card';
  let dirty = false;

  const close = () => {
    // entryNode 交回的就是一个新的 li，要拿它换掉手上这个；用 replaceChildren 会套成
    // li 里再套一个 li，内层又加一份 padding，缩回后整条行高就鼓了。
    li.replaceWith(entryNode(e));
    if (dirty) return loadEntries();
    return undefined;
  };

  const head = document.createElement('div');
  head.className = 'quiz-head';
  const title = document.createElement('strong');
  title.textContent = e.word;
  const meta = document.createElement('span');
  meta.className = 'card-status';
  meta.textContent = [`${(e.senses || []).length} 条义项`, MASTERY_TEXT[e.mastery]].join(' · ');
  head.append(title, meta);

  const hint = document.createElement('p');
  hint.className = 'quiz-hint';
  hint.textContent = '就地问答：填哪条判哪条，留空的不判；例句可选，填了会一起判。判定不写盘，通过的义项旁边会出现「勾选为已掌握」。';

  const list = document.createElement('div');
  list.className = 'answer-list';
  const rows = (e.senses || []).map((sense, i) => {
    const row = answerRow({ label: `义项 ${i + 1}`, level: sense.level, example: sense.example });
    row.api.sense = i;
    row.api.data = sense;
    row.api.checked = Boolean(sense.checked);
    if (sense.checked) {
      const flag = document.createElement('span');
      flag.className = 'answer-flag';
      flag.textContent = '已掌握';
      row.api.head.append(flag);
    }
    list.append(row.api.row);
    return row;
  });

  const status = document.createElement('span');
  status.className = 'count';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = '收起';
  cancel.addEventListener('click', close);
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn primary';
  submit.textContent = '提交判定';

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.append(cancel, submit);
  card.append(head, hint, list, actions, status);

  submit.addEventListener('click', async () => {
    const filled = rows.filter((row) => row.api.input.value.trim());
    if (!filled.length) {
      status.textContent = '至少填一条义项的释义';
      return;
    }
    submit.disabled = true;
    let passes = 0;
    for (let i = 0; i < filled.length; i += 1) {
      const row = filled[i];
      status.textContent = `判定中 ${i + 1}/${filled.length}…`;
      try {
        const res = await api('/api/judge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            word: e.word,
            sense: row.api.sense,
            userDefinition: row.api.input.value.trim(),
            userExample: row.api.exampleInput.value.trim(),
            lang: settings ? settings.lang : 'zh',
          }),
        });
        if (res.pass) passes += 1;
        renderCheckVerdict(row, res, e, () => {
          dirty = true;
        });
      } catch (err) {
        renderCheckError(row, err);
      }
    }
    submit.disabled = false;
    status.textContent = `判了 ${filled.length} 条 · ${passes} 条通过`;
  });

  return card;
}

function renderCheckVerdict(row, res, entry, wrote) {
  const box = row.api.result;
  box.innerHTML = '';
  box.hidden = false;
  box.className = `answer-result ${res.pass ? 'pass' : 'fail'}`;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = res.pass ? 'PASS' : 'FAIL';
  const reason = document.createElement('p');
  reason.textContent = res.reason || (res.pass ? '判定通过。' : '判定未通过。');
  box.append(badge, reason);

  if (res.suggestion) {
    const sug = document.createElement('p');
    sug.className = 'suggestion';
    sug.textContent = `建议：${res.suggestion}`;
    box.append(sug);
  }

  const sense = row.api.data;
  const stored = document.createElement('p');
  stored.className = 'stored';
  stored.textContent = `表内：${sense.definition || '（缺释义）'}${sense.chinese ? ` · ${sense.chinese}` : ''}${
    sense.example ? ` · ${sense.example}` : ''
  }`;
  box.append(stored);

  if (!res.pass) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  const label = () => {
    btn.textContent = row.api.checked ? '这条义项已勾选 · 撤销' : '勾选为已掌握';
  };
  label();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const next = !row.api.checked;
    try {
      await api('/api/set-checked', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word: entry.word, sense: row.api.sense, checked: next }),
      });
      row.api.checked = next;
      label();
      btn.disabled = false;
      wrote();
      toast(`${entry.word}${row.api.sense ? ` 第 ${row.api.sense + 1} 条义项` : ''}${next ? ' 已勾选' : ' 已取消勾选'}`);
    } catch (e) {
      btn.disabled = false;
      toast(e.message, 'bad');
    }
  });
  box.append(btn);
}

function renderCheckError(row, e) {
  const box = row.api.result;
  box.innerHTML = '';
  box.hidden = false;
  box.className = 'answer-result bad';
  box.textContent = `判定失败：${e.message}`;
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  const shown = visibleEntries();
  const frag = document.createDocumentFragment();
  if (!shown.length) {
    // 筛选落空时给一句话，别剩一个白框让人猜是坏了还是真没有。
    const empty = document.createElement('li');
    empty.className = 'list-empty';
    empty.textContent = state.entries.length
      ? '没有符合条件的词：换一个筛选，或清空搜索。'
      : '词表还是空的：去「加词」生成第一张草稿卡。';
    frag.append(empty);
  }
  for (const e of shown) frag.append(entryNode(e));
  list.append(frag);
  $('#count').textContent = `显示 ${shown.length} / ${state.entries.length}`;
  syncSelection();
}

async function loadEntries() {
  const btn = $('#reload');
  btn.disabled = true;
  try {
    const body = await api('/api/entries');
    state.entries = body.entries;
    state.stats = body.stats;
    for (const word of [...selected]) {
      if (!state.entries.some((e) => e.word === word)) selected.delete(word);
    }
    const chapterList = [...new Set(body.entries.map((e) => e.chapter).filter(Boolean))];
    fillSelect($('#chapter'), chapterList, $('#chapter').value);
    fillSelect($('#difficulty'), CEFR, $('#difficulty').value);
    renderStats();
    renderList();
  } catch (e) {
    toast(e.message, 'bad');
    $('#stats').textContent = `读取失败：${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

const selected = new Set();

function syncSelection() {
  const shown = visibleEntries();
  const inView = shown.filter((e) => selected.has(e.word)).length;
  $('#selectedCount').textContent = selected.size
    ? `已选 ${selected.size} 个词${inView !== selected.size ? `（当前筛选里 ${inView} 个）` : ''}`
    : '未选中任何词';
  const none = selected.size === 0;
  // 批量跑着的时候一律锁住。这几个按钮的 disabled 本来有两个人写（这里按选中数量、跑起来时
  // 按进度），中途被这里重新点亮就能起第二批，把前一批的「终止」顶掉。锁上时挂一句 title：
  // 光变灰没人知道为什么点不动。
  // panelLock 是第二把锁：清单面板露面之后就一直摆着（除非刷新页面），那期间也不许起新的一轮——
  // 两块面板都是单例，再跑一轮会把上一轮摆出来的结果直接抹掉。
  for (const id of ['#markChecked', '#markUnchecked', '#refactorBtn', '#levelBtn']) {
    const el = $(id);
    el.disabled = none || batchBusy || panelLock;
    el.title = batchBusy
      ? '这一轮还在跑：等它跑完，或点旁边的「终止」'
      : panelLock
        ? '上面还摆着一份清单：写完它、或刷新页面，才能再起一轮'
        : '';
  }
  $('#selectAll').checked = shown.length > 0 && shown.every((e) => selected.has(e.word));
}

function toggleSelected(word, on) {
  if (on) selected.add(word);
  else selected.delete(word);
  syncSelection();
}

function setSelectionMode(on) {
  selectionMode = on;
  if (!on) selected.clear();
  const btn = $('#selectMode');
  btn.textContent = on ? '退出复选' : '复选模式';
  btn.classList.toggle('active', on);
  for (const el of document.querySelectorAll('.selection-only')) el.hidden = !on;
  renderList();
}

async function markSelection(checked) {
  const words = [...selected];
  if (!words.length) return;
  // 批量标记也是一条批量：跑着的这一下里，其余批量按钮照 D41 的规矩一起锁住。
  batchBusy = true;
  syncSelection();
  try {
    const res = await api('/api/commit-mastery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ words, checked }),
    });
    await loadEntries();
    const done = checked ? '标记为已掌握' : '标记为未掌握';
    const skipped = res.skipped.length ? `，跳过 ${res.skipped.map((s) => s.word).join('、')}` : '';
    const tail = res.backup ? `备份 ${res.backup}` : '状态没变，未写盘';
    toast(`已${done} ${res.changed} 个词${skipped} · ${tail}`, res.skipped.length ? 'bad' : 'ok');
  } catch (e) {
    toast(`批量标记失败：${e.message}`, 'bad');
  } finally {
    batchBusy = false;
    syncSelection();
  }
}

// 清单长了就压成默认高度、右下角给个拖柄（CSS 里的 .preview.scrollable），高度随你拖；
// 矮清单不挂这个类：没东西可拖，白长一个角。
function fitPreview(list) {
  // 先按 .preview 的 340px 上限量一眼，量完再加类：加完类上限就变成 85vh 了。
  const capped = list.clientHeight;
  if (list.scrollHeight <= capped + 1) return;
  list.classList.add('scrollable');
  list.style.height = `${capped}px`;
}

// 重构面板分两段：点下去先把选中的词全部摆出来（现有义项本地就有，这一段不调模型），跑的
// 时候哪个词回来就填哪一行、哪条义项定完档就填哪一条——和「重定档位」那边一样，从头到尾
// 界面上都有东西，而不是攒到整个词跑完才一起出现。
function refactorSlot(entry) {
  const li = document.createElement('li');
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'refactor-pick';
  pick.disabled = true; // 跑完、而且定档完整，才允许勾

  const word = document.createElement('strong');
  word.textContent = entry.word;
  const move = document.createElement('span');
  move.className = 'def';
  const before = (entry.senses || []).map((s) => s.level || '—').join(' / ') || '—';
  move.textContent = `${before} → …`;
  const out = document.createElement('span');
  out.className = 'save-state';
  out.textContent = '排队中';
  li.append(pick, word, move, out);

  const senses = document.createElement('div');
  senses.className = 'refactor-senses';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.hidden = true;
  const bad = document.createElement('div');
  bad.className = 'edit-msg bad';
  bad.hidden = true;
  li.append(senses, hint, bad);

  const slot = {
    li,
    pick,
    entry,
    item: null,
    lines: [],
    fallbackTrace: null,
    status(text, isBad = false) {
      out.textContent = text;
      out.className = isBad ? 'save-state bad' : 'save-state';
    },
    // 义项一到就先摆出来（档位还空着），定完一条就地更新那一条——不攒到整个词跑完。
    showSenses(list, fallbackTrace) {
      slot.fallbackTrace = fallbackTrace || null;
      senses.replaceChildren();
      slot.lines = list.map((sense) => {
        const line = document.createElement('div');
        line.className = 'child';
        const tag = document.createElement('span');
        tag.className = 'tag';
        const text = document.createTextNode('');
        line.append(tag, text);
        // 定档依据跟着每条义项走，展开能看到逐步命中与几次投票。
        const card = levelCard({ level: null, trace: sense.trace || slot.fallbackTrace });
        senses.append(line, card);
        const node = { line, tag, text, card };
        slot.paint(node, sense);
        return node;
      });
    },
    paint(node, sense) {
      if (sense.level) node.tag.dataset.level = sense.level;
      else delete node.tag.dataset.level;
      node.tag.textContent = sense.level ? `#${sense.level}` : '#—';
      node.text.textContent = ` ${sense.definition}${sense.chinese ? ` · ${sense.chinese}` : ''} — ${sense.example}`;
      node.card.api.update({
        level: sense.level,
        vote: sense.vote,
        trace: sense.trace || slot.fallbackTrace,
        error: sense.voteError,
        note: sense.kept ? '释义没变，沿用原档位' : null,
      });
    },
    updateSense(i, sense) {
      const node = slot.lines[i];
      if (node) slot.paint(node, sense);
    },
    done(item) {
      slot.item = item;
      move.textContent = `${before} → ${item.senses.map((s) => s.level).join(' / ')}`;
      out.textContent = '';
      // 已经流出来的那些就地更新，不整块重画（不然用户展开的依据方块会被收回去）。
      item.senses.forEach((sense, i) => slot.updateSense(i, sense));
      if (item.note) {
        hint.textContent = item.note;
        hint.hidden = false;
      }
      if (!item.writeable) {
        bad.textContent = `无法写盘：${item.error?.message || item.error?.code || '未知原因'}`;
        bad.hidden = false;
      }
      pick.disabled = !item.writeable;
      pick.checked = Boolean(item.writeable);
    },
  };
  return slot;
}

function openRefactorPanel(entries) {
  const panel = $('#refactorPanel');
  panel.innerHTML = '';
  panel.hidden = false;
  panelLock = true;
  syncSelection();

  const head = document.createElement('p');
  head.className = 'quiz-hint';
  panel.append(head);

  const actions = document.createElement('div');
  actions.className = 'row';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'btn ghost';
  all.textContent = '全选';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'btn ghost';
  none.textContent = '全不选';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn primary';
  apply.textContent = '确认写入';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = '取消';
  const result = document.createElement('span');
  result.className = 'save-state';
  actions.append(all, none, apply, cancel, result);
  panel.append(actions);

  // 「取消」是整块收摊：还在飞的调用一并中止，面板收掉、什么也不写回词表，工具栏那把锁跟着解开。
  const closePanel = () => {
    refactorStop?.abort();
    panel.hidden = true;
    panel.innerHTML = '';
    panelLock = false;
    syncSelection();
  };
  cancel.addEventListener('click', () => {
    closePanel();
    toast('已取消这一轮重构，未写盘');
  });

  const list = document.createElement('ul');
  list.className = 'preview';
  const slots = entries.map((entry) => refactorSlot(entry));
  for (const slot of slots) list.append(slot.li);
  panel.append(list);
  fitPreview(list);

  // 开跑前就把这轮的账摆出来：一个词一次生成 + 每条义项三票。
  const expected = estimate({
    entries: entries.length,
    senses: entries.reduce((n, e) => n + (e.senses || []).length, 0),
  });
  const say = (extra) => {
    const ready = slots.filter((s) => s.item).length;
    head.textContent = `重构建议 ${ready}/${slots.length} 个词 · 预计 ${expected.text} · 勾选后一次写盘，写盘前自动备份${
      extra ? ` · ${extra}` : ''
    }`;
  };
  say('');

  all.addEventListener('click', () => {
    for (const slot of slots) if (!slot.pick.disabled) slot.pick.checked = true;
  });
  none.addEventListener('click', () => {
    for (const slot of slots) slot.pick.checked = false;
  });

  apply.addEventListener('click', async () => {
    const chosen = slots.filter((s) => s.pick.checked && s.item);
    if (!chosen.length) {
      result.textContent = '没有勾选任何词';
      result.className = 'save-state bad';
      return;
    }
    const payload = chosen.map((s) => ({ word: s.item.word, senses: s.item.senses, checked: s.item.checked }));
    apply.disabled = true;
    result.textContent = '写入中…';
    result.className = 'save-state';
    try {
      const out = await api('/api/refactor/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: payload }),
      });
      result.textContent = `已重构 ${out.changed} 条${out.failed.length ? ` · 跳过 ${out.failed.length}` : ''}${out.backup ? ` · 备份 ${out.backup}` : ''}`;
      toast(`已重构 ${out.changed} 条${out.backup ? ` · 备份 ${out.backup}` : ''}`);
      selected.clear();
      await loadEntries();
      // 写过的那些从清单里摘掉，剩下的继续摆着。
      for (const slot of chosen) slot.li.remove();
      slots.splice(0, slots.length, ...slots.filter((s) => !chosen.includes(s)));
      if (!slots.length) {
        // 全都写完了就整块收摊：工具栏那把锁跟着解开，好接着跑下一批。
        closePanel();
        return;
      }
      say('');
    } catch (e) {
      result.textContent = `写入失败：${e.message}`;
      result.className = 'save-state bad';
    }
    apply.disabled = false;
  });

  return { slots, say };
}

// 档位复判（任务三）：档位依据没写进 markdown，只有生成那一刻知道，所以能复判的近似判据是
// 「这个词在参考词表里有没有东西可依」——一点参考都没有的那些义项，当初的档位就是纯 AI 自判。
// 两步点击：出清单（不调模型）→ 对勾选的义项并发跑三次取平均，最后点「确认写入」一次写盘。
// 面板一露面就一直摆着，那期间工具栏别的批量按钮都锁着（D41）。
// 行的样子与「重构」那面板一致（同一套 li/preview 版式），但**不展示例句**：这一版只关心档位。
function levelRow(item, sense, index) {
  const li = document.createElement('li');
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'refactor-pick';
  pick.disabled = !sense.definition;
  // 档位现在一律由三票定（D30），所以默认全勾：复判是给旧数据按新口径重算一遍。
  pick.checked = !pick.disabled;

  const word = document.createElement('strong');
  word.textContent = `${item.word} · 义项 ${index + 1}`;
  const move = document.createElement('span');
  move.className = 'def';
  move.textContent = sense.level ? `#${sense.level}` : '#—';
  const out = document.createElement('span');
  out.className = 'save-state';
  li.append(pick, word, move, out);

  const senses = document.createElement('div');
  senses.className = 'refactor-senses';
  const line = document.createElement('div');
  line.className = 'child';
  line.textContent = `${sense.definition || '（缺释义）'}${sense.chinese ? ` · ${sense.chinese}` : ''}`;
  const card = levelCard({ level: sense.level, trace: item.trace });
  senses.append(line, card);
  li.append(senses);

  li.api = { item, sense, index, pick, out, card, move, level: sense.level };
  return li;
}

function renderLevelPanel(res) {
  const panel = $('#levelPanel');
  panel.innerHTML = '';
  panel.hidden = false;
  const rows = [];
  const total = res.items.reduce((n, item) => n + item.senses.length, 0);
  if (!total) {
    // 没东西可判：这条只留一句话，不该锁住工具栏（锁了就只能刷新页面才能再点别的）。
    panel.textContent = res.missing.length ? `没有可复判的词（${res.missing.length} 个查不到）` : '没有可复判的义项';
    return;
  }
  panelLock = true;
  syncSelection();

  const head = document.createElement('p');
  head.className = 'quiz-hint';
  const plan = estimate({ senses: total });
  head.textContent = `档位复判 ${res.items.length} 个词 / ${total} 条义项（每条三票，预计 ${plan.text}）：默认全勾；展开每条的依据能看每一步命中了什么。`;
  panel.append(head);

  const actions = document.createElement('div');
  actions.className = 'row';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'btn ghost';
  all.textContent = '全选';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'btn ghost';
  none.textContent = '全不选';
  // 清单摆好就自己开跑（与「重构」一致），不用再点一次；停过之后才露出「继续复判」补没跑到的。
  // 「取消」是整块收摊：在飞的投票一起中止，面板收掉，什么也不写回词表。
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'btn';
  more.textContent = '继续复判';
  more.hidden = true;
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'btn ghost';
  stop.textContent = '终止';
  stop.hidden = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = '取消';
  const status = document.createElement('span');
  status.className = 'save-state';
  actions.append(all, none, more, stop, cancel, status);
  panel.append(actions);

  const list = document.createElement('ul');
  list.className = 'preview';
  for (const item of res.items) {
    const group = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.covered === 0 ? '参考词表未收录' : `有 ${item.covered} 条参考档位`;
    const title = document.createElement('strong');
    title.textContent = item.word;
    group.append(title, tag);
    if (item.covered) group.append(document.createTextNode(levelSourceLine(item.referenceLevels).join(' · ')));
    list.append(group);
    item.senses.forEach((sense, i) => {
      const row = levelRow(item, sense, i);
      rows.push(row.api);
      list.append(row);
    });
  }
  panel.append(list);
  fitPreview(list);

  const commit = document.createElement('button');
  commit.type = 'button';
  commit.className = 'btn primary';
  commit.textContent = '确认写入';
  const done = document.createElement('span');
  done.className = 'save-state';
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(commit, done);
  panel.append(foot);

  const chosen = () => rows.filter((r) => r.pick.checked && r.to !== undefined);
  all.addEventListener('click', () => {
    for (const r of rows) if (!r.pick.disabled) r.pick.checked = true;
  });
  none.addEventListener('click', () => {
    for (const r of rows) r.pick.checked = false;
  });

  // 「终止」只关连接：服务端跟着停掉还在跑的那些投票，已经跑完的结果原样留着；没跑的那些不记
  // r.to，所以停过之后「继续复判」会露出来，从它们接着跑。
  let controller = null;
  stop.addEventListener('click', () => {
    stop.disabled = true;
    status.textContent = '正在终止…';
    status.className = 'save-state';
    controller?.abort();
  });

  // 「取消」是整块收摊：在飞的投票一并中止，面板收掉、什么也不写回词表，工具栏那把锁随之解开。
  const closePanel = () => {
    controller?.abort();
    panel.hidden = true;
    panel.innerHTML = '';
    panelLock = false;
    syncSelection();
  };
  cancel.addEventListener('click', () => {
    closePanel();
    toast('已取消复判，未写盘');
  });

  const run = async () => {
    const targets = rows.filter((r) => r.to === undefined);
    if (!targets.length) return;
    more.hidden = true;
    stop.hidden = false;
    stop.disabled = false;
    // 复判投票也算一条批量：跑着的时候工具栏那几个按钮一起锁住。
    batchBusy = true;
    syncSelection();
    const meter = usageMeter();
    status.textContent = `正在复判 ${targets.length} 条义项，结果逐条回填（随时可终止）`;
    status.className = 'save-state';
    controller = new AbortController();
    let ok = 0;
    let stopped = false;
    // 收尾放在 finally：中间出什么事，这把锁与用量表都得放掉——它俩只在这一条路上复位。
    try {
      // 分块并发（√n 一块）：一次跑完几十条要等太久，全并发又会把上游打爆。
      // 一批 8 条一起问（D37）：固定那份规则只摊一次，比逐条问省得多。
      await voteAll(
        targets.map((r) => ({ r, target: { word: r.item.word, sense: r.index } })),
        {
          model: $('#model').value,
          signal: controller.signal,
          onRow: ({ r }, res2, error) => {
            const cut = controller.signal.aborted;
            if (!res2 || !res2.level) {
              // 被终止的那几条不算失败：它们只是还没跑，接着跑一轮就会补上。
              r.out.textContent = cut ? '已终止，还没跑' : `复判失败：${error ? error.message : '这条没定出档位'}`;
              r.out.className = cut ? 'save-state' : 'save-state bad';
              return;
            }
            r.to = res2.level;
            r.card.api.update({ level: res2.level, vote: res2, trace: res2.trace });
            r.move.textContent = `${r.level ? `#${r.level} → ` : ''}#${res2.level}`;
            r.out.textContent = `${res2.agree}/${res2.valid} 票一致${
              res2.votes.length > res2.valid ? `（${res2.votes.length - res2.valid} 票空）` : ''
            }`;
            if (res2.from !== res2.level) ok += 1;
          },
          onProgress: (n, total) => {
            status.textContent = `复判中 ${n}/${total}…${meter.text()}`;
            status.className = 'save-state';
          },
        },
      );
      stopped = controller.signal.aborted;
    } finally {
      meter.stop();
      controller = null;
      stop.hidden = true;
      batchBusy = false;
      syncSelection();
    }
    const left = targets.filter((r) => r.to === undefined).length;
    for (const r of targets) {
      if (r.to === undefined && !r.out.textContent) r.out.textContent = stopped ? '已终止，还没跑' : '没跑成';
    }
    done.textContent = '';
    if (!left) {
      status.textContent = `复判完成 · ${ok} 条档位会变`;
      status.className = 'save-state';
    } else {
      more.hidden = false;
      status.textContent = stopped
        ? `已终止 · 跑完 ${targets.length - left}/${targets.length}，还剩 ${left} 条`
        : `有 ${left} 条没跑成 · 再点一次重试`;
      status.className = stopped ? 'save-state' : 'save-state bad';
    }
  };
  more.addEventListener('click', () => run());

  commit.addEventListener('click', async () => {
    // 写回只改档位，而且只改**勾上的**那些（勾选框管的是写不写回去，不是跑不跑）：其余字段照抄
    // 清单里的现状，一次写盘一份备份。
    const picked = chosen();
    if (!picked.length) {
      done.textContent = '没有勾选任何有结果的义项';
      done.className = 'save-state bad';
      return;
    }
    const byWord = new Map();
    const changedWords = new Set();
    for (const r of picked) {
      if (!byWord.has(r.item.word)) {
        byWord.set(r.item.word, {
          word: r.item.word,
          checked: r.item.checked,
          senses: r.item.senses.map((s) => ({
            level: s.level,
            definition: s.definition,
            chinese: s.chinese,
            example: s.example,
            checked: s.checked,
          })),
        });
      }
      const item = byWord.get(r.item.word);
      if (item.senses[r.index].level !== r.to) changedWords.add(r.item.word);
      item.senses[r.index].level = r.to;
    }
    if (!changedWords.size) {
      done.textContent = '没有档位变化，未写盘';
      done.className = 'save-state';
      return;
    }
    const items = [...byWord.values()].filter((item) => changedWords.has(item.word));
    commit.disabled = true;
    done.textContent = '写入中…';
    done.className = 'save-state';
    try {
      const out = await api('/api/level/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      toast(`档位已重定 ${out.changed} 个词${out.backup ? ` · 备份 ${out.backup}` : ''}`);
      selected.clear();
      await loadEntries();
      if (!out.failed.length) {
        // 写完了就整块收摊：工具栏那把锁跟着解开，好接着跑下一批。
        closePanel();
        return;
      }
      done.textContent = `已写回 ${out.changed} 个词 · 跳过 ${out.failed.length}`;
      done.className = 'save-state bad';
    } catch (e) {
      done.textContent = `写入失败：${e.message}`;
      done.className = 'save-state bad';
    }
    // 还有没写成的：面板留着，按钮放行，好让你改完再写一次。
    commit.disabled = false;
  });

  // 摆好就开跑。
  run();
}

// 重构出的义项也要定档（D30）：模型只写释义与例句，档位逐条跑三次投票，带上参考档位。
// 义项内并发（√n）；定不出档位的那条留「待定」，并把这个词标成写不进。
// onSense(i, sense) 每定完一条就叫一次，调用方据此把那一条就地画出来（别攒到最后）。
async function withLevels(item, { onSense, onStep } = {}, signal) {
  const model = $('#model').value;
  // 释义跟表里一模一样的义项不重投票：档位是对着这条释义定的，释义没变、档位就不该变。
  // 实测（5 个词 13 条义项）85% 原样回来——这一条把重构那半边的定档开销砍掉八成多。
  const kept = item.senses.map((sense, i) => {
    const before = (item.current && item.current.senses && item.current.senses[i]) || null;
    return Boolean(before && before.level && before.definition && before.definition.trim() === (sense.definition || '').trim());
  });
  item.senses.forEach((sense, i) => {
    if (!kept[i]) return;
    sense.level = item.current.senses[i].level;
    sense.vote = null;
    sense.kept = true;
    if (onSense) onSense(i, sense);
  });
  // 剩下那些摆在一批里问（多数词 1–3 条，一趟就问完）。
  await voteAll(
    item.senses
      .map((sense, i) => ({
        i,
        sense,
        target: { word: item.word, definition: sense.definition, example: sense.example },
      }))
      .filter(({ i }) => !kept[i]),
    {
      model,
      signal,
      onRow: ({ i, sense }, out, error) => {
        if (out && out.level) {
          sense.level = out.level;
          sense.vote = out;
          sense.trace = out.trace;
        } else {
          sense.level = null;
          sense.vote = null;
          // 没定出档位：把原因留下（中止时别把浏览器那句原样端给用户）。
          sense.voteError = error
            ? signal?.aborted
              ? '已终止，还没定档'
              : error.message
            : '这条没给出合法档位';
        }
        if (onSense) onSense(i, sense);
      },
      onProgress: (done, total) => onStep && onStep(done, total),
    },
  );
  const missing = item.senses.findIndex((s) => !s.level);
  if (missing >= 0) {
    return {
      ...item,
      writeable: false,
      error: { code: 'noLevel', message: `第 ${missing + 1} 条义项没定出档位：${item.senses[missing].voteError || '没定出档位'}` },
    };
  }
  // 定完档就按新档位重探一次写盘：服务端那份探测是拿占位档位做的，这里才是最终结论。
  return { ...item, writeable: true, error: null };
}

// 正在跑的那一轮重构。点「终止」就是 abort 它：连接一关，服务端那边还没出结果的上游调用
// 也跟着停（server.js 里按连接断开中止），界面立刻解冻。
let refactorStop = null;
// 有没有一条批量在跑（重构或复判投票）。批量按钮的可用状态按它算。
let batchBusy = false;
// 重构 / 复判的清单面板都是单例，而且露面之后就一直摆在那儿（除非刷新页面）：摆着的时候
// 不许再起任何别的批量操作——再跑一轮会把自己那一格的面板重画一遍，上一轮的结果就没了。
let panelLock = false;

async function refactorSelection() {
  const words = [...selected];
  if (!words.length) return;
  const stop = $('#refactorStop');
  const out = $('#refactorProgress');
  batchBusy = true;
  syncSelection();
  stop.hidden = false;
  stop.disabled = false;
  // 用量表在 try **外面**声明：finally 是另一层作用域，看不见 try 里 const 出来的东西。这里踩过——
  // `meter.stop()` 一抛 ReferenceError，finally 后面的解锁就全不执行了，按钮一直灰到刷新页面。
  let meter = null;
  // 整段包在 try 里：中间任何一处抛（建面板、发请求、收尾），那几个按钮都必须解锁，
  // 不能就这么锁死到刷新页面为止。
  try {
    // 先把清单摆出来：这一步只读本地数据，不调模型，所以点下去立刻能看到 N 行。
    const panel = openRefactorPanel(
      words.map((word) => state.entries.find((e) => e.word === word) || { word, senses: [] }),
    );
    const slotOf = new Map(panel.slots.map((slot) => [slot.entry.word, slot]));
    meter = usageMeter();
    out.textContent = `正在重构 ${words.length} 个词（随时可终止）`;
    const controller = new AbortController();
    refactorStop = controller;
    const results = await inChunks(
      words,
      async (word) => {
        const slot = slotOf.get(word);
        slot.status('生成中…');
        const proposal = await api('/api/refactor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word, model: $('#model').value }),
          signal: controller.signal,
        });
        // 义项一回来就先摆出来（档位待定、查表命中已经有），随后每定完一条就地更新那一条。
        slot.showSenses(proposal.senses, proposal.trace);
        slot.status('定档中…');
        // 信号一路传进定档：一个词内部那几条义项也一起停，不留半截在跑。
        return withLevels(
          proposal,
          {
            onSense: (i, sense) => slot.updateSense(i, sense),
            onStep: (done, total) => slot.status(total > 1 ? `定档中 ${done}/${total}…` : '定档中…'),
          },
          controller.signal,
        );
      },
      (n, total) => {
        out.textContent = `重构并定档 ${n}/${total}…${meter.text()}`;
      },
      controller.signal,
    );
    const stopped = results.some((r) => r.aborted);
    const failed = new Set();
    for (const r of results) {
      if (r.ok) {
        slotOf.get(r.item).done(r.value);
        continue;
      }
      // 被终止的那些不算失败，别拿它们刷红条：连着的请求本来就是我们自己掐的。
      if (r.aborted) continue;
      failed.add(r.item);
      slotOf.get(r.item).status(`重构失败：${r.error.message}`, true);
      toast(`${r.item} 重构失败：${r.error.message}`, 'bad');
    }
    // 没跑到的行要说清是为什么，别让它们一直挂着「排队中」。
    for (const slot of panel.slots) {
      if (slot.item || failed.has(slot.entry.word)) continue;
      slot.status(stopped ? '已终止，还没跑' : '没跑成');
    }
    const ready = results.filter((r) => r.ok).length;
    panel.say(stopped ? '上一轮中途终止' : '');
    out.textContent = `${
      stopped
        ? `已终止 · 跑完 ${ready}/${words.length} 个词`
        : ready
          ? `本轮完成 ${ready}/${words.length}`
          : '没有拿到任何建议'
    }${meter.text()}`;
  } catch (e) {
    out.textContent = `重构失败：${e.message}`;
    toast(`重构失败：${e.message}`, 'bad');
  } finally {
    meter?.stop();
    refactorStop = null;
    batchBusy = false;
    stop.hidden = true;
    stop.disabled = false;
    syncSelection();
  }
}

async function levelPlan() {
  const words = [...selected];
  if (!words.length) return;
  const btn = $('#levelBtn');
  const out = $('#refactorProgress');
  btn.disabled = true;
  out.textContent = `查参考档位：${words.length} 个词…`;
  try {
    const res = await api('/api/level/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ words }),
    });
    out.textContent = res.missing.length ? `${res.missing.length} 个词在词表里查不到，已跳过` : '';
    renderLevelPanel(res);
  } catch (e) {
    out.textContent = `读取失败：${e.message}`;
  } finally {
    // 别在这里直接点亮：清单已经摆出来了，这个按钮得跟着 panelLock 一起关着。
    syncSelection();
  }
}

$('#selectAll').addEventListener('change', (ev) => {
  const on = ev.target.checked;
  for (const entry of visibleEntries()) {
    if (on) selected.add(entry.word);
    else selected.delete(entry.word);
  }
  renderList();
});
$('#clearSelection').addEventListener('click', () => {
  selected.clear();
  renderList();
});
$('#selectMode').addEventListener('click', () => setSelectionMode(!selectionMode));
$('#markChecked').addEventListener('click', () => markSelection(true));
$('#markUnchecked').addEventListener('click', () => markSelection(false));
$('#refactorBtn').addEventListener('click', refactorSelection);
$('#levelBtn').addEventListener('click', levelPlan);
$('#refactorStop').addEventListener('click', () => {
  if (!refactorStop) return;
  $('#refactorStop').disabled = true;
  $('#refactorProgress').textContent = '正在终止…';
  refactorStop.abort();
});

for (const id of ['#q', '#chapter', '#difficulty', '#mastery']) {
  $(id).addEventListener('input', renderList);
}

$('#reload').addEventListener('click', loadEntries);

export { renderList, loadEntries };
