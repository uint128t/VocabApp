import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore, AUTO_BACKUP, syncMirror } from '../store.js';

const OLD = '### A\n\n- [x] absorb - take in\n\n### B\n\n- [ ] ballpoint - a pen with a metal ball tip\n';
const NEW = '### A\n\n- [x] absorb - take in\n  - #B1 · Plants absorb water through their roots.\n\n### B\n\n- [ ] ballpoint - a pen with a metal ball tip\n';

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup({ content = OLD, maxBackups, fsImpl, mirror = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'Vocabulary.md');
  fs.writeFileSync(file, content);
  const mirrorFile = mirror === null ? null : path.join(dir, mirror);
  const store = createStore({
    file,
    mirrorFile,
    backupDir: path.join(dir, 'backups'),
    maxBackups,
    fs: fsImpl,
  });
  return { dir, file, mirrorFile, store, backupDir: path.join(dir, 'backups') };
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

test('rotation keeps the newest 20 auto backups and never touches named ones', () => {
  const seeded = [];
  for (let i = 0; i < 25; i++) {
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
  assert.equal(kept.length, 20);
  assert.ok(kept.includes(res.backup));
  assert.deepEqual(kept, [...sorted.slice(-19), res.backup].sort());
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
  assert.equal(store.target, real);
});

test('an intact mirror is left alone', () => {
  const { file, mirrorFile, store } = setup({ mirror: 'mirror.md' });
  fs.linkSync(file, mirrorFile);
  assert.equal(store.sync().action, 'linked');
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), OLD);
  assert.equal(fs.statSync(file).nlink, 2);
});

test('a broken mirror link is rebuilt and the newer side wins', () => {
  // 镜像那份更新（在 App 目录里改过，链接被改名式保存打断）
  const a = setup({ mirror: 'mirror.md' });
  fs.linkSync(a.file, a.mirrorFile);
  const tmp = path.join(a.dir, 'tmp.md');
  fs.writeFileSync(tmp, NEW);
  fs.renameSync(tmp, a.mirrorFile);
  assert.equal(fs.statSync(a.file).nlink, 1, '链接确实断了');
  assert.equal(a.store.readFile(), NEW, '工具要看到镜像那份的最新内容');
  assert.equal(fs.readFileSync(a.file, 'utf8'), NEW, '新内容已写回真身');
  assert.equal(fs.readFileSync(a.mirrorFile, 'utf8'), NEW);
  assert.equal(fs.statSync(a.file).nlink, 2, '链接已重建');
  assert.equal(a.store.sync().action, 'linked');

  // 真身更新（真身被改名式保存过，镜像成了陈旧快照）
  const b = setup({ mirror: 'mirror.md' });
  fs.linkSync(b.file, b.mirrorFile);
  const tmp2 = path.join(b.dir, 'tmp.md');
  fs.writeFileSync(tmp2, NEW);
  fs.renameSync(tmp2, b.file);
  assert.equal(b.store.readFile(), NEW);
  assert.equal(fs.readFileSync(b.mirrorFile, 'utf8'), NEW, '镜像已用真身内容刷新');
  assert.equal(fs.statSync(b.file).nlink, 2);
});

test('a mirror that is the same file is a no-op, and a missing mirror does nothing', () => {
  const { file, mirrorFile } = setup({ mirror: 'mirror.md' });
  const seen = [];
  const fake = {
    ...fs,
    existsSync: () => true,
    statSync: () => ({ dev: 1, ino: 7, nlink: 1, mtimeMs: 0 }),
    lstatSync: () => ({ isSymbolicLink: () => true }),
    rmSync: () => seen.push('rm'),
    symlinkSync: () => seen.push('symlink'),
    linkSync: () => seen.push('link'),
  };
  assert.equal(syncMirror({ file, mirrorFile, fs: fake }).action, 'linked');
  assert.deepEqual(seen, [], '同一个文件时什么都不该动');

  const plain = setup();
  assert.equal(plain.store.sync().action, 'none');
});

test('a broken symlink mirror is rebuilt as a symlink when that is allowed', () => {
  const { file, mirrorFile } = setup({ mirror: 'mirror.md' });
  const seen = [];
  const fake = {
    ...fs,
    existsSync: () => true,
    statSync: (p) => (p === file ? { dev: 1, ino: 7, nlink: 1, mtimeMs: 100 } : { dev: 1, ino: 9, nlink: 1, mtimeMs: 50 }),
    lstatSync: () => ({ isSymbolicLink: () => true }),
    rmSync: () => seen.push('rm'),
    symlinkSync: (target) => seen.push(`symlink:${target}`),
  };
  const out = syncMirror({ file, mirrorFile, fs: fake });
  assert.equal(out.action, 'refreshed-mirror-symlink');
  assert.deepEqual(seen, ['rm', `symlink:${path.resolve(file)}`]);
});
