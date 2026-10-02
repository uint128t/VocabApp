import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, createSettings, modelEndpoints } from '../settings.js';
import { createStateFile } from '../state-file.js';

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup({ keyNames } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-settings-'));
  dirs.push(dir);
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'VOCAB_KEY_TEST=sk-do-not-touch\n');
  const file = path.join(dir, 'settings.json');
  const stateFile = createStateFile({ file });
  return { dir, file, envFile, settings: createSettings({ stateFile, keyNames }) };
}

test('defaults apply when there is no settings file', () => {
  const { settings } = setup();
  const out = settings.get();
  assert.equal(out.error, null);
  assert.deepEqual(out.settings, DEFAULTS);
  assert.deepEqual(DEFAULTS, {
    vocabFile: null,
    model: null,
    extraModels: [],
    lang: 'zh',
    theme: 'auto',
    port: 5317,
    lanAccess: false,
    prompts: { entry: null, judge: null },
  });
});

test('port and lanAccess validate: 数字串收、越界与非整数驳回、驳回了不动盘', () => {
  const { file, settings } = setup();
  const ok = settings.patch({ port: '5318', lanAccess: true });
  assert.equal(ok.error, null);
  assert.equal(ok.settings.port, 5318, '设置页交来的是字符串，转成数字落盘');
  assert.equal(ok.settings.lanAccess, true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.port, 5318);
  assert.equal(written.lanAccess, true);

  const before = fs.readFileSync(file);
  for (const bad of ['abc', '', '   ', 80, 70000, 5317.5, null, true, [5318]]) {
    assert.equal(settings.patch({ port: bad }).error.code, 'badSettings', JSON.stringify(bad));
  }
  assert.equal(settings.patch({ lanAccess: 'yes' }).error.code, 'badSettings');
  assert.deepEqual(fs.readFileSync(file), before, '非法值一个字节都不写');
  assert.equal(settings.get().settings.port, 5318);
});

test('vocabFile 必填：空串与空白被驳回，null 只表示还没设置', () => {
  const { settings, file } = setup();
  for (const bad of ['', '   ', 42]) {
    assert.equal(settings.patch({ vocabFile: bad }).error.code, 'badSettings', JSON.stringify(bad));
  }
  assert.ok(!fs.existsSync(file), '全被驳回就不该落盘');

  const ok = settings.patch({ vocabFile: '  C:/Notes/Vocabulary.md  ' });
  assert.equal(ok.error, null);
  assert.equal(ok.settings.vocabFile, 'C:/Notes/Vocabulary.md', '存之前去掉首尾空白');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vocabFile, 'C:/Notes/Vocabulary.md');

  // null 是合法状态：读一份「还没设置」的设置文件时就是它
  assert.equal(settings.patch({ vocabFile: null }).error, null);
  assert.equal(settings.get().settings.vocabFile, null);
});

