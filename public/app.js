const $ = (sel) => document.querySelector(sel);
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const state = { entries: [], stats: null };

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body?.error?.message || `HTTP ${res.status}`);
    e.code = body?.error?.code;
    e.status = res.status;
    e.details = body?.error?.details;
    throw e;
  }
  return body;
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

function text(...parts) {
  return parts.filter(Boolean).join(' ');
}

function fillSelect(sel, values, current) {
  sel.innerHTML = '';
  if (sel.dataset.noEmpty !== '1') {
    const all = document.createElement('option');
    all.value = '';
    all.textContent = sel.dataset.allLabel || '全部';
    sel.append(all);
  }
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.append(o);
  }
  if (current && values.includes(current)) sel.value = current;
}

function visibleEntries() {
  const q = $('#q').value.trim().toLowerCase();
  const chapter = $('#chapter').value;
  const difficulty = $('#difficulty').value;
  const mastery = $('#mastery').value;
  return state.entries.filter((e) => {
    if (chapter && e.chapter !== chapter) return false;
    if (difficulty && e.difficulty !== difficulty) return false;
    if (mastery === 'checked' && !e.checked) return false;
    if (mastery === 'unchecked' && e.checked) return false;
    if (q && !text(e.word, e.definition, e.chinese).toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderStats() {
  const s = state.stats;
  const n = s.senses || { total: 0, checked: 0, unchecked: 0 };
  $('#stats').textContent =
    `共 ${s.total} 词 · ${n.total} 条义项 ｜ 已掌握 ${s.checked} 词 / ${n.checked} 义项 · ` +
    `未掌握 ${s.unchecked} 词 / ${n.unchecked} 义项`;
}

function levelSelect(current) {
  const sel = document.createElement('select');
  for (const level of CEFR) {
    const o = document.createElement('option');
    o.value = level;
    o.textContent = level;
    sel.append(o);
  }
  sel.value = current && CEFR.includes(current) ? current : CEFR[2];
  return sel;
}

function senseRow(entry, sense, { withCheck = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sense-item';
  const row = document.createElement('div');
  row.className = 'sense-row';
  const level = levelSelect(sense.level);
  const def = document.createElement('input');
  def.className = 'sense-def-input';
  def.value = sense.definition || '';
  def.placeholder = '这条义项的释义（可留空）';
  const ex = document.createElement('input');
  ex.className = 'sense-ex-input';
  ex.value = sense.example || '';
  ex.placeholder = '例句（必填）';
  const zh = document.createElement('input');
  zh.className = 'sense-zh-input';
  zh.value = sense.chinese || '';
  zh.placeholder = '中文（可选）';

  const check = withCheck ? document.createElement('input') : null;
  if (check) {
    check.type = 'checkbox';
    check.className = 'sense-check';
    check.checked = Boolean(sense.checked);
    check.title = '这一条义项是否已掌握';
  }

  const gen = document.createElement('button');
  gen.type = 'button';
  gen.className = 'skip-btn';
  gen.textContent = '生成例句';
  const out = document.createElement('span');
  out.className = 'gen-example';
  gen.addEventListener('click', async () => {
    gen.disabled = true;
    out.textContent = '生成中…';
    try {
      const body = await api('/api/example', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word: entry.word, definition: def.value, model: $('#model').value }),
      });
      ex.value = body.example;
      out.textContent = '已填入，保存后生效';
    } catch (e) {
      out.textContent = `生成失败：${e.message}`;
    } finally {
      gen.disabled = false;
    }
  });

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'delete-btn';
  drop.textContent = '删除';
  drop.addEventListener('click', () => wrap.remove());

  const basis = document.createElement('div');
  basis.className = 'hint sense-basis';

  row.api = { level, def, ex, zh, basis, check };
  if (check) row.append(check);
  row.append(level, def, ex, zh, gen, drop, out);
  wrap.append(row, basis);
  wrap.api = row.api;
  return wrap;
}

function relatedLabel(rel) {
  return `${rel.form}（${rel.via === 'root' ? '词根推测' : '词形归并'}） ${rel.level} · ${rel.source}`;
}

function senseBasisNote(sense, referenceLevels) {
  const refs = (referenceLevels?.levels || []).map((l) => `${l.source}${l.pos ? ` ${l.pos}` : ''} ${l.level}`);
  for (const rel of referenceLevels?.related || []) {
    refs.push(relatedLabel(rel));
  }
  if (sense.levelBasis === 'reference') return `查表定档：${refs.join(' · ') || '参考词表'}`;
  return refs.length ? `AI 判断（参考：${refs.join(' · ')}）` : 'AI 判断（词表未收录）';
}

function readSenses(list) {
  return [...list.querySelectorAll('.sense-row')].map((row) => ({
    level: row.api.level.value,
    definition: row.api.def.value.trim() || null,
    chinese: row.api.zh.value.trim() || null,
    example: row.api.ex.value.trim(),
    ...(row.api.check ? { checked: row.api.check.checked } : {}),
  }));
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

  const add = document.createElement('button');
  add.type = 'button';
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
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '保存';

  cancel.addEventListener('click', () => li.replaceChildren(entryNode(entry)));
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

function targetOf(entry, index) {
  const senses = entry.senses;
  const i = index >= 0 && index < senses.length ? index : 0;
  const sense = senses[i];
  return {
    word: entry.word,
    sense: i,
    count: senses.length,
    chapter: entry.chapter,
    level: sense.level,
    definition: sense.definition,
    chinese: sense.chinese ?? null,
    example: sense.example,
    checked: Boolean(sense.checked),
  };
}

function firstOpenSense(entry) {
  const i = entry.senses.findIndex((s) => !s.checked);
  return i < 0 ? 0 : i;
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

  if (e.difficulty) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.dataset.level = e.difficulty;
    tag.textContent = `#${e.difficulty}`;
    head.append(tag);
  }

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

  if (!selectionMode) head.append(edit, del);

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

    if (senses.length > 1 && sense.level) {
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
    row.append(document.createTextNode(sense.example || '缺例句'));
    li.append(row);
  });
  return li;
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
    fillSelect($('#examChapter'), chapterList, $('#examChapter').value);
    fillSelect($('#difficulty'), CEFR, $('#difficulty').value);
    fillSelect($('#quizDifficulty'), CEFR, $('#quizDifficulty').value);
    fillSelect($('#examDifficulty'), CEFR, $('#examDifficulty').value);
    renderStats();
    renderList();
  } catch (e) {
    toast(e.message, 'bad');
    $('#stats').textContent = `读取失败：${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function fillModelSelect(models, current) {
  const sel = $('#model');
  sel.innerHTML = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    sel.append(o);
  }
  sel.value = current;
}

function activateTab(panel) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.panel === panel);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${panel}`);
}

