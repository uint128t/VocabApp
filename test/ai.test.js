import test from 'node:test';
import assert from 'node:assert/strict';

import { createAi, parseJsonTolerant, normalizeDifficulty, CONTRACTS } from '../ai.js';

const ok = (content) => {
  const payload = { choices: [{ message: { content } }] };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
};

function harness({ responses, extra = { enable_thinking: false }, prompts } = {}) {
  const calls = [];
  const slept = [];
  const queue = [...responses];
  const ai = createAi({
    getDefaultModel: () => 'qwen3.8-flash',
    getEndpoints: () => ({ 'qwen3.8-flash': { baseUrl: 'https://example.test/v1', apiKey: 'sk-test', extra } }),
    getPrompts: prompts ? () => prompts : undefined,
    sleep: async (ms) => {
      slept.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error('fake fetch 没有更多响应');
      if (next.throw) throw next.throw;
      return next;
    },
  });
  return { ai, calls, slept };
}

const fail = (status, body = 'upstream said no') => ({
  ok: false,
  status,
  text: async () => body,
  json: async () => ({ error: body }),
});

test('parseJsonTolerant survives bare, fenced, chatty and array-wrapped output', () => {
  assert.deepEqual(parseJsonTolerant('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonTolerant('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonTolerant('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonTolerant('Sure! Here you go: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.deepEqual(parseJsonTolerant('[{"a":1}]'), { a: 1 });
  assert.deepEqual(parseJsonTolerant('[{"a":1},{"a":2}]'), [
    { a: 1 },
    { a: 2 },
  ]);
  assert.deepEqual(parseJsonTolerant('{"a":1} then {"a":2}'), { a: 1 });
  assert.equal(parseJsonTolerant('no json here'), null);
  assert.equal(parseJsonTolerant('{"a":'), null);
  assert.equal(parseJsonTolerant(''), null);
});

test('normalizeDifficulty accepts only the six CEFR levels', () => {
  assert.equal(normalizeDifficulty('b1'), 'B1');
  assert.equal(normalizeDifficulty(' C2 '), 'C2');
  assert.equal(normalizeDifficulty('#A2'), 'A2');
  assert.equal(normalizeDifficulty('b1.5'), null);
  assert.equal(normalizeDifficulty(''), null);
  assert.equal(normalizeDifficulty(undefined), null);
});

test('chat posts to chat/completions with the key, model and extra params', async () => {
  const { ai, calls } = harness({ responses: [ok('smoke ok')] });
  const content = await ai.chat([{ role: 'user', content: 'hi' }], { maxTokens: 16 });
  assert.equal(content, 'smoke ok');
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    max_tokens: 16,
    enable_thinking: false,
  });
});

test('chat retries 429 and 5xx with backoff but never retries 4xx', async () => {
  const slow = harness({ responses: [fail(429), fail(503), ok('late')] });
  assert.equal(await slow.ai.chat([{ role: 'user', content: 'hi' }]), 'late');
  assert.equal(slow.calls.length, 3);
  assert.deepEqual(slow.slept, [1000, 3000]);

  const bad = harness({ responses: [fail(400)] });
  await assert.rejects(bad.ai.chat([{ role: 'user', content: 'hi' }]), (e) => e.code === 'aiHttp' && e.status === 400);
  assert.equal(bad.calls.length, 1);

  const exhausted = harness({ responses: [fail(500), fail(500), fail(500)] });
  await assert.rejects(exhausted.ai.chat([{ role: 'user', content: 'hi' }]), (e) => e.status === 500);
  assert.equal(exhausted.calls.length, 3);
});

test('chat reports a network failure as retryable and gives up after two retries', async () => {
  const { ai, calls } = harness({
    responses: [{ throw: new Error('ECONNRESET') }, { throw: new Error('ECONNRESET') }, { throw: new Error('ECONNRESET') }],
  });
  await assert.rejects(ai.chat([{ role: 'user', content: 'hi' }]), /ECONNRESET/);
  assert.equal(calls.length, 3);
});

test('chat rejects a response shaped like neither chat completion nor error', async () => {
  const { ai } = harness({ responses: [{ ok: true, status: 200, text: async () => '{"unexpected":true}' }] });
  await assert.rejects(ai.chat([{ role: 'user', content: 'hi' }]), (e) => e.code === 'aiShape');
});

const ENTRY_REPLY = JSON.stringify({
  senses: [
    { level: 'B1', levelBasis: 'reference', definition: 'take in', chinese: '吸收', example: 'Plants absorb water.' },
    { level: 'C1', levelBasis: 'judged', definition: 'hold attention', chinese: '', example: 'The lecture absorbed her completely.' },
  ],
  note: '补了两条义项',
});

test('sensesEntry in draft mode asks for senses and returns them with their basis', async () => {
  const { ai, calls } = harness({ responses: [ok(ENTRY_REPLY)] });
  const out = await ai.sensesEntry({ word: 'absorb', withChinese: true });
  assert.deepEqual(out, {
    word: 'absorb',
    senses: [
      { level: 'B1', levelBasis: 'reference', definition: 'take in', chinese: '吸收', example: 'Plants absorb water.' },
      { level: 'C1', levelBasis: 'judged', definition: 'hold attention', chinese: '', example: 'The lecture absorbed her completely.' },
    ],
    note: '补了两条义项',
  });
  const body = JSON.parse(calls[0].init.body);
  assert.ok(body.messages[0].content.endsWith(CONTRACTS.entry));
  assert.match(body.messages[0].content, /referenceLevels/);
  const sent = JSON.parse(body.messages[1].content);
  assert.deepEqual(sent, { word: 'absorb', current: null, referenceLevels: null, withChinese: true });
});

test('sensesEntry in draft mode drops chinese when it was not asked for', async () => {
  const { ai } = harness({ responses: [ok(ENTRY_REPLY)] });
  const out = await ai.sensesEntry({ word: 'absorb' });
  assert.equal(out.senses[0].chinese, '');
  assert.equal(out.senses[1].chinese, '');
});

test('sensesEntry tolerates fenced output and unwraps a single-element array', async () => {
  const { ai } = harness({
    responses: [ok('```json\n[{"senses":[{"level":"A2","definition":"deep hole","example":"He fell into the abyss."}]}]\n```')],
  });
  const out = await ai.sensesEntry({ word: 'abyss' });
  assert.deepEqual(out.senses, [{ level: 'A2', levelBasis: 'judged', definition: 'deep hole', chinese: '', example: 'He fell into the abyss.' }]);
});

test('sensesEntry refuses unusable payloads instead of guessing', async () => {
  const cases = [
    ['{"senses":[{"level":"B1","definition":"","example":"x."}]}', 'aiField'],
    ['{"senses":[{"level":"B1","definition":"take in"}]}', 'aiField'],
    ['{"senses":[{"level":"B7","definition":"take in","example":"x."}]}', 'aiField'],
    ['{"senses":[{"level":"B1","definition":"a - b","example":"x."}]}', 'aiField'],
    ['{"senses":[]}', 'aiField'],
    ['I cannot answer that.', 'aiJson'],
    ['{"other":true}', 'aiField'],
  ];
  for (const [content, code] of cases) {
    const { ai } = harness({ responses: [ok(content)] });
    await assert.rejects(
      ai.sensesEntry({ word: 'absorb' }),
      (e) => e.code === code,
      content,
    );
  }
});

test('judgeEntry returns a normalized verdict and shows the criteria', async () => {
  const { ai, calls } = harness({
    responses: [ok('{"pass":true,"reason":"释义抓住核心义；例句用法正确。","suggestion":"可以试试 absorb information"}')],
  });
  const verdict = await ai.judgeEntry({
    word: 'absorb',
    userDefinition: 'take in',
    userExample: 'Plants absorb water through their roots.',
    storedDefinition: 'soak up',
  });
  assert.deepEqual(verdict, {
    pass: true,
    reason: '释义抓住核心义；例句用法正确。',
    suggestion: '可以试试 absorb information',
  });
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.messages[0].content, /core sense/i);
  assert.match(body.messages[0].content, /Ignore grammar slips/i);
  assert.match(body.messages[0].content, /Fail an example only when/i);
  assert.match(body.messages[0].content, /reference and may be imperfect/i);
  assert.match(body.messages[1].content, /absorb/);
  assert.match(body.messages[1].content, /Plants absorb water through their roots\./);
  assert.match(body.messages[1].content, /soak up/);
});

