import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server.js';
import { createStore, createStateFile } from '../store.js';
import { createSettings } from '../settings.js';
import { parseEnv, loadConfig } from '../config.js';

const FIXTURE =
  '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water through their roots.\n\n### B\n\n- ballpoint\n  - [ ] #B1 - a pen with a metal ball tip - This ballpoint leaks.\n';

const dirs = [];
const servers = [];
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const fakeCefr = ({ outside = [], levels = {} } = {}) => ({
  lookup: (word) => {
    if (outside.includes(word)) return { level: null, source: null, label: 'CEFR 表外' };
    return { level: levels[word] || 'B1', source: 'cefrj', label: 'CEFR-J' };
  },
  sources: () => ({ cefrj: 'CEFR-J Vocabulary Profile 1.5', bands: [] }),
  describe: (word) => ({
    word,
    levels: outside.includes(word) ? [] : [{ source: 'CEFR-J', pos: null, level: levels[word] || 'B1' }],
    related: [],
    frequencyRank: null,
    outside: outside.includes(word),
  }),
  // 逐步查表记录（界面上「定档依据」那块的原料）。假的就照 describe 编一份。
  trace: (word) => ({
    word,
    tiers: [
      { key: 'cefrj', source: 'CEFR-J', plain: outside.includes(word) ? null : levels[word] || 'B1', pos: [] },
      { key: 'octanove', source: 'Octanove C1/C2', plain: null, pos: [] },
    ],
    lemma: [],
    root: [],
    rank: null,
    band: null,
  }),
});

async function start(content = FIXTURE, { ai, cefr } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-server-'));
  dirs.push(dir);
  const file = path.join(dir, 'Vocabulary.md');
  fs.writeFileSync(file, content);
  const config = {
    settingsFile: path.join(dir, 'settings.json'),
    stateDir: path.join(dir, 'state'),
    keys: { TEST: 'sk-test' },
  };
  // 与生产一致：词表路径存在设置里，store 每次都按当前设置取目标（所以改了立刻生效）
  const settings = createSettings({ stateFile: createStateFile({ file: config.settingsFile }), keyNames: config.keyNames });
  settings.patch({ vocabFile: file });
  const store = createStore({ file: () => settings.get().settings.vocabFile, backupDir: path.join(dir, 'backups') });
  const server = createApp({ store, ai, cefr: cefr || fakeCefr(), config, settings });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    file,
    store,
    settings,
    server,
    base,
    settingsFile: config.settingsFile,
    stateFile: path.join(dir, 'state', 'session.json'),
  };
}

test('GET /api/entries returns projected entries and stats', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/api/entries`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.stats, {
    total: 2,
    full: 1,
    partial: 0,
    none: 1,
    senses: { total: 2, checked: 1, unchecked: 1 },
    missingExample: 0,
    missingDifficulty: 0,
  });
  assert.deepEqual(body.entries[0], {
    chapter: 'A',
    word: 'absorb',
    definition: 'take in',
    chinese: null,
    mastery: 'full',
    difficulty: 'B1',
    example: 'Plants absorb water through their roots.',
    senses: [
      {
        level: 'B1',
        definition: 'take in',
        chinese: null,
        example: 'Plants absorb water through their roots.',
        checked: true,
      },
    ],
  });
  assert.equal(body.entries[1].word, 'ballpoint');
  assert.equal(body.entries[1].mastery, 'none');
  assert.equal(body.entries[1].difficulty, 'B1');
});

test('GET /api/entries reports a dirty file instead of serving partial data', async () => {
  const { base } = await start('### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n\n### B\n\n- absorb\n  - [ ] #B2 - soak up - The sponge absorbed it.\n');
  const res = await fetch(`${base}/api/entries`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, 'parseErrors');
  assert.equal(body.error.details[0].type, 'duplicateWord');
});

test('GET /api/settings lists models, the vocab path and never leaks the key', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/api/settings`);
  const text = await res.text();
  assert.equal(res.status, 200);
  const body = JSON.parse(text);
  assert.deepEqual(body.models, []);
  assert.match(body.vocabFile, /Vocabulary\.md$/);
  assert.ok(!/sk-/.test(text));
  assert.ok(!text.includes('apiKey'));
});

test('GET /api/backups lists the backup directory', async () => {
  const { base, store } = await start();
  assert.deepEqual((await (await fetch(`${base}/api/backups`)).json()).files, []);
  store.writeWithBackup('### A\n\n- [x] absorb - take in\n');
  const body = await (await fetch(`${base}/api/backups`)).json();
  assert.equal(body.files.length, 1);
  assert.match(body.files[0].name, /^Vocabulary\./);
});

test('static assets are served without caching', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  for (const path of ['/app.js', '/js/core.js', '/js/session-ui.js']) {
    const js = await fetch(base + path);
    assert.equal(js.status, 200, path);
    assert.match(js.headers.get('content-type'), /javascript/, path);
    assert.equal(js.headers.get('cache-control'), 'no-store', path);
  }
});

test('unknown paths and traversal are refused', async () => {
  const { base, dir } = await start();
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'OPENAI_API_KEY=sk-secret');
  for (const guess of ['/..%2f.env', '/../.env', '/%2e%2e%2f.env', '/.env']) {
    const res = await fetch(base + guess);
    assert.ok([400, 404].includes(res.status), `${guess} → ${res.status}`);
    assert.ok(!(await res.text()).includes('sk-secret'));
  }
});

