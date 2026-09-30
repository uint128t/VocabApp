// 真实词表的位置就在 settings.json 的 vocabFile 里（设置页可改），测试只读它、不写。
// 找不到就把话说清楚——不要悄悄跳过，那样一套全绿的测试什么都没验。
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

export function realVocabFile() {
  let file = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).vocabFile;
    if (typeof p === 'string' && p.trim()) file = p.trim();
  } catch {}
  if (!file) {
    throw new Error('settings.json 里没有 vocabFile：去设置页把词表路径填上，再跑测试');
  }
  if (!fs.existsSync(file)) {
    throw new Error(`找不到真实词表：${file}（settings.json 里的 vocabFile 指向的文件不在）`);
  }
  return file;
}
