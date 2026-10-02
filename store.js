import realFs from 'node:fs';
import path from 'node:path';

import { parse } from './vocab.js';

export const AUTO_BACKUP = /^Vocabulary\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z?(?:-\d+)?\.md$/;

// maxBackups 管的是自动备份的轮转上限：每次写盘都会把当前内容存一份，攒够 30 份之后
// 多出来的从最老的开始删。文件名带自定义后缀的不算在内（那是手存的，不该被轮转吃掉）。
export function createStore({ file, backupDir, maxBackups = 30, fs = realFs }) {
  let seq = 0;
  let queue = Promise.resolve();

  // file 可以是路径，也可以是「每次取当前值」的函数：设置页改了词表路径要立刻生效，
  // 所以目标路径每次重新解析，不在建 store 的时候定死。
  const sourceFile = () => {
    const f = typeof file === 'function' ? file() : file;
    if (!f) throw new Error('还没有设置词表文件路径（去「设置」里填一个）');
    return f;
  };

  // 词表文件常常是个链接，两种链要区别对待：
  //  · 软链：先 resolve 出真实路径再写，否则「改名」会把链接本身换成一个普通文件；
  //  · 硬链（同一 inode 有两个名字）：不能用「写临时文件再改名」——改名只换掉一个名字，
  //    另一个名字还留在旧 inode 上，两边内容会悄悄分叉。这时改成原处覆盖写（写前照例已备份）。
  const target = () => {
    const f = sourceFile();
    try {
      return fs.realpathSync(f);
    } catch {
      return f;
    }
  };

  const hardLinked = (abs) => {
    try {
      return fs.statSync(abs).nlink > 1;
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

  const readFile = () => fs.readFileSync(target(), 'utf8');

  const writeWithBackup = (text) => {
    const abs = target();
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = backupName();
    fs.copyFileSync(abs, path.join(backupDir, backup));
    rotate();
    if (hardLinked(abs)) {
      fs.writeFileSync(abs, text, 'utf8');
      return { backup };
    }
    const tmp = `${abs}.${process.pid}.${++seq}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, abs);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw e;
    }
    return { backup };
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
    const abs = target();
    if (!fs.existsSync(abs)) throw new Error(`词表文件不存在：${abs}`);
    fs.accessSync(abs, fs.constants.W_OK);
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

  return { target, readFile, writeWithBackup, enqueue, selfCheck };
}
