// 加词面板：粘贴一批词 → 逐词出卡 → 校对后写入。

import { $, api, toast, activateTab } from './core.js';
import { senseRow, readSenses, senseBasisNote } from './sense-ui.js';
import { renderList, loadEntries } from './vocab-list.js';

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
  write.className = 'btn primary';
  write.textContent = '写入';
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.className = 'btn ghost';
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

$('#draftBtn').addEventListener('click', draftWords);
$('#commitAll').addEventListener('click', commitAllCards);
$('#clearCards').addEventListener('click', () => {
  $('#cards').innerHTML = '';
  $('#addHint').textContent = '';
});
