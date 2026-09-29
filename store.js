import realFs from 'node:fs';
import path from 'node:path';

import { parse } from './vocab.js';

export const AUTO_BACKUP = /^Vocabulary\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z?(?:-\d+)?\.md$/;

const sameFile = (a, b, fs) => {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
};

// 真身（通常是 Obsidian 库里那份）与镜像（本目录的同名文件，硬链或软链）之间的双向同步。
//  · 链接好着 → 本来就是同一个文件（stat 走链接看 ino 一致），什么都不用做；
//  · 链接断了（被「写临时文件再改名」式的保存打断：硬链改名只换掉一个名字、另一个名字留在旧 inode 上；
//    软链名被换成普通文件）→ 谁的时间戳新听谁的：镜像更新就先把镜像内容写回真身，
//    然后照原来的链接类型重建（软链要权限，建不了就退成硬链，再不行退成普通副本）。
// 于是两个位置都可以随便改，工具下次读/写时把它俩重新对齐。
export function syncMirror({ file, mirrorFile, fs = realFs } = {}) {
  if (!mirrorFile || !file) return { action: 'none' };
  if (path.resolve(mirrorFile) === path.resolve(file)) return { action: 'none' };
  if (!fs.existsSync(file) || !fs.existsSync(mirrorFile)) return { action: 'none' };
  if (sameFile(file, mirrorFile, fs)) return { action: 'linked' };

  const wasSymlink = (() => {
    try {
      return fs.lstatSync(mirrorFile).isSymbolicLink();
    } catch {
      return false;
    }
  })();

  const mine = fs.statSync(file);
  const theirs = fs.statSync(mirrorFile);
  const action = theirs.mtimeMs > mine.mtimeMs ? 'adopted-mirror' : 'refreshed-mirror';
  if (action === 'adopted-mirror') {
    fs.writeFileSync(file, fs.readFileSync(mirrorFile, 'utf8'), 'utf8');
  }
  fs.rmSync(mirrorFile);
  if (wasSymlink) {
    try {
      fs.symlinkSync(path.resolve(file), mirrorFile, 'file');
      return { action: `${action}-symlink` };
    } catch {}
  }
  try {
    fs.linkSync(file, mirrorFile);
  } catch {
    fs.copyFileSync(file, mirrorFile);
    return { action: `${action}-copied` };
  }
  return { action };
}

export function createStore({ file, backupDir, maxBackups = 20, fs = realFs, mirrorFile = null }) {
  let seq = 0;
  let queue = Promise.resolve();

  // 词表文件常常是个链接，两种链要区别对待：
  //  · 软链：先 resolve 出真实路径再写，否则「改名」会把链接本身换成一个普通文件；
  //  · 硬链（同一 inode 有两个名字）：不能用「写临时文件再改名」——改名只换掉一个名字，
  //    另一个名字还留在旧 inode 上，两边内容会悄悄分叉。这时改成原处覆盖写（写前照例已备份）。
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    target = file;
  }
  const hardLinked = () => {
    try {
      return fs.statSync(target).nlink > 1;
    } catch {
      return false;
    }
  };

  const backupName = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let name = `Vocabulary.${stamp}.md`;
    for (let n = 2; fs.existsSync(path.join(backupDir, name)); n++) {
      name = `Vocabulary.${stamp}-${n}.md`;
    }
    return name;
  };

  const rotate = () => {
    if (!fs.existsSync(backupDir)) return;
    const auto = fs.readdirSync(backupDir).filter((n) => AUTO_BACKUP.test(n)).sort();
    for (const n of auto.slice(0, Math.max(0, auto.length - maxBackups))) {
      fs.unlinkSync(path.join(backupDir, n));
    }
  };

  const sync = () => syncMirror({ file: target, mirrorFile, fs });

  const readFile = () => {
    sync();
    return fs.readFileSync(target, 'utf8');
  };

  const writeWithBackup = (text) => {
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = backupName();
    fs.copyFileSync(target, path.join(backupDir, backup));
    rotate();
    if (hardLinked()) {
      fs.writeFileSync(target, text, 'utf8');
      sync();
      return { backup };
    }
    const tmp = `${target}.${process.pid}.${++seq}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, target);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw e;
    }
    sync();
    return { backup };
  };

  const listBackups = () => {
    if (!fs.existsSync(backupDir)) return [];
    return fs
      .readdirSync(backupDir)
      .filter((n) => n.startsWith('Vocabulary.') && n.endsWith('.md'))
      .map((n) => {
        const st = fs.statSync(path.join(backupDir, n));
        return { name: n, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  };

  const enqueue = (task) => {
    const run = queue.then(() => task());
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const selfCheck = () => {
    sync();
    if (!fs.existsSync(target)) throw new Error(`词表文件不存在：${file}`);
    fs.accessSync(target, fs.constants.W_OK);
    const text = readFile();
    const { entries, stats, errors } = parse(text);
    if (errors.length) {
      const detail = errors
        .slice(0, 20)
        .map((e) => `  第 ${e.line} 行 ${e.type}：${e.raw ?? e.word ?? ''}`)
        .join('\n');
      throw new Error(`词表解析失败，共 ${errors.length} 处：\n${detail}`);
    }
    return { entries, stats };
  };

  return { file, target, mirrorFile, backupDir, maxBackups, readFile, writeWithBackup, listBackups, enqueue, selfCheck, sync };
}

export function createStateFile({ file, fs = realFs }) {
  let seq = 0;

  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(raw);
  };

  const write = (value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw e;
    }
  };

  const clear = () => {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  };

  return { file, read, write, clear };
}