test('POST to a read-only route returns 405', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/api/entries`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 405);
  assert.equal((await res.json()).error.code, 'methodNotAllowed');
});

test('parseEnv reads key=value and skips comments', () => {
  const env = parseEnv('# c\nA=1\nB = two words \n\nC={"x":1}\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: '{"x":1}' });
});

test('loadConfig reads a .env file and applies defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-config-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, '.env'),
    'VOCAB_KEY_TEST=sk-test\nOPENAI_API_KEY=ignored\nVOCAB_FILE=' + path.join(dir, 'V.md') + '\nVOCAB_MODELS=qwen3.8-flash\n',
  );
  const cfg = loadConfig({ dir, env: {} });
  assert.deepEqual(cfg.keys, { TEST: 'sk-test' });
  assert.deepEqual(cfg.keyNames, ['TEST']);
  assert.equal(cfg.backupDir, path.join(dir, 'backups'));
  assert.equal(loadConfig({ dir, env: { VOCAB_BACKUP_DIR: path.join(dir, 'elsewhere') } }).backupDir, path.join(dir, 'elsewhere'));
});

const DRAFT = {
  senses: [
    { level: 'B1', definition: 'space or room just under the roof', example: 'They found the box in the attic.' },
  ],
};

function fakeAi({ throwError, verdict = { pass: true, reason: 'ok', suggestion: '' }, delay = 0, votes = [] } = {}) {
  const seen = [];
  const judged = [];
  const judgedOpts = [];
  const refactors = [];
  const examples = [];
  const tested = [];
  const levelVotes = [];
  // 五次并行调用按顺序取票，票用完了就用最后一票兜底。
  const queue = [...votes];
  return {
    seen,
    judged,
    judgedOpts,
    refactors,
    examples,
    tested,
    levelVotes,
    async sensesEntry(input, opts) {
      seen.push({ input, opts });
      if (input.current) refactors.push({ input, opts });
      if (throwError) throw throwError;
      return {
        word: input.word,
        senses: [
          {
            level: null,
            definition: `sense of ${input.word}`,
            chinese: input.withChinese ? '释义' : '',
            example: `A fresh sentence for ${input.word}.`,
          },
        ],
        note: '补齐了义项',
      };
    },
    async judgeEntry(input, opts) {
      judged.push(input);
      judgedOpts.push(opts || {});
      if (throwError) throw throwError;
      return verdict;
    },
    // 一次判一批：票按传入顺序从队列里取（一批几条就取几条），取完了用最后一票兜底。
    async levelVoteBatch(items, opts) {
      const batch = items.map((input) => ({ input, opts }));
      levelVotes.push(...batch);
      if (throwError) throw throwError;
      return {
        levels: items.map(() => {
          if (queue.length) {
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next;
          }
          return votes.length ? votes[votes.length - 1] : 'B1';
        }),
      };
    },
    async exampleEntry(word, definition, opts) {
      examples.push({ word, definition, opts });
      if (throwError) throw throwError;
      return { example: `A fresh example about ${word}.` };
    },
    async testTarget(target = {}) {
      tested.push(target);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (throwError) throw throwError;
      return { ok: true, model: target.model || 'default', baseUrl: target.baseUrl || 'https://default.test/v1', latencyMs: 5 };
    },
  };
}

const post = async (base, path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const SORT_FIXTURE =
  '### A\n\n- attentive\n  - [ ] #B2 - paying attention - She is attentive in class.\n- authentic\n  - [x] #B1 - real - The painting is authentic.\n';

test('POST /api/draft returns the senses from the shared entry core', async () => {
  const ai = fakeAi();
  const { base } = await start(SORT_FIXTURE, { ai });
  const res = await post(base, '/api/draft', { word: 'attic', withChinese: true, model: 'qwen-max' });
  assert.equal(res.status, 200);
  // 档位留空：草稿只交释义与例句，档位随后由三次投票来定（D30）。
  assert.deepEqual(res.body.senses, [
    { level: null, definition: 'sense of attic', chinese: '释义', example: 'A fresh sentence for attic.' },
  ]);
  assert.ok(res.body.trace, '逐步查表记录要随草稿一起给前端');
  assert.equal(res.body.note, '补齐了义项');
  assert.equal(res.body.word, 'attic');

  const sent = ai.seen[0];
  assert.equal(sent.input.current, null, '草稿没有现存内容');
  assert.equal(sent.input.withChinese, true);
  assert.ok(!('referenceLevels' in sent.input), '补齐不带参考档位（那是指给投票的）');
  assert.deepEqual(sent.opts, { model: 'qwen-max' });
});

test('POST /api/draft validates the word before spending a call', async () => {
  const ai = fakeAi();
  const { base } = await start(SORT_FIXTURE, { ai });
  for (const body of [{}, { word: '   ' }, { word: 'a\nb' }, { word: 42 }]) {
    const res = await post(base, '/api/draft', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'badWord');
  }
  assert.equal(ai.seen.length, 0);
});

test('POST /api/draft maps model failures to 502 and missing config to 503', async () => {
  const boom = Object.assign(new Error('上游返回 500'), { code: 'aiHttp', status: 500 });
  const { base } = await start(SORT_FIXTURE, { ai: fakeAi({ throwError: boom }) });
  const res = await post(base, '/api/draft', { word: 'attic' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'aiHttp');

  const noAi = await start(SORT_FIXTURE);
  const res2 = await post(noAi.base, '/api/draft', { word: 'attic' });
  assert.equal(res2.status, 503);
  assert.equal(res2.body.error.code, 'aiUnavailable');
});

test('POST /api/commit-add writes the entry at the sorted position', async () => {
  const { base, file } = await start(SORT_FIXTURE);
  const res = await post(base, '/api/commit-add', { word: 'attic', ...DRAFT });
  assert.equal(res.status, 200);
  assert.equal(res.body.entry.chapter, 'A');
  assert.equal(res.body.entry.word, 'attic');
  assert.equal(res.body.entry.mastery, 'none');
  assert.match(res.body.backup, /^Vocabulary\./);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '### A',
    '',
    '- attentive',
    '  - [ ] #B2 - paying attention - She is attentive in class.',
    '- attic',
    '  - [ ] #B1 - space or room just under the roof - They found the box in the attic.',
    '- authentic',
    '  - [x] #B1 - real - The painting is authentic.',
    '',
  ]);
  const backups = await (await fetch(`${base}/api/backups`)).json();
  assert.equal(backups.files[0].name, res.body.backup);
  assert.equal((await (await fetch(`${base}/api/entries`)).json()).stats.total, 3);
});

test('POST /api/commit-add refuses a duplicate word without touching the file', async () => {
  const { base, file } = await start(SORT_FIXTURE);
  const before = fs.readFileSync(file);
  const res = await post(base, '/api/commit-add', { word: 'Attentive', ...DRAFT });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'wordExists');
  assert.deepEqual(fs.readFileSync(file), before);
  const backups = await (await fetch(`${base}/api/backups`)).json();
  assert.deepEqual(backups.files, []);
});

test('POST /api/commit-add refuses invalid fields without touching the file', async () => {
  const { base, file } = await start(SORT_FIXTURE);
  const before = fs.readFileSync(file);
  const cases = [
    [{ word: 'bench', definition: 'long seat', difficulty: 'B7', example: 'Sit here.' }, 'badDifficulty'],
    [{ word: 'bench', definition: '', difficulty: 'B1', example: 'Sit here.' }, 'badDefinition'],
    [{ word: 'bench', definition: 'long seat', difficulty: 'B1', example: '' }, 'badExample'],
    [{ word: 'bench', definition: 'long seat', difficulty: 'B1', example: 'Sit here.', checked: 'yes' }, 'badChecked'],
  ];
  for (const [body, code] of cases) {
    const res = await post(base, '/api/commit-add', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, code);
  }
  assert.deepEqual(fs.readFileSync(file), before);
});

test('POST /api/commit-add writes chinese as a third segment', async () => {
  const { base, file } = await start(SORT_FIXTURE);
  const res = await post(base, '/api/commit-add', {
    word: 'band',
    definition: 'range; strip',
    difficulty: 'B1',
    example: 'A band of rain moved in.',
    chinese: '乐队',
  });
  assert.equal(res.status, 200);
  assert.ok(fs.readFileSync(file, 'utf8').includes('  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.'));
});

test('POST routes reject malformed and oversized bodies', async () => {
  const { base } = await start(SORT_FIXTURE);
  const bad = await post(base, '/api/commit-add', '{oops');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'badJson');
  const huge = await fetch(base + '/api/commit-add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(huge.status, 413);
  await huge.text();
});

const QUIZ_FIXTURE =
  '### A\n\n- absorb\n  - [ ] #B1 - take in - Plants absorb water through their roots.\n- abyss\n  - [x] #C2 - deep hole - The ship disappeared into the abyss.\n\n### B\n\n- ballpoint\n  - [ ] #A2 - a pen with a metal ball tip - This pen leaks.\n';

test('POST /api/judge passes without writing; the checkbox is a separate click', async () => {
  const ai = fakeAi({ verdict: { pass: true, reason: '到位', suggestion: '再练' } });
  const { base, file } = await start(QUIZ_FIXTURE, { ai });
  const before = fs.readFileSync(file);
  const res = await post(base, '/api/judge', {
    word: 'absorb',
    userDefinition: 'take in something',
    userExample: 'Plants absorb water.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.pass, true);
  assert.equal(res.body.sense, 0);
  assert.equal(res.body.checked, false);
  assert.equal(res.body.backup, null);
  assert.deepEqual(ai.judged, [
    {
      word: 'absorb',
      userDefinition: 'take in something',
      userExample: 'Plants absorb water.',
      storedDefinition: 'take in',
      targetExample: 'Plants absorb water through their roots.',
    },
  ]);
  assert.deepEqual(fs.readFileSync(file), before);

  const checked = await post(base, '/api/set-checked', { word: 'absorb', checked: true });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.checked, true);
  assert.equal(checked.body.sense, 0);
  assert.match(checked.body.backup, /^Vocabulary\./);
  assert.ok(fs.readFileSync(file, 'utf8').includes('- absorb\n  - [x] #B1 - take in - Plants absorb water through their roots.\n'));
});

test('POST /api/judge grades a named sense and reports its own checkbox', async () => {
  const ai = fakeAi({ verdict: { pass: true, reason: '到位', suggestion: '' } });
  const { base, file } = await start(MULTI_FIXTURE, { ai });
  const res = await post(base, '/api/judge', {
    word: 'angle',
    sense: 1,
    userDefinition: 'to fish',
    userExample: '',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sense, 1);
  assert.equal(res.body.checked, false);
  assert.equal(ai.judged[0].storedDefinition, 'to fish');
  assert.equal(ai.judged[0].targetExample, 'He angled his line carefully.');
  assert.equal((await post(base, '/api/judge', { word: 'angle', sense: 2, userDefinition: 'x' })).status, 400);

  await post(base, '/api/set-checked', { word: 'angle', sense: 1, checked: true });
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[2], '- angle');
  assert.equal(lines[3], '  - [ ] #A2 - the space between two lines - The angle was 45 degrees.');
  assert.equal(lines[4], '  - [x] #C1 - to fish - He angled his line carefully.');
});

test('POST /api/judge leaves the file untouched on FAIL', async () => {
  const ai = fakeAi({ verdict: { pass: false, reason: '例句没用对该词', suggestion: '再造一句' } });
  const { base, file } = await start(QUIZ_FIXTURE, { ai });
  const before = fs.readFileSync(file);
  const res = await post(base, '/api/judge', {
    word: 'absorb',
    userDefinition: 'give out',
    userExample: 'The sun gives out light.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.pass, false);
  assert.equal(res.body.checked, false);
  assert.equal(res.body.backup, null);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual((await (await fetch(`${base}/api/backups`)).json()).files, []);
});

test('POST /api/judge forwards the feedback language and falls back to Chinese', async () => {
  const ai = fakeAi();
  const { base } = await start(QUIZ_FIXTURE, { ai });
  const ask = (extra) => post(base, '/api/judge', { word: 'absorb', userDefinition: 'take in', userExample: 'Plants absorb water.', ...extra });
  await ask({ lang: 'en' });
  await ask({});
  await ask({ lang: 'fr' });
  assert.deepEqual(ai.judgedOpts.map((o) => o.lang), ['en', 'zh', 'zh']);
});

test('POST /api/judge refuses unknown words and bad input without calling the model', async () => {
  const ai = fakeAi();
  const { base } = await start(QUIZ_FIXTURE, { ai });
  assert.equal((await post(base, '/api/judge', { word: 'nosuch', userDefinition: 'x', userExample: 'x.' })).status, 404);
  assert.equal((await post(base, '/api/judge', { word: 'absorb', userDefinition: '', userExample: 'x.' })).status, 400);

  assert.equal((await post(base, '/api/judge', { word: 'abyss', userDefinition: 'a deep hole' })).status, 200);
  assert.deepEqual(ai.judged[0], {
    word: 'abyss',
    userDefinition: 'a deep hole',
    userExample: '',
    storedDefinition: 'deep hole',
    targetExample: 'The ship disappeared into the abyss.',
  });
  assert.equal(ai.judged.length, 1);
});

test('POST /api/judge maps model failures to 502 without writing', async () => {
  const boom = Object.assign(new Error('上游返回 503'), { code: 'aiHttp', status: 503 });
  const { base, file } = await start(QUIZ_FIXTURE, { ai: fakeAi({ throwError: boom }) });
  const before = fs.readFileSync(file);
  const res = await post(base, '/api/judge', { word: 'absorb', userDefinition: 'take in', userExample: 'Plants absorb water.' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'aiHttp');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('POST /api/set-checked reverts the box and touches nothing else', async () => {
  const { base, file } = await start(QUIZ_FIXTURE, { ai: fakeAi() });
  await post(base, '/api/set-checked', { word: 'absorb', checked: true });
  const res = await post(base, '/api/set-checked', { word: 'absorb', checked: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.checked, false);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[2], '- absorb');
  assert.equal(lines[3], '  - [ ] #B1 - take in - Plants absorb water through their roots.');
  assert.equal((await post(base, '/api/set-checked', { word: 'absorb', checked: 'yes' })).status, 400);
  assert.equal((await post(base, '/api/set-checked', { word: 'absorb', sense: 3, checked: true })).status, 400);
  assert.equal((await post(base, '/api/set-checked', { word: 'nosuch', checked: true })).status, 404);
});






test('GET /api/settings returns defaults and contracts without the key', async () => {
  const { base } = await start(SORT_FIXTURE, { ai: fakeAi() });
  const res = await fetch(`${base}/api/settings`);
  const text = await res.text();
  assert.equal(res.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.settings.theme, 'auto');
  assert.equal(body.settings.lang, 'zh');
  assert.match(body.contracts.judge, /^Output ONLY a JSON object/);
  assert.match(body.contracts.entry, /definition, chinese, example/);
  assert.ok(!/levelBasis/.test(body.contracts.entry), '档位不由模型输出');
  assert.ok(!text.includes('sk-test'));
});

test('POST /api/settings persists and drives the effective model', async () => {
  const ai = fakeAi();
  const { base, settingsFile } = await start(SORT_FIXTURE, { ai });
  const res = await post(base, '/api/settings', {
    model: 'qwen-max',
    extraModels: [{ name: 'qwen-plus', baseUrl: 'https://q.test/v1', keyName: 'TEST' }],
    theme: 'dark',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.model, 'qwen-max');
  assert.match(fs.readFileSync(settingsFile, 'utf8'), /qwen-max/);

  const cfg = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(cfg.settings.model, 'qwen-max');
  assert.deepEqual(cfg.models, ['qwen-max', 'qwen-plus']);
  assert.equal(cfg.settings.theme, 'dark');

  await post(base, '/api/draft', { word: 'attic' });
  assert.equal(ai.seen[0].opts.model, 'qwen-max');
  await post(base, '/api/draft', { word: 'attic', model: 'explicit-one' });
  assert.equal(ai.seen[1].opts.model, 'explicit-one');
});

test('POST /api/settings makes the saved language the judging default', async () => {
  const ai = fakeAi();
  const { base } = await start(QUIZ_FIXTURE, { ai });
  assert.equal((await post(base, '/api/settings', { lang: 'en' })).status, 200);
  await post(base, '/api/judge', { word: 'absorb', userDefinition: 'take in', userExample: 'Plants absorb water.' });
  assert.equal(ai.judgedOpts[0].lang, 'en');
  await post(base, '/api/judge', { word: 'absorb', userDefinition: 'take in', userExample: 'Plants absorb water.', lang: 'zh' });
  assert.equal(ai.judgedOpts[1].lang, 'zh');
});

test('POST /api/settings rejects invalid values and leaves the file untouched', async () => {
  const { base, settingsFile, dir } = await start(SORT_FIXTURE, { ai: fakeAi() });
  const seeded = fs.readFileSync(settingsFile);
  const bad = await post(base, '/api/settings', { theme: 'neon' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'badSettings');
  assert.deepEqual(fs.readFileSync(settingsFile), seeded, '被驳回就不该动设置文件');

  assert.equal((await post(base, '/api/settings', { unknownKey: 12 })).status, 200);
  const before = fs.readFileSync(settingsFile);
  const worse = await post(base, '/api/settings', { prompts: { entry: 'x'.repeat(5000) } });
  assert.equal(worse.status, 400);
  assert.deepEqual(fs.readFileSync(settingsFile), before);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
});

test('词表路径存在设置里，改完立刻生效', async () => {
  const { base, dir, file } = await start(SORT_FIXTURE, { ai: fakeAi() });
  const other = path.join(dir, 'other.md');
  fs.writeFileSync(other, '### Z\n\n- zed\n  - [ ] #B1 - the last letter - Z is the last letter.\n');

  const beforeBytes = fs.readFileSync(file);
  const before = (await (await fetch(`${base}/api/entries`)).json()).entries.map((e) => e.word);
  assert.ok(before.length > 1 && !before.includes('zed'), `原文件读出来是 ${before.join(',')}`);

  const missing = await post(base, '/api/settings', { vocabFile: path.join(dir, 'nope.md') });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'badVocabFile');
  assert.equal((await post(base, '/api/settings', { vocabFile: '   ' })).status, 400);

  const saved = await post(base, '/api/settings', { vocabFile: other });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.vocabFile, other);
  assert.equal(saved.body.vocabFileError, null);

  assert.deepEqual(
    (await (await fetch(`${base}/api/entries`)).json()).entries.map((e) => e.word),
    ['zed'],
    '换了路径不用重启就读到新文件',
  );
  assert.deepEqual(fs.readFileSync(file), beforeBytes, '旧文件一个字节都没动');
});

const EDIT_FIXTURE =
  '### A\n\n- absorb\n  - [ ] #B1 - take in - Plants absorb water.\n\n- band\n  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.\n- cliché\n  - [x] #C1 - overused phrase - His speech was full of clichés.\n';

test('POST /api/commit-edit rewrites the head and child lines', async () => {
  const { base, file } = await start(EDIT_FIXTURE);
  const res = await post(base, '/api/commit-edit', {
    word: 'absorb',
    definition: 'soak up',
    difficulty: 'A2',
    example: 'The sponge absorbed the spill.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.entry.definition, 'soak up');
  assert.equal(res.body.entry.difficulty, 'A2');
  assert.equal(res.body.noop, false);
  assert.match(res.body.backup, /^Vocabulary\./);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '### A',
    '',
    '- absorb',
    '  - [ ] #A2 - soak up - The sponge absorbed the spill.',
    '',
    '- band',
    '  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.',
    '- cliché',
    '  - [x] #C1 - overused phrase - His speech was full of clichés.',
    '',
  ]);
});

test('POST /api/commit-edit reports noop without writing', async () => {
  const { base, file } = await start(EDIT_FIXTURE);
  const before = fs.readFileSync(file);
  const res = await post(base, '/api/commit-edit', {
    word: 'absorb',
    definition: 'take in',
    difficulty: 'B1',
    example: 'Plants absorb water.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.noop, true);
  assert.equal(res.body.backup, null);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual((await (await fetch(`${base}/api/backups`)).json()).files, []);
});

test('POST /api/commit-edit keeps chinese unless told to drop it', async () => {
  const { base, file } = await start(EDIT_FIXTURE);
  await post(base, '/api/commit-edit', { word: 'band', definition: 'range; strip', difficulty: 'B1', example: 'A band of rain moved in.' });
  assert.ok(fs.readFileSync(file, 'utf8').includes('  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.'));

  await post(base, '/api/commit-edit', { word: 'band', definition: 'range; strip', chinese: null, difficulty: 'B1', example: 'A band of rain moved in.' });
  assert.ok(fs.readFileSync(file, 'utf8').includes('  - [ ] #B1 - range; strip - A band of rain moved in.\n'));

  await post(base, '/api/commit-edit', { word: 'band', definition: 'range; strip', chinese: '乐队', difficulty: 'B1', example: 'A band of rain moved in.' });
  assert.ok(fs.readFileSync(file, 'utf8').includes('  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.'));
});

test('POST /api/commit-edit leaves the sense checkbox alone unless asked', async () => {
  const { base, file } = await start(EDIT_FIXTURE);
  await post(base, '/api/commit-edit', { word: 'cliché', definition: 'overused phrase', difficulty: 'C1', example: 'His speech was full of clichés.' });
  let lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[7], '- cliché');
  assert.equal(lines[8], '  - [x] #C1 - overused phrase - His speech was full of clichés.');

  await post(base, '/api/commit-edit', { word: 'cliché', definition: 'overused phrase', difficulty: 'C1', example: 'His speech was full of clichés.', checked: false });
  lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[8], '  - [ ] #C1 - overused phrase - His speech was full of clichés.');
  assert.equal((await (await fetch(`${base}/api/entries`)).json()).stats.full, 0);
});

test('POST /api/commit-edit refuses unknown words and bad fields', async () => {
  const { base } = await start(EDIT_FIXTURE);
  assert.equal((await post(base, '/api/commit-edit', { word: 'nope', definition: 'd', difficulty: 'B1', example: 'Y.' })).status, 404);
  assert.equal((await post(base, '/api/commit-edit', { word: 'absorb', definition: 'd', difficulty: 'B7', example: 'Y.' })).status, 400);
  assert.equal((await post(base, '/api/commit-edit', { word: 'absorb', definition: '', difficulty: 'B1', example: 'Y.' })).status, 400);
});

const DELETE_FIXTURE =
  '### A\n\n- absorb\n  - [ ] #B1 - take in - Plants absorb water.\n- band\n  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.\n\n### B\n\n- cliché\n  - [x] #C1 - overused phrase - His speech was full of clichés.\n';

test('POST /api/commit-delete removes the head and its child line', async () => {
  const { base, file } = await start(DELETE_FIXTURE);
  const res = await post(base, '/api/commit-delete', { word: 'absorb' });
  assert.equal(res.status, 200);
  assert.equal(res.body.word, 'absorb');
  assert.equal(res.body.removed, 2);
  assert.equal(res.body.stats.total, 2);
  assert.equal(res.body.stats.full, 1);
  assert.match(res.body.backup, /^Vocabulary\./);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '### A',
    '',
    '- band',
    '  - [ ] #B1 - range; strip - 乐队 - A band of rain moved in.',
    '',
    '### B',
    '',
    '- cliché',
    '  - [x] #C1 - overused phrase - His speech was full of clichés.',
    '',
  ]);
  const list = await (await fetch(`${base}/api/entries`)).json();
  assert.deepEqual(
    list.entries.map((e) => e.word),
    ['band', 'cliché'],
  );
});

test('POST /api/commit-delete drops a head that has no sense line', async () => {
  const { base, file } = await start('### A\n\n- boast - talk too proudly about oneself\n');
  const res = await post(base, '/api/commit-delete', { word: 'boast' });
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '### A\n\n');
});

test('POST /api/commit-delete rejects unknown words and dirty files without writing', async () => {
  const { base, file } = await start(DELETE_FIXTURE);
  const before = fs.readFileSync(file);
  const missing = await post(base, '/api/commit-delete', { word: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'wordNotFound');
  assert.equal((await post(base, '/api/commit-delete', {})).status, 400);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual((await (await fetch(`${base}/api/backups`)).json()).files, []);

  const dirty = await start('### A\n\n- [x] absorb - take in\n\n### B\n\n- [ ] absorb - soak up\n');
  const blocked = await post(dirty.base, '/api/commit-delete', { word: 'absorb' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'parseErrors');
});

const SESSION_FIXTURE =
  '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n- abyss\n  - [ ] #C2 - deep hole - The ship disappeared into the abyss.\n';

const ONLY_CHECKED = '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n';

test('GET /api/session is empty before a round starts', async () => {
  const { base, stateFile } = await start(SESSION_FIXTURE, { ai: fakeAi() });
  assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), {
    state: null,
    current: null,
    study: null,
    preview: null,
  });
  assert.ok(!fs.existsSync(stateFile));
});

test('a review round draws mastered words, judges them and settles in one write', async () => {
  const { base, file, stateFile } = await start(SESSION_FIXTURE, { ai: fakeAi() });
  const started = await post(base, '/api/session/start', { mode: 'review' });
  assert.equal(started.status, 200);
  assert.deepEqual(started.body.state.queue, [{ word: 'absorb', senses: [0] }]);
  assert.equal(started.body.state.mode, 'review');
  assert.equal(started.body.state.phase, 'test');
  assert.equal(started.body.study, null);
  assert.equal(started.body.current.word, 'absorb');
  assert.equal(started.body.current.open, 1);
  assert.ok(fs.existsSync(stateFile));

  const outOfOrder = await post(base, '/api/session/answer', { word: 'abyss', answers: [] });
  assert.equal(outOfOrder.status, 409);
  assert.equal(outOfOrder.body.error.code, 'examOutOfOrder');

  const locked = await post(base, '/api/session/reveal', { word: 'absorb' });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error.code, 'examLocked');

  const skipped = await post(base, '/api/session/skip', { word: 'absorb', sense: 0 });
  assert.equal(skipped.status, 200);
  assert.deepEqual(
    { resolved: skipped.body.resolved, via: skipped.body.via, sense: skipped.body.sense, done: skipped.body.done },
    { resolved: 'fail', via: 'skip', sense: 0, done: true },
  );
  assert.equal((await post(base, '/api/session/skip', { word: 'absorb', sense: 0 })).status, 409);

  const view = await (await fetch(`${base}/api/session`)).json();
  assert.equal(view.current.done, true);
  assert.deepEqual(view.preview, {
    add: [],
    remove: [{ word: 'absorb', sense: 0, level: 'B1' }],
    unchanged: 0,
    skipped: [],
    judged: 1,
    total: 1,
  });

  const revealed = await post(base, '/api/session/reveal', { word: 'absorb' });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.senses[0].definition, 'take in');
  assert.equal(revealed.body.senses[0].via, 'skip');

  const advanced = await post(base, '/api/session/next', {});
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.cursor, 1);
  assert.equal(advanced.body.finished, true);
  assert.equal(advanced.body.current, null);

  const committed = await post(base, '/api/session/commit', {});
  assert.equal(committed.status, 200);
  assert.equal(committed.body.changed, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /- absorb\n  - \[ \] #B1 - take in/);
  assert.equal(committed.body.state.status, 'settled');

  const again = await post(base, '/api/session/commit', {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'examSettled');
});

test('a learn round walks the study phase before the test phase', async () => {
  const ai = fakeAi({ verdict: { pass: true, reason: 'ok', suggestion: '方向对，再想具体一点' } });
  const { base, file } = await start(SESSION_FIXTURE, { ai });
  const started = await post(base, '/api/session/start', { mode: 'learn' });
  assert.equal(started.status, 200);
  assert.deepEqual(started.body.state.queue, [{ word: 'abyss', senses: [0] }]);
  assert.equal(started.body.state.phase, 'study');
  assert.equal(started.body.current, null);
  assert.deepEqual(started.body.study, {
    index: 0,
    total: 1,
    word: 'abyss',
    chapter: 'A',
    senses: [
      {
        sense: 0,
        level: 'C2',
        definition: 'deep hole',
        chinese: null,
        example: 'The ship disappeared into the abyss.',
        checked: false,
      },
    ],
  });

  const tooEarly = await post(base, '/api/session/answer', { word: 'abyss', answers: [] });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error.code, 'examOutOfOrder');

  const next = await post(base, '/api/session/study/next', {});
  assert.equal(next.status, 200);
  assert.equal(next.body.phase, 'test');
  assert.equal(next.body.study, null);
  assert.equal(next.body.current.word, 'abyss');
  assert.equal((await post(base, '/api/session/study/next', {})).status, 409);

  const answered = await post(base, '/api/session/answer', {
    word: 'abyss',
    answers: [{ sense: 0, definition: 'a deep hole', example: 'The ship fell into the abyss.' }],
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.results, [
    { sense: 0, pass: true, reason: 'ok', suggestion: '方向对，再想具体一点', resolved: 'pass', via: null, attemptsLeft: 0 },
  ]);
  // 例句跟着进 prompt；闭卷的敏感词用表内释义，但表内释义本身不发出去。
  assert.equal(ai.judged[0].userExample, 'The ship fell into the abyss.');
  assert.equal(ai.judged[0].storedDefinition, undefined);
  assert.equal(ai.judgedOpts[0].exam, true);
  assert.deepEqual(ai.judgedOpts[0].guard, { definitions: ['deep hole'], chinese: [] });
  const revealed = await post(base, '/api/session/reveal', { word: 'abyss' });
  assert.equal(revealed.body.senses[0].suggestion, '方向对，再想具体一点');

  const committed = await post(base, '/api/session/commit', {});
  assert.equal(committed.status, 200);
  assert.equal(committed.body.changed, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /- abyss\n  - \[x\] #C2 - deep hole/);
});

test('session start and answer validate their input', async () => {
  const { base } = await start(SESSION_FIXTURE, { ai: fakeAi() });
  for (const body of [{}, { mode: 'quiz' }, { mode: 1 }]) {
    const bad = await post(base, '/api/session/start', body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(bad.body.error.code, 'badMode');
  }

  const empty = await start(ONLY_CHECKED, { ai: fakeAi() });
  const noPool = await post(empty.base, '/api/session/start', { mode: 'learn' });
  assert.equal(noPool.status, 400);
  assert.equal(noPool.body.error.code, 'emptyScope');

  assert.equal((await post(base, '/api/session/start', { mode: 'review' })).status, 200);
  const cur = (await (await fetch(`${base}/api/session`)).json()).current;
  const noAnswers = await post(base, '/api/session/answer', { word: cur.word });
  assert.equal(noAnswers.status, 400);
  assert.equal(noAnswers.body.error.code, 'badAnswers');

  const outOfRange = await post(base, '/api/session/answer', {
    word: cur.word,
    answers: [{ sense: 9, definition: 'x' }],
  });
  assert.equal(outOfRange.status, 400);
  assert.equal(outOfRange.body.error.code, 'badSense');

  const wrongWord = await post(base, '/api/session/answer', { word: 'nope', answers: [] });
  assert.equal(wrongWord.status, 409);
  assert.equal(wrongWord.body.error.code, 'examOutOfOrder');

  const gone = await post(base, '/api/session/reveal', { word: 'nope' });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'wordNotFound');
});

test('session start takes the slider count and defaults per mode', async () => {
  const { base } = await start(SESSION_FIXTURE, { ai: fakeAi() });
  const wide = await start('### A\n\n' + Array.from({ length: 40 }, (_, i) => `- w${i}\n  - [ ] #B1 - meaning ${i} - Sentence ${i}.\n`).join(''), { ai: fakeAi() });
  const picked = await post(wide.base, '/api/session/start', { mode: 'learn', count: 7 });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.state.queue.length, 7);
  const fallback = await post(wide.base, '/api/session/start', { mode: 'learn', force: true });
  assert.equal(fallback.body.state.queue.length, 10);

  for (const count of [0, -3, 2.5, '20', 501]) {
    const bad = await post(base, '/api/session/start', { mode: 'review', count });
    assert.equal(bad.status, 400, JSON.stringify(count));
    assert.equal(bad.body.error.code, 'badCount');
  }
});

