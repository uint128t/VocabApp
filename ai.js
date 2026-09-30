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
  'You fill in one entry of a hand-maintained English-English vocabulary list: the senses a learner should know, each with an example.',
  'Input is {word, current, referenceLevels, withChinese}. "current" is the entry as it stands today, or null when the word is new; it may be incomplete. "referenceLevels" are CEFR levels taken from published word lists for this word, for related forms of it, and its frequency rank.',
  'Return at most three senses, most common first, and give every sense these three fields:',
  'Split a word into separate senses only when the meanings really differ, and fewer when they are close: if two candidates are variants of the same idea, or one is just another wording of the other, merge them into one sense. A short list of clearly distinct senses beats a long list of near-duplicates.',
  'definition: English-English, at most 8 words, lowercase first letter, no trailing period, no " - " inside, exactly one meaning; for a phrasal verb describe it as verb + particle.',
  'Never write a part-of-speech label such as "(v.)" or "(n.)": not in the headword, not at the start of a definition. Separate senses are how you tell parts of speech apart.',
  'chinese: a Simplified Chinese gloss of 2 to 6 characters when withChinese is true, otherwise an empty string; keep the gloss when the current entry already has one.',
  'example: at most 14 words, everyday real context, must contain an actually inflected form of the word, ends with a period, no " - " inside.',
  'Do not decide the CEFR level and do not output one: levels are assigned separately, by voting.',
  'Never change the headword, never bundle two meanings or two parts of speech into one sense, and never output a reference level as the definition.',
  'note: one short sentence in Chinese saying what you filled in or changed.',
];

export const CONTRACTS = {
  entry:
    'Output ONLY a JSON object with no prose and no code fences. Keys: senses, note. senses must be an array of objects with exactly definition, chinese, example.',
  judge:
    'Output ONLY a JSON object with no prose and no code fences. Keys: pass, reason, suggestion. pass must be a boolean.',
  example:
    'Output ONLY a JSON object with no prose and no code fences. Keys: example. example must be one English sentence of at most 14 words and must end with a period.',
  level:
    'Output ONLY a JSON object with no prose and no code fences. Keys: level. level must be exactly one of A1, A2, B1, B2, C1, C2.',
};

function entryInstructions() {
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

const EXAM_CODES = [
  'ok',
  'sense-off',
  'partial',
  'wrong-pos',
  'spelling',
  'word-not-used',
  'example-off',
  'unspecified',
];

const EXAM_RULES = [
  'This is a closed-book test: the learner must not be able to learn what the word means from your reply.',
  `reason must be exactly one of these codes and nothing else: ${EXAM_CODES.join(', ')}.`,
  'Use sense-off when the definition misses the sense being asked about or is not English; partial when it is on the right track but does not pin the core sense down; wrong-pos when it is only a part-of-speech label; spelling when the word form is too misspelled to recognise; word-not-used when the submitted example does not actually use the word; example-off when the submitted example shows a different or unrelated meaning; unspecified when nothing else fits.',
  'suggestion is the only free text you may write: at most two short sentences, in the language asked for, on a single line without line breaks.',
  'suggestion speaks only about the learner\'s own answer and about how to check their thinking next time: what is too broad or too narrow in what they wrote, which part of the question to re-read, which step to try again. Quote their own words when that helps.',
  'suggestion must never state, translate, paraphrase, narrow down, or hint at what the word or any of its senses means, in any language. No synonym, no collocation, no example sentence, no definition of a related word, no part-of-speech label, no Chinese gloss of the meaning.',
  'Bad suggestion: "这个词指一种小的容器". Bad suggestion: "试试「吸收」这个义项". Bad suggestion: "think of something you use when it rains". Good suggestion: "你写的范围太宽了，再想想它具体指什么". Good suggestion: "回到卡片上的例句，看这个词出现在什么场景里".',
  'Return an empty suggestion when you cannot say something useful without giving the meaning away.',
  'Also return safe: set it to false when your suggestion — or anything else in your reply — would tell the learner what the word or any of its senses means, in any language, including a Chinese translation of the meaning; set it to true when the suggestion only talks about their own answer and how to check it next time. Judge this after you have written the suggestion.',
  'reason must not restate or hint at the correct meaning either; if you are unsure which code fits, use unspecified.',
];

// 闭卷点评的机械兜底：拿模型写的话跟表内释义/中文比对，撞上就算说漏了。
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into',
  'about', 'as', 'than', 'that', 'this', 'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been',
  'am', 'do', 'does', 'did', 'not', 'no', 'you', 'your', 'yours', 'i', 'my', 'me', 'we', 'our', 'he', 'she', 'they',
  'them', 'his', 'her', 'their', 'one', 'some', 'any', 'all', 'more', 'most', 'less', 'very', 'too', 'also', 'so',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'have', 'has', 'had', 'there', 'here', 'when',
  'where', 'which', 'who', 'what', 'how', 'why', 'again', 'still', 'just', 'only', 'even', 'out', 'up', 'down',
  'off', 'over', 'under', 'then', 'now', 'word', 'words', 'sense', 'senses', 'meaning', 'means', 'definition',
  'define', 'answer', 'example', 'sentence', 'english', 'chinese', 'correct', 'wrong', 'right', 'closer', 'close',
  'think', 'try', 'write', 'wrote', 'written', 'remember', 'check', 'guess', 'good', 'better', 'bad', 'part',
  'speech', 'noun', 'verb', 'adjective', 'adverb', 'prefix', 'suffix', 'form', 'core', 'vague', 'broad',
  'narrow', 'specific', 'concrete', 'general', 'usage', 'used', 'use', 'using', 'context', 'see', 'look', 'read',
]);

