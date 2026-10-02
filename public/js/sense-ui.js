// 义项相关的公共零件：档位下拉、编辑行、答题目用的义项行、义项小标签。
// 词表、加词、学习、复习四个面板都从这里取。

import { $, CEFR, api, inChunks, VOTE_BATCH } from './core.js';
import { levelCard } from './level-card.js';

function levelSelect(current) {
  const sel = document.createElement('select');
  // 档位由三次投票定；还没投票时留一个空的「待定」，别假装有个档位。
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '待定';
  sel.append(blank);
  for (const level of CEFR) {
    const o = document.createElement('option');
    o.value = level;
    o.textContent = level;
    sel.append(o);
  }
  sel.value = current && CEFR.includes(current) ? current : '';
  return sel;
}

function senseRow(entry, sense, { withCheck = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sense-item';
  const row = document.createElement('div');
  row.className = 'sense-row';
  const level = levelSelect(sense.level);
  // 三个输入框必须显式写 type：样式挂在 input[type="text"] 上，不写就整个吃不到，
  // 浏览器会按默认样式画成 2px 内凹边框、小一号字号，深色下底色还不对。
  const def = document.createElement('input');
  def.type = 'text';
  def.className = 'sense-def-input';
  def.value = sense.definition || '';
  def.placeholder = '这条义项的释义（可留空）';
  const ex = document.createElement('input');
  ex.type = 'text';
  ex.className = 'sense-ex-input';
  ex.value = sense.example || '';
  ex.placeholder = '例句（必填）';
  const zh = document.createElement('input');
  zh.type = 'text';
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
  gen.className = 'link-btn';
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

  // 档位依据是可展开的方块（加词与词表共用）：这里只按传进来的数据画一次，
  // 定档回来之后再 update 一次。
  const card = levelCard({ level: sense.level || null, vote: sense.vote || null, trace: sense.trace || null });
  if (sense.voteError) card.api.update({ error: sense.voteError });

  row.api = { level, def, ex, zh, card, check };
  if (check) row.append(check);
  row.append(level, def, ex, zh, gen, drop, out);
  wrap.append(row, card);
  wrap.api = row.api;
  return wrap;
}

// 参考档位按来源去重：同一个来源在表里按词性各有一条（CEFR-J 名词 A2、CEFR-J 动词 B1），
// 逐条列出来能占掉一整行。取每个来源的平词条目（数据里的「该来源最低档」），没有就取最低的那条。
function levelSourceLine(referenceLevels) {
  const bySource = new Map();
  for (const item of referenceLevels?.levels || []) {
    const held = bySource.get(item.source);
    if (!held || (held.pos && !item.pos)) {
      bySource.set(item.source, item);
      continue;
    }
    if (held.pos && item.pos && CEFR.indexOf(item.level) < CEFR.indexOf(held.level)) bySource.set(item.source, item);
  }
  return [...bySource.values()].map((l) => `${l.source} ${l.level}`);
}

// 没定出档位的那几条再进队列、跟着下一批重来，最多这么多轮（第一轮 + 两次重试）。
const VOTE_ROUNDS = 3;

// 一组义项一起定档：按 VOTE_BATCH 切批，批间并发（√n），每批一个请求。
// items 是 [{target, ...}]，target 交给服务端；onRow(item, result, error) 由调用方决定怎么落界面。
// 一批整体挂了（网络/上游）或者某条没定出档位，那几条会重新进队列、跟着下一批重来；
// 重试到底还是不行，才按失败报给 onRow——这样一条坏数据不至于连累同批的其他条目（D37）。
async function voteAll(items, { model, signal, onRow, onProgress } = {}) {
  const total = items.length;
  let done = 0;
  let pending = items;
  for (let round = 0; round < VOTE_ROUNDS && pending.length; round += 1) {
    const last = round === VOTE_ROUNDS - 1;
    const batches = [];
    for (let i = 0; i < pending.length; i += VOTE_BATCH) batches.push(pending.slice(i, i + VOTE_BATCH));
    const left = [];
    await inChunks(
      batches,
      async (batch) => {
        let results = null;
        let error = null;
        try {
          const body = await api('/api/level/vote', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targets: batch.map((it) => it.target), model }),
            signal,
          });
          results = body.results;
        } catch (e) {
          error = e;
        }
        batch.forEach((it, k) => {
          const res = results ? results[k] : null;
          if (res && res.level) {
            done += 1;
            onRow(it, res, null);
          } else if (last) {
            onRow(it, null, error || new Error('这条没给出合法档位'));
          } else {
            left.push(it);
          }
        });
        if (onProgress) onProgress(done, total);
      },
      null,
      signal,
    );
    pending = left;
    if (signal?.aborted) break;
  }
  // 中途被终止：剩下的按「还没跑」报回去，调用方按终止显示。
  if (signal?.aborted) for (const it of pending) onRow(it, null, signal.reason instanceof Error ? signal.reason : new Error('已终止'));
}

// 定完档把结果填回那一行的档位下拉与依据方块。
function applyVote(row, out) {
  row.api.level.value = out.level;
  row.api.card.api.update({ level: out.level, vote: out, trace: out.trace });
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

function levelTag(level) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  if (level) tag.dataset.level = level;
  tag.textContent = level ? `#${level}` : '#—';
  return tag;
}

// 学习、复习与词表的「考这个词」共用的一行：抬头是义项编号、档位和该义项的例句，
// 下面两个输入框——英文释义，和可选的一句例句（填了才判，判不过会影响 pass）。
function answerRow({ label, level, example }) {
  const row = document.createElement('div');
  row.className = 'answer-row';

  const head = document.createElement('div');
  head.className = 'answer-head';
  const name = document.createElement('span');
  name.className = 'answer-label';
  name.textContent = label;
  head.append(name, levelTag(level));
  const ex = document.createElement('span');
  ex.className = 'sense-ex';
  ex.textContent = example || '（这条没有例句）';
  head.append(ex);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'answer-input';
  input.placeholder = '用英文写这条义项的释义';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const exampleInput = document.createElement('input');
  exampleInput.type = 'text';
  exampleInput.className = 'answer-example-input';
  exampleInput.placeholder = '可选：用这个词造一句';
  exampleInput.autocomplete = 'off';
  exampleInput.spellcheck = false;

  const result = document.createElement('div');
  result.className = 'answer-result';
  result.hidden = true;

  row.append(head, input, exampleInput, result);
  row.api = { row, input, exampleInput, result, head, ex };
  return row;
}

export {
  levelTag,
  senseRow,
  levelSourceLine,
  readSenses,
  answerRow,
  voteAll,
  applyVote,
};
