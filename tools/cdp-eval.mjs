// 通过 CDP 在（模拟器/真机上的）WebView 里执行一段表达式并打印结果。
// 用法：node cdp-eval.mjs <expression-file-or-inline> [wsUrl]
const wsUrl = process.argv[3] || process.env.CDP_WS;
const source = process.argv[2];
if (!wsUrl) {
  console.error('缺少 WebSocket 调试地址（第二个参数或 CDP_WS）');
  process.exit(2);
}
const fs = await import('node:fs');
const expr = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : source;

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => {
  console.error('超时：30 秒内没拿到结果');
  process.exit(3);
}, 30000);
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true },
  }));
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== 1) return;
  clearTimeout(timer);
  if (msg.result?.exceptionDetails) {
    console.error('页面里抛错：', JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails));
    process.exit(4);
  }
  const value = msg.result?.result?.value;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => {
  console.error('WebSocket 出错：', e.message || e);
  process.exit(5);
};
