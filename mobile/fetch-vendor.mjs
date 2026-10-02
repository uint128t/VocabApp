// 下载 capacitor-nodejs 的发布包到 vendor/。GitHub 直连在部分网络不可达，按顺序试镜像；
// 已有完整文件时跳过。下载走断点续传，代理截断多来几次能拼完整。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v1.0.0-beta.10';
const FILE = 'capacitor-nodejs.tgz';
const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(mobileDir, 'vendor');
const target = path.join(vendor, FILE);
fs.mkdirSync(vendor, { recursive: true });

const BASE = `https://github.com/hampoelz/capacitor-nodejs/releases/download/${VERSION}/${FILE}`;
const MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://mirror.ghproxy.com/'];

// 完整包约 57MB；小了肯定没下完
if (fs.existsSync(target) && fs.statSync(target).size > 30_000_000) {
  console.log('vendor 里已有完整的 capacitor-nodejs 包，跳过下载');
  process.exit(0);
}

let ok = false;
for (const mirror of MIRRORS) {
  const url = mirror + BASE;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const code = await fetch(url, { headers: { range: `bytes=${fs.existsSync(target) ? fs.statSync(target).size : 0}-` } })
      .then((r) => {
        if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        fs.appendFileSync(target, Buffer.from(buf));
        return 200;
      })
      .catch((e) => {
        console.log(`  第 ${attempt} 次：${e.message}`);
        return 0;
      });
    if (!code) continue;
    const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
    if (size > 30_000_000) {
      console.log(`下载完成：${mirror || 'GitHub 直连'} · ${Math.round(size / 1024 / 1024)}MB`);
      ok = true;
      break;
    }
    console.log(`  第 ${attempt} 次后 ${Math.round(size / 1024)}KB，继续续传`);
  }
  if (ok) break;
}

if (!ok) {
  console.error('下载失败：换一个网络环境再跑 npm run fetch-vendor，或手工把\n' + BASE + '\n下载到 ' + target);
  process.exit(1);
}