const stemOf = (w) => (w.length > 3 ? w.replace(/(ies|es|s|ed|ing)$/, '') : w);

function contentWords(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z']+/)) {
    const w = raw.replace(/^'+|'+$/g, '');
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    const stem = stemOf(w);
    if (stem.length >= 3 && !STOP_WORDS.has(stem)) out.add(stem);
  }
  return out;
}

function cjkRuns(text) {
  return String(text || '')
    .split(/[^\u4e00-\u9fff]+/)
    .filter((run) => run.length >= 2);
}

// 中文那边只能按字面比：表内中文是 2–6 字，整串和它的 2 字片段都算敏感词。
function cjkTerms(text) {
  const out = new Set();
  for (const run of cjkRuns(text)) {
    out.add(run);
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

// 说漏了没有：点评里的实词/中文片段撞上表内释义与中文就算。你自己答案里已经出现过的
// 那部分扣掉——照表内释义写对了、模型复述你的答案，不该被当成泄密。
export function leaksMeaning(note, guard, mine = '') {
  const text = String(note || '');
  if (!text.trim()) return false;
  const guarded = new Set();
  for (const def of guard?.definitions || []) for (const w of contentWords(def)) guarded.add(w);
  const mineWords = contentWords(mine);
  for (const w of guarded) if (!mineWords.has(w) && contentWords(text).has(w)) return true;

  const mineZh = String(mine || '');
  for (const zh of guard?.chinese || []) {
    for (const term of cjkTerms(zh)) {
      if (text.includes(term) && !mineZh.includes(term)) return true;
    }
  }
  return false;
}

// 说漏了再问一次时的追加要求；三轮都堵不住就只留代码。
const EXAM_RETRY_NUDGE =
  'Your previous reply would have given the meaning away, so it was thrown away. Answer again with a suggestion that says nothing about what the word means, or with an empty suggestion.';
const EXAM_TRIES = 3;

export function judgeInstructions(lang) {
  const feedback =
    lang === 'en'
      ? 'Write the reason and suggestion in English.'
      : 'Write the reason and suggestion in Chinese (Simplified).';
  return [...JUDGE_RULES, feedback].join(' ');
}

// 学习者写的东西一律压成单行再入 prompt：换行会让它伪造出下面那些字段，
// 而这几行前缀是模型分辨「哪句是它自己写的」的唯一线索。
const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

function judgePrompt({ word, userDefinition, userExample, storedDefinition, targetExample }) {
  const parts = [`word: ${word}`, `learner definition: ${oneLine(userDefinition)}`];
  if (userExample) parts.push(`learner example: ${oneLine(userExample)}`);
  if (targetExample) parts.push(`the word is being asked about as used here: ${oneLine(targetExample)}`);
  if (storedDefinition) parts.push(`stored definition (reference only): ${oneLine(storedDefinition)}`);
  return parts.join('\n');
}

const NO_EXAMPLE_NOTE =
  'No example sentence was submitted this time; grade only the definition and do not fail the answer for the missing example.';

const EXAMPLE_RULES =
  'You write one fresh example sentence for an English word in a vocabulary list. It must be natural, everyday and self-contained, must use the word in an actually inflected form, and must clearly show the given meaning.';

// 档位复判（任务三起成为唯一的定档路径）：只给词与某一条义项，让模型独立定一次档。
// 参考词表给的东西一并奉上，采信还是推翻由它自己判断；跑多次取平均，所以每次都要独立作答。
const LEVEL_RULES =
  'You assign one CEFR level to a single sense of an English word, from your own knowledge. Judge that one sense, not the word as a whole: how common it is, how early a learner meets it, how specialised it is. A1 and A2 are everyday core senses, B1 and B2 are general but less basic ones, C1 and C2 are advanced, formal, literary or technical ones. Give the single level you judge most likely, never a range.';
const LEVEL_REFERENCE_NOTE =
  'Published word lists were checked for this word and its derived forms; whatever they gave is listed after "reference" below. Treat it as evidence you may follow or overrule, and never let it replace your own reading of the sense.';

// 参考档位压缩成一行给模型看：来源 + 可选词性 + 档位；派生词额外标出是词形归并还是词根推测。
function referenceLine(referenceLevels) {
  const parts = [];
  for (const l of referenceLevels?.levels || []) parts.push(`${l.source}${l.pos ? ` ${l.pos}` : ''} ${l.level}`);
  for (const r of referenceLevels?.related || []) {
    parts.push(`${r.form}${r.via === 'root' ? '（词根推测）' : '（词形归并）'} ${r.level} · ${r.source}`);
  }
  if (referenceLevels?.frequencyRank) parts.push(`常用度第 ${referenceLevels.frequencyRank} 位`);
  return parts.join(' · ');
}

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

  async function once(messages, { maxTokens, temperature, signal }, target) {
    const body = { model: target.name, messages, temperature };
    if (maxTokens) body.max_tokens = maxTokens;
    Object.assign(body, target.extra || {});
    // 两个信号并一个：超时照旧（默认 90 秒），调用方一终止也跟着停。
    const timeout = AbortSignal.timeout(timeoutMs);

    let res;
    try {
      res = await fetchImpl(`${target.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (e) {
      // 调用方终止（界面上的「终止」把连接关了）：这是我们要的结果，不是上游故障，
      // 单独标出来让 chat 别去重试，也别报成一个假的 502。
      if (signal?.aborted) throw aiError('aiAborted', '已终止');
      throw e;
    }

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
    // 空内容多半是上游一次坏生成（推理段吃光预算、网关抽风），也可能是模型在「想」而不是在答。
    // 这里单独认出来，交给 chat() 的去重试分支；当成解析失败抛出去就白丢一次重试机会。
    if (!content.trim()) {
      const choice = data.choices[0] || {};
      const message = choice.message || {};
      throw aiError(
        'aiEmpty',
        `上游返回了空内容（finish_reason=${choice.finish_reason ?? '?'}，推理段 ${String(message.reasoning_content || '').length} 字，用量 ${JSON.stringify(data.usage ?? {})}）`,
      );
    }
    return content;
  }

  async function chat(messages, { model, maxTokens, temperature = 0, signal } = {}) {
    const target = targetFor(model);
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(messages, { model, maxTokens, temperature, signal }, target);
      } catch (e) {
        // 被终止的就别再来一轮：退避等待只会让「终止」按下去之后还拖着。
        if (e.code === 'aiAborted') throw e;
        const retryable = e.code === 'aiHttp' ? RETRYABLE_STATUS.has(e.status) : e.code !== 'aiShape';
        if (retryable && attempt < retries) {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
          continue;
        }
        throw e;
      }
    }
  }

  // 要一份 JSON：容错解析接不住的就再要一次（一次坏生成不值得记成判定失败），
  // 顺手把原始内容打到服务窗口，免得下次又只能看到一个截断的报错。
  async function askJson(messages, opts) {
    const first = await chat(messages, opts);
    const obj = parseJsonTolerant(first);
    if (obj !== null) return { obj, content: first };
    console.error(`[ai] 模型没吐出可解析的 JSON，再要一次：${String(first).slice(0, 300)}`);
    const second = await chat(messages, opts);
    return { obj: parseJsonTolerant(second), content: second };
  }

  async function judgeEntry({ word, userDefinition, userExample, storedDefinition, targetExample }, { model, lang, exam, guard } = {}) {
    const example = typeof userExample === 'string' ? userExample.trim() : '';
    const parts = [system('judge', judgeInstructions(lang))];
    if (!example) parts.push(NO_EXAMPLE_NOTE);
    if (exam) parts.push(EXAM_RULES.join(' '));
    parts.push(CONTRACTS.judge);

    const asked = judgePrompt({
      word,
      userDefinition,
      userExample: example,
      // 闭卷不把表内释义发给模型；它只作为本地兜底比对的敏感词。
      storedDefinition: exam ? '' : storedDefinition,
      targetExample,
    });

    // 逐轮问：模型写的点评只要撞上表内释义或中文，就当作说漏了，追加要求再问一次；
    // 问满三轮还漏就把点评丢掉，只留代码（代码本身永远不会泄密）。
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    let last = null;
    for (let round = 0; round < (exam ? EXAM_TRIES : 1); round += 1) {
      const messages = [
        { role: 'system', content: parts.join(' ') },
        { role: 'user', content: round ? `${asked}\n${EXAM_RETRY_NUDGE}` : asked },
      ];
      const { obj, content } = await askJson(messages, { model, maxTokens: 1600, temperature: 0 });
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw aiError('aiJson', `模型没有返回可用 JSON：${String(content).slice(0, 200)}`);
      }
      const raw = obj.pass;
      const pass = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
      if (pass === null) throw aiError('aiField', `模型没有给出可用的 pass：${JSON.stringify(obj).slice(0, 200)}`);

      if (!exam) return { pass, reason: text(obj.reason), suggestion: text(obj.suggestion) };

      const code = text(obj.reason);
      const said = text(obj.suggestion);
      // 两道闸：模型自己判的 safe（能挡住机械比不出来的中文意译），以及服务端拿表内释义与
      // 中文做的机械比对（模型嘴上说安全、手里抄了释义时兜底）。
      const selfReported = obj.safe === false || obj.safe === 'false';
      const bad = leaksMeaning(said, guard, userDefinition);
      const suggestion = said && !selfReported && !bad ? said : '';
      last = { pass, reason: EXAM_CODES.includes(code) ? code : 'unspecified', suggestion };
      // 没说、或说了但安全：收工。说了但漏了：换一轮再问。
      if (suggestion || !said) return last;
      console.warn(`[ai] 闭卷点评疑似透露词义（${selfReported ? '模型自报' : '命中表内释义'}），重问（第 ${round + 1}/${EXAM_TRIES} 次）：${said.slice(0, 120)}`);
    }
    return last;
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
    const { obj, content } = await askJson(
      [
        { role: 'system', content: `${EXAMPLE_RULES} ${CONTRACTS.example}` },
        { role: 'user', content: `word: ${word}\nmeaning: ${typeof definition === 'string' ? definition.trim() : ''}` },
      ],
      { model, maxTokens: 400, temperature: 0 },
    );
    const raw = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.example : null;
    const example = cleanField(typeof raw === 'string' ? raw : '');
    if (!example) throw aiError('aiField', `模型没有给出可用例句：${String(content).slice(0, 200)}`);
    return { example };
  }

  // 定档：给一条义项投一次票（任务三起也是唯一的定档路径）。温度交给调用方，
  // 0 会让五票同声、平均没意义。
  async function levelVote({ word, definition, example, referenceLevels = null }, { model, temperature = 0.9, signal } = {}) {
    const refs = referenceLine(referenceLevels);
    const { obj } = await askJson(
      [
        { role: 'system', content: `${LEVEL_RULES} ${LEVEL_REFERENCE_NOTE} ${CONTRACTS.level}` },
        {
          role: 'user',
          content: [
            `word: ${word}`,
            `sense: ${typeof definition === 'string' ? definition.trim() : ''}`,
            example ? `example: ${String(example).trim()}` : null,
            refs ? `reference: ${refs}` : 'reference: none, the published lists do not cover this word',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      // 200 不够：推理型模型会把整个预算烧在推理段上（实测 completion_tokens 全是
      // reasoning_tokens、content 空），一张票就废了。这里给足，输出本来只有一个档位。
      { model, maxTokens: 1200, temperature, signal },
    );
    const level = normalizeDifficulty(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.level : null);
    return { level };
  }

  async function sensesEntry({ word, current = null, referenceLevels = null, withChinese = false }, { model, signal } = {}) {
    const keepChinese = Boolean(current && ((current.senses || []).some((s2) => s2.chinese) || current.headChinese));
    const wantChinese = withChinese === true || keepChinese;
    let { obj, content } = await askJson(
      [
        { role: 'system', content: `${system('entry', entryInstructions())} ${CONTRACTS.entry}` },
        { role: 'user', content: JSON.stringify({ word, current, referenceLevels, withChinese: wantChinese }) },
      ],
      { model, maxTokens: 1400, temperature: 0, signal },
    );
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
      const definition = cleanField(row?.definition);
      const example = cleanField(row?.example);
      // 档位不在这里定：模型被明确要求不输出档位，档位随后由五次投票决定。
      // 「 - 」是行格式的分隔符，释义与例句里出现都会把那一行拆错，两条都挡住。
      if (!definition || !example || definition.includes(' - ') || example.includes(' - ')) continue;
      const chinese = wantChinese ? (typeof row.chinese === 'string' ? row.chinese.trim() : '') : '';
      usable.push({ level: null, definition, chinese, example });
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
    levelVote,
    testTarget,
  };
}
