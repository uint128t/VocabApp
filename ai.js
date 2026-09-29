const CEFR = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function aiError(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) Object.assign(e, details);
  return e;
}

function stripFence(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

function balancedSlice(text, from) {
  const open = text[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

export function parseJsonTolerant(raw) {
  const text = stripFence(String(raw ?? ''));
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const from = Math.min(...starts);
  const slice = balancedSlice(text, from);
  if (!slice) return null;
  let value;
  try {
    value = JSON.parse(slice);
  } catch {
    return null;
  }
  if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object') return value[0];
  return value;
}

export function normalizeDifficulty(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/^#/, '').toUpperCase();
  return CEFR.has(v) ? v : null;
}

const cleanField = (value) =>
  typeof value === 'string' && value.trim() !== '' && !value.includes('\n') ? value.trim() : null;

const ENTRY_RULES = [
  'You fill in one entry of a hand-maintained English-English vocabulary list: the senses a learner should know, each with a CEFR level and an example.',
  'Input is {word, current, referenceLevels, withChinese}. "current" is the entry as it stands today, or null when the word is new; it may be incomplete. "referenceLevels" are CEFR levels taken from published word lists for this word, for related forms of it, and its frequency rank.',
  'Return at most three senses, most common first, and give every sense these five fields:',
  'level: exactly one of A1, A2, B1, B2, C1, C2. When the reference levels cover that sense, use them and set levelBasis to "reference"; only when the references do not cover it may you judge the level yourself, and then set levelBasis to "judged".',
  'definition: English-English, at most 8 words, lowercase first letter, no trailing period, no " - " inside, exactly one meaning; for a phrasal verb describe it as verb + particle.',
  'Never write a part-of-speech label such as "(v.)" or "(n.)": not in the headword, not at the start of a definition. Separate senses are how you tell parts of speech apart.',
  'chinese: a Simplified Chinese gloss of 2 to 6 characters when withChinese is true, otherwise an empty string; keep the gloss when the current entry already has one.',
  'example: at most 14 words, everyday real context, must contain an actually inflected form of the word, ends with a period.',
  'Never change the headword, never bundle two meanings or two parts of speech into one sense, and never output a reference level as the definition.',
  'note: one short sentence in Chinese saying what you filled in or changed.',
];

export const CONTRACTS = {
  entry:
    'Output ONLY a JSON object with no prose and no code fences. Keys: senses, note. senses must be an array of objects with exactly level, levelBasis, definition, chinese, example.',
  judge:
    'Output ONLY a JSON object with no prose and no code fences. Keys: pass, reason, suggestion. pass must be a boolean.',
  example:
    'Output ONLY a JSON object with no prose and no code fences. Keys: example. example must be one English sentence of at most 14 words and must end with a period.',
};

export function entryInstructions() {
  return ENTRY_RULES.join(' ');
}

export function defaultPrompts() {
  return {
    entry: entryInstructions(),
    judge: judgeInstructions('zh'),
  };
}

const JUDGE_RULES = [
  'You grade whether a learner has mastered one English word.',
  'pass is true only when BOTH the definition and the example are acceptable.',
  'Definition: accept any wording that hits the core sense of the word, including a broader phrasing; fail when the sense is wrong, when it is written in Chinese, or when it is only a part-of-speech label.',
  'Example: judge only whether the sentence shows that the learner knows what the word means. Ignore grammar slips, awkward phrasing, missing or wrong articles, tense and number agreement, unusual collocations, and using the word as another part of speech.',
  'When the prompt shows the sentence in which the word is being asked about, grade the definition against that use of the word.',
  'Fail an example only when the word is not actually used in it, when the sentence shows a wrong or unrelated meaning, or when the word is spelled so differently that it is no longer recognisable.',
  'reason is one short sentence explaining the verdict; suggestion is one short sentence about what to practise next.',
  'The stored definition is only a reference and may be imperfect; judge mainly from your own knowledge of the word.',
];

export const EXAM_CODES = ['ok', 'sense-off', 'word-not-used', 'wrong-pos', 'spelling', 'partial', 'unspecified'];

const EXAM_RULES = [
  'This is a closed-book test: the learner must not learn anything new from your reply.',
  'reason must be exactly one of these codes and nothing else: ok, sense-off, word-not-used, wrong-pos, spelling, partial, unspecified.',
  'Never write an explanation, translation, example sentence, synonym, or any wording that hints at the meaning into reason or suggestion.',
  'reason must not state, restate, translate, or hint at the correct meaning; if unsure which code fits, use unspecified.',
];

export function judgeInstructions(lang) {
  const feedback =
    lang === 'en'
      ? 'Write the reason and suggestion in English.'
      : 'Write the reason and suggestion in Chinese (Simplified).';
  return [...JUDGE_RULES, feedback].join(' ');
}

function judgePrompt({ word, userDefinition, userExample, storedDefinition, targetExample }) {
  const parts = [`word: ${word}`, `learner definition: ${userDefinition}`];
  if (userExample) parts.push(`learner example: ${userExample}`);
  if (targetExample) parts.push(`the word is being asked about as used here: ${targetExample}`);
  if (storedDefinition) parts.push(`stored definition (reference only): ${storedDefinition}`);
  return parts.join('\n');
}

const NO_EXAMPLE_NOTE =
  'No example sentence was submitted this time; grade only the definition and do not fail the answer for the missing example.';

const EXAMPLE_RULES =
  'You write one fresh example sentence for an English word in a vocabulary list. It must be natural, everyday and self-contained, must use the word in an actually inflected form, and must clearly show the given meaning.';

export function createAi({
  getDefaultModel = () => undefined,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 90_000,
  retries = 2,
  backoff = [1000, 3000],
  getPrompts = () => ({}),
  getEndpoints = () => ({}),
} = {}) {
  const system = (key, fallback) => {
    const custom = getPrompts()?.[key];
    return typeof custom === 'string' && custom.trim() ? custom.trim() : fallback;
  };

  const normalizeBase = (base) =>
    String(base || '')
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/i, '');

  const targetFor = (model) => {
    const name = model || getDefaultModel();
    if (!name) throw aiError('aiConfig', '未设置默认模型：请在设置页选择或添加一个模型');
    const hit = (getEndpoints() || {})[name];
    if (!hit) throw aiError('aiConfig', `模型 ${name} 没有配置接入点：请在设置页添加它的接入点与密钥名`);
    const base = normalizeBase(hit.baseUrl);
    if (!base || !hit.apiKey) throw aiError('aiConfig', `模型 ${name} 缺少接入点或密钥（密钥请在 .env 里用 VOCAB_KEY_名字=… 配置）`);
    return { base, key: hit.apiKey, extra: hit.extra, name };
  };

  async function once(messages, { maxTokens, temperature }, target) {
    const body = { model: target.name, messages, temperature };
    if (maxTokens) body.max_tokens = maxTokens;
    Object.assign(body, target.extra || {});

    const res = await fetchImpl(`${target.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw aiError('aiHttp', `上游返回 ${res.status}`, { status: res.status, body: raw.slice(0, 500) });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw aiError('aiShape', `上游返回不是 JSON：${raw.slice(0, 200)}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw aiError('aiShape', '上游响应里没有 message.content');
    return content;
  }

  async function chat(messages, { model, maxTokens, temperature = 0 } = {}) {
    const target = targetFor(model);
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(messages, { model, maxTokens, temperature }, target);
      } catch (e) {
        const retryable = e.code === 'aiHttp' ? RETRYABLE_STATUS.has(e.status) : e.code !== 'aiShape';
        if (retryable && attempt < retries) {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
          continue;
        }
        throw e;
      }
    }
  }

  async function judgeEntry({ word, userDefinition, userExample, storedDefinition, targetExample }, { model, lang, exam } = {}) {
    const example = typeof userExample === 'string' ? userExample.trim() : '';
    const parts = [system('judge', judgeInstructions(lang))];
    if (!example) parts.push(NO_EXAMPLE_NOTE);
    if (exam) parts.push(EXAM_RULES.join(' '));
    parts.push(CONTRACTS.judge);
    const content = await chat(
      [
        { role: 'system', content: parts.join(' ') },
        {
          role: 'user',
          content: judgePrompt({
            word,
            userDefinition,
            userExample: example,
            storedDefinition: exam ? '' : storedDefinition,
            targetExample,
          }),
        },
      ],
      { model, maxTokens: 800, temperature: 0 },
    );
    const obj = parseJsonTolerant(content);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw aiError('aiJson', `模型没有返回可用 JSON：${String(content).slice(0, 200)}`);
    }
    const raw = obj.pass;
    const pass = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
    if (pass === null) throw aiError('aiField', `模型没有给出可用的 pass：${JSON.stringify(obj).slice(0, 200)}`);
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    if (!exam) return { pass, reason: text(obj.reason), suggestion: text(obj.suggestion) };
    const code = text(obj.reason);
    return { pass, reason: EXAM_CODES.includes(code) ? code : 'unspecified', suggestion: '' };
  }

  async function testTarget(target = {}) {
    const name = target.model || getDefaultModel();
    if (!name) throw aiError('aiConfig', '未设置默认模型：请在设置页选择或添加一个模型');
    const base = normalizeBase(target.baseUrl);
    const key = target.apiKey;
    if (!base || !key) throw aiError('aiConfig', `模型 ${name} 缺少接入点或密钥（密钥请在 .env 里用 VOCAB_KEY_名字=… 配置）`);
    const startedAt = Date.now();
    await once(
      [{ role: 'user', content: 'Reply with the single word OK' }],
      { model: name, maxTokens: 200, temperature: 0 },
      { base, key, extra: target.extra, name },
    );
    return { ok: true, model: name, baseUrl: base, latencyMs: Date.now() - startedAt };
  }

  async function exampleEntry(word, definition, { model } = {}) {
    const content = await chat(
      [
        { role: 'system', content: `${EXAMPLE_RULES} ${CONTRACTS.example}` },
        { role: 'user', content: `word: ${word}\nmeaning: ${typeof definition === 'string' ? definition.trim() : ''}` },
      ],
      { model, maxTokens: 120, temperature: 0 },
    );
    const obj = parseJsonTolerant(content);
    const raw = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.example : null;
    const example = cleanField(typeof raw === 'string' ? raw : '');
    if (!example) throw aiError('aiField', `模型没有给出可用例句：${String(content).slice(0, 200)}`);
    return { example };
  }

  async function sensesEntry({ word, current = null, referenceLevels = null, withChinese = false }, { model } = {}) {
    const keepChinese = Boolean(current && ((current.senses || []).some((s2) => s2.chinese) || current.headChinese));
    const wantChinese = withChinese === true || keepChinese;
    const content = await chat(
      [
        { role: 'system', content: `${system('entry', entryInstructions())} ${CONTRACTS.entry}` },
        { role: 'user', content: JSON.stringify({ word, current, referenceLevels, withChinese: wantChinese }) },
      ],
      { model, maxTokens: 1400, temperature: 0 },
    );
    let obj = parseJsonTolerant(content);
    if (Array.isArray(obj)) obj = { senses: obj };
    if (obj && typeof obj === 'object' && obj.senses && !Array.isArray(obj.senses) && typeof obj.senses === 'object') {
      obj = { ...obj, senses: [obj.senses] };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw aiError('aiJson', `模型没有返回可用 JSON：${String(content).slice(0, 200)}`);
    }
    const rows = Array.isArray(obj.senses) ? obj.senses : [];
    const usable = [];
    for (const row of rows) {
      const level = normalizeDifficulty(row?.level);
      const definition = cleanField(row?.definition);
      const example = cleanField(row?.example);
      if (!level || !definition || !example || definition.includes(' - ')) continue;
      const chinese = wantChinese ? (typeof row.chinese === 'string' ? row.chinese.trim() : '') : '';
      const levelBasis = row?.levelBasis === 'reference' ? 'reference' : 'judged';
      usable.push({ level, levelBasis, definition, chinese, example });
    }
    const senses = usable.slice(0, 3);
    if (!senses.length) {
      throw aiError('aiField', `模型没有给出可用的义项：${JSON.stringify(obj).slice(0, 200)}`);
    }
    const note = typeof obj.note === 'string' ? obj.note.trim() : '';
    return { word, senses, note };
  }

  return {
    chat,
    sensesEntry,
    judgeEntry,
    exampleEntry,
    testTarget,
    parseJsonTolerant,
    normalizeDifficulty,
  };
}
