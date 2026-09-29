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

test('loadConfig falls back to this folder and keeps the mirror when VOCAB_FILE is unset', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'Vocabulary.md'), '### A\n');
  const c = loadConfig({ dir, env: {} });
  assert.equal(c.vocabFile, path.join(dir, 'Vocabulary.md'));
  assert.equal(c.vocabMirror, path.join(dir, 'Vocabulary.md'));
});

test('loadConfig keeps the mirror when VOCAB_FILE resolves to the same file', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'real.md'), '### A\n');
  fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'Vocabulary.md'), 'file');
  const c = loadConfig({ dir, env: { VOCAB_FILE: path.join(dir, 'real.md') } });
  assert.equal(c.vocabFile, path.join(dir, 'real.md'));
  assert.equal(c.vocabMirror, path.join(dir, 'Vocabulary.md'));
});

test('loadConfig drops the mirror when the vocabulary file lives elsewhere', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'Vocabulary.md'), '### A\n');
  fs.writeFileSync(path.join(dir, 'copy.md'), '### B\n');
  const c = loadConfig({ dir, env: { VOCAB_FILE: path.join(dir, 'copy.md') } });
  assert.equal(c.vocabFile, path.join(dir, 'copy.md'));
  assert.equal(c.vocabMirror, null);
});

test('loadConfig drops the mirror when the target does not exist yet', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'Vocabulary.md'), '### A\n');
  const c = loadConfig({ dir, env: { VOCAB_FILE: path.join(dir, 'not-there.md') } });
  assert.equal(c.vocabMirror, null);
});
