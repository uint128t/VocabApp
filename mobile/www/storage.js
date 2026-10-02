// 共享存储权限桥页（D48）。
//
// 为什么单独一个页面：主界面由内嵌服务接管后停在 http://127.0.0.1:5317，那个 WebView 里
// 没有 Capacitor 插件桥（实测：window.Capacitor.Plugins 是空的）；而 https://localhost
// 这个 Capacitor 的自家页面能调原生插件。所以流程是：
//   5317 的界面 → 跳到这里 → 这里申请「所有文件访问」权限 → 拿回 5317 继续切换。
//
// 权限在系统设置里手动开，所以这里轮询插件状态：用户开完一回来看见就跳回去。
const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
const params = new URLSearchParams(location.search);
const backUrl = params.get('back') || '/';
const msg = document.querySelector('#msg');
const grant = document.querySelector('#grant');
const back = document.querySelector('#back');

const goBack = () => location.replace(backUrl);

async function granted() {
  const sp = plugins().StoragePermission;
  if (!sp) {
    msg.textContent = '插件未注册：请安装最新版 APK。';
    return false;
  }
  try {
    const res = await sp.isGranted();
    return Boolean(res.granted);
  } catch {
    return false;
  }
}

async function ask() {
  const sp = plugins().StoragePermission;
  if (!sp) return;
  try {
    await sp.openSettings();
  } catch (e) {
    msg.textContent = `打开系统设置失败：${e.message || e}`;
  }
}

grant.addEventListener('click', async () => {
  msg.textContent = '在系统设置里找到「本应用」→ 允许「管理所有文件」，开完回来自动继续。';
  await ask();
});
back.addEventListener('click', goBack);

(async () => {
  if (await granted()) {
    msg.textContent = '权限已开，正在返回…';
    goBack();
    return;
  }
  msg.textContent = '需要「所有文件访问」权限才能把词表放进共享存储。点下面按钮去系统设置里开启，开完回来自动继续。';
  grant.hidden = false;
  back.hidden = false;
  await ask();
  // 用户去设置页期间这个页面被暂停；回来（visible）就再查一次
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (await granted()) {
      msg.textContent = '权限已开，正在返回…';
      goBack();
    }
  }, 1200);
})();