test('judgeEntry switches the feedback language and defaults to Chinese', async () => {
  const zh = harness({ responses: [ok('{"pass":true}')] });
  await zh.ai.judgeEntry({ word: 'bench', userDefinition: 'a seat', userExample: 'Sit here.' });
  assert.match(JSON.parse(zh.calls[0].init.body).messages[0].content, /Write the reason and suggestion in Chinese/);

  const en = harness({ responses: [ok('{"pass":true}')] });
  await en.ai.judgeEntry({ word: 'bench', userDefinition: 'a seat', userExample: 'Sit here.' }, { lang: 'en' });
  const prompt = JSON.parse(en.calls[0].init.body).messages[0].content;
  assert.match(prompt, /Write the reason and suggestion in English/);
  assert.ok(!/in Chinese \(Simplified\)/.test(prompt));
});

test('judgeEntry normalizes a stringified pass and tolerates missing prose', async () => {
  const { ai } = harness({ responses: [ok('{"pass":"false"}')] });
  assert.deepEqual(await ai.judgeEntry({ word: 'bench', userDefinition: 'a seat', userExample: 'Sit on the bench.' }), {
    pass: false,
    reason: '',
    suggestion: '',
  });
});

test('judgeEntry refuses unusable verdicts instead of guessing', async () => {
  for (const content of ['I think you did fine.', '{"reason":"ok"}', '{"pass":"maybe"}', '{"pass":null}']) {
    const { ai } = harness({ responses: [ok(content)] });
    await assert.rejects(
      ai.judgeEntry({ word: 'bench', userDefinition: 'a seat', userExample: 'Sit on the bench.' }),
      (e) => e.code === 'aiJson' || e.code === 'aiField',
      content,
    );
  }
});

