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

// 滚动并发：同时最多 ceil(√n) 个活（另有 MAX_PARALLEL 防呆），谁跑完谁拿下一条。
// 定档与重构都要跑几十上百个模型调用，全串行太慢、全并发会把上游打爆，所以按 √n 压着跑。
// 不摆「一块跑完再开下一块」的屏障：那样一轮要等最慢的那条，一个卡了 27 秒的词会把同批
// 二十几个早就跑完的一起拖住。MAX_PARALLEL 只是防呆（√n 要到 25 万条才碰得到它），别拿它
// 当调速旋钮：真把并发压小，大批量只会更慢；「跑着没反应」是界面没东西可看，靠逐条回填解决。
const MAX_PARALLEL = 500;

// 第四个参数是可选的 signal（界面上那颗「终止」）：块与块之间看它一眼，已经中止就不开新块，
// 没轮到的那些标成 aborted 原样留在结果里；已经开跑的那一块连 fetch 一起被中止（worker 里
// 要把同一个 signal 交给 api()）。调用方据此写「还剩几条」而不是把中止当成失败。
async function inChunks(items, worker, onProgress, signal) {
  const list = [...items];
  const size = Math.max(1, Math.min(Math.ceil(Math.sqrt(list.length)), MAX_PARALLEL));
  const results = new Array(list.length);
  const abortedSlot = (item) => {
    const e = new Error('已终止');
    e.aborted = true;
    return { ok: false, error: e, item, aborted: true };
  };
  let done = 0;
  let next = 0;
  // 一个 worker 负责一条流水线：拿一条、跑完、再拿下一条，直到没活或被终止。
  const run = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next;
      next += 1;
      if (i >= list.length) return;
      const item = list[i];
      try {
        results[i] = { ok: true, value: await worker(item, i), item };
      } catch (error) {
        results[i] = { ok: false, error, item, aborted: Boolean(signal?.aborted) };
      } finally {
        done += 1;
        if (onProgress) onProgress(done, list.length, item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
  // 终止时还没被拿走的那些，标成 aborted 留在结果里，调用方据此写「还剩几条」。
  for (let i = 0; i < list.length; i += 1) if (!results[i]) results[i] = abortedSlot(list[i]);
  return results;
}

// 一次定档摆几条（D37，用户定的）。批越小越保险、批越大固定开销摊得越薄。
const VOTE_BATCH = 8;

// 三种调用的实测单价（token）：定档一票 ≈106、生成义项一个词 ≈590、判定一次 ≈380。
// 2026-10-01 按 deepseek 关掉推理段之后测的（关之前是 456 / 1900 / 450）。定档那一项拿真机反推
// 校准过：全表 906 条重判花掉 287.7k token，287700 / (906×3) ≈ 106，比单批实测的 96 略高——
// 真跑起来有重排队、还有不满批的尾巴。换个模型、或者哪天把推理段重新打开，这几个数就不作数了。
// 只用来在开跑之前报个量级，真账看 /api/usage。重构那一路的预估会偏高：D38 会跳过释义没变的
// 义项（真机是 589 词 475.8k，估算报 634k），估算器不知道有多少条会真的变。
const COST = { vote: 106, entry: 590, judge: 380 };

function tokens(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// 按「有多少词、多少条义项要跑」估一下：返回 {calls, tokens, text}。
// 定档按批算调用数（一批 8 条、跑三遍），生成义项暂时还是一个词一次。
function estimate({ entries = 0, senses = 0, judges = 0 } = {}) {
  const votes = senses * 3;
  const calls = entries + Math.ceil(senses / VOTE_BATCH) * 3 + judges;
  const total = entries * COST.entry + votes * COST.vote + judges * COST.judge;
  return { calls, tokens: total, text: `约 ${calls} 次调用 · ${tokens(total)} token` };
}

// 用量表：批量跑起来 token 走得飞快，进度行里顺带把这轮的用量写上——看得见才好决定要不要收手。
// 自己先读一次基线，之后每 2 秒轮询一次；调用方把 text() 拼进进度文案，跑完记得 stop()。
function usageMeter() {
  let base = null;
  let spent = 0;
  const tick = async () => {
    try {
      const res = await api('/api/usage');
      const total = res.usage.prompt + res.usage.completion;
      if (base === null) base = total;
      spent = total - base;
    } catch {
      /* 读不到就不显示，别打扰正在跑的那一轮 */
    }
  };
  tick();
  const timer = setInterval(tick, 2000);
  return {
    text: () => (spent > 0 ? ` · 已用 ${tokens(spent)} token` : ''),
    stop: () => clearInterval(timer),
  };
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

export { $, CEFR, state, api, toast, text, fillSelect, activateTab, inChunks, usageMeter, estimate, tokens, VOTE_BATCH };
