// 词表面板：统计与侧栏概览、列表渲染、就地编辑、复选与批量操作、重构建议面板、
// 以及条目右下角的「考这个词」。

import { $, CEFR, state, api, toast, text, fillSelect, inChunks } from './core.js';
import { senseRow, readSenses, levelSourceLine, answerRow, levelVote } from './sense-ui.js';
import { levelCard } from './level-card.js';
import { settings } from './settings-panel.js';

function visibleEntries() {
  const q = $('#q').value.trim().toLowerCase();
  const chapter = $('#chapter').value;
  const difficulty = $('#difficulty').value;
  const mastery = $('#mastery').value;
  return state.entries.filter((e) => {
    if (chapter && e.chapter !== chapter) return false;
    if (difficulty && !(e.senses || []).some((s) => s.level === difficulty)) return false;
    if (mastery === 'checked' && !e.checked) return false;
    if (mastery === 'unchecked' && e.checked) return false;
    if (q && !text(e.word, e.definition, e.chinese).toLowerCase().includes(q)) return false;
    return true;
  });
}

function statTile(label, value, total, strong) {
  const box = document.createElement('div');
  box.className = strong ? 'stat ok' : 'stat';
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

function statBar(label, got, total) {
  const pct = total ? Math.round((got / total) * 100) : 0;
  const row = document.createElement('div');
  row.className = 'ov-row';
  const name = document.createElement('span');
  name.textContent = label;
  const num = document.createElement('b');
  num.textContent = `${got} / ${total}`;
  row.append(name, num);
  const track = document.createElement('div');
  track.className = 'ov-bar';
  const fill = document.createElement('i');
  fill.style.width = `${pct}%`;
  track.append(fill);
  return [row, track];
}

function renderStats() {
  const s = state.stats;
  const n = s.senses || { total: 0, checked: 0, unchecked: 0 };
  $('#stats').replaceChildren(
    statTile('词', s.total, null, false),
    statTile('条义项', n.total, null, false),
    statTile('已掌握词', s.checked, s.total, true),
    statTile('已掌握义项', n.checked, n.total, true),
    statTile('未掌握词', s.unchecked, s.total, false),
    statTile('未掌握义项', n.unchecked, n.total, false),
  );
  const head = document.createElement('div');
  head.className = 'ov-head';
  head.textContent = `共 ${s.total} 词 · ${n.total} 条义项`;
  $('#overview').replaceChildren(head, ...statBar('词', s.checked, s.total), ...statBar('义项', n.checked, n.total));
}

function editForm(entry, li) {
  const form = document.createElement('div');
  form.className = 'edit-form';

  const list = document.createElement('div');
  list.className = 'sense-list';
  const senses = entry.senses.map((s, i) =>
    i === 0 && !s.definition && !s.chinese && entry.definition
      ? { ...s, definition: entry.definition, checked: s.checked === undefined ? entry.checked : s.checked }
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
  mastery.title = '整词已掌握 = 每一行义项都勾上';
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
  li.className = text('entry', e.checked && 'checked');

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

  // 词头这行不标档位：档位是按义项来的，只写在义项行上。
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
  meta.textContent = [
    `### ${e.chapter}`,
    `${(e.senses || []).length} 条义项`,
    e.checked ? '整词已掌握' : '还有义项没掌握',
  ].join(' · ');
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
  // 按进度），中途被这里重新点亮就能起第二批，把前一批的「终止」顶掉。
  for (const id of ['#markChecked', '#markUnchecked', '#refactorBtn', '#levelBtn']) $(id).disabled = none || batchBusy;
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
  const btns = ['#markChecked', '#markUnchecked', '#refactorBtn'].map((id) => $(id));
  for (const b of btns) b.disabled = true;
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
    syncSelection();
  }
}

function refactorRow(item) {
  const li = document.createElement('li');
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'refactor-pick';
  pick.checked = item.writeable;
  pick.disabled = !item.writeable;
  pick.dataset.word = item.word;

  const word = document.createElement('strong');
  word.textContent = item.word;
  const move = document.createElement('span');
  move.className = 'def';
  const before = (item.current.senses || []).map((x) => x.level || '—').join(' / ') || '—';
  const after = item.senses.map((x) => x.level).join(' / ');
  move.textContent = `${before} → ${after}`;
  li.append(pick, word, move);

  const senses = document.createElement('div');
  senses.className = 'refactor-senses';
  for (const sense of item.senses) {
    const line = document.createElement('div');
    line.className = 'child';
    const tag = document.createElement('span');
    tag.className = 'tag';
    if (sense.level) tag.dataset.level = sense.level;
    tag.textContent = sense.level ? `#${sense.level}` : '#—';
    line.append(tag, document.createTextNode(` ${sense.definition}${sense.chinese ? ` · ${sense.chinese}` : ''} — ${sense.example}`));
    senses.append(line);
    // 定档依据跟着每条义项走，展开能看到逐步命中与五次投票。
    senses.append(levelCard({ level: sense.level, vote: sense.vote, trace: sense.trace, error: sense.voteError }));
  }
  li.append(senses);

  const notes = [];
  if (item.note) notes.push(item.note);
  if (notes.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = notes.join(' · ');
    li.append(hint);
  }
  if (!item.writeable) {
    const bad = document.createElement('div');
    bad.className = 'edit-msg bad';
    bad.textContent = `无法写盘：${item.error?.message || item.error?.code || '未知原因'}`;
    li.append(bad);
  }
  return li;
}

function renderRefactorPanel(items, { stopped = false } = {}) {
  const panel = $('#refactorPanel');
  panel.innerHTML = '';
  panel.hidden = false;
  if (!items.length) {
    panel.textContent = stopped
      ? '上一轮被终止时还没跑完任何一个词，再点一次「重构选中的词」就是了。'
      : '没有待确认的重构建议。';
    return;
  }
  const head = document.createElement('p');
  head.className = 'quiz-hint';
  head.textContent = `重构建议 ${items.length} 条 · 勾选后一次写盘，写盘前自动备份${
    stopped ? ' · 上一轮中途终止，这里只是已经跑完的那部分' : ''
  }`;
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
  const result = document.createElement('span');
  result.className = 'save-state';
  actions.append(all, none, apply, result);
  panel.append(actions);

  const list = document.createElement('ul');
  list.className = 'preview';
  for (const item of items) list.append(refactorRow(item));
  panel.append(list);

  all.addEventListener('click', () => {
    for (const box of panel.querySelectorAll('.refactor-pick')) if (!box.disabled) box.checked = true;
  });
  none.addEventListener('click', () => {
    for (const box of panel.querySelectorAll('.refactor-pick')) if (!box.disabled) box.checked = false;
  });
  apply.addEventListener('click', async () => {
    const chosen = [...panel.querySelectorAll('.refactor-pick:checked')].map((box) => box.dataset.word);
    if (!chosen.length) {
      result.textContent = '没有勾选任何词';
      result.className = 'save-state bad';
      return;
    }
    const payload = items
      .filter((item) => chosen.includes(item.word))
      .map((item) => ({ word: item.word, senses: item.senses, checked: item.checked }));
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
      renderRefactorPanel(items.filter((item) => !chosen.includes(item.word)));
    } catch (e) {
      result.textContent = `写入失败：${e.message}`;
      result.className = 'save-state bad';
      apply.disabled = false;
    }
  });
}