test('judgeEntry omits the stored definition when there is none', async () => {
  const { ai, calls } = harness({ responses: [ok('{"pass":true,"reason":"ok","suggestion":""}')] });
  await ai.judgeEntry({ word: 'attic', userDefinition: 'space under the roof', userExample: 'The box sat in the attic.' });
  assert.ok(!JSON.parse(calls[0].init.body).messages[1].content.includes('undefined'));
});

test('createAi refuses to run when the model is unconfigured or keyless', async () => {
  const noHit = createAi({ getDefaultModel: () => 'm', fetchImpl: async () => ok('') });
  await assert.rejects(noHit.chat([]), (e) => e.code === 'aiConfig' && /m\b/.test(e.message));
  const noKey = createAi({
    getDefaultModel: () => 'm',
    getEndpoints: () => ({ m: { baseUrl: 'https://x.test/v1', apiKey: '' } }),
    fetchImpl: async () => ok(''),
  });
  await assert.rejects(noKey.chat([]), (e) => e.code === 'aiConfig' && /m\b/.test(e.message));
});

const BATCH = [
  { word: 'absorb', definition: 'take in' },
  { word: 'bump', definition: 'small raised area' },
  { word: 'mow', definition: 'cut grass' },
];

const REFACTOR_INPUT = {
  word: 'absorb',
  current: {
    checked: false,
    headDefinition: 'take in',
    senses: [{ level: 'B1', definition: null, chinese: null, example: 'Plants absorb water.' }],
    rawLines: ['- [ ] absorb - take in', '  - #B1 · Plants absorb water.'],
  },
  referenceLevels: { word: 'absorb', levels: [{ source: 'CEFR-J', pos: 'verb', level: 'B1' }], related: [] },
};

test('sensesEntry in refactor mode sends the current entry plus the reference levels', async () => {
  const { ai, calls } = harness({ responses: [ok(ENTRY_REPLY)] });
  const out = await ai.sensesEntry(REFACTOR_INPUT);
  assert.equal(out.senses.length, 2);
  assert.equal(out.senses[0].levelBasis, 'reference');
  assert.equal(out.senses[1].levelBasis, 'judged');
  const sent = JSON.parse(JSON.parse(calls[0].init.body).messages[1].content);
  assert.deepEqual(sent.current, REFACTOR_INPUT.current);
  assert.deepEqual(sent.referenceLevels, REFACTOR_INPUT.referenceLevels);
  assert.equal(sent.withChinese, false);
});

