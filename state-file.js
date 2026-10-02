import realFs from 'node:fs';
import path from 'node:path';

// 一个 JSON 小文件的读写（设置、轮次状态、运行期密钥都算这类）。词表本体走 store.js：
// 那边要备份、要轮转、要认链接，是另一套规矩，别混在一起。
// 写盘一律「临时文件 + 改名」：读到一半不会拿到写了一半的内容。
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

  return { read, write };
}
