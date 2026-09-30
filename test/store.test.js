import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore, AUTO_BACKUP } from '../store.js';

const OLD = '### A\n\n- [x] absorb - take in\n\n### B\n\n- [ ] ballpoint - a pen with a metal ball tip\n';
const NEW = '### A\n\n- [x] absorb - take in\n  - #B1 · Plants absorb water through their roots.\n\n### B\n\n- [ ] ballpoint - a pen with a metal ball tip\n';

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup({ content = OLD, maxBackups, fsImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'Vocabulary.md');
  fs.writeFileSync(file, content);
  const store = createStore({
    file,
    backupDir: path.join(dir, 'backups'),
    maxBackups,
    fs: fsImpl,
  });
  return { dir, file, store, backupDir: path.join(dir, 'backups') };
}

function stamp(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/[:.]/g, '-');
}

test('readFile returns the current text', () => {
  const { store } = setup();
  assert.equal(store.readFile(), OLD);
});

test('writeWithBackup keeps the previous text and swaps in the new one', () => {
  const { file, store, backupDir } = setup();
  const res = store.writeWithBackup(NEW);
  assert.equal(fs.readFileSync(file, 'utf8'), NEW);
  assert.match(res.backup, AUTO_BACKUP);
  const names = fs.readdirSync(backupDir);
  assert.deepEqual(names, [res.backup]);
  assert.equal(fs.readFileSync(path.join(backupDir, res.backup), 'utf8'), OLD);
});

test('a failing write leaves the original file untouched and no temp file behind', () => {
  const { file, store, dir } = setup({
    fsImpl: {
      ...fs,
      renameSync() {
        throw new Error('EIO simulated');
      },
    },
  });
  assert.throws(() => store.writeWithBackup(NEW), /simulated/);
  assert.equal(fs.readFileSync(file, 'utf8'), OLD);
  const leftovers = fs.readdirSync(path.join(dir)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('rotation keeps the newest 30 auto backups and never touches named ones', () => {
  const seeded = [];
  for (let i = 0; i < 35; i++) {
    const name = `Vocabulary.${stamp(i + 1)}.md`;
    seeded.push(name);
  }
  const sorted = seeded.sort();
  const { store, backupDir } = setup();
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of sorted) fs.writeFileSync(path.join(backupDir, name), 'old');
  const manual = 'Vocabulary.2026-09-06T16-50-pre-split.md';
  fs.writeFileSync(path.join(backupDir, manual), 'do not delete me');

  const res = store.writeWithBackup(NEW);
  const kept = fs.readdirSync(backupDir).filter((n) => AUTO_BACKUP.test(n)).sort();
  assert.equal(kept.length, 30);
  assert.ok(kept.includes(res.backup));
  assert.deepEqual(kept, [...sorted.slice(-29), res.backup].sort());
  for (const gone of sorted.slice(0, 6)) assert.ok(!kept.includes(gone), `${gone} should be pruned`);
  assert.ok(fs.readdirSync(backupDir).includes(manual));
});

test('rotation is configurable', () => {
  const { store, backupDir } = setup({ maxBackups: 3 });
  fs.mkdirSync(backupDir, { recursive: true });
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(backupDir, `Vocabulary.${stamp(i + 1)}.md`), 'old');
  store.writeWithBackup(NEW);
  assert.equal(fs.readdirSync(backupDir).filter((n) => AUTO_BACKUP.test(n)).length, 3);
});

test('listBackups returns newest first with sizes', () => {
  const { store, backupDir } = setup();
  fs.mkdirSync(backupDir, { recursive: true });
  const seeded = `Vocabulary.${stamp(120)}.md`;
  fs.writeFileSync(path.join(backupDir, seeded), 'aaa');
  const res = store.writeWithBackup(NEW);
  const files = store.listBackups();
  assert.equal(files.length, 2);
  assert.equal(files[0].name, res.backup);
  assert.equal(files[1].name, seeded);
  assert.equal(files[1].size, 3);
  for (const f of files) assert.equal(typeof f.mtime, 'number');
});

test('enqueue runs one task at a time', async () => {
  const { store } = setup();
  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tasks = [50, 5, 20].map((ms, i) =>
    store.enqueue(async () => {
      log.push(`start:${i}`);
      await wait(ms);
      log.push(`end:${i}`);
      return i;
    }),
  );
  const out = await Promise.all(tasks);
  assert.deepEqual(out, [0, 1, 2]);
  assert.deepEqual(log, ['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2']);
});

test('enqueue survives a failing task', async () => {
  const { store } = setup();
  const bad = store.enqueue(async () => {
    throw new Error('boom');
  });
  const good = store.enqueue(async () => 'still runs');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'still runs');
});

