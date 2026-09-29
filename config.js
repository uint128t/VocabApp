import fs from 'node:fs';
import path from 'node:path';

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

export function loadConfig({ dir = import.meta.dirname, env = process.env } = {}) {
  const envFile = path.join(dir, '.env');
  const src = { ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}), ...env };

  const keys = {};
  for (const [name, value] of Object.entries(src)) {
    if (name.startsWith('VOCAB_KEY_') && name.length > 10 && value) keys[name.slice(10)] = value;
  }

  return {
    dir,
    envFile,
    keys,
    keyNames: Object.keys(keys),
    vocabFile: src.VOCAB_FILE || path.join(dir, 'Vocabulary.md'),
    vocabMirror: path.join(dir, 'Vocabulary.md'),
    cefrFile: src.VOCAB_CEFR_FILE || path.join(dir, 'data', 'cefr.json'),
    backupDir: src.VOCAB_BACKUP_DIR || path.join(dir, 'backups'),
    settingsFile: src.VOCAB_SETTINGS_FILE || path.join(dir, 'settings.json'),
    stateDir: src.VOCAB_STATE_DIR || path.join(dir, '.state'),
    port: Number(src.PORT || 5317),
  };
}
