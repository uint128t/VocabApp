// VocabApp · 移动版入口（D45）
//
// Capacitor 的 nodejs-mobile 内核以 www/nodejs/package.json 的 main 字段找到本文件。
// 职责只有三件：
//   1. 把所有数据文件指进应用沙盒的 dataPath——nodejs 项目目录会在 App 更新时被整个覆盖，
//      settings/词表/备份/轮次状态/密钥绝不能放那里；
//   2. 拉起与桌面版完全相同的 server.js（桌面代码零改动，只认我们塞进环境的这些路径）；
//   3. 服务就绪后通过 bridge 通道把端口报给加载页（报 20 次、每秒一次，加载页任何时候
//      订阅都收得到；加载页收到就把自己换成 http://127.0.0.1:端口）。
const path = require('node:path');
const fs = require('node:fs');
const { channel, getDataPath } = require('bridge');

const data = getDataPath();
process.env.VOCAB_DATA_DIR = data;
process.env.VOCAB_SETTINGS_FILE = path.join(data, 'settings.json');
process.env.VOCAB_BACKUP_DIR = path.join(data, 'backups');
process.env.VOCAB_STATE_DIR = path.join(data, '.state');
process.env.VOCAB_KEYS_FILE = path.join(data, 'keys.json');
process.env.VOCAB_MOBILE = '1';
fs.mkdirSync(process.env.VOCAB_BACKUP_DIR, { recursive: true });
fs.mkdirSync(process.env.VOCAB_STATE_DIR, { recursive: true });

import('./settings.js')
  .then(async ({ resolvePort, DEFAULTS }) => {
    let port = DEFAULTS.port;
    try {
      port = resolvePort(JSON.parse(fs.readFileSync(process.env.VOCAB_SETTINGS_FILE, 'utf8')).port);
    } catch {}
    await import('./server.js');
    const base = `http://127.0.0.1:${port}`;
    // 等服务真的应答了再广播端口，别让加载页跳到一个还没 listen 的地址上
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${base}/api/settings`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    for (let n = 0; n < 20; n++) {
      try {
        channel.send('server-ready', port);
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  })
  .catch((e) => {
    try {
      channel.send('server-failed', String((e && e.stack) || e));
    } catch {}
    console.error('[mobile] 服务启动失败', e);
  });
