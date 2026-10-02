import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnv, loadConfig } from '../config.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-config-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseEnv keeps key=value pairs and ignores comments and blanks', () => {
  assert.deepEqual(parseEnv('# note\n\nVOCAB_KEY_QWEN=abc\nPORT=5318\nbroken\n'), {
    VOCAB_KEY_QWEN: 'abc',
    PORT: '5318',
  });
});

test('loadConfig 只管密钥与路径覆盖（端口与词表路径都归 settings.json）', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'Vocabulary.md'), '### A\n');
  const c = loadConfig({
    dir,
    env: {
      VOCAB_KEY_QWEN: 'sk-one',
      VOCAB_KEY_ZHIPU: 'sk-two',
      VOCAB_KEY_EMPTY: '',
      PORT: '5318',
      VOCAB_BACKUP_DIR: 'X:/backups',
      VOCAB_STATE_DIR: 'X:/state',
    },
  });
  assert.deepEqual(c.readKeys(), { QWEN: 'sk-one', ZHIPU: 'sk-two' });
  // 端口归 settings.json 的 port 管（D44）：.env 里的 PORT 从此只是没人读的死数据
  assert.equal(c.port, undefined);
  assert.equal(c.backupDir, 'X:/backups');
  assert.equal(c.stateDir, 'X:/state');
});

test('config 不碰词表路径', () => {
  const dir = sandbox();
  // 词表路径归 settings.json 的 vocabFile 管；config 只认其余那几项
  const c = loadConfig({ dir, env: { VOCAB_FILE: path.join(dir, 'real.md') } });
  assert.equal(c.seedVocabFile, undefined);
  assert.equal(c.vocabFile, undefined);
  assert.equal(c.vocabMirror, undefined);
});

test('VOCAB_KEYS_FILE merges key values and readKeys() picks up live changes', () => {
  const dir = sandbox();
  const keysFile = path.join(dir, 'keys.json');
  fs.writeFileSync(keysFile, JSON.stringify({ MOBILE: 'sk-m1' }));
  const c = loadConfig({ dir, env: { VOCAB_KEYS_FILE: keysFile, VOCAB_KEY_ENV: 'sk-env' } });
  assert.deepEqual(c.readKeys(), { ENV: 'sk-env', MOBILE: 'sk-m1' });
  assert.equal(c.keysFile, keysFile);

  // /api/keys 写完文件后，readKeys() 现读就能看到，不用重启
  fs.writeFileSync(keysFile, JSON.stringify({ MOBILE: 'sk-m2', NEW: 'sk-n1' }));
  assert.deepEqual(c.readKeys(), { ENV: 'sk-env', MOBILE: 'sk-m2', NEW: 'sk-n1' });
});

test('项目目录里的 keys.json 不用环境变量也会被认出来（设备包导入的落点，D46）', () => {
  const bare = sandbox();
  // 没有 keys.json 也没有环境变量：只有 .env 的密钥，keysFile 为空
  const none = loadConfig({ dir: bare, env: { VOCAB_KEY_ENV: 'sk-env' } });
  assert.equal(none.keysFile, null);
  assert.deepEqual(none.readKeys(), { ENV: 'sk-env' });

  // 迁移导入写出 keys.json 之后（无需环境变量）：自动并入，且每次现值
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ IMPORTED: 'sk-i1' }));
  const c = loadConfig({ dir, env: { VOCAB_KEY_ENV: 'sk-env' } });
  assert.equal(c.keysFile, path.join(dir, 'keys.json'));
  assert.deepEqual(c.readKeys(), { ENV: 'sk-env', IMPORTED: 'sk-i1' });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ IMPORTED: 'sk-i2' }));
  assert.deepEqual(c.readKeys(), { ENV: 'sk-env', IMPORTED: 'sk-i2' });
});
