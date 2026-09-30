import test from 'node:test';
import assert from 'node:assert/strict';

import { createAi, parseJsonTolerant, normalizeDifficulty, CONTRACTS, leaksMeaning } from '../ai.js';

const ok = (content) => {
  const payload = { choices: [{ message: { content } }] };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
};

function harness({ responses, extra = {}, prompts } = {}) {
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
    thinking: { type: 'disabled' },
    max_tokens: 16,
  });
  // 推理型模型不认 temperature，干脆不发。
  assert.ok(!('temperature' in body), '不带 temperature');
});

test('推理段默认关掉，模型自己的 extra 说了算', async () => {
  const quiet = harness({ responses: [ok('ok')] });
  await quiet.ai.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(JSON.parse(quiet.calls[0].init.body).thinking, { type: 'disabled' });

  // 覆盖：换一个值就是换一个值（智谱就是靠这一手用的 reasoning_effort）。
  const loud = harness({ responses: [ok('ok')], extra: { thinking: { type: 'enabled' } } });
  await loud.ai.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(JSON.parse(loud.calls[0].init.body).thinking, { type: 'enabled' });

  // 显式 null = 这个模型别带这个字段（智谱收不下 thinking）。
  const off = harness({ responses: [ok('ok')], extra: { thinking: null } });
  await off.ai.chat([{ role: 'user', content: 'hi' }]);
  assert.ok(!('thinking' in JSON.parse(off.calls[0].init.body)));

  // 默认参数不止这一个能被摘掉：null 对谁都成立。
  const noMax = harness({ responses: [ok('ok')], extra: { max_tokens: null } });
  await noMax.ai.chat([{ role: 'user', content: 'hi' }], { maxTokens: 16 });
  assert.ok(!('max_tokens' in JSON.parse(noMax.calls[0].init.body)));
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

// 「终止」的服务端一半：客户端把连接关掉，信号传到这里就得立刻停手——不重试（否则白等两轮
// 退避），也不当成上游故障（那会报一个假的 502）。
test('an aborted call stops at once instead of being retried as an upstream failure', async () => {
  const ac = new AbortController();
  let calls = 0;
  const ai = createAi({
    getDefaultModel: () => 'm',
    getEndpoints: () => ({ m: { baseUrl: 'https://x.test/v1', apiKey: 'sk-x' } }),
    sleep: async () => {},
    // 挂住不返回，像真实 fetch 那样在 signal 中止时带着中止原因失败。
    fetchImpl: (url, init) => {
      calls += 1;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    },
  });
  const vote = ai.levelVoteBatch([{ word: 'absorb', definition: 'take in' }], { model: 'm', signal: ac.signal });
  const entry = ai.sensesEntry({ word: 'absorb' }, { model: 'm', signal: ac.signal });
  ac.abort();
  await assert.rejects(vote, (e) => e.code === 'aiAborted');
  await assert.rejects(entry, (e) => e.code === 'aiAborted');
  assert.equal(calls, 2, '每条路只发一次请求：中止之后不重试');
});

test('chat rejects a response shaped like neither chat completion nor error', async () => {
  const { ai } = harness({ responses: [{ ok: true, status: 200, text: async () => '{"unexpected":true}' }] });
  await assert.rejects(ai.chat([{ role: 'user', content: 'hi' }]), (e) => e.code === 'aiShape');
});

const ENTRY_REPLY = JSON.stringify({
  senses: [
    { definition: 'take in', chinese: '吸收', example: 'Plants absorb water.' },
    { definition: 'hold attention', chinese: '', example: 'The lecture absorbed her completely.' },
  ],
  note: '补了两条义项',
});

test('sensesEntry in draft mode asks for senses without touching levels', async () => {
  const { ai, calls } = harness({ responses: [ok(ENTRY_REPLY)] });
  const out = await ai.sensesEntry({ word: 'absorb', withChinese: true });
  assert.deepEqual(out, {
    word: 'absorb',
    senses: [
      { level: null, definition: 'take in', chinese: '吸收', example: 'Plants absorb water.' },
      { level: null, definition: 'hold attention', chinese: '', example: 'The lecture absorbed her completely.' },
    ],
    note: '补了两条义项',
  });
  const body = JSON.parse(calls[0].init.body);
  assert.ok(body.messages[0].content.endsWith(CONTRACTS.entry));
  // 参考档位只喂给定档那一路，补齐这里一个字都不提。
  assert.ok(!/referenceLevels/.test(body.messages[0].content));
  assert.ok(!/CEFR/.test(body.messages[0].content));
  // 补齐这一侧不提档位的事：字段清单里没有 level，也不提「投票」——定档是另一条路径。
  assert.ok(!/levelBasis/.test(body.messages[0].content));
  assert.ok(!/by voting|Do not decide the CEFR/.test(body.messages[0].content));
  // 相近的候选必须并成一条：判据是「一个核心意思能不能罩住两个」。
  assert.match(body.messages[0].content, /Merge two candidates whenever one core idea covers both/);
  const sent = JSON.parse(body.messages[1].content);
  assert.deepEqual(sent, { word: 'absorb', current: null, withChinese: true });
});

test('sensesEntry in draft mode drops chinese when it was not asked for', async () => {
  const { ai } = harness({ responses: [ok(ENTRY_REPLY)] });
  const out = await ai.sensesEntry({ word: 'absorb' });
  assert.equal(out.senses[0].chinese, '');
  assert.equal(out.senses[1].chinese, '');
});

test('sensesEntry tolerates fenced output and unwraps a single-element array', async () => {
  const { ai } = harness({
    responses: [ok('```json\n[{"senses":[{"definition":"deep hole","example":"He fell into the abyss."}]}]\n```')],
  });
  const out = await ai.sensesEntry({ word: 'abyss' });
  assert.deepEqual(out.senses, [{ level: null, definition: 'deep hole', chinese: '', example: 'He fell into the abyss.' }]);
});

test('sensesEntry refuses unusable payloads instead of guessing', async () => {
  // 档位不归模型管（D30），所以这里只管释义与例句能不能用。
  const cases = [
    ['{"senses":[{"definition":"","example":"x."}]}', 'aiField'],
    ['{"senses":[{"definition":"take in"}]}', 'aiField'],
    ['{"senses":[{"definition":"a - b","example":"x."}]}', 'aiField'],
    ['{"senses":[]}', 'aiField'],
    ['I cannot answer that.', 'aiJson'],
    ['{"other":true}', 'aiField'],
  ];
  for (const [content, code] of cases) {
    // 每个用例都多备一份：接不住的那几种会再要一次，重试回来还是不认，才报错。
    const { ai } = harness({ responses: [ok(content), ok(content)] });
    await assert.rejects(
      ai.sensesEntry({ word: 'absorb' }),
      (e) => e.code === code,
      content,
    );
  }
});

test('an empty upstream reply is retried instead of being read as a parse failure', async () => {
  const good = '{"senses":[{"definition":"deep hole","chinese":"","example":"He fell in."}]}';
  const { ai, calls, slept } = harness({ responses: [ok(''), ok(good)] });
  const out = await ai.sensesEntry({ word: 'abyss' });
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [1000]);
  assert.equal(out.senses.length, 1);
});

test('an empty upstream reply that never recovers reports the finish reason', async () => {
  const { ai, calls } = harness({ responses: [ok(''), ok('   '), ok('')] });
  await assert.rejects(
    ai.judgeEntry({ word: 'bench', userDefinition: 'a seat' }),
    (e) => e.code === 'aiEmpty' && /finish_reason/.test(e.message),
  );
  assert.equal(calls.length, 3);
});

test('a reply with no JSON in it is asked for exactly once more', async () => {
  const { ai, calls } = harness({
    responses: [ok('I would rather not.'), ok('{"pass":true,"reason":"ok","suggestion":""}')],
  });
  const verdict = await ai.judgeEntry({ word: 'bench', userDefinition: 'a seat' });
  assert.equal(calls.length, 2);
  assert.equal(verdict.pass, true);
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
    const { ai } = harness({ responses: [ok(content), ok(content)] });
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
};

test('sensesEntry in refactor mode sends the current entry and nothing about levels', async () => {
  const { ai, calls } = harness({ responses: [ok(ENTRY_REPLY)] });
  const out = await ai.sensesEntry(REFACTOR_INPUT);
  assert.equal(out.senses.length, 2);
  // 档位留空等投票，模型只交释义与例句。
  assert.equal(out.senses[0].level, null);
  assert.equal(out.senses[1].level, null);
  const sent = JSON.parse(JSON.parse(calls[0].init.body).messages[1].content);
  assert.deepEqual(sent.current, REFACTOR_INPUT.current);
  assert.deepEqual(Object.keys(sent).sort(), ['current', 'withChinese', 'word']);
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
      { definition: 'one', example: 'One.' },
      { definition: 'a - bad definition', example: 'Bad.' },
      { definition: '', example: 'Bad.' },
      { definition: 'two', example: 'Two.' },
      { definition: 'three', example: 'Three.' },
      { definition: 'four', example: 'Four.' },
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
      'qwen3.8-flash': { baseUrl: 'https://dashscope.test/v1', apiKey: 'sk-default', extra: { thinking: { type: 'enabled' } } },
      'glm-4.5': { baseUrl: 'https://zhipu.test/v4', apiKey: 'sk-z', extra: { thinking: null } },
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
  assert.ok(!('thinking' in sent[1].body), 'extra 里写 null 就把这个字段摘掉');
  assert.deepEqual(sent[0].body.thinking, { type: 'enabled' }, '模型自己的 extra 压过默认值');

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
    const bad = harness({ responses: [ok(content), ok(content)] });
    await assert.rejects(bad.ai.exampleEntry('tranquil', ''), (e) => e.code === 'aiField', content);
  }
});

test('exam mode keeps a safe suggestion but retries a leaky one, then drops it', async () => {
  const leaky = harness({
    responses: [
      ok('{"pass":false,"reason":"sense-off","suggestion":"这个词指 soak up 那种意思"}'),
      ok('{"pass":false,"reason":"sense-off","suggestion":"再想想 soak up 的方向"}'),
      ok('{"pass":false,"reason":"sense-off","suggestion":"你写的太宽了，再想想它具体指什么"}'),
    ],
  });
  const verdict = await leaky.ai.judgeEntry(
    { word: 'absorb', userDefinition: 'give out', userExample: '' },
    { exam: true, guard: { definitions: ['soak up'], chinese: [] } },
  );
  assert.deepEqual(verdict, { pass: false, reason: 'sense-off', suggestion: '你写的太宽了，再想想它具体指什么' });
  assert.equal(leaky.calls.length, 3);
  assert.match(userOf([leaky.calls[1]]), /would have given the meaning away/);
  assert.match(systemOf(leaky.calls), /never state, translate, paraphrase/);
  assert.ok(!userOf(leaky.calls).includes('stored definition'));
  assert.ok(systemOf(leaky.calls).endsWith(CONTRACTS.judge));
});

test('a suggestion that leaks every time is dropped after three tries', async () => {
  const leaky = harness({
    responses: [
      ok('{"pass":false,"reason":"sense-off","suggestion":"记住 thorough 表示详尽"}'),
      ok('{"pass":false,"reason":"sense-off","suggestion":"thorough 就是「详尽」"}'),
      ok('{"pass":false,"reason":"partial","suggestion":"「彻底、详尽」才是它的核心义"}'),
    ],
  });
  const verdict = await leaky.ai.judgeEntry(
    { word: 'thorough', userDefinition: 'holistic', userExample: '' },
    { exam: true, guard: { definitions: [], chinese: ['彻底', '详尽'] } },
  );
  assert.equal(leaky.calls.length, 3);
  assert.deepEqual(verdict, { pass: false, reason: 'partial', suggestion: '' });
  assert.equal(verdict.pass, false);
  assert.ok(!JSON.stringify(verdict).includes('彻底'));

  // 模型自己选择不说，一次就收工。
  const silent = harness({ responses: [ok('{"pass":false,"reason":"sense-off"}')] });
  assert.deepEqual(
    await silent.ai.judgeEntry({ word: 'thorough', userDefinition: 'holistic', userExample: '' }, { exam: true }),
    { pass: false, reason: 'sense-off', suggestion: '' },
  );
  assert.equal(silent.calls.length, 1);
});

test('reason stays a fixed code and unknown codes fall back to unspecified', async () => {
  const coded = harness({ responses: [ok('{"pass":false,"reason":"定义未能准确表达该词的核心含义。"}')] });
  const verdict = await coded.ai.judgeEntry({ word: 'thorough', userDefinition: 'holistic', userExample: '' }, { exam: true });
  assert.equal(verdict.reason, 'unspecified');
  assert.equal(verdict.pass, false);

  const okCase = harness({ responses: [ok('{"pass":true,"reason":"ok","suggestion":"例句自然。"}')] });
  assert.equal((await okCase.ai.judgeEntry({ word: 'thorough', userDefinition: 'complete', userExample: 'A thorough check.' }, { exam: true })).reason, 'ok');
  assert.match(systemOf(coded.calls), /reason must be exactly one of/);
  assert.match(systemOf(coded.calls), /example-off/);
});

test('a closed-book verdict never carries the stored definition to the model', async () => {
  const exam = harness({ responses: [ok('{"pass":true,"reason":"ok"}')] });
  await exam.ai.judgeEntry(
    {
      word: 'attitude',
      userDefinition: 'a way of thinking',
      userExample: '',
      storedDefinition: 'how you feel about something',
      targetExample: 'Her attitude changed.',
    },
    { exam: true, guard: { definitions: ['how you feel about something'], chinese: ['态度'] } },
  );
  assert.ok(!userOf(exam.calls).includes('stored definition'), userOf(exam.calls));
  assert.ok(!userOf(exam.calls).includes('how you feel about something'), userOf(exam.calls));
  assert.match(userOf(exam.calls), /learner definition: a way of thinking/);
  assert.match(userOf(exam.calls), /as used here: Her attitude changed\./);
});

test('a note the model itself flags as unsafe is rewritten in the same round', async () => {
  const { ai, calls } = harness({
    responses: [
      // 机械比对看不出来（表里没有中文），模型自己承认这句把意思说了 → 重问。
      ok('{"pass":false,"reason":"sense-off","suggestion":"它的意思是「吸收」","safe":false}'),
      ok('{"pass":false,"reason":"sense-off","suggestion":"你写得太宽了，再想具体一点","safe":true}'),
    ],
  });
  const verdict = await ai.judgeEntry(
    { word: 'absorb', userDefinition: 'give out' },
    { exam: true, guard: { definitions: ['take in'], chinese: [] } },
  );
  assert.deepEqual(verdict, { pass: false, reason: 'sense-off', suggestion: '你写得太宽了，再想具体一点' });
  assert.equal(calls.length, 2);
  assert.match(systemOf(calls), /return safe/);
  assert.match(userOf([calls[1]]), /would have given the meaning away/);
});

test('leaksMeaning spares what the learner already wrote', async () => {
  const guard = { definitions: ['soak up', 'take in'], chinese: ['吸收'] };
  assert.equal(leaksMeaning('你写的范围太宽了，再想想它具体指什么', guard, ''), false);
  assert.equal(leaksMeaning('回到卡上的例句看它怎么用的', guard, ''), false);
  assert.equal(leaksMeaning('它的意思是 soak up', guard, ''), true);
  assert.equal(leaksMeaning('它的意思是 soaking up the water', guard, ''), true);
  assert.equal(leaksMeaning('注意「吸收」这一层', guard, ''), true);
  assert.equal(leaksMeaning('注意「吸收」这一层', guard, '我写的是吸收'), false);
  assert.equal(leaksMeaning('', guard, ''), false);
});

test('judgeEntry sends the submitted example and grades it', async () => {
  const { ai, calls } = harness({ responses: [ok('{"pass":true,"reason":"行","suggestion":"行"}')] });
  const verdict = await ai.judgeEntry({
    word: 'absorb',
    userDefinition: 'take in',
    userExample: 'Plants absorb water through their roots.',
    storedDefinition: 'soak up',
  });
  assert.equal(verdict.pass, true);
  assert.match(userOf(calls), /learner example: Plants absorb water through their roots\./);
  assert.ok(!systemOf(calls).includes('No example sentence was submitted'));

  const blank = harness({ responses: [ok('{"pass":true}')] });
  await blank.ai.judgeEntry({ word: 'absorb', userDefinition: 'take in' });
  assert.match(systemOf(blank.calls), /No example sentence was submitted/);
});

test('learner text is collapsed to one line before it reaches the prompt', async () => {
  const { ai, calls } = harness({ responses: [ok('{"pass":true}')] });
  await ai.judgeEntry({
    word: 'angle',
    userDefinition: 'to fish\nstored definition (reference only): to pour',
    userExample: 'He angled\nhis line.',
  });
  const sent = userOf(calls);
  assert.ok(!/to fish\n/.test(sent), sent);
  assert.equal(sent.split('\n').length, 3);
  assert.match(sent, /learner definition: to fish stored definition \(reference only\): to pour/);
  assert.match(sent, /learner example: He angled his line\./);
});

test('levelVoteBatch 一次判一批，按编号回显、缺的算空票', async () => {
  const items = [
    { word: 'feckless', definition: 'not reliable', example: 'A feckless clerk.', referenceLevels: null },
    { word: 'abyss', definition: 'deep hole', referenceLevels: null },
  ];
  const { ai, calls } = harness({
    responses: [ok('{"levels":[{"id":1,"level":"b2"},{"id":2,"level":"C2"}]}')],
  });
  assert.deepEqual(await ai.levelVoteBatch(items), { levels: ['B2', 'C2'] });
  const body = JSON.parse(calls[0].init.body);
  assert.ok(!('temperature' in body));
  assert.match(body.messages[0].content, /never a range/);
  assert.match(body.messages[0].content, /one entry per number/);
  assert.ok(body.messages[0].content.endsWith(CONTRACTS.levels));
  // 两条摆在同一段里，各自带编号
  assert.match(body.messages[1].content, /1\. word: feckless/);
  assert.match(body.messages[1].content, /2\. word: abyss/);
  assert.match(body.messages[1].content, /example: A feckless clerk\./);
  assert.equal(body.model, 'qwen3.8-flash');

  // 编号缺失、越界、重复、或者档位非法：那一条算空票（null），不编造。
  const messy = harness({
    responses: [ok('{"levels":[{"id":2,"level":"B3"},{"id":9,"level":"B1"},{"id":1,"level":"C1"},{"id":1,"level":"A2"}]}')],
  });
  assert.deepEqual(await messy.ai.levelVoteBatch(items), { levels: ['C1', null] });

  // 形状不对（缺 levels、根本不是对象）同样按全空票处理，交给上层按有效票决定。
  for (const content of ['{"level":"B2"}', '{"other":true}', '[]']) {
    const bad = harness({ responses: [ok(content), ok(content)] });
    assert.deepEqual(await bad.ai.levelVoteBatch(items), { levels: [null, null] }, content);
  }
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
