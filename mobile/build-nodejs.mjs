// 组装 www/nodejs：把仓库里的 Node 后端原样拷进去（D45 的「后端代码零改动」），
// 加上移动版入口与 package.json。每次构建都整个重建，保证不带旧文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(mobileDir, '..');
const target = path.join(mobileDir, 'www', 'nodejs');

const COPY_FILES = ['server.js', 'vocab.js', 'store.js', 'session.js', 'ai.js', 'cefr.js', 'config.js', 'settings.js', 'dirname.js'];

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, 'data'), { recursive: true });

for (const file of COPY_FILES) fs.copyFileSync(path.join(repo, file), path.join(target, file));
fs.cpSync(path.join(repo, 'public'), path.join(target, 'public'), { recursive: true });
fs.copyFileSync(path.join(repo, 'data', 'cefr.json'), path.join(target, 'data', 'cefr.json'));
fs.copyFileSync(path.join(mobileDir, 'nodejs-src', 'mobile-main.cjs'), path.join(target, 'mobile-main.cjs'));

// package.json 的 main 字段是内核找入口的依据；type:module 让 server.js 的 ESM import 生效
const pkg = {
  name: 'vocabapp-node',
  version: '1.0.0',
  private: true,
  type: 'module',
  main: './mobile-main.cjs',
};
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

const count = (dir) => fs.readdirSync(dir, { recursive: true }).length;
console.log(`www/nodejs 组装完成：${COPY_FILES.length} 个后端模块 + public/ + data/cefr.json + 移动入口（共 ${count(target)} 个文件）`);
