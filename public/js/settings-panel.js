// 设置面板与主题：模型候选、提示词、主题循环、打开配置文件、设备迁移。

import { $, api, toast, fillSelect, activateTab } from './core.js';
import { initMigrate } from './migrate.js';

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

const THEME_KEY = 'vocab-theme';
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
// 顶栏按钮用两字版：「跟随系统」比「浅色/深色」宽两个汉字，系统字体一放大就把顶栏顶出横向滚动
// （用户实测：主题选跟随系统才会横向滚动）。设置页的下拉仍然写全「跟随系统」。
const THEME_BTN_LABEL = { auto: '自动', light: '浅色', dark: '深色' };
let settings = null;
let availableModels = [];
let keyNames = [];
// 平台与密钥存储方式决定两处界面：「打开 .env / settings.json」只有 Windows 有；
// 密钥值管理（只写不读）只在移动版有——桌面版的密钥在 .env 里，工具绝不写它（D16）。
let platform = 'unknown';
let keysFile = null;
let pickerMounted = false;

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
  $('#themeBtn').textContent = `主题·${THEME_BTN_LABEL[mode] || THEME_BTN_LABEL.auto}`;
  $('#themeBtn').title = `切换深浅色（当前：${THEME_LABEL[mode] || THEME_LABEL.auto}）`;
}

function setSaveState(message, bad) {
  const el = $('#saveState');
  el.textContent = message;
  el.className = bad ? 'save-state bad' : 'save-state';
}

const VOCAB_NOTE = '指向真实的词表文件（Obsidian 库里那份）。保存后立即生效，不用重启服务；留空或文件不存在会被驳回。';
const VOCAB_NOTE_MOBILE = '手机上词表默认住应用沙盒；用上面的「选取词表文件…」可以直接切到外部文件（放进 Syncthing 同步的文件夹就能自动同步）。';

function showVocabNote(problem) {
  const el = $('#vocabFileNote');
  if (problem) {
    el.textContent = `当前读不了词表：${problem}。把路径改对再保存。`;
  } else {
    // 移动版没有「Obsidian 库里的路径」这回事，别让手机用户去找一个不存在的文件
    el.textContent = keysFile ? VOCAB_NOTE_MOBILE : VOCAB_NOTE;
  }
  el.className = problem ? 'hint bad' : 'hint';
}

// 词表路径一变，词表面板里显示的数据就过期了。由入口把 loadEntries 接进来，
// 免得 settings-panel 反过来 import vocab-list 形成环。
let vocabFileReload = null;

export function setVocabFileReload(fn) {
  vocabFileReload = fn;
}

// 保存设置后要让学习/复习那两个面板重新对一遍（反馈语言的默认值、可抽数量的上限）。
// 同 setVocabFileReload：由入口把刷新函数接进来，免得 settings-panel 反过来 import 面板。
let panelsReload = null;

export function setPanelsReload(fn) {
  panelsReload = fn;
}

async function saveSettings(patch, notice) {
  const before = settings ? settings.vocabFile : null;
  const beforePort = settings ? settings.port : null;
  const beforeLan = settings ? settings.lanAccess : null;
  setSaveState('保存中…');
  try {
    const body = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const switched = body.settings.vocabFile !== before;
    // 端口与访问范围只在启动时读一次：改了它们要重启服务才生效（D44）。
    const restart = body.settings.port !== beforePort || body.settings.lanAccess !== beforeLan;
    settings = body.settings;
    applyTheme(settings.theme);
    syncSettingDefaults();
    showVocabNote(body.vocabFileError);
    setSaveState(`已保存 ${new Date().toLocaleTimeString()}${restart ? ' · 端口/访问范围重启后生效' : ''}`);
    if (notice) toast(restart ? `${notice} · 端口或访问范围改了，重启服务后生效` : notice);
    if (switched && vocabFileReload) await vocabFileReload();
    if (panelsReload) await panelsReload();
    return true;
  } catch (e) {
    setSaveState(`保存失败：${e.message}`, true);
    toast(e.message, 'bad');
    return false;
  }
}

function syncSettingDefaults() {
  $('#setTheme').value = settings.theme;
  $('#setLang').value = settings.lang;
  fillSelect($('#model'), availableModels, settings.model || $('#model').value);
  fillSelect($('#setModel'), availableModels);
  $('#setModel').value = settings.model || '';
}