test('sensesEntry keeps chinese alive when the entry already had it', async () => {
  const { ai, calls } = harness({ responses: [ok(ENTRY_REPLY)] });
  await ai.sensesEntry({
    ...REFACTOR_INPUT,
    current: { ...REFACTOR_INPUT.current, senses: [{ level: 'B1', definition: 'x', chinese: '吸收', example: 'y.' }] },
  });
  const sent = JSON.parse(JSON.parse(calls[0].init.body).messages[1].content);
  assert.equal(sent.withChinese, true);
});

test('sensesEntry caps usable senses at three and skips the rest', async () => {
  const many = JSON.stringify({
    senses: [
      { level: 'B1', definition: 'one', example: 'One.' },
      { level: 'B7', definition: 'bad level', example: 'Bad.' },
      { level: 'C1', definition: 'a - bad definition', example: 'Bad.' },
      { level: 'C2', definition: 'two', example: 'Two.' },
      { level: 'A2', definition: 'three', example: 'Three.' },
      { level: 'A1', definition: 'four', example: 'Four.' },
    ],
    note: '',
  });
  const { ai } = harness({ responses: [ok(many)] });
  const out = await ai.sensesEntry({ word: 'absorb' });
  assert.deepEqual(out.senses.map((s) => s.definition), ['one', 'two', 'three']);
});
test('a model can be routed to its own endpoint and key', async () => {
  const sent = [];
  const ai = createAi({
    getDefaultModel: () => 'qwen3.8-flash',
    getEndpoints: () => ({
      'qwen3.8-flash': { baseUrl: 'https://dashscope.test/v1', apiKey: 'sk-default', extra: { enable_thinking: false } },
      'glm-4.5': { baseUrl: 'https://zhipu.test/v4', apiKey: 'sk-z', extra: {} },
    }),
    fetchImpl: async (url, init) => {
      sent.push({ url, auth: init.headers.authorization, model: JSON.parse(init.body).model, body: JSON.parse(init.body) });
      return ok('hi');
    },
  });
  await ai.chat([{ role: 'user', content: 'x' }]);
  await ai.chat([{ role: 'user', content: 'x' }], { model: 'glm-4.5' });
  await assert.rejects(ai.chat([{ role: 'user', content: 'x' }], { model: 'not-configured' }), (e) => e.code === 'aiConfig');
  assert.deepEqual(
    sent.map((s) => [s.url, s.auth, s.model]),
    [
      ['https://dashscope.test/v1/chat/completions', 'Bearer sk-default', 'qwen3.8-flash'],
      ['https://zhipu.test/v4/chat/completions', 'Bearer sk-z', 'glm-4.5'],
    ],
  );
  assert.ok(!('enable_thinking' in sent[1].body), '自定义模型的 extra 覆盖了全局参数');
  assert.equal(sent[0].body.enable_thinking, false, '默认模型仍带自己配置的 extra');

  const full = createAi({
    getDefaultModel: () => 'm',
    getEndpoints: () => ({ m: { baseUrl: 'https://x.test/v4/chat/completions', apiKey: 'sk-x' } }),
    fetchImpl: async (url, init) => {
      sent.push({ url });
      return ok('hi');
    },
  });
  await full.chat([{ role: 'user', content: 'x' }], { model: 'm' });
  assert.equal(sent.at(-1).url, 'https://x.test/v4/chat/completions');
});

test('a routed model without a key says which one failed', async () => {
  const ai = createAi({
    getDefaultModel: () => 'm',
    getEndpoints: () => ({
      m: { baseUrl: 'https://dashscope.test/v1', apiKey: 'sk-default' },
      'glm-4.5': { baseUrl: 'https://zhipu.test/v4', apiKey: '' },
    }),
    fetchImpl: async () => ok('hi'),
  });
  await assert.rejects(ai.chat([{ role: 'user', content: 'x' }], { model: 'glm-4.5' }), (e) => e.code === 'aiConfig' && /glm-4\.5/.test(e.message));
  assert.equal(await ai.chat([{ role: 'user', content: 'x' }]), 'hi');
});

const systemOf = (calls) => JSON.parse(calls[0].init.body).messages[0].content;
const userOf = (calls) => JSON.parse(calls[0].init.body).messages[1].content;

