import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CEFR_LEVELS, createCefr, createIndex, parseQuery, lookup, sourceLabel, familyCandidates } from '../cefr.js';
import { parse } from '../vocab.js';
import { realVocabFile } from './real-vocab.js';

const REAL = fs.readFileSync(realVocabFile(), 'utf8');
const DATA_FILE = path.join(import.meta.dirname, '..', 'data', 'cefr.json');
const cefr = createCefr({ dataFile: DATA_FILE });

test('parseQuery strips a parenthetical and punctuation down to the bare word', () => {
  assert.deepEqual(parseQuery('address (v.)'), { base: 'address' });
  assert.deepEqual(parseQuery('angle (n.)'), { base: 'angle' });
  assert.deepEqual(parseQuery('Bat (n.)'), { base: 'bat' });
  assert.deepEqual(parseQuery('  take   on '), { base: 'take on' });
  assert.deepEqual(parseQuery('cliché'), { base: 'cliché' });
  assert.deepEqual(parseQuery(''), { base: '' });
});

test('a headword carrying a part-of-speech label looks up like the bare word', () => {
  const labelled = cefr.lookup('address (v.)');
  assert.deepEqual({ ...labelled }, { ...cefr.lookup('address') });
  assert.equal(labelled.source, 'cefrj');
  assert.match(labelled.label, /最低档/);
  assert.ok(CEFR_LEVELS.includes(labelled.level));
});

test('lookup falls back to the lowest level for multi-pos headwords', () => {
  const result = cefr.lookup('agency');
  assert.ok(CEFR_LEVELS.includes(result.level));
  assert.equal(result.how, 'lowest');
  assert.match(result.label, /最低档/);
});

test('lookup reduces inflected forms back to a headword in the lists', () => {
  const accounting = cefr.lookup('accounting');
  assert.equal(accounting.source, 'cefrj');
  assert.match(accounting.how, /^lemma/);
  assert.match(accounting.label, /词形归并自 account/);
  assert.equal(cefr.lookup('strengths').source, 'cefrj');
  assert.equal(cefr.lookup('correlated').source, 'octanove');
  assert.equal(cefr.lookup('correlated').level, 'C2');
  assert.ok(cefr.lookup('synthesized').level === null || CEFR_LEVELS.includes(cefr.lookup('synthesized').level));
});

test('familyCandidates walks surface → lemma → family without inventing the word itself', () => {
  assert.ok(!familyCandidates('accounting').includes('accounting'));
  assert.ok(familyCandidates('accounting').includes('account'), '第一轮：词形');
  assert.ok(familyCandidates('unhappiness').includes('happy'), '剥前缀再剥后缀');
  assert.ok(familyCandidates('misunderstanding').includes('understand'), '剥前缀再剥词形');
  assert.deepEqual(familyCandidates('on').length, 0, '太短的词不做推测');
  assert.ok(!familyCandidates('carol').includes('car'), '别把 carol 猜成 car');
});

test('a root-inferred hit says so and stays behind the plain lemma tier', () => {
  const root = cefr.lookup('reopen');
  assert.ok(CEFR_LEVELS.includes(root.level), JSON.stringify(root));
  assert.equal(root.viaRoot, 'open');
  assert.match(root.label, /词根推测自 open/);
  assert.match(root.how, /^root/);
  assert.ok(!root.viaLemma);

  const prefixOnly = cefr.lookup('coworker');
  assert.equal(prefixOnly.viaRoot, 'work');
  assert.match(prefixOnly.label, /词根推测自 work/);

  const lemma = cefr.lookup('accounting');
  assert.match(lemma.label, /词形归并自 account/);
  assert.equal(lemma.viaRoot, undefined);

  // 词频表扩到 50k 之后，「表外」的例子得挑一个连词频骨架都不收的词：feckless 现在能按
  // 常用度推出来了（第 46033 位），ashen 三条路都不中，才是真的表外。
  const unknown = cefr.lookup('ashen');
  assert.equal(unknown.level, null, '剥出来的词根也不在表里，就老老实实表外，不猜');
  assert.equal(unknown.label, 'CEFR 表外');
});