function parseWords(text) {
  const seen = new Set();
  const out = [];
  for (const part of text.split(/[,;\n]+/)) {
    const w = part.replace(/\s+/g, ' ').trim();
    if (w && !seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase());
      out.push(w);
    }
  }
  return out;
}

function field(label, control) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function makeCard(word) {
  const card = document.createElement('article');
  card.className = 'card loading';

  const title = document.createElement('strong');
  title.textContent = word;
  const status = document.createElement('span');
  status.className = 'card-status';
  status.textContent = '生成中…';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(title, status);

  const sensesBox = document.createElement('div');
  sensesBox.className = 'sense-list';
  const addSense = document.createElement('button');
  addSense.type = 'button';
  addSense.className = 'skip-btn';
  addSense.textContent = '+ 添加义项';
  addSense.addEventListener('click', () => sensesBox.append(senseRow({ word }, { level: null, definition: '', example: '' })));
  const note = document.createElement('span');
  note.className = 'hint';
  const senseTools = document.createElement('div');
  senseTools.className = 'sense-actions';
  senseTools.append(addSense, note);

  const write = document.createElement('button');
  write.type = 'button';
  write.textContent = '写入';
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.textContent = '定位到该条';
  locate.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.append(locate, write);

  const body = document.createElement('div');
  body.className = 'card-body';
  body.append(sensesBox, senseTools, actions);
  card.append(head, body);

  card.api = { word, sensesBox, addSense, note, status, write, locate };
  write.addEventListener('click', () => commitCard(card));
  locate.addEventListener('click', () => locateWord(word));
  return card;
}

function applyDraft(card, d) {
  const a = card.api;
  a.sensesBox.innerHTML = '';
  for (const sense of d.senses || []) {
    const row = senseRow({ word: a.word }, sense);
    row.api.basis.textContent = senseBasisNote(sense, d.referenceLevels);
    a.sensesBox.append(row);
  }
  a.note.textContent = d.note || '';
  a.status.textContent = '';
  card.classList.remove('loading');
}

async function draftWords() {
  const words = parseWords($('#words').value);
  const existing = new Set([...document.querySelectorAll('#cards .card')].map((c) => c.api.word.toLowerCase()));
  const fresh = words.filter((w) => !existing.has(w.toLowerCase()));
  $('#addHint').textContent = `${fresh.length} 个待生成${words.length - fresh.length ? `，${words.length - fresh.length} 个已有卡片` : ''}`;
  if (!fresh.length) return;

  const btn = $('#draftBtn');
  btn.disabled = true;
  try {
    for (const word of fresh) {
      const card = makeCard(word);
      $('#cards').append(card);
      try {
        const d = await api('/api/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word, withChinese: $('#withChinese').checked, model: $('#model').value }),
        });
        applyDraft(card, d);
      } catch (e) {
        card.classList.remove('loading');
        card.classList.add('bad');
        card.api.status.textContent = `生成失败：${e.message}`;
      }
    }
  } finally {
    btn.disabled = false;
  }
}