function renderModelChips() {
  const box = $('#modelList');
  box.innerHTML = '';
  // 这里只列候选，默认模型看上面那个下拉；候选为空时给一句提示。
  if (!settings.extraModels.length) {
    const label = document.createElement('span');
    label.className = 'hint';
    label.textContent = '还没有候选模型。';
    box.append(label);
    return;
  }
  for (const m of settings.extraModels) {
    const chip = document.createElement('span');
    chip.className = 'already';
    chip.textContent = modelLabel(m);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      settings.extraModels = settings.extraModels.filter((x) => x.name !== m.name);
      // 默认模型不在候选里也始终保留：服务端的 models 就是 [默认, ...候选] 去重，
      // 这里少算它的话，顶栏那个模型下拉会悄悄把默认模型挤掉。
      availableModels = [...new Set([settings.model, ...settings.extraModels.map((x) => x.name)].filter(Boolean))];
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
    $('#vocabFile').value = body.vocabFile || '';
    $('#setPort').value = String(settings.port ?? 5317);
    $('#setLan').checked = Boolean(settings.lanAccess);
    platform = body.platform || 'unknown';
    keysFile = body.keysFile || null;
    // keysFile 定下来再写词表备注：移动版与桌面版的措辞不同
    showVocabNote(body.vocabFileError);
    $('#openEnv').hidden = $('#openSettings').hidden = platform !== 'win32';
    $('#keysRow').hidden = $('#keysEditRow').hidden = $('#keysHint').hidden = !keysFile;
    // 词表路径旁的「浏览…（桌面）/选取词表文件…（手机）」按平台挂一次（重复 loadSettings 不重复挂）
    if (!pickerMounted) {
      pickerMounted = true;
      mountVocabPicker({ platform, isLocal: Boolean(body.local), isMobile: Boolean(keysFile) });
    }
    // 移动版没有 .env，那段「密钥写在 .env 里」的说明换成沙盒口径，别让手机用户去找不存在的文件
    if (keysFile) {
      $('#modelHint').textContent =
        '模型全部平级地保存在应用沙盒的 settings.json（「添加」后记得「保存设置」），每个模型自带接入点、密钥名与可选附加参数。密钥值用上面的「密钥管理」保存，只选名字、不回显。';
    }
    renderKeyNames();
    // 没密钥的提示按存储方式说人话：桌面密钥在 .env，移动版在应用沙盒里
    $('#keyFlag').textContent = body.hasKey ? '' : body.keysFile ? '还没有任何密钥' : '.env 里没有密钥';
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
    vocabFile: $('#vocabFile').value.trim(),
    theme: $('#setTheme').value,
    lang: $('#setLang').value,
    // 端口交字符串让服务端统一校验（1024–65535 的整数），填坏了驳回时带明确文案
    port: $('#setPort').value.trim(),
    lanAccess: $('#setLan').checked,
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

function renderKeyNames() {
  const el = $('#keyNamesLine');
  el.textContent = keyNames.length ? `已存密钥：${keyNames.join('、')}（值不回显）` : '还没有任何密钥';
}

$('#saveKey').addEventListener('click', async () => {
  const name = $('#newKeyName').value.trim();
  const value = $('#newKeyValue').value;
  const state = $('#keysState');
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    state.textContent = '密钥名只能用字母、数字和下划线';
    state.className = 'save-state bad';
    return;
  }
  if (!value.trim()) {
    state.textContent = '密钥值不能为空';
    state.className = 'save-state bad';
    return;
  }
  state.textContent = '保存中…';
  state.className = 'save-state';
  try {
    const res = await api('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: { [name]: value } }),
    });
    $('#newKeyValue').value = '';
    keyNames = res.keyNames;
    renderKeyNames();
    // 新密钥顺手选进「新增候选」的密钥下拉里
    fillSelect($('#newModelKey'), keyNames, name);
    state.textContent = `已保存 ${name}（值不再回显）`;
    state.className = 'save-state';
  } catch (e) {
    state.textContent = `保存失败：${e.message}`;
    state.className = 'save-state bad';
  }
});

