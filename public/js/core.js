// 基础层：DOM 查询、CEFR 档位常量、共享的 entries/stats 状态、fetch 封装、toast，
// 以及面板切换（侧栏导航 + 顶栏标题）。

const $ = (sel) => document.querySelector(sel);
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const state = { entries: [], stats: null };

// 跨面板共享的设定值，目前只有反馈语言的默认值：设置面板写它，词表与两个轮次面板读它。
// 走这里而不是 import 设置面板——面板之间不互相引，方向才是单向的。
const prefs = { lang: 'zh' };

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

// 两种调用的实测单价（token）：定档一票 ≈106、生成义项一个词 ≈590。2026-10-01 按 deepseek 关掉
// 推理段之后测的；定档那一项拿真机反推校准过（全表 906 条重判 287.7k ÷ (906×3) ≈ 106）。换个模型、
// 或者哪天把推理段重新打开，这几个数就不作数了。只用来在开跑前报个量级，真账看 /api/usage。
const COST = { vote: 106, entry: 590 };

// token 数按人读的位数说：1500 → 1.5k，1200000 → 1.20M。
function tokens(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// 按「有多少词、多少条义项要跑」估一句：`约 N 次调用 · X token`。定档按批算调用数（一批 8 条、
// 跑三遍），生成义项是一个词一次。重构那一路会偏高——D38 跳过释义没变的义项，估算器不知道有
// 多少条真会变。
function estimate({ entries = 0, senses = 0 } = {}) {
  const calls = entries + Math.ceil(senses / VOTE_BATCH) * 3;
  const total = entries * COST.entry + senses * 3 * COST.vote;
  return `约 ${calls} 次调用 · ${tokens(total)} token`;
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

// 收尾的结果只弹右下角、原地那一格清干净：页面上只留「进行中」和「等你动手」的状态，
// 结果不留痕（他的口径：结果只走弹窗，不要原地反馈）。传的必须是 .save-state 那类状态格。
function report(el, message, bad = false) {
  for (const node of Array.isArray(el) ? el : [el]) {
    if (!node) continue;
    node.textContent = '';
    node.className = 'save-state';
  }
  toast(message, bad ? 'bad' : 'ok');
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  // 连着弹两条时把入场动画重放一遍：同一个元素改 className 不会自己重来，得先让它重排一次。
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  // 退场也动一下：直接 hidden 是「啪」地不见，看着像被吞了。
  toastTimer = setTimeout(() => {
    el.classList.add('out');
    toastTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('out');
    }, 200);
  }, 4000);
}

// ---- 防横滚 ----
// 一行真正占多宽：scrollWidth 只算右/下方向的溢出，而右对齐的行（顶栏工具条）塞不下时内容往
// 左跑、scrollWidth 一点不长——所以不换行的行再按「子元素总宽 + 间隙」量一遍，取大者。
function naturalWidth(el) {
  const cs = getComputedStyle(el);
  const widest = el.scrollWidth;
  if (cs.flexWrap !== 'nowrap') return widest;
  const gap = parseFloat(cs.columnGap) || 0;
  // 只数量得到的那些：display:none 的子元素不占位，给它也算一道间隙会把行系统性量宽几像素，
  //  borderline 的字号下就是一次误压
  const vis = [...el.children].filter((kid) => getComputedStyle(kid).display !== 'none');
  const total = vis.reduce((w, kid) => w + kid.offsetWidth, 0) + gap * Math.max(0, vis.length - 1);
  return Math.max(widest, total);
}

// 判据只有这一条：真实溢出——占宽超过 clientWidth。它跟字号、系统字体缩放、文案长短、语言都
// 无关，量的是当下真实的占位（窄屏那几轮栽的都是「看着没问题、量出来超了」，所以一律用量出来
// 的数判断，不靠断点猜）。
function overflows(el) {
  return Boolean(el) && naturalWidth(el) > el.clientWidth + 1;
}

// 处置：溢出就把这一行的字号压回去。行内字号写在 CSS 里、写成 calc(基准 * var(--fit, 1))，
// 这里只改 --fit：先按比例一步算到刚好塞下，再逐步微调；压到下限还塞不下返回 false，交给
// 调用方兜底（收起次要内容）。没溢出就把 --fit 复位——视口一大、内容一短，字号自己回来。
function fitRow(el, { floor = 0.8 } = {}) {
  if (!el) return true;
  el.style.removeProperty('--fit');
  if (!overflows(el)) return true;
  let fit = Math.max(floor, (el.clientWidth - 1) / naturalWidth(el));
  for (let i = 0; i < 20 && overflows(el) && fit > floor; i += 1) fit = Math.max(floor, fit - 0.02);
  el.style.setProperty('--fit', fit.toFixed(3));
  return !overflows(el);
}