test('describe lists the related forms it actually found in the authoritative tables', () => {
  const info = cefr.describe('reopen');
  const open = info.related.find((r) => r.form === 'open');
  assert.ok(open, JSON.stringify(info.related));
  assert.equal(open.via, 'root');
  assert.ok(CEFR_LEVELS.includes(open.level));

  const plain = cefr.describe('accounting');
  assert.equal(plain.related.find((r) => r.form === 'account').via, 'lemma');
});

test('a word outside every list is graded by calibrated frequency and says so', () => {
  const monetary = cefr.lookup('monetary');
  assert.equal(monetary.source, 'freq');
  assert.ok(CEFR_LEVELS.includes(monetary.level));
  assert.match(monetary.label, /按常用度推算（第 \d+ 位）/);
  assert.equal(cefr.lookup('the').source, 'cefrj');
});

test('words and phrases with no CEFR home stay unmapped instead of being guessed', () => {
  const outsider = cefr.lookup('beadwork');
  assert.equal(outsider.level, null);
  assert.equal(outsider.label, 'CEFR 表外');
  assert.equal(cefr.lookup('make ends meet').level, null);
  assert.equal(cefr.lookup('take ... for granted').level, null);
  assert.equal(cefr.lookup('').level, null);
});

test('摘掉 Oxford 两源之后，它原来独有的词落到常用度推算上（2026-10-01）', () => {
  const hits = ['adaptation', 'authentic', 'bias'].map((w) => cefr.lookup(w));
  assert.ok(hits.every((h) => h.source === 'freq'), JSON.stringify(hits));
  assert.ok(hits.every((h) => CEFR_LEVELS.includes(h.level)));
});

test('every real entry resolves to a valid level or an explicit 表外, and coverage stays high', () => {
  const entries = parse(REAL).entries.map((e) => e.word);
  assert.ok(entries.length > 500);
  let mapped = 0;
  const bySource = {};
  for (const word of entries) {
    const result = cefr.lookup(word);
    if (result.level === null) {
      assert.equal(result.label, 'CEFR 表外', word);
      continue;
    }
    mapped += 1;
    assert.ok(CEFR_LEVELS.includes(result.level), `${word} → ${result.level}`);
    assert.ok(result.label && result.label.length > 1, word);
    bySource[result.source] = (bySource[result.source] || 0) + 1;
  }
  assert.ok(mapped / entries.length > 0.65, `coverage ${mapped}/${entries.length} bySource=${JSON.stringify(bySource)}`);
  assert.ok(bySource.cefrj > 250);
});

test('the shipped data file declares its sources and monotone frequency bands', () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert.equal(data.version, 1);
  assert.match(data.sources.cefrj, /CEFR-J/);
  assert.match(data.sources.octanove, /CC BY-SA/);
  assert.match(data.sources.freq, /CC BY-SA/);
  assert.deepEqual(Object.keys(data.lists).sort(), ['cefrj', 'freq', 'octanove']);
  let prev = 0;
  for (const band of data.freqBands) {
    assert.ok(CEFR_LEVELS.includes(band.level), JSON.stringify(band));
    assert.ok(band.max > prev, `band 边界必须递增：${JSON.stringify(band)}`);
    prev = band.max;
  }
  assert.equal(data.freqBands.at(-1).max, data.lists.freq.split('\n').length);
});

test('createCefr refuses an unknown data version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-cefr-'));
  const file = path.join(dir, 'cefr.json');
  fs.writeFileSync(file, JSON.stringify({ version: 99 }));
  assert.throws(() => createCefr({ dataFile: file }).lookup('absorb'), /版本不支持/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the index is built once and reused', () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const index = createIndex(data);
  assert.equal(lookup(index, 'absorb').level, 'B1');
  assert.equal(lookup(index, 'absorb').source, 'cefrj');
  assert.match(sourceLabel(lookup(index, 'absorb')), /^CEFR-J/);
  assert.equal(sourceLabel(null), 'CEFR 表外');
});