async function commitCard(card, quiet) {
  const a = card.api;
  const senses = readSenses(a.sensesBox);
  if (!senses.length) {
    a.status.textContent = '至少留一条义项';
    return '至少留一条义项';
  }
  if (!senses[0].definition) {
    a.status.textContent = '第一条义项要填释义';
    return '第一条义项要填释义';
  }
  const blank = senses.findIndex((s) => !s.example);
  if (blank >= 0) {
    a.status.textContent = `第 ${blank + 1} 条义项缺例句`;
    return `第 ${blank + 1} 条义项缺例句`;
  }
  const empty = senses.findIndex((s) => !s.definition);
  if (empty >= 0) {
    a.status.textContent = `第 ${empty + 1} 条义项缺释义`;
    return `第 ${empty + 1} 条义项缺释义`;
  }

  a.write.disabled = true;
  a.status.textContent = '写入中…';
  try {
    const res = await api('/api/commit-add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: a.word, checked: false, senses }),
    });
    card.classList.add('done');
    a.status.textContent = `已写入 · 落在 ### ${res.entry.chapter} · 备份 ${res.backup}`;
    for (const el of a.sensesBox.querySelectorAll('input, select, button')) el.disabled = true;
    a.addSense.disabled = true;
    a.write.hidden = true;
    if (!quiet) {
      toast(`${a.word} 已写入 ${res.entry.chapter} 章`);
      await loadEntries();
    }
    return true;
  } catch (e) {
    a.write.disabled = false;
    a.status.textContent = `写入失败：${e.message}`;
    return `写入失败：${e.message}`;
  }
}

async function commitAllCards() {
  const targets = [...document.querySelectorAll('#cards .card')].filter(
    (c) => !c.classList.contains('done') && !c.classList.contains('loading'),
  );
  if (!targets.length) {
    toast('没有待写入的卡片');
    return;
  }
  const btn = $('#commitAll');
  btn.disabled = true;
  let written = 0;
  const skipped = [];
  for (const card of targets) {
    const a = card.api;
    const res = await commitCard(card, true);
    if (res === true) written += 1;
    else skipped.push(`${a.word}（${typeof res === 'string' ? res : '未写入'}）`);
  }
  btn.disabled = false;
  if (written) await loadEntries();
  toast(`已写入 ${written} 条${skipped.length ? ` · 未写入 ${skipped.length} 条：${skipped.join('、')}` : ''}`, skipped.length ? 'bad' : 'ok');
}

function locateWord(word) {
  activateTab('fill');
  $('#chapter').value = '';
  $('#difficulty').value = '';
  $('#mastery').value = '';
  $('#q').value = word;
  renderList();
  document.querySelector('#list li')?.scrollIntoView({ block: 'center' });
}

async function pickRandom() {
  const params = new URLSearchParams({ count: '1' });
  if ($('#onlyUnchecked').checked) params.set('onlyUnchecked', '1');
  if ($('#quizDifficulty').value) params.set('difficulty', $('#quizDifficulty').value);
  try {
    const res = await api(`/api/random?${params}`);
    if (!res.targets.length) {
      toast('没有符合条件的义项', 'bad');
      return;
    }
    startQuiz(res.targets[0]);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

function startFromWord() {
  const raw = $('#quizWord').value.trim().toLowerCase();
  if (!raw) return;
  const found = state.entries.find((e) => e.word.toLowerCase() === raw);
  if (!found) {
    toast(`词表里没有 ${raw}`, 'bad');
    return;
  }
  startQuiz(targetOf(found, firstOpenSense(found)));
}

function startQuiz(target) {
  const card = $('#quizCard');
  card.hidden = false;
  card.innerHTML = '';

  const meta = document.createElement('span');
  meta.className = 'card-status';
  const title = document.createElement('strong');
  title.textContent = target.word;
  const head = document.createElement('div');
  head.className = 'quiz-head';
  head.append(title, meta);

  const hint = document.createElement('p');
  hint.className = 'quiz-hint';
  hint.textContent =
    target.count > 1
      ? `表内释义已遮住；这是第 ${target.sense + 1}/${target.count} 条义项，例句会显示出来供你辨认。`
      : '表内释义已遮住；例句会显示出来，供你辨别是哪个义项。';

  const def = document.createElement('textarea');
  def.rows = 2;
  def.placeholder = '用英文写释义（英英）';
  const ex = document.createElement('textarea');
  ex.rows = 2;
  ex.placeholder = '用这个词造一个句子（可留空，留空则只判释义）';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = '提交判定';
  const verdict = document.createElement('div');
  verdict.className = 'verdict';
  verdict.hidden = true;

  const tools = document.createElement('div');
  tools.className = 'row';
  tools.append(exampleRow(target.word, target.example, target.sense));
  if (target.count > 1) {
    const pick = document.createElement('select');
    (state.entries.find((e) => e.word === target.word)?.senses || []).forEach((s, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `第 ${i + 1} 条义项${s.level ? ` · #${s.level}` : ''}${s.checked ? ' · 已掌握' : ''}`;
      pick.append(o);
    });
    pick.value = String(target.sense);
    pick.addEventListener('change', () => {
      const entry = state.entries.find((e) => e.word === target.word);
      if (entry) startQuiz(targetOf(entry, Number(pick.value)));
    });
    tools.append(pick);
  }

  card.append(head, hint, tools, field('我的释义', def), field('我的例句（可选）', ex), submit, verdict);
  submit.addEventListener('click', () => judgeQuiz({ target, def, ex, submit, verdict, meta }));
  syncQuizMeta({ target, meta });
}

function syncQuizMeta({ target, meta }) {
  const bits = [`### ${target.chapter}`];
  if (target.level) bits.push(`#${target.level}`);
  if (target.count > 1) bits.push(`第 ${target.sense + 1}/${target.count} 条义项`);
  bits.push(target.checked ? '这条已勾选' : '未勾选');
  meta.textContent = bits.join(' · ');
}

async function judgeQuiz(ui) {
  ui.submit.disabled = true;
  ui.verdict.hidden = true;
  try {
    const res = await api('/api/judge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        word: ui.target.word,
        sense: ui.target.sense,
        userDefinition: ui.def.value,
        userExample: ui.ex.value,
        lang: $('#quizLang').value,
      }),
    });
    await renderVerdict(ui, res);
  } catch (e) {
    ui.verdict.hidden = false;
    ui.verdict.className = 'verdict bad';
    ui.verdict.textContent = `判定失败：${e.message}`;
  } finally {
    ui.submit.disabled = false;
  }
}

