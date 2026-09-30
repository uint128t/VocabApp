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

test('loadConfig picks up keys, port and the path overrides', () => {
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
  assert.deepEqual(c.keys, { QWEN: 'sk-one', ZHIPU: 'sk-two' });
  assert.deepEqual(c.keyNames, ['QWEN', 'ZHIPU']);
  assert.equal(c.port, 5318);
  assert.equal(c.backupDir, 'X:/backups');
  assert.equal(c.stateDir, 'X:/state');
});

test('loadConfig no longer decides the vocabulary path', () => {
  const dir = sandbox();
  // 词表路径归 settings.json 的 vocabFile 管；config 只认其余那几项
  const c = loadConfig({ dir, env: { VOCAB_FILE: path.join(dir, 'real.md') } });
  assert.equal(c.seedVocabFile, undefined);
  assert.equal(c.vocabFile, undefined);
  assert.equal(c.vocabMirror, undefined);
});
