// 桌面冒烟：用假的 bridge 模块跑一遍组装出来的移动版入口，验证「移动版启动链路」
// 在真机之外也能走通：mobile-main 设环境 → server.js 的移动分支起服务 → 种子词表 →
// /api/settings 带 platform/keysFile → /api/vocab/export 原文下发。
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-mobile-smoke-'));
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'bridge') {
    return { getDataPath: () => data, channel: { send: (...a) => console.log('[bridge]', a[0], a[1] || '') } };
  }
  return origLoad.call(this, request, ...args);
};

process.env.VOCAB_MOBILE = '1';
// 预设一个独立端口：真实服务常驻 5317，Windows 允许重复绑定会让探测在两个进程间摇摆，
// 冒烟必须独占一个端口才作数。这份 settings.json 也顺带验证「移动入口按设置取端口」。
fs.writeFileSync(path.join(data, 'settings.json'), `${JSON.stringify({ vocabFile: null, port: 5319 }, null, 2)}\n`);
require(path.join(__dirname, 'www', 'nodejs', 'mobile-main.cjs'));

const port = 5319;
const base = `http://127.0.0.1:${port}`;
const poll = setInterval(async () => {
  try {
    const res = await fetch(`${base}/api/settings`);
    if (!res.ok) return;
    clearInterval(poll);
    const body = await res.json();
    const exportRes = await fetch(`${base}/api/vocab/export`);
    const exportText = await exportRes.text();
    const checks = {
      平台字段: body.platform === process.platform,
      keysFile指向沙盒: body.keysFile === path.join(data, 'keys.json'),
      词表种子: fs.existsSync(path.join(data, 'Vocabulary.md')),
      设置在沙盒: fs.existsSync(path.join(data, 'settings.json')),
      导出是原文: exportRes.status === 200 && exportText === fs.readFileSync(path.join(data, 'Vocabulary.md'), 'utf8'),
      密钥接口可用: body.keysFile !== null,
    };
    console.log('--- 冒烟结果 ---');
    for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✔' : '✖'} ${k}`);
    const bad = Object.values(checks).filter((x) => !x).length;
    console.log(bad ? `冒烟失败：${bad} 项` : '移动版启动链路全部通过');
    process.exit(bad ? 1 : 0);
  } catch {}
}, 200);
setTimeout(() => {
  console.log('冒烟超时：服务 15 秒内没有应答');
  process.exit(1);
}, 15000);
