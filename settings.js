export const DEFAULTS = {
  vocabFile: null,
  model: null,
  extraModels: [],
  lang: 'zh',
  theme: 'auto',
  prompts: { entry: null, judge: null },
};

const THEMES = new Set(['auto', 'light', 'dark']);
const LANGS = new Set(['zh', 'en']);
const PROMPT_KEYS = ['entry', 'judge'];
const PROMPT_MAX = 4000;

const bad = (message) => ({ error: { code: 'badSettings', message } });
const cloneDefaults = () => structuredClone(DEFAULTS);

function normalizePrompt(value, label) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > PROMPT_MAX) throw new Error(`${label} 超过 ${PROMPT_MAX} 字符`);
  return trimmed;
}

function normalizeModel(entry, keyNames) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('extraModels 只能包含对象');
  const raw = entry;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error('模型名不能为空');

  if (typeof raw.baseUrl !== 'string' || !/^https?:\/\/\S+$/.test(raw.baseUrl.trim())) {
    throw new Error(`${name} 的接入点必须是 http(s) 地址`);
  }
  const baseUrl = raw.baseUrl.trim().replace(/\/+$/, '');

  if (typeof raw.keyName !== 'string' || !raw.keyName.trim()) throw new Error(`${name} 的密钥名不能为空`);
  const keyName = raw.keyName.trim();
  if (keyNames && !keyNames.includes(keyName)) {
    throw new Error(`.env 里没有名为 ${keyName} 的密钥（用 VOCAB_KEY_${keyName}=… 添加）`);
  }

  let extra;
  if (raw.extra !== undefined && raw.extra !== null) {
    if (!raw.extra || typeof raw.extra !== 'object' || Array.isArray(raw.extra)) {
      throw new Error(`${name} 的附加参数必须是 JSON 对象`);
    }
    let text;
    try {
      text = JSON.stringify(raw.extra);
    } catch {
      throw new Error(`${name} 的附加参数无法序列化`);
    }
    if (text.length > 2000) throw new Error(`${name} 的附加参数过长`);
    extra = JSON.parse(text);
  }

  return { name, baseUrl, keyName, ...(extra ? { extra } : {}) };
}

export function mergeSettings(current, patch, { keyNames } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return bad('设置必须是对象');
  const next = structuredClone(current);

  try {
    if ('vocabFile' in patch) {
      const v = patch.vocabFile;
      // undefined = 没给，不动；null = 显式清空（读一份「还没设置」的设置文件时也是它）；
      // 给了字符串就必须非空白，空串一律驳回（设置页那条是必填）。
      if (v === null) next.vocabFile = null;
      else if (v !== undefined) {
        if (typeof v !== 'string' || !v.trim()) throw new Error('词表路径不能为空');
        next.vocabFile = v.trim();
      }
    }
    if ('model' in patch) {
      const m = patch.model;
      if (m !== null && (typeof m !== 'string' || !m.trim())) throw new Error('model 必须是非空字符串或 null');
      next.model = m === null ? null : m.trim();
    }
    if ('extraModels' in patch) {
      if (!Array.isArray(patch.extraModels)) throw new Error('extraModels 必须是数组');
      const list = [];
      for (const entry of patch.extraModels) {
        const model = normalizeModel(entry, keyNames);
        if (!list.some((m) => m.name === model.name)) list.push(model);
      }
      next.extraModels = list;
    }
    if ('lang' in patch) {
      if (!LANGS.has(patch.lang)) throw new Error('lang 只能是 zh 或 en');
      next.lang = patch.lang;
    }
    if ('theme' in patch) {
      if (!THEMES.has(patch.theme)) throw new Error('theme 只能是 auto、light 或 dark');
      next.theme = patch.theme;
    }
    if ('prompts' in patch) {
      const p = patch.prompts;
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('prompts 必须是对象');
      for (const key of PROMPT_KEYS) {
        const value = normalizePrompt(p[key], `prompts.${key}`);
        if (value !== undefined) next.prompts[key] = value;
      }
    }
  } catch (e) {
    return bad(e.message);
  }

  return { settings: next };
}

export function modelEndpoints({ settings, keys = {} }) {
  const out = {};
  for (const model of settings.extraModels || []) {
    out[model.name] = {
      baseUrl: model.baseUrl,
      apiKey: keys[model.keyName] || '',
      ...(model.extra ? { extra: model.extra } : {}),
    };
  }
  return out;
}

export function createSettings({ stateFile, keyNames }) {
  const options = { keyNames };
  const get = () => {
    let raw;
    try {
      raw = stateFile.read();
    } catch (e) {
      return { settings: cloneDefaults(), error: { code: 'settingsUnreadable', message: e.message } };
    }
    if (raw === null) return { settings: cloneDefaults(), error: null };

    const merged = mergeSettings(cloneDefaults(), raw, options);
    if (merged.error) {
      return { settings: cloneDefaults(), error: { code: 'settingsUnreadable', message: merged.error.message } };
    }
    return { settings: merged.settings, error: null };
  };

  const patch = (changes) => {
    const out = mergeSettings(get().settings, changes, options);
    if (out.error) return out;
    stateFile.write(out.settings);
    return { settings: out.settings, error: null };
  };

  return { get, patch };
}