// 顶栏那两条每次视口或内容变了都过一遍。右侧工具条：量到溢出就压字号（不截省略号）。
// 窄屏下导航那一行还是原来的判断——真放不下就收起概览（它同时管着顶栏高度，缩字代替它不划算）。
// 处置只认「连着两帧都溢出」：替换完词表那一瞬布局还没落定（系统文件选择器刚收回去尤其明显），
// 单帧量到的溢出会把压好的字号钉在页面上——症状就是「工具条突然缩小，再打开又恢复正常」。
let overflowSeen = false;

function fitChrome() {
  const tools = $('.topbar-tools');
  const side = $('.side');
  const narrow = Boolean(side) && matchMedia('(max-width: 920px)').matches;
  if ((overflows(tools) || (narrow && overflows(side))) && !overflowSeen) {
    overflowSeen = true;
    requestAnimationFrame(fitChrome);
    return;
  }
  overflowSeen = false;
  fitRow(tools);
  if (!side) return;
  document.documentElement.classList.remove('nav-compact');
  if (narrow && overflows(side)) document.documentElement.classList.add('nav-compact');
}

window.addEventListener('resize', fitChrome);

// ---- 把一份文件交给用户 ----
// 桌面就是浏览器下载；安卓 App 里主界面（http://127.0.0.1:端口）那个 WebView 没有插件桥，
// 写文件与系统分享只能交给自家桥页去做（storage.html?mode=share，D50）——那里自己去内嵌服务
// 取同一份内容，所以只传地址，不过手搬文本（词表上百 KB）。
// 这两条事实由 settings-panel 读到 /api/settings 后写一次：
//  · inApp——宿主是安卓 App。判据用平台，不用「有没有 Capacitor 对象」：主界面里那个对象压根
//    不存在，拿它判断等于永远判成桌面，导出在手机上就成了点了没反应的那颗按钮。
//  · local——页面就在运行服务这台机器上开（回环）。设备包的密钥只有回环请求拿得走（D46），
//    导出成功与否要说给他听，看的正是这个。
const deployment = { inApp: false, local: true };

function setDeployment({ inApp, local } = {}) {
  if (inApp !== undefined) deployment.inApp = Boolean(inApp);
  if (local !== undefined) deployment.local = Boolean(local);
}

const runningInApp = () => deployment.inApp;
const loopback = () => deployment.local;

function deliverFile(name, url) {
  if (deployment.inApp) {
    const src = new URL(url, location.href).href;
    const back = `${location.origin}/?ptab=settings`;
    location.href = `https://localhost/storage.html?mode=share&name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}&back=${encodeURIComponent(back)}`;
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
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

// 下拉与标签里的说法只有这一处：HTML 里只留空壳，各面板启动时按这几张表填自己的 select。
const LABELS = {
  lang: { zh: '中文', en: 'English' },
  mastery: { full: '完全掌握', partial: '部分掌握', none: '不掌握' },
  theme: { auto: '跟随系统', light: '浅色', dark: '深色' },
  // 顶栏那颗按钮用短版：「跟随系统」比「浅色/深色」宽两个汉字，系统字体一放大就把顶栏顶出横滚。
  themeBtn: { auto: '自动', light: '浅色', dark: '深色' },
};

// 按 {值: 文字} 填一个 select；placeholder 是那条空值选项（筛选框要用）。
function fillOptions(sel, map, placeholder) {
  sel.innerHTML = '';
  if (placeholder !== undefined) {
    const all = document.createElement('option');
    all.value = '';
    all.textContent = placeholder;
    sel.append(all);
  }
  for (const [value, label] of Object.entries(map)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.append(o);
  }
}

// 面板名只有一处来源：侧栏导航上那几项的标题文字。顶栏标题与学习/复习的文案都从这里取。
const PANEL_TITLE = Object.fromEntries(
  [...document.querySelectorAll('.nav-item')].map((t) => [t.dataset.panel, t.querySelector('span').textContent.trim()]),
);

function activateTab(panel) {
  for (const t of document.querySelectorAll('.nav-item')) t.classList.toggle('active', t.dataset.panel === panel);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${panel}`);
  $('#panelTitle').textContent = PANEL_TITLE[panel] || 'VocabApp';
  // 切面板是换地方干活，不是接着刚才的滚动位置往下看；留在原处只会落在新面板的半腰上。
  window.scrollTo(0, 0);
}

for (const tab of document.querySelectorAll('.nav-item')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.panel));
}

export {
  $,
  CEFR,
  state,
  prefs,
  api,
  toast,
  report,
  text,
  fillSelect,
  fillOptions,
  LABELS,
  PANEL_TITLE,
  activateTab,
  inChunks,
  usageMeter,
  estimate,
  fitChrome,
  deliverFile,
  setDeployment,
  runningInApp,
  loopback,
  VOTE_BATCH,
};
