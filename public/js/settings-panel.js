// 设置面板与主题：模型候选、提示词、主题循环、打开配置文件。

import { $, api, toast, fillSelect } from './core.js';

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
let settings = null;
let availableModels = [];
let keyNames = [];

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
  $('#themeBtn').textContent = `主题·${THEME_LABEL[mode] || THEME_LABEL.auto}`;
}

function setSaveState(message, bad) {
  const el = $('#saveState');
  el.textContent = message;
  el.className = bad ? 'save-state bad' : 'save-state';
}

const VOCAB_NOTE = '指向真实的词表文件（Obsidian 库里那份）。保存后立即生效，不用重启服务；留空或文件不存在会被驳回。';

function showVocabNote(problem) {
  const el = $('#vocabFileNote');
  el.textContent = problem ? `当前读不了词表：${problem}。把路径改对再保存。` : VOCAB_NOTE;
  el.className = problem ? 'hint bad' : 'hint';
}

// 词表路径一变，词表面板里显示的数据就过期了。由入口把 loadEntries 接进来，
// 免得 settings-panel 反过来 import vocab-list 形成环。
let vocabFileReload = null;

export function setVocabFileReload(fn) {
  vocabFileReload = fn;
}

async function saveSettings(patch, notice) {
  const before = settings ? settings.vocabFile : null;
  setSaveState('保存中…');
  try {
    const body = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const switched = body.settings.vocabFile !== before;
    settings = body.settings;
    applyTheme(settings.theme);
    syncSettingDefaults();
    showVocabNote(body.vocabFileError);
    setSaveState(`已保存 ${new Date().toLocaleTimeString()}`);
    if (notice) toast(notice);
    if (switched && vocabFileReload) await vocabFileReload();
    return true;
  } catch (e) {
    setSaveState(`保存失败：${e.message}`, true);
    toast(e.message, 'bad');
    return false;
  }
}

function syncSettingDefaults() {
  $('#learnLang').value = settings.lang;
  $('#reviewLang').value = settings.lang;
  $('#setTheme').value = settings.theme;
  $('#setLang').value = settings.lang;
  fillSelect($('#model'), availableModels, settings.model || $('#model').value);
  fillSelect($('#setModel'), availableModels);
  $('#setModel').value = settings.model || '';
}

function renderModelChips() {
  const box = $('#modelList');
  box.innerHTML = '';
  // 默认模型上面那个下拉已经写着，这里不再重复一遍；只有候选为空时给一句提示。
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
      availableModels = [...new Set(settings.extraModels.map((x) => x.name))];
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
    showVocabNote(body.vocabFileError);
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
$('#saveSettings').addEventListener('click', () => saveSettings(settingsFromForm(), '设置已保存'));
$('#resetSettings').addEventListener('click', () =>
  saveSettings(
    { model: null, extraModels: [], lang: 'zh', theme: 'auto', prompts: { entry: null, judge: null } },
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

export { settings, loadSettings };
