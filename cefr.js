import fs from 'node:fs';
import path from 'node:path';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const TIER = ['cefrj', 'octanove', 'oxford', 'phrase'];

export const SOURCES = {
  cefrj: 'CEFR-J',
  octanove: 'Octanove C1/C2',
  oxford: 'Oxford 3000/5000',
  phrase: 'Oxford Phrase List',
  freq: '按常用度推算',
};

export const CEFR_LEVELS = LEVELS;

export function parseQuery(raw) {
  const base = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\((?:[^)]*)\)/g, ' ')
    .replace(/[.,;:!?"'\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { base };
}

function lemmaCandidates(word) {
  const out = [];
  const add = (x) => {
    if (x && x.length > 2 && x !== word && !out.includes(x)) out.push(x);
  };
  const cut = (re, min, ...replacements) => {
    if (!re.test(word)) return;
    for (const replacement of replacements) {
      const stem = word.replace(re, replacement);
      if (stem.length >= min) add(stem);
    }
  };
  cut(/ies$/, 3, 'y');
  cut(/(ches|shes|sses|xes|zes)$/, 3, '');
  if (/[^s]s$/.test(word)) add(word.replace(/s$/, ''));
  cut(/ing$/, 3, '', 'e');
  cut(/ed$/, 3, '', 'e');
  cut(/ied$/, 3, 'y');
  cut(/ally$/, 3, 'al');
  cut(/(er|est|ly|ness|ment)$/, 3, '');
  cut(/(ation|ition)$/, 3, 'e');
  cut(/(tion|sion)$/, 3, 't');
  cut(/ity$/, 3, 'e');
  cut(/ist$/, 3, '');
  cut(/ous$/, 3, '');
  return out;
}

// 构词后缀：一条词的「家族」成员多半是这么来的（helpful→help、readable→read、happiness→happy）。
function derivationalStems(word) {
  const out = [];
  const add = (x) => {
    if (x && x.length > 2 && x !== word && !out.includes(x)) out.push(x);
  };
  const cut = (re, min, ...replacements) => {
    if (!re.test(word)) return;
    for (const replacement of replacements) {
      const stem = word.replace(re, replacement);
      if (stem.length >= min) add(stem);
    }
  };
  cut(/(iness|ily)$/, 4, 'y');
  cut(/(able|ible|ance|ence|ant|ent|ful|less|ish|ist|ous)$/, 4, '');
  cut(/(ation|ition)$/, 4, 'e');
  cut(/(tion|sion)$/, 4, 't');
  cut(/(ness|ment|ity|ism|age)$/, 4, '');
  cut(/(ive|ate|ize|ise)$/, 4, '');
  cut(/(al|ic|ary|ory)$/, 4, '');
  cut(/en$/, 4, '');
  return out;
}

const PREFIXES = [
  'counter',
  'inter',
  'under',
  'super',
  'semi',
  'post',
  'anti',
  'over',
  'mis',
  'dis',
  'out',
  'sub',
  'pre',
  'non',
  'de',
  're',
  'un',
  'in',
  'im',
  'ir',
  'il',
  'co',
];

function prefixStems(word) {
  const out = [];
  for (const prefix of PREFIXES) {
    if (!word.startsWith(prefix)) continue;
    const stem = word.slice(prefix.length);
    if (stem.length >= 3 && !out.includes(stem)) out.push(stem);
  }
  return out;
}

// surface → lemma → family：先剥构词成分（后缀与前缀），再在前一轮结果上剥第二遍。
export function familyCandidates(word) {
  const seen = new Set([word]);
  const out = [];
  const push = (x) => {
    if (x && x.length > 2 && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  };
  const round = (w) => [...lemmaCandidates(w), ...derivationalStems(w), ...prefixStems(w)];
  for (const first of round(word)) {
    push(first);
    for (const second of round(first)) push(second);
  }
  return out;
}

export function createIndex(data) {
  const freq = data.lists.freq.split('\n');
  const lists = {
    cefrj: data.lists.cefrj,
    octanove: data.lists.octanove,
    oxford: data.lists.oxford,
    phrase: data.lists.phrase,
  };
  const byPos = new Map();
  for (const [name, list] of Object.entries(lists)) {
    for (const [key, level] of Object.entries(list)) {
      const cut = key.indexOf('|');
      if (cut <= 0) continue;
      const word = key.slice(0, cut);
      const pos = key.slice(cut + 1);
      if (!pos) continue;
      if (!byPos.has(word)) byPos.set(word, []);
      byPos.get(word).push({ source: name, pos, level });
    }
  }
  const posWords = {};
  for (const [name, list] of Object.entries(lists)) {
    const set = new Set();
    for (const key of Object.keys(list)) {
      const cut = key.indexOf('|');
      if (cut > 0 && key.slice(cut + 1)) set.add(key.slice(0, cut));
    }
    posWords[name] = set;
  }
  return {
    lists,
    posWords,
    byPos,
    bands: data.freqBands,
    rank: new Map(freq.map((word, i) => [word, i + 1])),
  };
}

function hitInList(index, name, base) {
  const list = index.lists[name];
  const plain = list[base];
  if (plain) return { level: plain, how: index.posWords[name].has(base) ? 'lowest' : 'exact' };
  return null;
}

function fromList(index, base, tier) {
  for (const name of tier) {
    const hit = hitInList(index, name, base);
    if (hit) return { level: hit.level, source: name, how: hit.how, base };
  }
  return null;
}

export function lookup(index, raw) {
  const { base } = parseQuery(raw);
  if (!base) return null;

  const direct = fromList(index, base, TIER);
  if (direct) return direct;

  if (!/\s/.test(base)) {
    const lemmas = lemmaCandidates(base);
    for (const candidate of lemmas) {
      const viaLemma = fromList(index, candidate, ['cefrj', 'octanove', 'oxford']);
      if (viaLemma) return { ...viaLemma, viaLemma: candidate, how: `lemma-${viaLemma.how}` };
    }
    for (const candidate of familyCandidates(base)) {
      if (lemmas.includes(candidate)) continue;
      const viaRoot = fromList(index, candidate, ['cefrj', 'octanove', 'oxford']);
      if (viaRoot) return { ...viaRoot, viaRoot: candidate, how: `root-${viaRoot.how}` };
    }
    const rank = index.rank.get(base);
    if (rank) {
      const band = (index.bands || []).find((b) => rank <= b.max);
      if (band) return { level: band.level, source: 'freq', how: 'freq', base, rank };
    }
  }
  return null;
}

export function sourceLabel(result) {
  if (!result) return 'CEFR 表外';
  const name = SOURCES[result.source] || result.source;
  if (result.viaLemma) return `${name}（词形归并自 ${result.viaLemma}）`;
  if (result.viaRoot) return `${name}（词根推测自 ${result.viaRoot}）`;
  if (result.source === 'freq') return `${name}（第 ${result.rank} 位）`;
  if (result.how === 'lowest') return `${name}（多词性取最低档）`;
  return name;
}

export function createCefr({ dataFile = path.join(import.meta.dirname, 'data', 'cefr.json'), fsImpl = fs } = {}) {
  let index = null;
  let meta = null;
  const load = () => {
    if (index) return index;
    const raw = JSON.parse(fsImpl.readFileSync(dataFile, 'utf8'));
    if (raw.version !== 1) throw new Error(`CEFR 数据版本不支持：${raw.version}`);
    index = createIndex(raw);
    meta = { sources: raw.sources, bands: raw.freqBands, size: Object.keys(raw.lists.cefrj).length };
    return index;
  };
  return {
    lookup: (word) => {
      const result = lookup(load(), word);
      return result ? { ...result, label: sourceLabel(result) } : { level: null, source: null, label: 'CEFR 表外' };
    },
    sources: () => {
      load();
      return meta;
    },
    describe: (word) => {
      const idx = load();
      const { base } = parseQuery(word);
      if (!base) return { word: '', levels: [], related: [] };
      const levels = [];
      for (const name of TIER) {
        const plain = idx.lists[name][base];
        if (plain) levels.push({ source: SOURCES[name], pos: null, level: plain });
      }
      for (const hit of idx.byPos.get(base) || []) {
        levels.push({ source: SOURCES[hit.source], pos: hit.pos, level: hit.level });
      }
      const related = [];
      const seen = new Set();
      const pushRelated = (form, via) => {
        if (seen.has(form)) return;
        const hit = fromList(idx, form, ['cefrj', 'octanove', 'oxford']);
        if (!hit) return;
        seen.add(form);
        related.push({ form, level: hit.level, source: SOURCES[hit.source] || hit.source, via });
      };
      const lemmas = lemmaCandidates(base);
      for (const form of lemmas) pushRelated(form, 'lemma');
      for (const form of familyCandidates(base)) {
        if (!lemmas.includes(form)) pushRelated(form, 'root');
      }
      return {
        word: base,
        levels,
        related,
        frequencyRank: idx.rank.get(base) || null,
        outside: levels.length === 0 && related.length === 0,
      };
    },
  };
}
