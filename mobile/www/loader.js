// 加载页：先订阅 bridge 通道再手动拉起 Node 引擎（startMode: manual，保证「服务已就绪」
// 这条消息不会漏），收到端口后把 WebView 导到内嵌服务上——之后整个界面就是同一套前端，
// 由同一个 Node 后端接管，与桌面版别无二致。
import { NodeJS } from 'capacitor-nodejs';

const msg = document.querySelector('#msg');
const retry = document.querySelector('#retry');
const spin = document.querySelector('#spin');
let navigated = false;

retry.addEventListener('click', () => {
  msg.textContent = '正在启动词表服务…';
  retry.hidden = true;
  spin.hidden = false;
  NodeJS.start().catch((e) => {
    msg.textContent = `启动失败：${e}`;
  });
});

NodeJS.addListener('server-ready', (event) => {
  const port = event?.args?.[0];
  if (navigated || !port) return;
  navigated = true;
  msg.textContent = '已就绪，正在打开…';
  window.location.replace(`http://127.0.0.1:${port}/`);
});

NodeJS.addListener('server-failed', (event) => {
  spin.hidden = true;
  msg.textContent = `服务启动失败：${event?.args?.[0] || '未知原因'}`;
  retry.hidden = false;
});

NodeJS.whenReady()
  .then(() => {
    // 引擎已起、服务还在路上（listen 要一点时间）：server-ready 消息到了就跳。
    // 15 秒还没跳就给一颗手动按钮，别让加载页永远转圈。
    setTimeout(() => {
      if (!navigated) {
        msg.textContent = '等了有点久还没就绪。';
        retry.hidden = false;
      }
    }, 15000);
  })
  .catch((e) => {
    spin.hidden = true;
    msg.textContent = `引擎启动失败：${e}`;
    retry.hidden = false;
  });

NodeJS.start().catch((e) => {
  spin.hidden = true;
  msg.textContent = `引擎启动失败：${e}`;
  retry.hidden = false;
});
