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

// 分块并发：n 个活分成 ceil(√n) 一块，块内并行、块间串行。定档与重构都要跑几十上百个
// 模型调用，全串行太慢、全并发会把上游打爆，所以按 √n 一块推进。
//
// 第四个参数是可选的 signal（界面上那颗「终止」）：块与块之间看它一眼，已经中止就不开新块，
// 没轮到的那些标成 aborted 原样留在结果里；已经开跑的那一块连 fetch 一起被中止（worker 里
// 要把同一个 signal 交给 api()）。调用方据此写「还剩几条」而不是把中止当成失败。
async function inChunks(items, worker, onProgress, signal) {
  const list = [...items];
  const size = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const results = new Array(list.length);
  const abortedSlot = (item) => {
    const e = new Error('已终止');
    e.aborted = true;
    return { ok: false, error: e, item, aborted: true };
  };
  let done = 0;
  for (let i = 0; i < list.length; i += size) {
    if (signal?.aborted) {
      for (let k = i; k < list.length; k += 1) results[k] = abortedSlot(list[k]);
      break;
    }
    await Promise.all(
      list.slice(i, i + size).map(async (item, k) => {
        try {
          results[i + k] = { ok: true, value: await worker(item, i + k), item };
        } catch (error) {
          results[i + k] = { ok: false, error, item, aborted: Boolean(signal?.aborted) };
        } finally {
          done += 1;
          if (onProgress) onProgress(done, list.length, item);
        }
      }),
    );
  }
  return results;
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

export { $, CEFR, state, api, toast, text, fillSelect, activateTab, inChunks };
