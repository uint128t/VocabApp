// 义项相关的公共零件：档位下拉、编辑行、答题目用的义项行、义项小标签。
// 词表、加词、自测、整测四个面板都从这里取。

import { $, CEFR, api, text } from './core.js';

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

function firstOpenSense(entry) {
  const i = entry.senses.findIndex((s) => !s.checked);
  return i < 0 ? 0 : i;
}

function levelTag(level) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  if (level) tag.dataset.level = level;
  tag.textContent = level ? `#${level}` : '#—';
  return tag;
}

// 自测与整测共用的一行：抬头是义项编号、档位和例句，下面是作答输入框与判定结果。
function answerRow({ label, level, example, focused, quiet, note }) {
  const row = document.createElement('div');
  row.className = text('answer-row', focused && 'focused', quiet && 'quiet');

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

  const result = document.createElement('div');
  result.className = 'answer-result';
  result.hidden = true;

  row.append(head);
  if (note) {
    const flag = document.createElement('span');
    flag.className = 'answer-flag';
    flag.textContent = note;
    row.append(flag);
  }
  if (!quiet) row.append(input);
  row.append(result);
  row.api = { row, input, result, head, ex };
  return row;
}

export { levelTag, senseRow, relatedLabel, senseBasisNote, readSenses, firstOpenSense, answerRow };
