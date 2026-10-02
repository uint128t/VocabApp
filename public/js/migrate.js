// 设备迁移（D46）：导出「密钥 + 设置 + 词表」为一个 .vocabpack.json；导入时逐块和本机比对——
// 一样跳过、单边直接搬、两边都有且不同就把两版并排摆出来（词表按章节、设置按字段、密钥按名字），
// 让用户逐项选。冲突未全部拍板前，「应用选择」保持禁用。词表路径不参与——各设备各自一份。

import { $, api, report, deliverFile, runningInApp, loopback } from './core.js';

let reload = async () => {}; // 由 settings-panel 接进来：重读设置、词表与轮次面板

export function initMigrate(deps) {
  reload = deps.reload;
}

// ---------------------------------------------------------------------------
// 导出：整份设备包（密钥 + 设置 + 词表）由服务端一次拼好（D50），这里只负责把那份文件交出去
// ——桌面是浏览器下载，手机上跳桥页走系统分享（应用里的主界面没有插件桥，`<a download>` 点了
// 不会有任何反应）。密钥只有回环请求拿得走，拿不走时包照样导，但要如实说清楚。

function exportPack() {
  const out = $('#packState');
  out.textContent = '导出中…';
  out.className = 'save-state';
  const name = `vocab-device-${runningInApp() ? 'android' : 'desktop'}-${new Date().toISOString().slice(0, 10)}.vocabpack.json`;
  deliverFile(name, '/api/migrate/export');
  report(out, `设备包已导出：${name}${loopback() ? '' : '（这台机器不让取密钥，包里只有设置与词表）'}`, !loopback());
}

// ---------------------------------------------------------------------------
// 导入：第一步选文件 → 出比对清单

$('#packExport').addEventListener('click', exportPack);
$('#packImport').addEventListener('click', () => $('#packFile').click());
$('#packFile').addEventListener('change', () => {
  const file = $('#packFile').files[0];
  if (file) importPack(file);
  $('#packFile').value = '';
});