test('session pause and resume keep the round', async () => {
  const { base, file } = await start(SESSION_FIXTURE, { ai: fakeAi() });
  await post(base, '/api/session/start', { mode: 'review' });
  const paused = await post(base, '/api/session/pause', {});
  assert.equal(paused.status, 200);
  assert.deepEqual(
    { phase: paused.body.phase, done: paused.body.done, total: paused.body.total },
    { phase: 'test', done: 0, total: 1 },
  );

  const frozen = fs.readFileSync(file);
  const blocked = await post(base, '/api/session/answer', { word: 'absorb', answers: [] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'examPaused');
  assert.equal((await post(base, '/api/session/pause', {})).status, 409);
  assert.equal((await post(base, '/api/session/commit', {})).status, 409);
  assert.deepEqual(fs.readFileSync(file), frozen);

  const view = await (await fetch(`${base}/api/session`)).json();
  assert.equal(view.state.status, 'paused');
  assert.equal(view.current, null);

  const resumed = await post(base, '/api/session/resume', {});
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.state.status, 'running');
  assert.equal(resumed.body.current.word, 'absorb');
  assert.equal((await post(base, '/api/session/resume', {})).status, 409);
  assert.equal((await post(base, '/api/session/resume', {})).body.error.code, 'examNotPaused');
});