async function renderVerdict(ui, res) {
  const v = ui.verdict;
  v.innerHTML = '';
  v.hidden = false;
  v.className = `verdict ${res.pass ? 'pass' : 'fail'}`;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = res.pass ? 'PASS' : 'FAIL';
  const reason = document.createElement('p');
  reason.textContent = res.reason || (res.pass ? '判定通过。' : '判定未通过。');
  v.append(badge, reason);

  if (res.suggestion) {
    const sug = document.createElement('p');
    sug.className = 'suggestion';
    sug.textContent = `建议：${res.suggestion}`;
    v.append(sug);
  }

  if (res.pass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const label = () => {
      btn.textContent = ui.target.checked ? '这条义项已勾选 · 撤销' : '勾选为已掌握';
    };
    label();
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const target = !ui.target.checked;
      try {
        await api('/api/set-checked', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: ui.target.word, sense: ui.target.sense, checked: target }),
        });
        ui.target.checked = target;
        syncQuizMeta(ui);
        label();
        btn.disabled = false;
        const suffix = ui.target.count > 1 ? ` 第 ${ui.target.sense + 1} 条义项` : '';
        toast(target ? `${ui.target.word}${suffix} 已勾选` : `${ui.target.word}${suffix} 已取消勾选`);
        await loadEntries();
      } catch (e) {
        btn.disabled = false;
        toast(e.message, 'bad');
      }
    });
    v.append(btn);
  }

  const stored = document.createElement('p');
  stored.className = 'stored';
  stored.textContent = `表内：${ui.target.definition}${ui.target.chinese ? ` · ${ui.target.chinese}` : ''}${
    ui.target.example ? ` · ${ui.target.example}` : ''
  }`;
  v.append(stored);

  if (res.pass) toast(`${ui.target.word} 判定通过`);
}

const selected = new Set();

function syncSelection() {
  const shown = visibleEntries();
  const inView = shown.filter((e) => selected.has(e.word)).length;
  $('#selectedCount').textContent = selected.size
    ? `已选 ${selected.size} 个词${inView !== selected.size ? `（当前筛选里 ${inView} 个）` : ''}`
    : '未选中任何词';
  const none = selected.size === 0;
  for (const id of ['#markChecked', '#markUnchecked', '#refactorBtn']) $(id).disabled = none;
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
    tag.dataset.level = sense.level;
    tag.textContent = `#${sense.level}`;
    line.append(tag, document.createTextNode(` ${sense.definition}${sense.chinese ? ` · ${sense.chinese}` : ''} — ${sense.example}`));
    senses.append(line);
  }
  li.append(senses);

  const refs = (item.referenceLevels?.levels || []).map((l) => `${l.source}${l.pos ? ` ${l.pos}` : ''} ${l.level}`);
  for (const rel of item.referenceLevels?.related || []) {
    refs.push(relatedLabel(rel));
  }
  const notes = [];
  if (item.note) notes.push(item.note);
  if (refs.length) notes.push(`参考档位：${refs.join(' · ')}`);
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

function renderRefactorPanel(items) {
  const panel = $('#refactorPanel');
  panel.innerHTML = '';
  panel.hidden = false;
  if (!items.length) {
    panel.textContent = '没有待确认的重构建议。';
    return;
  }
  const head = document.createElement('p');
  head.className = 'quiz-hint';
  head.textContent = `重构建议 ${items.length} 条 · 勾选后一次写盘，写盘前自动备份`;
  panel.append(head);

  const actions = document.createElement('div');
  actions.className = 'row';
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = '全选';
  const none = document.createElement('button');
  none.type = 'button';
  none.textContent = '全不选';
  const apply = document.createElement('button');
  apply.type = 'button';
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

async function refactorSelection() {
  const words = [...selected];
  if (!words.length) return;
  const btn = $('#refactorBtn');
  const out = $('#refactorProgress');
  btn.disabled = true;
  const items = [];
  for (let i = 0; i < words.length; i++) {
    out.textContent = `重构中 ${i + 1}/${words.length}：${words[i]}`;
    try {
      items.push(
        await api('/api/refactor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: words[i], model: $('#model').value }),
        }),
      );
    } catch (e) {
      toast(`${words[i]} 重构失败：${e.message}`, 'bad');
    }
  }
  out.textContent = items.length ? `本轮完成 ${items.length}/${words.length}` : '没有拿到任何建议';
  btn.disabled = false;
  if (items.length) renderRefactorPanel(items);
}

