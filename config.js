import fs from 'node:fs';
import path from 'node:path';
import { moduleDir } from './dirname.js';

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function loadConfig({ dir = moduleDir(import.meta.url), env = process.env } = {}) {
  const envFile = path.join(dir, '.env');
  const src = { ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}), ...env };

  const envKeys = {};
  for (const [name, value] of Object.entries(src)) {
    if (name.startsWith('VOCAB_KEY_') && name.length > 10 && value) envKeys[name.slice(10)] = value;
  }

  // keys.json 是「补充密钥源」：移动版用 VOCAB_KEYS_FILE 指进应用沙盒；桌面版从设备包导入密钥时
  // 也会在项目目录里生成一份（工具绝不写 .env，D16 不变），此后自动被认出来。readKeys() 每次现读。
  const explicitKeysFile = src.VOCAB_KEYS_FILE || null;
  const defaultKeysFile = path.join(dir, 'keys.json');
  const resolveKeysFile = () => explicitKeysFile || (fs.existsSync(defaultKeysFile) ? defaultKeysFile : null);
  const readKeys = () => {
    const file = resolveKeysFile();
    return file ? { ...envKeys, ...readKeysFile(file) } : envKeys;
  };
  const keys = readKeys();

  return {
    dir,
    envFile,
    keys,
    get keysFile() {
      return resolveKeysFile();
    },
    readKeys,
    keyNames: Object.keys(keys),
    cefrFile: src.VOCAB_CEFR_FILE || path.join(dir, 'data', 'cefr.json'),
    backupDir: src.VOCAB_BACKUP_DIR || path.join(dir, 'backups'),
    settingsFile: src.VOCAB_SETTINGS_FILE || path.join(dir, 'settings.json'),
    stateDir: src.VOCAB_STATE_DIR || path.join(dir, '.state'),
  };
}

// 读密钥文件：形如 {名字: 值} 的 JSON。文件坏了就当没有，别让一把坏钥匙挡住整个服务。
export function readKeysFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
