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

  // 移动版（D45）没有可编辑的 .env：密钥值放应用沙盒里的一个 JSON 文件（VOCAB_KEYS_FILE 指过去），
  // 而且运行期可以增改（/api/keys），所以 readKeys() 每次现读。桌面版不设 keysFile，
  // 行为照旧——.env 仍是密钥的唯一来源，工具绝不写它。
  const keysFile = src.VOCAB_KEYS_FILE || null;
  const keys = keysFile ? { ...envKeys, ...readKeysFile(keysFile) } : envKeys;

  return {
    dir,
    envFile,
    keys,
    keysFile,
    readKeys: () => (keysFile ? { ...envKeys, ...readKeysFile(keysFile) } : keys),
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