const THEME_KEY = 'vocab-theme';
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
let settings = null;
let availableModels = [];
let keyNames = [];

function modelLabel(model) {
  let host = '';
  try {
    host = new URL(model.baseUrl).host;
  } catch {
    host = '未填接入点';
  }
  return `${model.name}（${host} · 密钥 ${model.keyName}）`;
}

function resolvedTheme(mode) {
  if (mode === 'dark' || mode === 'light') return mode;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {}
  document.documentElement.dataset.theme = resolvedTheme(mode);
  $('#themeBtn').textContent = `主题·${THEME_LABEL[mode] || THEME_LABEL.auto}`;
}

function setSaveState(message, bad) {
  const el = $('#saveState');
  el.textContent = message;
  el.className = bad ? 'save-state bad' : 'save-state';
}

async function saveSettings(patch, notice) {
  setSaveState('保存中…');
  try {
    const body = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    settings = body.settings;
    applyTheme(settings.theme);
    syncSettingDefaults();
    setSaveState(`已保存 ${new Date().toLocaleTimeString()}`);
    if (notice) toast(notice);
    return true;
  } catch (e) {
    setSaveState(`保存失败：${e.message}`, true);
    toast(e.message, 'bad');
    return false;
  }
}

function syncSettingDefaults() {
  $('#quizLang').value = settings.lang;
  $('#setTheme').value = settings.theme;
  $('#setLang').value = settings.lang;
  fillSelect($('#model'), availableModels, settings.model || $('#model').value);
  fillSelect($('#setModel'), availableModels);
  $('#setModel').value = settings.model || '';
}

function renderModelChips() {
  const box = $('#modelList');
  box.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = settings.model ? `默认模型：${settings.model}` : '未设置默认模型';
  box.append(label);
  for (const m of settings.extraModels) {
    const chip = document.createElement('span');
    chip.className = 'already';
    chip.textContent = modelLabel(m);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      settings.extraModels = settings.extraModels.filter((x) => x.name !== m.name);
      availableModels = [...new Set(settings.extraModels.map((x) => x.name))];
      renderModelChips();
      syncSettingDefaults();
      setSaveState('有未保存的改动');
    });
    chip.append(' ', remove);
    box.append(chip);
  }
}

async function loadSettings() {
  try {
    const body = await api('/api/settings');
    settings = body.settings;
    availableModels = body.models;
    keyNames = body.keyNames || [];
    fillModelSelect(body.models, settings.model);
    $('#keyFlag').hidden = Boolean(body.hasKey);
    fillSelect($('#newModelKey'), keyNames, keyNames[0]);
    $('#promptEntry').value = settings.prompts.entry || '';
    $('#promptJudge').value = settings.prompts.judge || '';
    $('#contractEntry').textContent = body.contracts.entry;
    $('#contractJudge').textContent = body.contracts.judge;
    applyTheme(settings.theme);
    syncSettingDefaults();
    renderModelChips();
    setSaveState(body.settingsError ? 'settings.json 读取失败，已按默认值显示' : '');
  } catch (e) {
    setSaveState(`读取设置失败：${e.message}`, true);
  }
}

function settingsFromForm() {
  return {
    theme: $('#setTheme').value,
    lang: $('#setLang').value,
    model: $('#setModel').value || null,
    extraModels: settings.extraModels,
    prompts: {
      entry: $('#promptEntry').value.trim() || null,
      judge: $('#promptJudge').value.trim() || null,
    },
  };
}

async function cycleTheme() {
  const order = ['light', 'dark', 'auto'];
  const cur = settings ? settings.theme : localStorage.getItem(THEME_KEY) || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyTheme(next);
  if (settings) await saveSettings({ theme: next });
}

function examScope() {
  return {
    chapter: $('#examChapter').value,
    difficulty: $('#examDifficulty').value,
    mastery: $('#examMastery').value,
    q: $('#examQ').value.trim(),
  };
}

