// 把 data/sources/ 里的三份来源拼成运行期只读的 data/cefr.json。
// 换来源只改这里与 data/sources/，运行期接口（cefr.js）不动。
//
// 来源与许可（都要能再分发才放得进来）：
//   · CEFR-J Vocabulary Profile 1.5 —— Tono Lab / TUFS，免费用于研究与商用、须注明出处；
//   · Octanove Vocabulary Profile C1/C2 1.0 —— CC BY-SA 4.0（署名 + 同协议共享）；
//   · FrequencyWords（hermitdave）OpenSubtitles 2018 en 50k —— 数据 CC BY-SA 4.0，只取排名。
// 所以 data/cefr.json 本身按 CC BY-SA 4.0 发布。Oxford 3000/5000 与 Oxford Phrase List
// 只有个人自用授权，2026-10-01 起整层摘掉（连带词频表换成上面那份 CC BY-SA 的）。
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

// 词频骨架：OpenSubtitles 语料的英文 50k，已压成「一行一个词、按频次降序」的纯字母词。
// 它只提供排名，档位由下面的已知词中位数标定出来（所以换语料会让推算档略有位移）。
const freq = fs
  .readFileSync(path.join(srcDir, 'opensubtitles-en-50k.txt'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
const rank = new Map(freq.map((w, i) => [w, i + 1]));

const known = new Map();
for (const list of [cefrj, octanove]) {
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
    freq: 'FrequencyWords (hermitdave) OpenSubtitles 2018 en 50k — CC BY-SA 4.0, rank only; bands calibrated here',
  },
  freqBands: bands,
  lists: { cefrj, octanove, freq: freq.join('\n') },
};

fs.writeFileSync(path.join(dataDir, 'cefr.json'), JSON.stringify(out));
const size = fs.statSync(path.join(dataDir, 'cefr.json')).size;
console.log(`cefr.json ${(size / 1024).toFixed(0)}KB`);
console.log(`cefrj ${Object.keys(cefrj).length} | octanove ${Object.keys(octanove).length} | freq ${freq.length}`);
console.log('freq bands', JSON.stringify(bands));