test('session routes report 503 when no model is configured', async () => {
  const { base } = await start(SESSION_FIXTURE);
  assert.equal((await post(base, '/api/session/start', { mode: 'review' })).status, 503);
  assert.equal((await fetch(`${base}/api/session`)).status, 503);
  assert.equal((await post(base, '/api/example', { word: 'absorb' })).status, 503);
});

test('POST /api/example generates a fresh sentence on demand', async () => {
  const ai = fakeAi();
  const { base } = await start(SORT_FIXTURE, { ai });
  const res = await post(base, '/api/example', { word: 'attic', definition: 'space under the roof' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { example: 'A fresh example about attic.' });
  assert.deepEqual(ai.examples[0].word, 'attic');
  assert.equal(ai.examples[0].definition, 'space under the roof');
  assert.equal((await post(base, '/api/example', { definition: 'x' })).status, 400);
  assert.equal(ai.examples.length, 1);
});

test('POST /api/test-model pings the configured endpoint', async () => {
  const ai = fakeAi();
  const { base } = await start(SORT_FIXTURE, { ai });
  const res = await post(base, '/api/test-model', {
    model: 'glm-4.5',
    baseUrl: 'https://z.test/v4',
    keyName: 'NOPE',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'badKeyName');

  const okRes = await post(base, '/api/test-model', { model: 'glm-4.5', baseUrl: 'https://z.test/v4', keyName: 'TEST' });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.model, 'glm-4.5');
  assert.ok(okRes.body.latencyMs >= 0);
  assert.deepEqual(ai.tested[0], {
    baseUrl: 'https://z.test/v4',
    apiKey: 'sk-test',
    model: 'glm-4.5',
    extra: undefined,
  });

  const noKeyName = await post(base, '/api/test-model', { model: 'glm-4.5', baseUrl: 'https://z.test/v4' });
  assert.equal(noKeyName.status, 400);
  assert.equal(noKeyName.body.error.code, 'badKeyName');
});

test('POST /api/test-model reports 503 when no model is configured', async () => {
  const { base } = await start(SORT_FIXTURE);
  assert.equal((await post(base, '/api/test-model', {})).status, 503);
});

const CEFR_FIXTURE =
  '### A\n\n- absorb\n  - [ ] #B1 - take in - Plants absorb water.\n- cliché\n  - [x] #C1 - overused phrase - His speech was full of clichés.\n- wordy\n  - [ ] #B2 - using too many words - His essay was wordy and dull.\n';






const SENSE_FIXTURE =
  '### A\n\n- angle\n  - [x] #A2 - the space between two lines - The angle was 45 degrees.\n';
const MULTI_FIXTURE =
  '### A\n\n- angle\n  - [ ] #A2 - the space between two lines - The angle was 45 degrees.\n  - [ ] #C1 - to fish - He angled his line carefully.\n';

test('GET /api/entries exposes every sense with its own level and checkbox', async () => {
  const { base } = await start(SENSE_FIXTURE);
  const body = await (await fetch(`${base}/api/entries`)).json();
  assert.deepEqual(body.entries[0].senses, [
    { level: 'A2', definition: 'the space between two lines', chinese: null, example: 'The angle was 45 degrees.', checked: true },
  ]);
  assert.equal(body.entries[0].definition, 'the space between two lines');
  assert.equal(body.entries[0].mastery, 'full');

  const multi = await start(MULTI_FIXTURE);
  const half = await (await fetch(`${multi.base}/api/entries`)).json();
  assert.deepEqual(half.entries[0].senses.map((s) => s.checked), [false, false]);
  assert.equal(half.entries[0].mastery, 'none');
  await post(multi.base, '/api/set-checked', { word: 'angle', sense: 0, checked: true });
  const after = await (await fetch(`${multi.base}/api/entries`)).json();
  assert.deepEqual(after.entries[0].senses.map((s) => s.checked), [true, false]);
  assert.equal(after.entries[0].mastery, 'partial', '勾了一条、还剩一条没掌握 = 部分掌握');
  assert.deepEqual(after.stats.senses, { total: 2, checked: 1, unchecked: 1 });
  assert.equal(after.stats.full, 0);
  assert.equal(after.stats.partial, 1);
});

test('POST /api/commit-senses keeps each sense checkbox and boxes multi-sense lines', async () => {
  const { base, file } = await start(SENSE_FIXTURE);
  const res = await post(base, '/api/commit-senses', {
    word: 'angle',
    senses: [
      { level: 'A2', definition: 'the space between two lines', example: 'The angle was 45 degrees.' },
      { level: 'C1', definition: 'to fish', example: 'He angled his line carefully.' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.entry.senses.length, 2);
  assert.deepEqual(res.body.entry.senses[1], {
    level: 'C1',
    definition: 'to fish',
    chinese: null,
    example: 'He angled his line carefully.',
    checked: true,
  });
  assert.match(res.body.backup, /^Vocabulary\./);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '### A',
    '',
    '- angle',
    '  - [x] #A2 - the space between two lines - The angle was 45 degrees.',
    '  - [x] #C1 - to fish - He angled his line carefully.',
    '',
  ]);
});

test('POST /api/commit-senses validates its payload and never writes garbage', async () => {
  const { base, file } = await start(SENSE_FIXTURE);
  const before = fs.readFileSync(file);
  assert.equal((await post(base, '/api/commit-senses', { word: 'angle', senses: [] })).status, 400);
  assert.equal((await post(base, '/api/commit-senses', { word: 'angle' })).status, 400);
  assert.equal((await post(base, '/api/commit-senses', { word: 'angle', senses: [{ level: 'B7', definition: 'x', example: 'X.' }] })).status, 400);
  assert.equal((await post(base, '/api/commit-senses', { word: 'angle', senses: [{ level: 'B1', example: 'X.' }] })).status, 400, '义项必须有释义');
  assert.equal((await post(base, '/api/commit-senses', { word: 'angle', senses: [{ level: 'B1', definition: 'x', example: '   ' }] })).status, 400);
  assert.equal((await post(base, '/api/commit-senses', { word: 'nope', senses: [{ level: 'B1', definition: 'x', example: 'X.' }] })).status, 404);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual((await (await fetch(`${base}/api/backups`)).json()).files, []);
});

test('POST /api/commit-add writes a bare head with one line per sense', async () => {
  const { base, file } = await start(SORT_FIXTURE);
  const res = await post(base, '/api/commit-add', {
    word: 'angle',
    senses: [
      { level: 'A2', definition: 'the space between two lines', example: 'The angle was 45 degrees.' },
      { level: 'C1', definition: 'to fish', example: 'He angled his line carefully.' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.entry.senses.length, 2);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(lines.slice(2, 7), [
    '- angle',
    '  - [ ] #A2 - the space between two lines - The angle was 45 degrees.',
    '  - [ ] #C1 - to fish - He angled his line carefully.',
    '- attentive',
    '  - [ ] #B2 - paying attention - She is attentive in class.',
  ]);
});

test('POST /api/refactor sends the current entry and the reference levels, and returns a proposal', async () => {
  const ai = fakeAi();
  const { base } = await start(CEFR_FIXTURE, { ai });
  const res = await post(base, '/api/refactor', { word: 'absorb' });
  assert.equal(res.status, 200);
  assert.equal(res.body.word, 'absorb');
  assert.deepEqual(res.body.senses, [
    {
      level: null,
      definition: 'sense of absorb',
      chinese: '',
      example: 'A fresh sentence for absorb.',
      checked: false,
    },
  ]);
  assert.equal(res.body.note, '补齐了义项');
  // 结构上可写（服务端拿占位档位探的），但 sense.level 还是 null，等前端逐条投票填回来。
  assert.equal(res.body.writeable, true);
  assert.equal(res.body.error, null);
  assert.equal(res.body.senses[0].level, null);
  assert.ok(res.body.trace, '逐步查表记录要随重构建议一起给前端');

  const sent = ai.refactors[0].input;
  assert.equal(sent.word, 'absorb');
  assert.deepEqual(sent.current.rawLines, ['- absorb', '  - [ ] #B1 - take in - Plants absorb water.']);
  assert.deepEqual(sent.current.senses, [
    { level: 'B1', definition: 'take in', chinese: null, example: 'Plants absorb water.' },
  ]);
  assert.equal(sent.current.headDefinition, 'take in');
  assert.ok(!('referenceLevels' in sent), '补齐不带参考档位（那是指给投票的）');
});

test('词头带方括号在入口就被挡下（写进去整张表就解析不出来了）', async () => {
  const { base, file } = await start(CEFR_FIXTURE, { ai: fakeAi() });
  const before = fs.readFileSync(file);
  for (const word of ['[x] atom', 'a]b']) {
    const add = await post(base, '/api/commit-add', {
      word,
      senses: [{ level: 'B1', definition: 'x', example: 'X.' }],
    });
    assert.equal(add.status, 400, word);
    assert.equal(add.body.error.code, 'badWord');
    assert.equal((await post(base, '/api/commit-delete', { word })).status, 400);
    assert.equal((await post(base, '/api/refactor', { word })).status, 400);
  }
  assert.deepEqual(fs.readFileSync(file), before);
});

test('POST /api/refactor reports 404 for a missing word and 503 without a model', async () => {
  const { base } = await start(CEFR_FIXTURE, { ai: fakeAi() });
  assert.equal((await post(base, '/api/refactor', { word: 'nope' })).status, 404);
  const noAi = await start(CEFR_FIXTURE);
  assert.equal((await post(noAi.base, '/api/refactor', { word: 'absorb' })).status, 503);
});

test('POST /api/refactor/commit rewrites every accepted proposal in one write with one backup', async () => {
  const { base, file } = await start(CEFR_FIXTURE);
  const res = await post(base, '/api/refactor/commit', {
    items: [
      { word: 'absorb', senses: [{ level: 'C1', definition: 'take in', example: 'Plants absorb water.' }], checked: true },
      { word: 'cliché', senses: [{ level: 'B2', definition: 'overused phrase', example: 'His speech was full of clichés.' }] },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 2);
  assert.deepEqual(res.body.failed, []);
  assert.match(res.body.backup, /^Vocabulary\./);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('- absorb\n  - [x] #C1 - take in - Plants absorb water.'));
  assert.ok(text.includes('- cliché\n  - [x] #B2 - overused phrase - His speech was full of clichés.'));
});

test('POST /api/refactor/commit reports unwritable words, skips noops and validates its payload', async () => {
  const { base, file } = await start(CEFR_FIXTURE);
  const before = fs.readFileSync(file);
  const res = await post(base, '/api/refactor/commit', {
    items: [
      { word: 'nope', senses: [{ level: 'B1', definition: 'x', example: 'X.' }] },
      { word: 'absorb', senses: [{ level: 'B1', definition: 'take in', example: 'Plants absorb water.' }] },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 0);
  assert.deepEqual(res.body.failed, [{ word: 'nope', reason: 'wordNotFound', message: '未找到词头：nope' }]);
  assert.equal(res.body.backup, null);
  assert.deepEqual(fs.readFileSync(file), before);

  assert.equal((await post(base, '/api/refactor/commit', {})).status, 400);
  assert.equal((await post(base, '/api/refactor/commit', { items: [{ word: '' }] })).status, 400);
  const bad = await post(base, '/api/refactor/commit', {
    items: [{ word: 'absorb', senses: [{ level: 'B1', definition: null, example: 'Plants absorb water.' }] }],
  });
  assert.equal(bad.status, 200);
  assert.deepEqual(bad.body.failed, [
    { word: 'absorb', reason: 'badDefinition', message: '义项释义不能为空或含换行' },
  ]);
});

test('POST /api/commit-mastery checks several words in one write with a single backup', async () => {
  const { base, file, dir } = await start(CEFR_FIXTURE);
  const before = fs.readFileSync(file, 'utf8');
  assert.ok(before.includes('- absorb\n  - [ ] #B1 - take in - Plants absorb water.'));

  const res = await post(base, '/api/commit-mastery', { words: ['absorb', 'wordy'], checked: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 2);
  assert.deepEqual(res.body.skipped, []);
  assert.match(res.body.backup, /^Vocabulary\./);

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('- absorb\n  - [x] #B1 - take in - Plants absorb water.'));
  assert.ok(text.includes('- wordy\n  - [x] #B2 - using too many words - His essay was wordy and dull.'));
  assert.ok(text.includes('- cliché\n  - [x] #C1 - overused phrase - His speech was full of clichés.'));
  assert.equal(text.split('\n').length, before.split('\n').length);

  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});

test('POST /api/commit-mastery clears boxes in bulk too', async () => {
  const { base, file, dir } = await start(CEFR_FIXTURE);
  const res = await post(base, '/api/commit-mastery', { words: ['cliché'], checked: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 1);
  assert.ok(fs.readFileSync(file, 'utf8').includes('- cliché\n  - [ ] #C1 - overused phrase - His speech was full of clichés.'));
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});

test('POST /api/commit-mastery skips unknown words, reports noops, and validates its payload', async () => {
  const { base, file, dir } = await start(CEFR_FIXTURE);
  const res = await post(base, '/api/commit-mastery', { words: ['nope', 'absorb'], checked: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 1);
  assert.deepEqual(res.body.skipped, [{ word: 'nope', reason: 'wordNotFound', message: '未找到词头：nope' }]);
  assert.match(res.body.backup, /^Vocabulary\./);

  const before = fs.readFileSync(file);
  const again = await post(base, '/api/commit-mastery', { words: ['absorb'], checked: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, 0);
  assert.equal(again.body.backup, null);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);

  assert.equal((await post(base, '/api/commit-mastery', {})).status, 400);
  assert.equal((await post(base, '/api/commit-mastery', { words: [] })).status, 400);
  assert.equal((await post(base, '/api/commit-mastery', { words: ['absorb'], checked: 'yes' })).status, 400);
  assert.equal((await post(base, '/api/commit-mastery', { words: ['absorb', ''], checked: true })).status, 400);
});

test('POST /api/level/plan lists senses and marks which words the reference lists cover', async () => {
  const { base } = await start(CEFR_FIXTURE, { ai: fakeAi(), cefr: fakeCefr({ outside: ['wordy'] }) });
  const res = await post(base, '/api/level/plan', { words: ['wordy', 'absorb', 'nope'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.missing, ['nope']);
  assert.deepEqual(
    res.body.items.map((i) => [i.word, i.chapter, i.covered, i.checked]),
    [
      ['wordy', 'A', 0, false],
      ['absorb', 'A', 1, false],
    ],
  );
  assert.deepEqual(res.body.items[0].senses, [
    {
      sense: 0,
      level: 'B2',
      definition: 'using too many words',
      chinese: null,
      example: 'His essay was wordy and dull.',
      checked: false,
    },
  ]);
  assert.equal(res.body.items[0].referenceLevels.outside, true);
  assert.deepEqual(res.body.items[1].referenceLevels.levels, [{ source: 'CEFR-J', pos: null, level: 'B1' }]);

  assert.equal((await post(base, '/api/level/plan', {})).status, 400);
  assert.equal((await post(base, '/api/level/plan', { words: [''] })).status, 400);
});

test('POST /api/level/vote asks three times and averages the levels back to a band', async () => {
  const ai = fakeAi({ votes: ['C1', 'C1', 'B2'] });
  const { base } = await start(CEFR_FIXTURE, { ai });
  const res = await post(base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 0 }] });
  assert.equal(res.status, 200);
  const { referenceLevels, trace, ...rest } = res.body.results[0];
  assert.deepEqual(rest, {
    word: 'absorb',
    sense: 0,
    from: 'B1',
    level: 'C1',
    votes: ['C1', 'C1', 'B2'],
    valid: 3,
    agree: 2,
    mean: 3.67,
  });
  assert.ok(res.body.results[0].referenceLevels.levels.length, '参考档位要一起回去');
  assert.ok(res.body.results[0].trace.tiers.length, '逐步命中要一起回去');
  // 三遍并行，每遍一批（这里一批只有一条），所以是 3 次调用。
  assert.equal(ai.levelVotes.length, 3);
  assert.equal(ai.levelVotes[0].input.word, 'absorb');
  assert.equal(ai.levelVotes[0].input.definition, 'take in');
  assert.equal(ai.levelVotes[0].input.example, 'Plants absorb water.');
  assert.ok(ai.levelVotes[0].input.referenceLevels, '投票也要带上参考档位（D30）');
  assert.equal(ai.levelVotes[0].opts.model, null);

  const majority = fakeAi({ votes: ['B2', 'B2', 'B1'] });
  const two = await start(CEFR_FIXTURE, { ai: majority });
  const band = await post(two.base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 0 }] });
  const one = band.body.results[0];
  assert.deepEqual({ level: one.level, mean: one.mean, agree: one.agree }, { level: 'B2', mean: 2.67, agree: 2 });
});

test('POST /api/level/vote drops invalid votes and reports no votes at all', async () => {
  const partial = fakeAi({ votes: ['B2', 'B2', 'XXXX'] });
  const { base } = await start(CEFR_FIXTURE, { ai: partial });
  const res = await post(base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 0 }] });
  assert.equal(res.status, 200);
  const only = res.body.results[0];
  assert.deepEqual({ level: only.level, valid: only.valid, agree: only.agree, mean: only.mean }, { level: 'B2', valid: 2, agree: 2, mean: 3 });

  // 票数只剩两张时平均会落在半档上，四舍五入向上（偏难的那一侧）。
  const tie = fakeAi({ votes: ['B2', 'A1', 'XXXX'] });
  const tied = await start(CEFR_FIXTURE, { ai: tie });
  const out = (await post(tied.base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 0 }] })).body.results[0];
  assert.equal(out.valid, 2);
  assert.equal(out.mean, 1.5);
  assert.equal(out.level, 'B1');

  // 三张票都不合法：这一条按「没定出档位」回去（level 为 null），不连累同批别的条目。
  const none = fakeAi({ votes: ['XXXX', 'XXXX', 'XXXX'] });
  const empty = await start(CEFR_FIXTURE, { ai: none });
  const bad = await post(empty.base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 0 }] });
  assert.equal(bad.status, 200);
  assert.deepEqual({ level: bad.body.results[0].level, valid: bad.body.results[0].valid }, { level: null, valid: 0 });
});