async function replaceExample(word, senseIndex, example, label, btn) {
  const entry = state.entries.find((e) => e.word === word);
  if (!entry) {
    toast(`找不到 ${word}，无法替换`, 'bad');
    return;
  }
  const rows = entry.senses.map((s, i) => ({
    level: s.level || entry.difficulty,
    definition: s.definition,
    chinese: s.chinese,
    example: i === senseIndex ? example : s.example,
    checked: s.checked === undefined ? entry.checked : s.checked,
  }));
  if (rows.some((r) => !r.level)) {
    toast(`${word} 还有义项没定难度，请在词表里先补齐再替换例句`, 'bad');
    return;
  }
  btn.disabled = true;
  try {
    await api('/api/commit-edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word, checked: entry.checked, senses: rows }),
    });
    label.textContent = `表内例句：${example}`;
    toast(`${word} 的例句已替换`);
    await loadEntries();
  } catch (e) {
    btn.disabled = false;
    toast(e.message, 'bad');
  }
}

function exampleRow(word, shown, senseIndex = 0) {
  const wrap = document.createElement('div');
  wrap.className = 'example-tools';
  const label = document.createElement('span');
  label.className = 'example-line';
  label.textContent = `表内例句：${shown || '（暂无）'}`;

  const out = document.createElement('span');
  out.className = 'gen-example';

  const gen = document.createElement('button');
  gen.type = 'button';
  gen.textContent = '生成新例句';
  gen.addEventListener('click', async () => {
    gen.disabled = true;
    out.textContent = '生成中…';
    try {
      const { example } = await api('/api/example', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word, model: $('#model').value }),
      });
      out.textContent = `新例句：${example}`;
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = '替换表内例句';
      use.addEventListener('click', () => replaceExample(word, senseIndex, example, label, use));
      out.append(' ', use);
    } catch (e) {
      out.textContent = `生成失败：${e.message}`;
    } finally {
      gen.disabled = false;
    }
  });

  wrap.append(label, ' ', gen, ' ', out);
  return wrap;
}

