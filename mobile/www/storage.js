// 外部文件桥页（D48）。
//
// 为什么单独一个页面：主界面由内嵌服务接管后停在 http://127.0.0.1:5317，那个 WebView 里
// 没有 Capacitor 插件桥（实测：window.Capacitor.Plugins 是空的）；而 https://localhost
// 这个 Capacitor 的自家页面能调原生插件。所有需要原生能力（权限、文件选择器）的动作都走这里。
//
// 用法：`storage.html?mode=pick&back=<应用里的完整地址>`
//   1. 先确认「所有文件访问」权限（没有就先引导去开，开完自动继续）；
//   2. 打开系统文件选择器；
//   3. 带着 `?picked=<真实路径>` 跳回应用；取消给 `?pick=none`；拿不到真实路径（云盘）
//      留在本页提示改用「从文件导入」，并给「重新选择」。
const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
const params = new URLSearchParams(location.search);
const backUrl = params.get('back') || 'http://127.0.0.1:5317/';
const msg = document.querySelector('#msg');
const grant = document.querySelector('#grant');
const back = document.querySelector('#back');

const withParam = (kv) => `${backUrl}${backUrl.includes('?') ? '&' : '?'}${kv}`;
const goBack = (kv) => location.replace(kv ? withParam(kv) : backUrl);

let busy = false;

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

async function askPermission() {
  const sp = plugins().StoragePermission;
  if (!sp) return;
  try {
    await sp.openSettings();
  } catch (e) {
    msg.textContent = `打开系统设置失败：${e.message || e}`;
  }
}

async function pickAndReturn() {
  if (busy) return;
  busy = true;
  const sp = plugins().StoragePermission;
  msg.textContent = '正在打开文件选择器…';
  grant.hidden = true;
  try {
    const res = await sp.pickFile();
    if (res && res.path) {
      goBack(`picked=${encodeURIComponent(res.path)}`);
      return;
    }
    if (res && res.uri) {
      // 云盘 / 特殊来源：拿不到真实路径，直接读写在 Node 侧做不了
      msg.textContent =
        '这个位置拿不到真实文件路径（云盘或特殊来源），不能直接读写。请选「本机存储」里的文件（比如 Syncthing 同步的文件夹），或者回应用里用「从文件导入并替换…」把它拷进来。';
      grant.textContent = '重新选择';
      grant.hidden = false;
      back.hidden = false;
      busy = false;
      return;
    }
    goBack('pick=none'); // 取消
  } catch (e) {
    msg.textContent = `选择文件失败：${e.message || e}`;
    grant.textContent = '重新选择';
    grant.hidden = false;
    back.hidden = false;
    busy = false;
  }
}

grant.addEventListener('click', async () => {
  if (grant.textContent === '重新选择') {
    pickAndReturn();
    return;
  }
  msg.textContent = '在系统设置里找到「本应用」→ 允许「管理所有文件」，开完回来自动继续。';
  await askPermission();
});
back.addEventListener('click', () => goBack());

(async () => {
  if (!(await granted())) {
    msg.textContent = '直接读写外部文件需要「所有文件访问」权限。点下面按钮去系统设置里开启，开完回来自动打开文件选择器。';
    grant.hidden = false;
    grant.textContent = '去开启权限';
    back.hidden = false;
    await askPermission();
    // 用户去设置页期间这个页面被暂停；回来（visible）就再查一次
    setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      if (await granted()) {
        msg.textContent = '权限已开，正在打开文件选择器…';
        pickAndReturn();
      }
    }, 1200);
    return;
  }
  await pickAndReturn();
})();
