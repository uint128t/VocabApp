// 加载页：先订阅 bridge 通道再手动拉起 Node 引擎（startMode: manual，保证「服务已就绪」
// 这条消息不会漏），收到端口后把 WebView 导到内嵌服务上——之后整个界面就是同一套前端，
// 由同一个 Node 后端接管，与桌面版别无二致。
//
// 注意：这里是静态页面、没有打包器，`import ... from 'capacitor-nodejs'` 这种裸模块名在
// WebView 里根本解析不了（整个模块直接炸，页面就永远卡在启动中）。插件由 Capacitor
// 自动注册，从注入的全局对象上取即可。
const NodeJS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorNodeJS;

const msg = document.querySelector('#msg');
const retry = document.querySelector('#retry');
const spin = document.querySelector('#spin');
let navigated = false;

function fail(text) {
  spin.hidden = true;
  msg.textContent = text;
  retry.hidden = false;
}

retry.addEventListener('click', () => {
  msg.textContent = '正在启动词表服务…';
  retry.hidden = true;
  spin.hidden = false;
  NodeJS.start().catch((e) => fail(`启动失败：${e}`));
});

if (!NodeJS) {
  fail('插件未注册：Capacitor 全局对象里找不到 CapacitorNodeJS');
} else {
  NodeJS.addListener('server-ready', (event) => {
    const port = event?.args?.[0];
    if (navigated || !port) return;
    navigated = true;
    msg.textContent = '已就绪，正在打开…';
    window.location.replace(`http://127.0.0.1:${port}/`);
  });

  NodeJS.addListener('server-failed', (event) => {
    fail(`服务启动失败：${event?.args?.[0] || '未知原因'}`);
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
    .catch((e) => fail(`引擎启动失败：${e}`));

  NodeJS.start().catch((e) => fail(`引擎启动失败：${e}`));
}
