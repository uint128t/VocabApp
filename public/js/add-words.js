// 加词面板：粘贴一批词 → 逐词出卡 → 校对后写入。

import { $, api, toast, inChunks, usageMeter, estimate } from './core.js';
import { senseRow, readSenses, voteAll, applyVote } from './sense-ui.js';
import { loadEntries, locateWord } from './vocab-list.js';

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
  addSense.className = 'link-btn';
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

// 定完档返回 true；中途被终止返回 false —— 这张卡是半截的，调用方整张丢掉。
async function applyDraft(card, d, signal, meter) {
  const a = card.api;
  a.sensesBox.innerHTML = '';
  const rows = [];
  for (const sense of d.senses || []) {
    // trace 挂在每条义项上，依据方块一建出来就能展开看逐步命中（那时还没投票）。
    const row = senseRow({ word: a.word }, { ...sense, trace: d.trace });
    a.sensesBox.append(row);
    rows.push(row);
  }
  a.note.textContent = d.note || '';
  // 档位不在这张卡里由模型定（D30）：逐条跑三次投票，带上查表命中的那些参考。
  // 分块并发（√n 一块），进度行写清；失败的那条留「待定」等手动选。
  // 一张卡的义项摆在一批里问（D37）：固定那份规则只摊一次。
  await voteAll(
    rows.map((row) => ({
      row,
      target: { word: a.word, definition: row.api.def.value.trim(), example: row.api.ex.value.trim() },
    })),
    {
      model: $('#model').value,
      signal,
      onRow: ({ row }, out, error) => {
        if (out && out.level) applyVote(row, out);
        else if (!signal?.aborted) row.api.card.api.update({ error: error ? error.message : '这条没给出合法档位' });
      },
      onProgress: (done, total) => {
        a.status.textContent = (total > 1 ? `定档中 ${done}/${total}…` : '定档中…') + (meter ? meter.text() : '');
      },
    },
  );
  if (signal?.aborted) return false;
  a.status.textContent = '';
  card.classList.remove('loading');
  return true;
}

// 正在跑的那一轮生成草稿（出义项 + 逐条定档）。点「终止」就是 abort 它：连接一关，
// 服务端那边还没出结果的上游调用也跟着停（server.js 按连接断开中止）。
let draftAbort = null;
// 「清空卡片」顺手把这一轮也取消了：收尾那句「已终止 · 生成 N 张」就别再写回空面板上。
let draftCleared = false;

async function draftWords() {
  const words = parseWords($('#words').value);
  const existing = new Set([...document.querySelectorAll('#cards .card')].map((c) => c.api.word.toLowerCase()));
  const fresh = words.filter((w) => !existing.has(w.toLowerCase()));
  const hint = $('#addHint');
  // 一个词一次生成 + 它的义项各三票；义项数还没生成出来，按全表均值 1.4 条先估。
  const plan = estimate({ entries: fresh.length, senses: Math.round(fresh.length * 1.4) });
  hint.textContent = `${fresh.length} 个待生成${words.length - fresh.length ? `，${words.length - fresh.length} 个已有卡片` : ''} · 预计 ${plan}`;
  if (!fresh.length) return;

  const btn = $('#draftBtn');
  const stop = $('#draftStop');
  btn.disabled = true;
  stop.hidden = false;
  stop.disabled = false;
  const controller = new AbortController();
  draftAbort = controller;
  draftCleared = false;
  const meter = usageMeter();
  let made = 0;
  try {
    for (const word of fresh) {
      if (controller.signal.aborted) break;
      const card = makeCard(word);
      $('#cards').append(card);
      try {
        const d = await api('/api/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word, withChinese: $('#withChinese').checked, model: $('#model').value }),
          signal: controller.signal,
        });
        // 半截的卡（义项齐、档位不齐）整张丢掉：重跑一次本来就整个重做，留着只会逼你
        // 手动去补剩下的档位。词还在输入框里，再点一次「生成草稿」会跳过已有的接着做。
        if (await applyDraft(card, d, controller.signal, meter)) made += 1;
        else {
          card.remove();
          break;
        }
      } catch (e) {
        if (controller.signal.aborted) {
          card.remove();
          break;
        }
        card.classList.remove('loading');
        card.classList.add('bad');
        card.api.status.textContent = `生成失败：${e.message}`;
      }
    }
  } finally {
    meter.stop();
    draftAbort = null;
    stop.hidden = true;
    btn.disabled = false;
    if (controller.signal.aborted && !draftCleared) {
      hint.textContent = `已终止 · 生成 ${made} 张，还剩 ${fresh.length - made} 个词${meter.text()}`;
    } else if (!draftCleared) {
      hint.textContent = `本轮生成 ${made} 张${meter.text()}`;
    }
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
  // 档位是三票定出来的（D30），没定出来就别写：先手动选一个，或者等定档成功再存。
  const noLevel = senses.findIndex((s) => !s.level);
  if (noLevel >= 0) {
    a.status.textContent = `第 ${noLevel + 1} 条义项还没定档，先选一个或重跑定档`;
    return `第 ${noLevel + 1} 条义项还没定档`;
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
    a.status.textContent = `已写入 · 备份 ${res.backup}`;
    for (const el of a.sensesBox.querySelectorAll('input, select, button')) el.disabled = true;
    a.addSense.disabled = true;
    a.write.hidden = true;
    if (!quiet) {
      toast(`${a.word} 已写入`);
      await loadEntries();
    }
    return true;
  } catch (e) {
    a.write.disabled = false;
    // 词已经在表里：把「定位到该条」亮出来，去那一行接着做，而不是再写一份重复的。
    if (e.code === 'wordExists') {
      a.locate.hidden = false;
      a.status.textContent = e.message;
      return e.message;
    }
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
  try {
    for (const card of targets) {
      const a = card.api;
      // 单张卡出什么意外都不许打断整轮，也别把按钮锁死到刷新页面。
      try {
        const res = await commitCard(card, true);
        if (res === true) written += 1;
        else skipped.push(`${a.word}（${typeof res === 'string' ? res : '未写入'}）`);
      } catch (e) {
        skipped.push(`${a.word}（${e.message}）`);
      }
    }
  } finally {
    btn.disabled = false;
  }
  if (written) await loadEntries();
  toast(`已写入 ${written} 条${skipped.length ? ` · 未写入 ${skipped.length} 条：${skipped.join('、')}` : ''}`, skipped.length ? 'bad' : 'ok');
}

$('#draftBtn').addEventListener('click', draftWords);
$('#draftStop').addEventListener('click', () => {
  if (!draftAbort) return;
  $('#draftStop').disabled = true;
  $('#addHint').textContent = '正在终止…';
  draftAbort.abort();
});
$('#commitAll').addEventListener('click', commitAllCards);
$('#clearCards').addEventListener('click', () => {
  // 清空时正在跑的那一轮也得停，不然卡片会一张张重新长回来。
  if (draftAbort) {
    draftCleared = true;
    draftAbort.abort();
  }
  $('#cards').innerHTML = '';
  $('#addHint').textContent = '';
});