test('selfCheck reports a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-store-'));
  dirs.push(dir);
  const store = createStore({ file: path.join(dir, 'nope.md'), backupDir: path.join(dir, 'backups') });
  assert.throws(() => store.selfCheck(), /不存在/);
});

test('selfCheck reports parse errors with line numbers', () => {
  const dirty =
    '### A\n\n- absorb\n  - [x] #B1 - take in - Plants absorb water.\n\n### B\n\n- absorb\n  - [ ] #B2 - soak up - The sponge absorbed it.\n';
  const { store } = setup({ content: dirty });
  assert.throws(() => store.selfCheck(), /第 8 行[\s\S]*duplicateWord/);
});

test('a hardlinked vocabulary file is written in place so the other name sees it too', () => {
  const { dir, file, store } = setup();
  const alias = path.join(dir, 'alias.md');
  fs.linkSync(file, alias);
  assert.equal(fs.statSync(file).nlink, 2);
  store.writeWithBackup(NEW);
  assert.equal(fs.readFileSync(file, 'utf8'), NEW);
  assert.equal(fs.readFileSync(alias, 'utf8'), NEW, '另一个名字必须看到新内容');
  assert.equal(fs.statSync(file).nlink, 2, '写入不能把链接打断');
  assert.equal(store.readFile(), NEW);
});

test('a symlinked vocabulary file is written to its real target, not to the link name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-store-link-'));
  dirs.push(dir);
  const real = path.join(dir, 'real.md');
  const link = path.join(dir, 'link.md');
  fs.writeFileSync(real, OLD);
  // 这台机器没开开发者模式，建真软链要管理员权限，所以只桩掉 realpath 的解析结果
  const store = createStore({
    file: link,
    backupDir: path.join(dir, 'backups'),
    fs: { ...fs, realpathSync: () => real },
  });
  store.writeWithBackup(NEW);
  assert.equal(fs.readFileSync(real, 'utf8'), NEW);
  assert.equal(fs.readFileSync(path.join(dir, 'backups', fs.readdirSync(path.join(dir, 'backups'))[0]), 'utf8'), OLD);
  assert.equal(fs.existsSync(link), false, '不该在链接名上凭空写出一个普通文件');
  assert.equal(store.target(), real);
});

test('file 传函数时每次重新取目标，改完路径立刻生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-store-'));
  dirs.push(dir);
  const first = path.join(dir, 'a.md');
  const second = path.join(dir, 'b.md');
  const NEWER = `${NEW}\n`;
  fs.writeFileSync(first, OLD);
  fs.writeFileSync(second, NEW);
  let current = first;
  const store = createStore({
    file: () => current,
    backupDir: path.join(dir, 'backups'),
  });
  assert.equal(store.readFile(), OLD);

  current = second;
  assert.equal(store.readFile(), NEW, '换路径后不用重建 store 就跟着走');
  const res = store.writeWithBackup(NEWER);
  assert.equal(fs.readFileSync(second, 'utf8'), NEWER);
  assert.equal(fs.readFileSync(path.join(dir, 'backups', res.backup), 'utf8'), NEW, '备份取的是新路径上的内容');

  current = null;
  assert.throws(() => store.readFile(), /还没有设置词表文件路径/);
});