test('every prompt ends with the fixed output contract', async () => {
  const d = harness({ responses: [ok(ENTRY_REPLY)] });
  await d.ai.sensesEntry({ word: 'absorb' });
  assert.ok(systemOf(d.calls).endsWith(CONTRACTS.entry), systemOf(d.calls).slice(-90));

  const j = harness({ responses: [ok('{"pass":true}')] });
  await j.ai.judgeEntry({ word: 'bench', userDefinition: 'a seat', userExample: 'Sit here.' });
  assert.ok(systemOf(j.calls).endsWith(CONTRACTS.judge));

  const e = harness({ responses: [ok('{"example":"Sit here."}')] });
  await e.ai.exampleEntry('bench', 'a seat');
  assert.ok(systemOf(e.calls).endsWith(CONTRACTS.example));
});

test('prompt overrides replace only the descriptive body', async () => {
  const prompts = { entry: 'MY ENTRY RULES', judge: 'MY JUDGE RULES' };

  const d = harness({ prompts, responses: [ok(ENTRY_REPLY)] });
  await d.ai.sensesEntry({ word: 'absorb' });
  assert.equal(systemOf(d.calls), `MY ENTRY RULES ${CONTRACTS.entry}`);

  const j = harness({ prompts, responses: [ok('{"pass":false,"reason":"no","suggestion":"no"}')] });
  await j.ai.judgeEntry({ word: 'bench', userDefinition: 'a seat', userExample: 'Sit here.' });
  assert.ok(systemOf(j.calls).startsWith('MY JUDGE RULES'));
  assert.ok(systemOf(j.calls).endsWith(CONTRACTS.judge));

  const b = harness({ prompts, responses: [ok(ENTRY_REPLY)] });
  await b.ai.sensesEntry(REFACTOR_INPUT);
  assert.ok(systemOf(b.calls).startsWith('MY ENTRY RULES'));
});

test('judgeEntry grades the definition alone when no example is submitted', async () => {
  const { ai, calls } = harness({ responses: [ok('{"pass":true,"reason":"释义到位"}')] });
  const verdict = await ai.judgeEntry({ word: 'absorb', userDefinition: 'take in', userExample: '' });
  assert.equal(verdict.pass, true);
  assert.match(systemOf(calls), /No example sentence was submitted/i);
  assert.match(systemOf(calls), /grade only the definition/i);
  assert.ok(!userOf(calls).includes('learner example'), userOf(calls));
  assert.ok(systemOf(calls).endsWith(CONTRACTS.judge));

  const withExample = harness({ responses: [ok('{"pass":true}')] });
  await withExample.ai.judgeEntry({ word: 'absorb', userDefinition: 'take in', userExample: 'Plants absorb water.' });
  assert.ok(!/No example sentence was submitted/.test(systemOf(withExample.calls)));
  assert.match(userOf(withExample.calls), /learner example: Plants absorb water\./);
});

test('judgeEntry grades against the use the target sentence shows', async () => {
  const { ai, calls } = harness({ responses: [ok('{"pass":true,"reason":"ok","suggestion":""}')] });
  await ai.judgeEntry({
    word: 'angle',
    userDefinition: 'to fish',
    userExample: '',
    targetExample: 'He angled his line carefully.',
  });
  assert.match(systemOf(calls), /grade the definition against that use/i);
  assert.match(userOf(calls), /as used here: He angled his line carefully\./);

  const plain = harness({ responses: [ok('{"pass":true}')] });
  await plain.ai.judgeEntry({ word: 'angle', userDefinition: 'to fish', userExample: '' });
  assert.ok(!userOf(plain.calls).includes('as used here'), userOf(plain.calls));

  const exam = harness({ responses: [ok('{"pass":true,"reason":"ok"}')] });
  const verdict = await exam.ai.judgeEntry(
    { word: 'angle', userDefinition: 'to fish', userExample: '', storedDefinition: 'to fish', targetExample: 'He angled his line carefully.' },
    { exam: true },
  );
  assert.equal(verdict.reason, 'ok');
  assert.match(userOf(exam.calls), /as used here: He angled his line carefully\./);
  assert.ok(!userOf(exam.calls).includes('stored definition'), userOf(exam.calls));
});

test('exampleEntry generates one fresh sentence and validates it', async () => {
  const good = harness({ responses: [ok('{"example":"The lake was tranquil at dawn."}')] });
  assert.deepEqual(await good.ai.exampleEntry('tranquil', 'calm and peaceful'), { example: 'The lake was tranquil at dawn.' });
  assert.match(userOf(good.calls), /word: tranquil/);
  assert.match(userOf(good.calls), /meaning: calm and peaceful/);
  assert.match(systemOf(good.calls), /at most 14 words/);
  assert.match(systemOf(good.calls), /actually inflected form/);

  for (const content of ['{"example":"   "}', 'not json at all', '{"other":1}', '[]']) {
    const bad = harness({ responses: [ok(content)] });
    await assert.rejects(bad.ai.exampleEntry('tranquil', ''), (e) => e.code === 'aiField', content);
  }
});