const EXAM_REASON_TEXT = {
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

function renderExamFeedback(item) {
  const box = $('#examFeedback');
  box.innerHTML = '';
  if (!item) {
    box.hidden = true;
    return;
  }
  box.className = `job-result verdict ${item.resolved === 'pass' ? 'pass' : 'fail'}`;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = item.resolved === 'pass' ? 'PASS' : item.via === 'skip' ? 'SKIP' : 'FAIL';
  const word = document.createElement('strong');
  word.className = 'verdict-word';
  word.textContent = `上一题 · ${item.word}${item.sense ? ` · 义项 ${item.sense + 1}` : ''}`;
  const lang = $('#examLang').value === 'en' ? 'en' : 'zh';
  const reason = document.createElement('p');
  reason.textContent = EXAM_REASON_TEXT[lang][item.reason] || EXAM_REASON_TEXT[lang].unspecified;
  box.append(badge, word, reason);

  if (item.stored) {
    const stored = document.createElement('p');
    stored.className = 'stored';
    stored.textContent = `表内：${item.stored.level ? `#${item.stored.level} · ` : ''}${item.stored.definition}${
      item.stored.chinese ? ` · ${item.stored.chinese}` : ''
    }${item.stored.example ? ` · ${item.stored.example}` : ''}`;
    box.append(stored);
  }
  box.hidden = false;
}

function examSettleBox(state, preview, current) {
  const box = $('#examResult');
  box.innerHTML = '';
  if (!state || !preview) {
    box.hidden = true;
    return;
  }
  const changed = preview.add.length + preview.remove.length;
  const head = document.createElement('p');
  head.className = 'quiz-hint';

  if (state.status !== 'running') {
    const done = preview.unchanged + changed;
    if (state.status === 'paused') {
      head.textContent = `本轮已暂停 · 已判 ${done}/${state.queue.length}，点「继续本轮」接着考`;
    } else if (state.status === 'settled') {
      const s = state.settlement;
      head.textContent = s
        ? `本轮已结算 · 写回 ${s.words.length} 个义项勾选 · ${s.backup ? `备份 ${s.backup}` : '无需写盘'}${
            s.skipped?.length ? ` · 跳过 ${s.skipped.length}` : ''
          }`
        : `本轮已结算 · 当时判定 ${done} 条义项`;
    } else {
      head.textContent = `本轮已放弃 · 词表未改动（当时已判 ${done} 条义项）`;
    }
    box.append(head);
    box.hidden = false;
    return;
  }

  head.textContent = current
    ? `已判 ${preview.unchanged + changed}/${state.queue.length} 条义项，可继续，也可随时结算已完成的部分`
    : `本轮 ${state.queue.length} 条义项全部判完，核对清单后结算`;
  box.append(head);

  const row = (item, label) => {
    const line = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = typeof item === 'string' ? item : `${item.word}${item.sense ? ` · 义项 ${item.sense + 1}` : ''}`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = typeof item === 'string' || !item.level ? label : `${label} · #${item.level}`;
    line.append(strong, tag);
    return line;
  };
  const list = document.createElement('div');
  list.className = 'preview';
  for (const w of preview.add) list.append(row(w, '将勾选'));
  for (const w of preview.remove) list.append(row(w, '将取消'));
  for (const s of preview.skipped) list.append(row(s.word, `跳过：${s.reason}`));
  if (!changed && !preview.skipped.length) list.append(row('勾选状态无需改动', '无改动'));
  box.append(list);

  const confirm = document.createElement('input');
  confirm.type = 'checkbox';
  const confirmWrap = document.createElement('label');
  confirmWrap.className = 'row-inline';
  confirmWrap.append(confirm, document.createTextNode(' 已核对清单，确认写回词表'));

  const commit = document.createElement('button');
  commit.type = 'button';
  commit.textContent = changed ? '结算并写回' : '标记为已结算';
  commit.disabled = changed > 0;
  confirm.addEventListener('change', () => {
    commit.disabled = changed > 0 && !confirm.checked;
  });
  commit.addEventListener('click', async () => {
    commit.disabled = true;
    try {
      const res = await api('/api/exam/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      toast(res.changed ? `已写回 ${res.changed} 个勾选 · 备份 ${res.backup}` : '已结算，词表未改动');
      await Promise.all([renderExam(), loadEntries()]);
    } catch (e) {
      commit.disabled = false;
      toast(e.message, 'bad');
    }
  });
  box.append(confirmWrap, commit);
  box.hidden = false;
}

async function renderExam(feedback) {
  let view;
  try {
    view = await api('/api/exam');
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  const { state, current, preview } = view;
  const running = state && state.status === 'running';
  const paused = state && state.status === 'paused';
  $('#examLang').value = state ? state.lang : settings ? settings.lang : 'zh';
  $('#examPause').hidden = !running;
  $('#examResume').hidden = !paused;
  $('#examAbort').hidden = !running && !paused;
  $('#examRestart').hidden = !running && !paused;

  if (state) {
    const done = Object.values(state.records).filter((r) => r.result).length;
    const tail = running ? '' : paused ? ' · 已暂停' : state.status === 'settled' ? ' · 已结算' : ' · 已放弃';
    $('#examProgress').textContent = `已判 ${done}/${state.queue.length} 条义项${tail}`;
  } else {
    $('#examProgress').textContent = '';
  }

  const card = $('#examCard');
  card.innerHTML = '';
  if (!current) {
    card.hidden = true;
  } else {
    card.hidden = false;
    const title = document.createElement('strong');
    title.textContent = current.word;
    const meta = document.createElement('span');
    meta.className = 'card-status';
    meta.textContent =
      `第 ${current.attempt}/${current.maxAttempts} 次机会 · 本轮第 ${current.index + 1}/${current.total} 题` +
      (current.senseCount > 1 ? ` · 义项 ${current.sense + 1}/${current.senseCount}` : '');
    const head = document.createElement('div');
    head.className = 'quiz-head';
    head.append(title, meta);

    const def = document.createElement('textarea');
    def.rows = 3;
    def.placeholder = '用英文写释义（不查表）。整测只考词义，不需要造句。';
    if (feedback && !feedback.resolved && feedback.word === current.word && feedback.sense === current.sense) {
      def.value = feedback.typed || '';
      setTimeout(() => def.focus(), 0);
    }
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = '提交这一题';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'skip-btn';
    skip.textContent = 'SKIP';
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(skip, submit);
    card.append(head, exampleRow(current.word, current.example, current.sense), field('我的释义', def), actions);

    const unlock = () => {
      submit.disabled = false;
      skip.disabled = false;
    };
    const finish = async (res) => {
      if (res.resolved) {
        res.stored = await api('/api/exam/reveal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: res.word, sense: res.sense }),
        }).catch(() => null);
      }
      await renderExam(res);
    };
    const call = async (path, body, typed) => {
      submit.disabled = true;
      skip.disabled = true;
      try {
        const res = await api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        res.typed = typed ?? '';
        await finish(res);
      } catch (e) {
        unlock();
        toast(e.message, 'bad');
      }
    };
    submit.addEventListener('click', () =>
      call(
        '/api/exam/answer',
        {
          word: current.word,
          sense: current.sense,
          userDefinition: def.value,
          userExample: '',
          lang: $('#examLang').value,
        },
        def.value,
      ),
    );
    skip.addEventListener('click', () => call('/api/exam/skip', { word: current.word, sense: current.sense }));
  }

  renderExamFeedback(feedback || null);
  examSettleBox(state, preview, current);
}

async function setExamLang(lang) {
  try {
    await api('/api/exam/lang', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang }),
    });
    toast(`本轮反馈语言已切为 ${lang === 'en' ? 'English' : '中文'}`);
  } catch {
    // 没有进行中的轮次，值留给下一次「开始整轮自测」
  }
}