// 档位复判（任务三）：档位依据没写进 markdown，只有生成那一刻知道，所以能复判的近似判据是
// 「这个词在参考词表里有没有东西可依」——一点参考都没有的那些义项，当初的档位就是纯 AI 自判。
// 三次点击：出清单（不调模型）→ 对勾选的义项分块并发跑五次取平均 → 核对后一次写盘。
// 行的样子与「重构」那面板一致（同一套 li/preview 版式），但**不展示例句**：这一版只关心档位。
function levelRow(item, sense, index) {
  const li = document.createElement('li');
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'refactor-pick';
  pick.disabled = !sense.definition;
  // 档位现在一律由五票定（D30），所以默认全勾：复判是给旧数据按新口径重算一遍。
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
    panel.textContent = res.missing.length ? `没有可复判的词（${res.missing.length} 个查不到）` : '没有可复判的义项';
    return;
  }

  const head = document.createElement('p');
  head.className = 'quiz-hint';
  head.textContent = `档位复判 ${res.items.length} 个词 / ${total} 条义项：默认全勾，每条的档位都重新跑五次投票取平均（带查表命中的参考）；展开每条的依据能看每一步命中了什么。`;
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
  const vote = document.createElement('button');
  vote.type = 'button';
  vote.className = 'btn';
  vote.textContent = '开始复判';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'btn ghost';
  stop.textContent = '终止';
  stop.hidden = true;
  const status = document.createElement('span');
  status.className = 'save-state';
  actions.append(all, none, vote, stop, status);
  panel.append(actions);

  const list = document.createElement('ul');
  list.className = 'preview';
  for (const item of res.items) {
    const chapter = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.covered === 0 ? '参考词表未收录' : `有 ${item.covered} 条参考档位`;
    const title = document.createElement('strong');
    title.textContent = `### ${item.chapter} · ${item.word}`;
    chapter.append(title, tag);
    if (item.covered) chapter.append(document.createTextNode(levelSourceLine(item.referenceLevels).join(' · ')));
    list.append(chapter);
    item.senses.forEach((sense, i) => {
      const row = levelRow(item, sense, i);
      rows.push(row.api);
      list.append(row);
    });
  }
  panel.append(list);

  const confirm = document.createElement('input');
  confirm.type = 'checkbox';
  const confirmWrap = document.createElement('label');
  confirmWrap.className = 'row-inline';
  confirmWrap.append(confirm, document.createTextNode(' 已核对清单，确认写回词表'));
  const commit = document.createElement('button');
  commit.type = 'button';
  commit.className = 'btn primary';
  commit.textContent = '确认写入';
  commit.disabled = true;
  const done = document.createElement('span');
  done.className = 'save-state';
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(confirmWrap, commit, done);
  panel.append(foot);

  const chosen = () => rows.filter((r) => r.pick.checked);
  all.addEventListener('click', () => {
    for (const r of rows) if (!r.pick.disabled) r.pick.checked = true;
  });
  none.addEventListener('click', () => {
    for (const r of rows) r.pick.checked = false;
  });

  // 「终止」只关连接：服务端跟着停掉还在跑的那些投票，已经跑完的结果原样留着。
  // 没跑的那些不记 r.to，所以再点一次（按钮这时写着「继续复判」）就从它们接着跑。
  let controller = null;
  stop.addEventListener('click', () => {
    stop.disabled = true;
    status.textContent = '正在终止…';
    status.className = 'save-state';
    controller?.abort();
  });

  vote.addEventListener('click', async () => {
    const targets = chosen().filter((r) => r.to === undefined);
    if (!targets.length) {
      status.textContent = '没有勾选待复判的义项';
      status.className = 'save-state bad';
      return;
    }
    vote.disabled = true;
    stop.hidden = false;
    stop.disabled = false;
    // 复判投票也算一条批量：跑着的时候工具栏那几个按钮一起锁住。
    batchBusy = true;
    syncSelection();
    controller = new AbortController();
    let ok = 0;
    // 分块并发（√n 一块）：一次跑完几十条要等太久，全并发又会把上游打爆。
    const results = await inChunks(
      targets,
      async (r) => {
        try {
          const res2 = await api('/api/level/vote', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ word: r.item.word, sense: r.index, model: $('#model').value }),
            signal: controller.signal,
          });
          r.to = res2.level;
          r.card.api.update({ level: res2.level, vote: res2, trace: res2.trace });
          r.move.textContent = `${r.level ? `#${r.level} → ` : ''}#${res2.level}`;
          r.out.textContent = `${res2.agree}/${res2.valid} 票一致${res2.valid < 5 ? `（${5 - res2.valid} 票空）` : ''}`;
          if (res2.from !== res2.level) ok += 1;
        } catch (e) {
          // 被终止的那几条不算失败：它们只是还没跑，重开一轮就会补上。
          const cut = e.name === 'AbortError' || e.aborted;
          r.out.textContent = cut ? '已终止，还没跑' : `复判失败：${e.message}`;
          r.out.className = cut ? 'save-state' : 'save-state bad';
        }
      },
      (n, total) => {
        status.textContent = `复判中 ${n}/${total}…`;
        status.className = 'save-state';
      },
      controller.signal,
    );
    controller = null;
    stop.hidden = true;
    vote.disabled = false;
    batchBusy = false;
    syncSelection();
    const stopped = results.some((r) => r.aborted);
    const left = targets.filter((r) => r.to === undefined).length;
    for (const r of targets) {
      if (r.to === undefined && !r.out.textContent) r.out.textContent = stopped ? '已终止，还没跑' : '没跑成';
    }
    done.textContent = '';
    vote.textContent = left ? '继续复判' : '开始复判';
    if (!left) {
      status.textContent = `复判完成 · ${ok} 条档位会变`;
      status.className = 'save-state';
    } else if (stopped) {
      status.textContent = `已终止 · 跑完 ${targets.length - left}/${targets.length}，还剩 ${left} 条`;
      status.className = 'save-state';
    } else {
      status.textContent = `有 ${left} 条没跑成 · 再点一次重试`;
      status.className = 'save-state bad';
    }
  });

  confirm.addEventListener('change', () => {
    commit.disabled = !confirm.checked;
  });

  commit.addEventListener('click', async () => {
    // 写回只改档位：其余字段照抄清单里的现状，一次写盘一份备份。
    const byWord = new Map();
    const changedWords = new Set();
    for (const r of rows) {
      if (r.to === undefined) continue;
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
      done.textContent = `已写回 ${out.changed} 个词${out.failed.length ? ` · 跳过 ${out.failed.length}` : ''}${out.backup ? ` · 备份 ${out.backup}` : ''}`;
      toast(`档位已重定 ${out.changed} 个词${out.backup ? ` · 备份 ${out.backup}` : ''}`);
      selected.clear();
      await loadEntries();
    } catch (e) {
      commit.disabled = false;
      done.textContent = `写入失败：${e.message}`;
      done.className = 'save-state bad';
    }
  });
}