test('exam mode forbids leaking the answer and drops the suggestion', async () => {
  const { ai, calls } = harness({
    responses: [ok('{"pass":false,"reason":"义项跑偏了","suggestion":"试试 absorb information"}')],
  });
  const verdict = await ai.judgeEntry(
    { word: 'absorb', userDefinition: 'give out', userExample: 'The sun absorbs light.', storedDefinition: 'soak up' },
    { exam: true },
  );
  assert.deepEqual(verdict, { pass: false, reason: 'unspecified', suggestion: '' });
  assert.match(systemOf(calls), /must not state, restate, translate, or hint at/);
  assert.ok(!userOf(calls).includes('stored definition'));
  assert.ok(!userOf(calls).includes('soak up'));
  assert.ok(systemOf(calls).endsWith(CONTRACTS.judge));
});

test('exam mode only ever returns an error code, never free text', async () => {
  const leaky = harness({
    responses: [ok('{"pass":false,"reason":"定义未能准确表达该词“彻底、详尽”的核心含义。","suggestion":"记住 thorough 表示详尽"}')],
  });
  const verdict = await leaky.ai.judgeEntry(
    { word: 'thorough', userDefinition: 'holistic', userExample: '' },
    { exam: true },
  );
  assert.equal(verdict.reason, 'unspecified');
  assert.equal(verdict.suggestion, '');
  assert.equal(verdict.pass, false);
  assert.ok(!JSON.stringify(verdict).includes('彻底'));

  const coded = harness({ responses: [ok('{"pass":false,"reason":"sense-off"}')] });
  const okCase = harness({ responses: [ok('{"pass":true,"reason":"ok"}')] });
  assert.equal((await coded.ai.judgeEntry({ word: 'thorough', userDefinition: 'holistic', userExample: '' }, { exam: true })).reason, 'sense-off');
  assert.equal((await okCase.ai.judgeEntry({ word: 'thorough', userDefinition: 'complete', userExample: '' }, { exam: true })).reason, 'ok');
  assert.match(systemOf(coded.calls), /reason must be exactly one of/);
});

test('testTarget pings a specific endpoint and reports latency', async () => {
  const sent = [];
  const ai = createAi({
    getDefaultModel: () => 'qwen3.8-flash',
    fetchImpl: async (url, init) => {
      sent.push({ url, auth: init.headers.authorization, model: JSON.parse(init.body).model });
      return ok('OK');
    },
  });
  const res = await ai.testTarget({ baseUrl: 'https://dashscope.test/v1', apiKey: 'sk-test', model: 'qwen3.8-flash' });
  assert.deepEqual(res, { ok: true, model: 'qwen3.8-flash', baseUrl: 'https://dashscope.test/v1', latencyMs: res.latencyMs });

  await ai.testTarget({ baseUrl: 'https://zhipu.test/v4', apiKey: 'sk-z', model: 'glm-4.5' });
  assert.deepEqual(sent.at(-1), { url: 'https://zhipu.test/v4/chat/completions', auth: 'Bearer sk-z', model: 'glm-4.5' });
});

test('testTarget says which model lacks a key', async () => {
  const ai = createAi({
    getDefaultModel: () => 'qwen3.8-flash',
    fetchImpl: async () => ok('OK'),
  });
  await assert.rejects(
    ai.testTarget({ baseUrl: 'https://zhipu.test/v4', apiKey: '', model: 'glm-4.5' }),
    (e) => e.code === 'aiConfig' && /glm-4\.5/.test(e.message),
  );
});

test('testTarget surfaces upstream errors with the response body', async () => {
  const { ai, calls } = harness({ responses: [fail(400, '{"error":{"message":"该模型始终思考"}}')] });
  await assert.rejects(
    ai.testTarget({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'glm-5.3-flash' }),
    (e) => e.code === 'aiHttp' && /始终思考/.test(e.body),
  );
  assert.equal(calls.length, 1);
});
