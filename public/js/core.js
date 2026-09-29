// 基础层：DOM 查询、CEFR 档位常量、共享的 entries/stats 状态、fetch 封装、toast，
// 以及面板切换（侧栏导航 + 顶栏标题）。

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

const PANEL_TITLE = { add: '加词', fill: '词表', learn: '学习', review: '复习', settings: '设置' };

function activateTab(panel) {
  for (const t of document.querySelectorAll('.nav-item')) t.classList.toggle('active', t.dataset.panel === panel);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${panel}`);
  $('#panelTitle').textContent = PANEL_TITLE[panel] || 'Vocabulary 助手';
}

for (const tab of document.querySelectorAll('.nav-item')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.panel));
}

export { $, CEFR, state, api, toast, text, fillSelect, activateTab };