// 重构出的义项也要定档（D30）：模型只写释义与例句，档位逐条跑五次投票，带上参考档位。
// 条目内分块并发（√n 一块）；定不出档位的那条留「待定」，并把这个词标成写不进。
async function withLevels(item, onStep, signal) {
  const model = $('#model').value;
  const results = await inChunks(
    item.senses,
    async (sense) => {
      try {
        const out = await levelVote({
          word: item.word,
          definition: sense.definition,
          example: sense.example,
          model,
        }, signal);
        sense.level = out.level;
        sense.vote = out;
        sense.trace = out.trace;
      } catch (e) {
        sense.level = null;
        sense.vote = null;
        // 中止时 fetch 抛的是浏览器自己那句「signal is aborted without reason」，别原样端给用户。
        sense.voteError = signal?.aborted ? '已终止，还没定档' : e.message;
      }
    },
    (done, total) => onStep && onStep(done, total),
    signal,
  );
  // 没轮到的那些义项一条票都没投（catch 都没进），别让下面把「五票无效」当成结论写出去。
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].aborted && !item.senses[i].level) item.senses[i].voteError = '已终止，还没定档';
  }
  const missing = item.senses.findIndex((s) => !s.level);
  if (missing >= 0) {
    return {
      ...item,
      writeable: false,
      error: { code: 'noLevel', message: `第 ${missing + 1} 条义项没定出档位：${item.senses[missing].voteError || '五票无效'}` },
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

async function refactorSelection() {
  const words = [...selected];
  if (!words.length) return;
  const stop = $('#refactorStop');
  const out = $('#refactorProgress');
  batchBusy = true;
  syncSelection();
  stop.hidden = false;
  stop.disabled = false;
  const controller = new AbortController();
  refactorStop = controller;
  const results = await inChunks(
    words,
    async (word) => {
      const proposal = await api('/api/refactor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word, model: $('#model').value }),
        signal: controller.signal,
      });
      // 信号一路传进定档：一个词内部那几条义项也一起停，不留半截在跑。
      return withLevels(proposal, null, controller.signal);
    },
    (n, total) => {
      out.textContent = `重构并定档 ${n}/${total}…`;
    },
    controller.signal,
  );
  refactorStop = null;
  batchBusy = false;
  stop.hidden = true;
  stop.disabled = false;
  syncSelection();
  // 被终止的那些不算失败，别拿它们刷红条：连着的请求本来就是我们自己掐的。
  for (const r of results) {
    if (!r.ok && !r.aborted) toast(`${r.item} 重构失败：${r.error.message}`, 'bad');
  }
  const items = results.filter((r) => r.ok).map((r) => r.value);
  const stopped = results.some((r) => r.aborted);
  // 被终止时正在定档的那几个词会带着「还没定档」回来：留着只会多出一行写不进去的红字，
  // 重跑一次本来就得把它们整个重做，所以只留下定档完整的那些。
  const shown = stopped ? items.filter((item) => item.writeable) : items;
  out.textContent = stopped
    ? `已终止 · 跑完 ${shown.length}/${words.length} 个词`
    : items.length
      ? `本轮完成 ${items.length}/${words.length}`
      : '没有拿到任何建议';
  // 哪怕一个词都没跑成也要画：不画的话上一轮那份清单会留在页面上，点「确认写入」写出去的是
  // 过期的东西。
  renderRefactorPanel(shown, { stopped });
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
    btn.disabled = false;
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