// 导出：服务端带附件头，落地成一份 Markdown 下载。
$('#exportVocab').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/vocab/export';
  a.download = `Vocabulary-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(a);
  a.click();
  a.remove();
});

// 导入走两步确认（同「删除」的 armed 模式）：选好文件先亮出确认键，5 秒内再点才真正替换。
let importArmTimer = null;
$('#importVocab').addEventListener('click', () => {
  const btn = $('#importVocab');
  if (!btn.dataset.armed) {
    $('#importVocabFile').click();
    return;
  }
  clearTimeout(importArmTimer);
  delete btn.dataset.armed;
  btn.textContent = '从文件导入并替换…';
  doImport($('#importVocabFile').files[0]);
});

$('#importVocabFile').addEventListener('change', () => {
  const btn = $('#importVocab');
  const file = $('#importVocabFile').files[0];
  if (!file) return;
  btn.dataset.armed = '1';
  btn.textContent = `确认导入 ${file.name}（替换当前词表）`;
  clearTimeout(importArmTimer);
  importArmTimer = setTimeout(() => {
    delete btn.dataset.armed;
    btn.textContent = '从文件导入并替换…';
    $('#importVocabFile').value = '';
  }, 5000);
});

async function doImport(file, stateEl = $('#vocabTransfer')) {
  const state = stateEl;
  if (!file) return;
  if (file.size > 900_000) {
    state.textContent = '文件超过 1MB 上限';
    state.className = 'save-state bad';
    return;
  }
  state.textContent = '导入中…';
  state.className = 'save-state';
  try {
    const text = await file.text();
    const res = await api('/api/vocab/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    state.textContent = `已导入 ${res.stats.total} 词 · 备份 ${res.backup}`;
    state.className = 'save-state';
    // 词表刚被整份替换，词表面板的数据要跟着重读（loadEntries 由入口接进来，避免 import 环）
    if (vocabFileReload) await vocabFileReload();
    toast(`词表已导入 ${res.stats.total} 词 · 备份 ${res.backup}`);
  } catch (e) {
    state.textContent = `导入失败：${e.message}`;
    state.className = 'save-state bad';
  } finally {
    $('#importVocabFile').value = '';
    const btn = $('#importVocab');
    delete btn.dataset.armed;
    btn.textContent = '从文件导入并替换…';
  }
}

// 词表路径旁的「选取」（D47/D48）。两端各一套、都落到同一个动作——**直接在选中的文件上读写**：
//  · Windows 桌面（且就在本机开页面）：调 /api/pick-file 弹原生文件框，选中即切过去；
//  · 安卓 App：跳去 Capacitor 桥页（那里才有原生插件）先要「所有文件访问」权限再弹系统文件
//    选择器，带着真实路径回来接着切（?picked=…）。
//  · 其他情况（如从手机浏览器访问电脑）：两个按钮都不显示，路径手填。
function mountVocabPicker({ platform, isLocal, isMobile }) {
  const hint = $('#pickHint');

  const say = (text, bad = false) => {
    hint.hidden = false;
    hint.textContent = text;
    hint.className = bad ? 'save-state bad' : 'save-state';
  };

  // 把「某个已有文件」切成当前词表（服务端负责校验、探写、空文件写入与切换）
  async function applyPickedPath(picked) {
    if (!picked) return;
    say('检查这个文件…');
    try {
      const res = await api('/api/vocab/use-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: picked }),
      });
      say(`已切到 ${res.vocabFile}（${res.stats.total} 词${res.copied ? '，已把当前词表写了过去' : ''}）——之后都在这个文件上读写`);
      toast(`词表现在是 ${res.vocabFile} 里那一份（${res.stats.total} 词）`);
      await loadSettings();
      if (vocabFileReload) await vocabFileReload();
    } catch (e) {
      // 没权限/读不了：手机上去桥页要权限再重选；桌面把原因摆出来
      if (e.code === 'externalDenied' && isMobile) {
        openBridgePicker();
        return;
      }
      say(`没切成：${e.message}`, true);
    }
  }

  function openBridgePicker() {
    const back = `${location.origin}/?ptab=settings`;
    location.href = `https://localhost/storage.html?mode=pick&back=${encodeURIComponent(back)}`;
  }

  if (platform === 'win32' && isLocal) {
    const browse = $('#pickVocab');
    browse.hidden = false;
    browse.addEventListener('click', async () => {
      say('等你在弹出的文件框里选…');
      browse.disabled = true;
      try {
        const res = await api('/api/pick-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!res.path) {
          say('已取消选择');
          return;
        }
        await applyPickedPath(res.path);
      } catch (e) {
        say(`打开文件框失败：${e.message}`, true);
      } finally {
        browse.disabled = false;
      }
    });
  } else if (isMobile) {
    $('#pickVocabMobile').hidden = false;
    $('#pickVocabMobile').addEventListener('click', openBridgePicker);
  }

  // 从桥页跳回来：带着选好的路径（或取消标记）——自动接着切
  const params = new URLSearchParams(location.search);
  if (params.get('ptab') === 'settings') activateTab('settings');
  const picked = params.get('picked');
  const cancelled = params.get('pick') === 'none';
  if (picked || cancelled) {
    history.replaceState(null, '', location.pathname);
    if (picked) setTimeout(() => applyPickedPath(picked), 300);
    else say('已取消选择');
  }
}

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
$('#saveSettings').addEventListener('click', () => {
  if (!settings) {
    toast('设置还没读出来，先点右上角「重新读取」', 'bad');
    return;
  }
  saveSettings(settingsFromForm(), '设置已保存');
});
$('#resetSettings').addEventListener('click', () =>
  saveSettings(
    { model: null, extraModels: [], lang: 'zh', theme: 'auto', port: 5317, lanAccess: false, prompts: { entry: null, judge: null } },
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

// 设备迁移模块用这套收尾：把设置与词表重新读一遍，轮次面板也对一遍
initMigrate({
  reload: async () => {
    await loadSettings();
    if (vocabFileReload) await vocabFileReload();
    if (panelsReload) await panelsReload();
  },
});

export { settings, loadSettings };