test('a corrupt settings file is reported, not silently rewritten', () => {
  const { file, settings } = setup();
  fs.writeFileSync(file, '{oops');
  const before = fs.readFileSync(file);
  const out = settings.get();
  assert.equal(out.error.code, 'settingsUnreadable');
  assert.deepEqual(out.settings, DEFAULTS);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('patch validates, merges and persists', () => {
  const { file, settings } = setup();
  const out = settings.patch({ theme: 'dark', lang: 'en', model: 'qwen-max' });
  assert.equal(out.error, null);
  assert.equal(out.settings.theme, 'dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark');
  assert.deepEqual(settings.get().settings, out.settings);
});

test('unknown keys are ignored', () => {
  const { file, settings } = setup();
  const out = settings.patch({ evil: 1, theme: 'dark' });
  assert.equal(out.error, null);
  assert.ok(!('evil' in out.settings));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('evil'));
});

test('invalid values are rejected and leave the file untouched', () => {
  const { file, settings } = setup();
  settings.patch({ theme: 'dark' });
  const before = fs.readFileSync(file);
  const cases = [
    { theme: 'neon' },
    { lang: 'fr' },
    { model: 42 },
    { extraModels: ['ok', '  '] },
    { extraModels: 'qwen-max' },
    { prompts: { judge: 12 } },
    { prompts: { entry: 'x'.repeat(4001) } },
  ];
  for (const patch of cases) {
    const out = settings.patch(patch);
    assert.equal(out.error.code, 'badSettings', JSON.stringify(patch));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  assert.equal(settings.get().settings.theme, 'dark');
});

test('clearing a prompt restores its default', () => {
  const { settings } = setup();
  settings.patch({ prompts: { entry: 'MY RULES' } });
  assert.equal(settings.get().settings.prompts.entry, 'MY RULES');
  settings.patch({ prompts: { entry: '   ' } });
  assert.equal(settings.get().settings.prompts.entry, null);
});

test('a partial prompt patch keeps the other overrides', () => {
  const { settings } = setup();
  settings.patch({ prompts: { entry: 'D' } });
  settings.patch({ prompts: { judge: 'J' } });
  const { prompts } = settings.get().settings;
  assert.deepEqual(prompts, { entry: 'D', judge: 'J' });
});

test('custom models may carry their own endpoint and key name', () => {
  const { settings } = setup({ keyNames: ['QWEN', 'ZHIPU'] });
  const out = settings.patch({
    extraModels: [
      { name: 'qwen3.8-flash', baseUrl: 'https://dashscope.test/compatible-mode/v1/', keyName: 'QWEN' },
      { name: 'glm-4.5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyName: 'ZHIPU' },
    ],
  });
  assert.equal(out.error, null);
  assert.deepEqual(out.settings.extraModels, [
    { name: 'qwen3.8-flash', baseUrl: 'https://dashscope.test/compatible-mode/v1', keyName: 'QWEN' },
    { name: 'glm-4.5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyName: 'ZHIPU' },
  ]);
  assert.deepEqual(settings.get().settings.extraModels, out.settings.extraModels);
});

test('a model can carry its own extra request params', () => {
  const { settings } = setup();
  const out = settings.patch({
    extraModels: [{ name: 'glm-5.3-flash', baseUrl: 'https://z.test/v4', keyName: 'ZHIPU', extra: { thinking: { type: 'low' } } }],
  });
  assert.equal(out.error, null);
  assert.deepEqual(out.settings.extraModels[0].extra, { thinking: { type: 'low' } });

  assert.equal(
    settings.patch({ extraModels: [{ name: 'glm-5.3-flash', baseUrl: 'https://z.test/v4', keyName: 'ZHIPU', extra: 'no' }] }).error.code,
    'badSettings',
  );
  assert.equal(
    settings.patch({ extraModels: [{ name: 'glm-5.3-flash', baseUrl: 'https://z.test/v4', keyName: 'ZHIPU', extra: [1] }] }).error.code,
    'badSettings',
  );

  const cleared = settings.patch({ extraModels: [{ name: 'glm-5.3-flash', baseUrl: 'https://z.test/v4', keyName: 'ZHIPU', extra: null }] });
  assert.equal(cleared.error, null);
  assert.ok(!('extra' in cleared.settings.extraModels[0]));
});
test('custom model endpoints and key names are validated', () => {
  const { settings } = setup({ keyNames: ['QWEN'] });
  const cases = [
    { extraModels: [{ name: 'x', baseUrl: 'file:///C:/secret.env', keyName: 'QWEN' }] },
    { extraModels: [{ name: 'x', baseUrl: 42, keyName: 'QWEN' }] },
    { extraModels: [{ name: 'x', keyName: 'QWEN' }] },
    { extraModels: [{ baseUrl: 'https://a.test/v1', keyName: 'QWEN' }] },
    { extraModels: [{ name: 'x', baseUrl: 'https://a.test/v1', keyName: 'NOPE' }] },
    { extraModels: [{ name: 'x', baseUrl: 'https://a.test/v1' }] },
    { extraModels: [{ name: '  ', baseUrl: 'https://a.test/v1', keyName: 'QWEN' }] },
    { extraModels: [7] },
    { extraModels: ['qwen-max'] },
  ];
  for (const patch of cases) {
    assert.equal(settings.patch(patch).error.code, 'badSettings', JSON.stringify(patch));
  }
  assert.deepEqual(settings.get().settings.extraModels, []);

  const { settings: loose } = setup();
  const out = loose.patch({ extraModels: [{ name: 'x', baseUrl: 'https://a.test/v1', keyName: 'ANYTHING' }] });
  assert.equal(out.error, null);
  assert.equal(out.settings.extraModels[0].keyName, 'ANYTHING');
});

test('writing settings never touches .env and leaves no temp file', () => {
  const { dir, envFile, settings } = setup();
  const before = fs.readFileSync(envFile);
  settings.patch({ theme: 'light' });
  settings.patch({ prompts: { entry: 'B' } });
  settings.patch({ extraModels: [{ name: 'qwen-max', baseUrl: 'https://a.test/v1', keyName: 'ANY' }] });
  assert.deepEqual(fs.readFileSync(envFile), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', 'settings.json']);
});

test('modelEndpoints maps each model to its base url and key', () => {
  const settings = {
    extraModels: [
      { name: 'qwen', baseUrl: 'https://d.test/v1', keyName: 'QWEN' },
      { name: 'zhipu', baseUrl: 'https://z.test/v4', keyName: 'ZHIPU', extra: {} },
      { name: 'orphan', baseUrl: 'https://none.test/v1', keyName: 'MISSING' },
    ],
  };
  assert.deepEqual(modelEndpoints({ settings, keys: { QWEN: 'sk-q', ZHIPU: 'sk-z' } }), {
    qwen: { baseUrl: 'https://d.test/v1', apiKey: 'sk-q' },
    zhipu: { baseUrl: 'https://z.test/v4', apiKey: 'sk-z', extra: {} },
    orphan: { baseUrl: 'https://none.test/v1', apiKey: '' },
  });
});

test('unknown keys in a settings file are ignored, not fatal', () => {
  const { file, settings } = setup();
  fs.writeFileSync(
    file,
    JSON.stringify({ model: 'qwen-max', batchSize: 30, prompts: { entry: 'E', judge: 'J', draft: 'D', backfill: 'B' } }),
  );
  const out = settings.get();
  assert.equal(out.error, null);
  assert.equal(out.settings.model, 'qwen-max');
  assert.deepEqual(out.settings.prompts, { entry: 'E', judge: 'J' });
  assert.equal('batchSize' in out.settings, false);
});