// 点「终止」= 关掉这条连接。服务端要把它变成信号往下传，让还在跑的五次投票一起停；
// 连接已经没了就别再写响应（写一个销毁了的 socket 会炸掉进程）。
test('closing the connection aborts the running votes and writes nothing back', async () => {
  const signals = [];
  const ai = fakeAi();
  ai.levelVoteBatch = (items, opts) =>
    new Promise((_, reject) => {
      signals.push(opts.signal);
      opts.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('已终止'), { code: 'aiAborted' })),
      );
    });
  const { base, file } = await start(CEFR_FIXTURE, { ai });
  const before = fs.readFileSync(file);
  const ac = new AbortController();
  const request = fetch(`${base}/api/level/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [{ word: 'absorb', sense: 0 }] }),
    signal: ac.signal,
  }).catch(() => 'aborted');

  for (let i = 0; i < 100 && signals.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(signals.length, 3, '三遍都发出了信号');
  ac.abort();
  assert.equal(await request, 'aborted');
  for (let i = 0; i < 100 && !signals.every((s) => s.aborted); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(signals.every((s) => s.aborted), '断开连接后三次调用都被中止');
  assert.deepEqual(fs.readFileSync(file), before, '复判不写盘');
});

test('POST /api/level/vote validates its target and surfaces the real upstream failure', async () => {
  const { base } = await start(CEFR_FIXTURE, { ai: fakeAi() });
  assert.equal((await post(base, '/api/level/vote', { targets: [{ word: 'nope', sense: 0 }] })).status, 404);
  assert.equal((await post(base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 9 }] })).status, 400);
  assert.equal((await post(base, '/api/level/vote', { targets: [{ word: 'absorb', sense: -1 }] })).status, 400);
  assert.equal((await post(base, '/api/level/vote', {})).status, 400);

  const noAi = await start(CEFR_FIXTURE);
  assert.equal((await post(noAi.base, '/api/level/vote', { targets: [{ word: 'absorb' }] })).status, 503);

  const broken = fakeAi({ throwError: Object.assign(new Error('没配模型'), { code: 'aiConfig' }) });
  const down = await start(CEFR_FIXTURE, { ai: broken });
  const err = await post(down.base, '/api/level/vote', { targets: [{ word: 'absorb', sense: 0 }] });
  assert.equal(err.status, 503);
  assert.equal(err.body.error.code, 'aiConfig');
});

test('POST /api/level/commit writes the whole batch in one go with one backup', async () => {
  const { base, file, dir } = await start(CEFR_FIXTURE);
  const res = await post(base, '/api/level/commit', {
    items: [
      { word: 'wordy', senses: [{ level: 'C1', definition: 'using too many words', example: 'His essay was wordy and dull.' }] },
      { word: 'cliché', senses: [{ level: 'B1', definition: 'overused phrase', example: 'His speech was full of clichés.' }], checked: false },
      { word: 'nope', senses: [{ level: 'B1', definition: 'x', example: 'X.' }] },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 2);
  assert.deepEqual(res.body.failed, [{ word: 'nope', reason: 'wordNotFound', message: '未找到词头：nope' }]);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('- wordy\n  - [ ] #C1 - using too many words - His essay was wordy and dull.'));
  assert.ok(text.includes('- cliché\n  - [ ] #B1 - overused phrase - His speech was full of clichés.'));

  const before = fs.readFileSync(file);
  assert.equal((await post(base, '/api/level/commit', {})).status, 400);
  assert.equal((await post(base, '/api/level/commit', { items: [7] })).status, 400);
  const noop = await post(base, '/api/level/commit', {
    items: [{ word: 'wordy', senses: [{ level: 'C1', definition: 'using too many words', example: 'His essay was wordy and dull.' }] }],
  });
  assert.equal(noop.body.changed, 0);
  assert.equal(noop.body.backup, null);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});