async function importPack(file) {
  const out = $('#packState');
  const box = $('#packResult');
  out.textContent = '';
  try {
    if (file.size > 8_000_000) throw new Error('文件超过 8MB，不像是一份设备包');
    const pack = JSON.parse(await file.text());
    if (pack?.kind !== 'vocabapp-pack') throw new Error('这不是 VocabApp 导出的设备包');
    out.textContent = '比对中…';
    const res = await api('/api/migrate/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack }),
    });
    out.textContent = '';
    renderCompare(box, pack, res);
  } catch (e) {
    report(out, `读取失败：${e.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// 比对清单与逐项选择

const state = { vocab: null, settings: null, keys: null, choices: new Map(), pack: null };

function renderCompare(box, pack, res) {
  state.pack = pack;
  state.vocab = res.vocab;
  state.settings = res.settings;
  state.keys = res.keys;
  state.choices = new Map();

  box.innerHTML = '';
  box.hidden = false;

  const head = document.createElement('p');
  head.className = 'quiz-hint';
  const when = pack.exportedAt ? `导出于 ${pack.exportedAt.slice(0, 16).replace('T', ' ')}` : '';
  const from = pack.device === 'android' ? '来自手机' : pack.device === 'desktop' ? '来自电脑' : '';
  head.textContent = `设备包比对：[${[from, when].filter(Boolean).join(' · ') || '未注明来源'}]。逐项打勾或用选择器拍板，选完点「应用选择」。`;
  box.append(head);

  if (state.vocab) renderVocab(box);
  if (state.settings) renderSettings(box);
  if (state.keys) renderKeys(box);

  const foot = document.createElement('div');
  foot.className = 'row';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn primary';
  apply.textContent = '应用选择';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = '取消';
  const note = document.createElement('span');
  note.className = 'save-state';
  foot.append(apply, cancel, note);
  box.append(foot);

  const refresh = () => {
    const pending = countPending();
    apply.disabled = pending > 0;
    note.textContent = pending ? `还有 ${pending} 处冲突没选` : '没有未决冲突';
    note.className = pending ? 'save-state bad' : 'save-state';
  };
  // 各行的 change 处理器通过 state.refresh 重算「还有几处没选」（闭包跨越几个渲染函数）
  state.refresh = refresh;
  cancel.addEventListener('click', () => {
    box.hidden = true;
    box.innerHTML = '';
  });
  apply.addEventListener('click', () => applyChoices(apply, note));

  refresh();
}

function countPending() {
  let n = 0;
  for (const v of state.choices.values()) if (v == null) n += 1;
  return n;
}

// 一行标题 +（可选）本机/远端两栏
function block(title, subtitle) {
  const wrap = document.createElement('div');
  wrap.className = 'mig-block';
  const h = document.createElement('strong');
  h.className = 'mig-title';
  h.textContent = title;
  wrap.append(h);
  if (subtitle) {
    const s = document.createElement('span');
    s.className = 'mig-sub';
    s.textContent = subtitle;
    wrap.append(s);
  }
  return wrap;
}

// 冲突的三选一：[本机] [远端]（单选，必须拍板）
function pickRow(name, localLabel, remoteLabel, { key = null } = {}) {
  const row = document.createElement('div');
  row.className = 'mig-pick';
  if (key !== null) state.choices.set(key, null);
  for (const [value, label] of [['local', localLabel], ['remote', remoteLabel]]) {
    const l = document.createElement('label');
    l.className = 'row-inline';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `mig-${name}`;
    input.addEventListener('change', () => {
      state.choices.set(key ?? name, value);
      state.refresh?.();
    });
    l.append(input, document.createTextNode(` ${label}`));
    row.append(l);
  }
  return row;
}

const stateBadge = (s) => ({ same: '一致', conflict: '两边不同', 'one-sided': '只有一边有', differs: '有差异' })[s] || s;

// ---- 词表：按章节，并排 diff ----
function renderVocab(box) {
  const v = state.vocab;
  if (v.state === 'same') {
    box.append(block('词表', '两边一字不差，跳过'));
    return;
  }
  const differs = v.entries.filter((e) => e.state !== 'same');
  box.append(block('词表', `${differs.length} 处不一样（按章节对齐）`));
  for (const e of v.entries) {
    if (e.state === 'same') continue;
    const row = document.createElement('div');
    row.className = 'mig-item';
    const title = document.createElement('div');
    title.className = 'mig-item-head';
    title.textContent = e.section;
    const badge = document.createElement('span');
    badge.className = `tag mig-tag-${e.state}`;
    badge.textContent = stateBadge(e.state);
    title.append(' ', badge);
    row.append(title);

    if (e.state === 'conflict') {
      row.append(diffView(e.localText, e.remoteText));
      row.append(pickRow(`vocab-${e.section}`, '用本机的这一章', '用远端包里的这一章', { key: `vocab:${e.section}` }));
    } else if (e.localText === null) {
      row.append(remoteOnlyView(e.remoteText));
      const l = document.createElement('label');
      l.className = 'row-inline';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      state.choices.set(`vocab:${e.section}`, 'remote');
      c.addEventListener('change', () => {
        state.choices.set(`vocab:${e.section}`, c.checked ? 'remote' : 'skip');
        state.refresh?.();
      });
      l.append(c, document.createTextNode(' 采用远端包里的这一章'));
      row.append(l);
    } else {
      const l = document.createElement('label');
      l.className = 'row-inline';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      state.choices.set(`vocab:${e.section}`, 'local');
      c.addEventListener('change', () => {
        state.choices.set(`vocab:${e.section}`, c.checked ? 'local' : 'skip');
        state.refresh?.();
      });
      l.append(c, document.createTextNode(' 保留本机这一章（远端包没有）'));
      row.append(l);
    }
    box.append(row);
  }
}

function remoteOnlyView(text) {
  const pre = document.createElement('pre');
  pre.className = 'mig-diff';
  pre.textContent = text;
  return pre;
}

// 极简行级 diff：掐掉公共前缀/后缀，中间不同的行双栏并排、上色。
function diffView(localText, remoteText) {
  const l = (localText || '').split('\n');
  const r = (remoteText || '').split('\n');
  let pre = 0;
  while (pre < l.length && pre < r.length && l[pre] === r[pre]) pre += 1;
  let post = 0;
  while (post < l.length - pre && post < r.length - pre && l[l.length - 1 - post] === r[r.length - 1 - post]) post += 1;
  const lMid = l.slice(pre, l.length - post);
  const rMid = r.slice(pre, r.length - post);

  const grid = document.createElement('div');
  grid.className = 'mig-diff-grid';
  const col = (label, lines, cls) => {
    const c = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'mig-diff-head';
    h.textContent = label;
    c.append(h);
    const pre1 = document.createElement('pre');
    pre1.className = 'mig-diff';
    l.slice(0, pre).forEach((line) => {
      const d = document.createElement('div');
      d.className = 'mig-diff-line';
      d.textContent = line || ' ';
      pre1.append(d);
    });
    lines.forEach((line) => {
      const d = document.createElement('div');
      d.className = `mig-diff-line ${cls}`;
      d.textContent = line || ' ';
      pre1.append(d);
    });
    l.slice(l.length - post).forEach((line) => {
      const d = document.createElement('div');
      d.className = 'mig-diff-line';
      d.textContent = line || ' ';
      pre1.append(d);
    });
    c.append(pre1);
    return c;
  };
  grid.append(col('本机', lMid, 'local'), col('远端', rMid, 'remote'));
  return grid;
}

// ---- 设置：按字段 ----
function renderSettings(box) {
  const s = state.settings;
  if (s.state === 'same') {
    box.append(block('设置', '全部一致，跳过'));
    return;
  }
  const differs = s.fields.filter((f) => f.state !== 'same');
  box.append(block('设置', `${differs.length} 项不一样`));
  for (const f of s.fields) {
    if (f.state === 'same') continue;
    const row = document.createElement('div');
    row.className = 'mig-item';
    const title = document.createElement('div');
    title.className = 'mig-item-head';
    title.textContent = f.label;
    const badge = document.createElement('span');
    badge.className = `tag mig-tag-${f.state}`;
    badge.textContent = stateBadge(f.state);
    title.append(' ', badge);
    row.append(title);

    const vals = document.createElement('div');
    vals.className = 'mig-values';
    for (const [side, v] of [['本机', f.localValue], ['远端', f.remoteValue]]) {
      const line = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = `${side}：`;
      const code = document.createElement('code');
      code.textContent = formatValue(v);
      line.append(b, code);
      vals.append(line);
    }
    row.append(vals);

    if (f.state === 'conflict') {
      row.append(pickRow(`setting-${f.field}`, '用本机', '用远端', { key: `setting:${f.field}` }));
    } else {
      // 单边：该采用哪边由服务端判好（空数组、全 null 的提示词也算空），前端只照着摆
      const takeRemote = Boolean(f.takeRemote);
      const l = document.createElement('label');
      l.className = 'row-inline';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      state.choices.set(`setting:${f.field}`, takeRemote ? 'remote' : 'local');
      c.addEventListener('change', () => {
        state.choices.set(`setting:${f.field}`, c.checked ? (takeRemote ? 'remote' : 'local') : 'skip');
        state.refresh?.();
      });
      l.append(c, document.createTextNode(takeRemote ? ' 采用远端这一项' : ' 保留本机这一项'));
      row.append(l);
    }
    box.append(row);
  }
}

function formatValue(v) {
  if (v === null || v === undefined) return '（空）';
  if (typeof v === 'string') return v || '（空串）';
  return JSON.stringify(v);
}

// ---- 密钥：按名字，只报长度 ----
function renderKeys(box) {
  const k = state.keys;
  if (k.state === 'same') {
    box.append(block('密钥', '名字与值都一致，跳过'));
    return;
  }
  box.append(block('密钥', '只显示长度，不显示值；含改过的钥匙'));
  for (const e of k.entries) {
    if (e.state === 'same') continue;
    const row = document.createElement('div');
    row.className = 'mig-item';
    const title = document.createElement('div');
    title.className = 'mig-item-head';
    title.textContent = e.name;
    const badge = document.createElement('span');
    badge.className = `tag mig-tag-${e.state}`;
    badge.textContent = stateBadge(e.state);
    title.append(' ', badge);
    const desc = document.createElement('span');
    desc.className = 'mig-sub';
    desc.textContent = `本机 ${e.local ? `${e.localLen} 字符` : '没有'} · 远端 ${e.remote ? `${e.remoteLen} 字符` : '没有'}`;
    title.append(' ', desc);
    row.append(title);

    if (e.state === 'conflict') {
      row.append(pickRow(`key-${e.name}`, '保留本机的钥匙', '改用远端包的钥匙', { key: `key:${e.name}` }));
    } else if (!e.local) {
      const l = document.createElement('label');
      l.className = 'row-inline';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      state.choices.set(`key:${e.name}`, 'remote');
      c.addEventListener('change', () => {
        state.choices.set(`key:${e.name}`, c.checked ? 'remote' : 'skip');
        state.refresh?.();
      });
      l.append(c, document.createTextNode(' 导入这把钥匙'));
      row.append(l);
    } else {
      const l = document.createElement('label');
      l.className = 'row-inline';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      state.choices.set(`key:${e.name}`, 'local');
      c.addEventListener('change', () => {
        state.choices.set(`key:${e.name}`, c.checked ? 'local' : 'skip');
        state.refresh?.();
      });
      l.append(c, document.createTextNode(' 保留本机的钥匙（远端包没有）'));
      row.append(l);
    }
    box.append(row);
  }
}

// ---------------------------------------------------------------------------
// 应用选择：把词表按章节拼回去，设置/密钥按拍板结果合并，一次提交

function sectionsOf(text) {
  const map = new Map();
  let current = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^### (.+)$/.exec(line);
    if (m) current = m[1].trim();
    if (!map.has(current)) map.set(current, []);
    map.get(current).push(line);
  }
  for (const [k, v] of map) map.set(k, v.join('\n').replace(/\n+$/, ''));
  return map;
}

function assembleVocab() {
  const v = state.vocab;
  if (!v) return null;
  if (v.state === 'same') return null;
  const ls = sectionsOf(v.localText);
  const rs = sectionsOf(v.remoteText);
  // 全是远端且没有本机独有章节：原样用远端文本（不重排字节）
  const allRemote = v.entries.every((e) => state.choices.get(`vocab:${e.section}`) === 'remote');
  if (allRemote) return v.remoteText;
  const out = [];
  for (const [name, rtext] of rs) {
    const pick = state.choices.get(`vocab:${name === '' ? '' : name}`);
    const useLocal = pick === 'local';
    const text = useLocal ? ls.get(name) ?? rtext : rtext;
    if (name === '' && !text.trim()) continue;
    out.push(text);
  }
  for (const [name, ltext] of ls) {
    if (name === '') continue;
    const pick = state.choices.get(`vocab:${name}`);
    if (!rs.has(name) && pick === 'local') out.push(ltext);
  }
  return `${out.join('\n\n')}\n`;
}

async function applyChoices(apply, note) {
  const pack = state.pack;
  const settingsPatch = {};
  if (state.settings) {
    for (const f of state.settings.fields) {
      const pick = state.choices.get(`setting:${f.field}`);
      if (pick === 'remote') settingsPatch[f.field] = f.remoteValue;
    }
  }
  const keysPatch = {};
  if (state.keys) {
    for (const e of state.keys.entries) {
      if (state.choices.get(`key:${e.name}`) === 'remote' && pack.keys && e.name in pack.keys) keysPatch[e.name] = pack.keys[e.name];
    }
  }
  const payload = {};
  const vocabText = assembleVocab();
  if (vocabText !== null) payload.vocabText = vocabText;
  if (Object.keys(settingsPatch).length) payload.settings = settingsPatch;
  if (Object.keys(keysPatch).length) payload.keys = keysPatch;
  if (!Object.keys(payload).length) {
    report(note, '选择结果和本机没有差别，未写盘');
    return;
  }
  apply.disabled = true;
  note.textContent = '写入中…';
  note.className = 'save-state';
  try {
    const res = await api('/api/migrate/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const bits = [];
    if (res.vocab) bits.push(`词表 ${res.vocab.stats.total} 词（备份 ${res.vocab.backup}）`);
    if (res.settings) bits.push('设置已合并');
    if (res.keys) bits.push(`密钥 ${res.keys.length} 把`);
    const restart = payload.settings && ('port' in settingsPatch || 'lanAccess' in settingsPatch);
    report([note, $('#packState')], `已从设备包应用：${bits.join('、')}${restart ? ' · 端口/访问范围重启后生效' : ''}`);
    $('#packResult').hidden = true;
    $('#packResult').innerHTML = '';
    await reload();
  } catch (e) {
    report(note, `写入失败：${e.message}`, true);
    apply.disabled = false;
  }
}
