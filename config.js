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

  const vocabFile = src.VOCAB_FILE || path.join(dir, 'Vocabulary.md');
  const mirror = path.join(dir, 'Vocabulary.md');
  // 镜像只在「词表与本目录那份 Vocabulary.md 其实是同一个文件」时才成立。
  // 指到别处（沙盒副本、换台机器）必须关掉：否则两边 inode 不同，兜底逻辑会按
  // 时间戳把其中一份的内容盖到另一份上，等于拿沙盒副本污染真表。
  const mirrorIsSameFile = (() => {
    try {
      return fs.realpathSync(vocabFile) === fs.realpathSync(mirror);
    } catch {
      return false;
    }
  })();

  return {
    dir,
    envFile,
    keys,
    keyNames: Object.keys(keys),
    vocabFile,
    vocabMirror: mirrorIsSameFile ? mirror : null,
    cefrFile: src.VOCAB_CEFR_FILE || path.join(dir, 'data', 'cefr.json'),
    backupDir: src.VOCAB_BACKUP_DIR || path.join(dir, 'backups'),
    settingsFile: src.VOCAB_SETTINGS_FILE || path.join(dir, 'settings.json'),
    stateDir: src.VOCAB_STATE_DIR || path.join(dir, '.state'),
    port: Number(src.PORT || 5317),
  };
}