async function startExam(force) {
  try {
    await api('/api/exam/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...examScope(), model: $('#model').value, lang: $('#examLang').value, force }),
    });
    renderExamFeedback(null);
    toast(force ? '已放弃旧的并重开一轮' : '整轮自测开始');
    await renderExam();
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function abortExam() {
  try {
    await api('/api/exam/abort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast('已放弃本轮，词表未改动');
    await renderExam();
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function pauseExam() {
  try {
    await api('/api/exam/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast('本轮已暂停，进度已保存');
    await renderExam();
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function resumeExam() {
  try {
    await api('/api/exam/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast('本轮已继续');
    await renderExam();
  } catch (e) {
    toast(e.message, 'bad');
  }
}

$('#examStart').addEventListener('click', () => startExam(false));
$('#examLang').addEventListener('change', (e) => setExamLang(e.target.value));
$('#examPause').addEventListener('click', pauseExam);
$('#examResume').addEventListener('click', resumeExam);
$('#examRestart').addEventListener('click', () => startExam(true));
$('#examAbort').addEventListener('click', abortExam);

$('#openEnv').addEventListener('click', () => openConfigFile('env'));
$('#openSettings').addEventListener('click', () => openConfigFile('settings'));

async function openConfigFile(which) {
  const out = $('#testResult');
  try {
    const res = await api('/api/open-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ which }),
    });
    toast(`已在记事本中打开 ${res.file}`);
    out.textContent = `已打开 ${res.file}`;
  } catch (e) {
    toast(e.message, 'bad');
    out.textContent = `打开失败：${e.message}`;
    out.className = 'save-state bad';
  }
}

$('#themeBtn').addEventListener('click', cycleTheme);
$('#saveSettings').addEventListener('click', () => saveSettings(settingsFromForm(), '设置已保存'));
$('#resetSettings').addEventListener('click', () =>
  saveSettings(
    { model: null, extraModels: [], lang: 'zh', theme: 'auto', prompts: { entry: null, judge: null } },
    '已恢复全部默认',
  ).then(loadSettings),
);
$('#addModel').addEventListener('click', () => {
  if (!settings) {
    toast('设置还没加载成功，无法添加模型', 'bad');
    return;
  }
  const name = $('#newModel').value.trim();
  if (!name) return;
  const names = [settings.model, ...settings.extraModels.map((m) => m.name)].filter(Boolean);
  if (names.includes(name)) {
    toast(`${name} 已在候选里`);
    return;
  }
  const baseUrl = $('#newModelUrl').value.trim();
  if (!baseUrl) {
    toast('接入点必填：每个模型自带自己的接入点', 'bad');
    return;
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    toast('接入点要以 http:// 或 https:// 开头', 'bad');
    return;
  }
  let extra;
  const extraRaw = $('#newModelExtra').value.trim();
  if (extraRaw) {
    try {
      extra = JSON.parse(extraRaw);
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('须是 JSON 对象');
    } catch (e) {
      toast(`附加参数 JSON 有误：${e.message}`, 'bad');
      return;
    }
  }
  settings.extraModels = [
    ...settings.extraModels,
    { name, baseUrl, keyName: $('#newModelKey').value, ...(extra ? { extra } : {}) },
  ];
  availableModels = [...new Set([...names, name])];
  $('#newModel').value = '';
  $('#newModelUrl').value = '';
  $('#newModelExtra').value = '';
  renderModelChips();
  syncSettingDefaults();
  setSaveState('有未保存的改动');
});
$('#testModel').addEventListener('click', async () => {
  const out = $('#testResult');
  out.textContent = '测试中…';
  out.className = 'save-state';
  const model = $('#newModel').value.trim() || $('#setModel').value || '';
  const known = (settings?.extraModels || []).find((m) => m.name === model);
  const baseUrl = $('#newModelUrl').value.trim() || known?.baseUrl || '';
  if (!model || !baseUrl) {
    out.textContent = '请填模型名和接入点';
    out.className = 'save-state bad';
    return;
  }
  const body = { model, baseUrl, keyName: $('#newModelKey').value };
  const extraRaw = $('#newModelExtra').value.trim();
  if (extraRaw) {
    try {
      body.extra = JSON.parse(extraRaw);
    } catch {
      out.textContent = '附加参数 JSON 有误';
      out.className = 'save-state bad';
      return;
    }
  }
  try {
    const res = await api('/api/test-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    out.textContent = `连通 OK · ${res.model} · ${res.latencyMs}ms`;
  } catch (e) {
    out.textContent = `不通：${e.message}${e.details ? ` · ${e.details}` : ''}`;
    out.className = 'save-state bad';
  }
});

for (const btn of document.querySelectorAll('.reset-prompt')) {
  btn.addEventListener('click', () => {
    const area = { entry: '#promptEntry', judge: '#promptJudge' }[btn.dataset.prompt];
    $(area).value = '';
    setSaveState('清空即恢复默认，记得保存');
  });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.panel));
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
$('#draftBtn').addEventListener('click', draftWords);
$('#commitAll').addEventListener('click', commitAllCards);
$('#clearCards').addEventListener('click', () => {
  $('#cards').innerHTML = '';
  $('#addHint').textContent = '';
});
$('#pickBtn').addEventListener('click', pickRandom);
$('#startWord').addEventListener('click', startFromWord);
$('#quizWord').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startFromWord();
});

for (const id of ['#q', '#chapter', '#difficulty', '#mastery']) {
  $(id).addEventListener('input', renderList);
}

$('#reload').addEventListener('click', loadEntries);

await Promise.all([loadEntries(), loadSettings(), renderExam()]);
