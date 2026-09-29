import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(import.meta.dirname, '..', 'data');
const srcDir = path.join(dataDir, 'sources');
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const readCsv = (file) =>
  fs
    .readFileSync(path.join(srcDir, file), 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const cells = line.split(',');
      const pos = (cells[1] || '').trim().toLowerCase();
      const level = (cells[2] || '').trim().toUpperCase();
      if (!LEVELS.includes(level)) return [];
      return (cells[0] || '')
        .split('/')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
        .map((word) => ({ word, pos, level }));
    });

const readPhraseList = (file) =>
  fs
    .readFileSync(path.join(srcDir, file), 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const cells = line.split(',');
      const level = (cells[1] || '').trim().toUpperCase();
      const phrase = (cells[0] || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!phrase || !LEVELS.includes(level)) return [];
      const stripped = phrase
        .replace(/\([^)]*\)/g, ' ')
        .replace(/…|\.\.\./g, ' ')
        .replace(/[^a-z' ]/g, ' ')
        .replace(/\bsb'?s\b|\bsb\b|\bsth\b|\bsomebody\b|\bsomething\b|\bone's\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const out = [{ word: phrase, pos: '', level }];
      if (stripped && stripped !== phrase && stripped.includes(' ')) out.push({ word: stripped, pos: '', level });
      return out;
    });

function index(rows) {
  const map = {};
  const set = (key, level) => {
    if (!(key in map)) map[key] = level;
  };
  for (const r of rows) set(`${r.word}|${r.pos}`, r.level);
  for (const r of rows) {
    const best = LEVELS.indexOf(r.level);
    const cur = map[r.word];
    if (cur === undefined || LEVELS.indexOf(cur) > best) map[r.word] = r.level;
  }
  return map;
}

const cefrj = index(readCsv('cefrj-vocabulary-profile-1.5.csv'));
const octanove = index(readCsv('octanove-vocabulary-profile-c1c2-1.0.csv'));
const oxford = index(
  JSON.parse(fs.readFileSync(path.join(srcDir, 'oxford-3000-5000-levels.json'), 'utf8')).map((r) => ({
    word: r.word.trim().toLowerCase(),
    pos: (r.pos || '').trim().toLowerCase(),
    level: r.level,
  })),
);
const phrase = index(readPhraseList('oxford-phrase-list.csv'));

const freq = fs
  .readFileSync(path.join(srcDir, 'google-20000-english.txt'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
const rank = new Map(freq.map((w, i) => [w, i + 1]));

const known = new Map();
for (const list of [cefrj, octanove, oxford]) {
  for (const [key, level] of Object.entries(list)) {
    if (key.includes('|')) continue;
    const cur = known.get(key);
    if (cur === undefined || LEVELS.indexOf(level) < LEVELS.indexOf(cur)) known.set(key, level);
  }
}

const buckets = {};
for (const [word, level] of known) {
  const r = rank.get(word);
  if (!r) continue;
  (buckets[level] ||= []).push(r);
}
const medians = [];
for (const level of LEVELS) {
  const ranks = (buckets[level] || []).sort((a, b) => a - b);
  if (ranks.length < 20) continue;
  medians.push({ level, median: ranks[Math.floor(ranks.length / 2)] });
}
const bands = [];
for (let i = 0; i < medians.length; i++) {
  const next = medians[i + 1];
  bands.push({
    level: medians[i].level,
    max: next ? Math.round((medians[i].median + next.median) / 2) : freq.length,
    median: medians[i].median,
  });
}

const out = {
  version: 1,
  generatedBy: 'tools/build-cefr-data.mjs',
  sources: {
    cefrj: 'CEFR-J Vocabulary Profile 1.5 (Tono Lab, TUFS) — free use with citation',
    octanove: 'Octanove Vocabulary Profile C1/C2 1.0 — CC BY-SA 4.0',
    oxford: 'The Oxford 3000/5000 by CEFR level — Oxford University Press, personal use',
    phrase: 'The Oxford Phrase List (A1–C1) — Oxford University Press, personal use',
    freq: 'google-10000-english 20k list (Google Trillion Word Corpus) — rank only, levels calibrated here',
  },
  freqBands: bands,
  lists: { cefrj, octanove, oxford, phrase, freq: freq.join('\n') },
};

fs.writeFileSync(path.join(dataDir, 'cefr.json'), JSON.stringify(out));
const size = fs.statSync(path.join(dataDir, 'cefr.json')).size;
console.log(`cefr.json ${(size / 1024).toFixed(0)}KB`);
console.log(`cefrj ${Object.keys(cefrj).length} | octanove ${Object.keys(octanove).length} | oxford ${Object.keys(oxford).length} | freq ${freq.length}`);
console.log('freq bands', JSON.stringify(bands));
