// 原生能力桥页（D48/D50）：权限、系统文件选择器、系统分享。
//
// 为什么单独一个页面：主界面由内嵌服务接管后停在它自己的地址（端口在设置里），那个 WebView 里
// 没有 Capacitor 插件桥（实测：window.Capacitor 压根不存在）；而 https://localhost 这个
// Capacitor 的自家页面能调原生插件。所以「把文件交出去」这件事也只能在这里做——主界面里
// 那颗 `<a download>` 点了不会有任何反应。
//
// 用法：
//   storage.html?mode=pick&back=<应用地址>
//     1. 先确认「所有文件访问」权限（没有就先引导去开，开完自动继续）；
//     2. 打开系统文件选择器；
//     3. 带着 `?picked=<真实路径>` 跳回应用；取消给 `?pick=none`；拿不到真实路径（云盘）
//        留在本页提示改用「从文件导入」，并给「重新选择」。
//   storage.html?mode=share&name=<文件名>&src=<内嵌服务的地址>&back=<应用地址>
//     向内嵌服务取回那份内容（词表 / 设备包，上百 KB，不经过 URL 搬运）→ 写进应用缓存 →
//     弹系统分享。取内容这一跳要跨一次源，服务端只放行 Capacitor 自家 origin。
const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'pick';
// 回哪儿去只由调用方给：端口是设置里的值，这一页再写死一个 5317 就是第二个来源。
const backUrl = params.get('back');
const msg = document.querySelector('#msg');
const grant = document.querySelector('#grant');
const back = document.querySelector('#back');

const withParam = (kv) => `${backUrl}${backUrl.includes('?') ? '&' : '?'}${kv}`;
const goBack = (kv) => backUrl && location.replace(kv ? withParam(kv) : backUrl);
// 没带 back 就没什么可回的，「返回应用」这颗别亮出来骗人。
const showBack = () => {
  back.hidden = !backUrl;
};

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
      showBack();
      busy = false;
      return;
    }
    goBack('pick=none'); // 取消
  } catch (e) {
    msg.textContent = `选择文件失败：${e.message || e}`;
    grant.textContent = '重新选择';
    grant.hidden = false;
    showBack();
    busy = false;
  }
}

// 分享一份内容：向内嵌服务取 → 写进应用缓存 → 弹系统分享。缓存目录不需要任何存储权限。
async function shareFile() {
  if (busy) return;
  busy = true;
  const name = params.get('name') || 'Vocabulary.md';
  const src = params.get('src');
  const { Filesystem, Share } = plugins();
  if (!src || !Filesystem || !Share) {
    msg.textContent = '缺少内容地址或插件没注册：请安装最新版 APK。';
    showBack();
    busy = false;
    return;
  }
  grant.hidden = true;
  msg.textContent = '正在取内容…';
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    const text = await res.text();
    await Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
    const { uri } = await Filesystem.getUri({ path: name, directory: 'CACHE' });
    // 分享面板被关掉时插件不一定回话（实测停在「正在打开」），所以先把「返回应用」亮出来
    msg.textContent = `已准备好 ${name}，在分享面板里选一个目标；不想分享就点「返回应用」。`;
    showBack();
    await Share.share({ title: name, dialogTitle: name, files: [uri] });
    goBack();
  } catch (e) {
    // 分享面板被取消也走这里：不算错误，给一颗返回就行
    msg.textContent = `没能分享出去：${(e && (e.message || e)) || e}`;
    grant.textContent = '重试';
    grant.hidden = false;
    showBack();
  } finally {
    busy = false;
  }
}

grant.addEventListener('click', async () => {
  if (grant.textContent === '重新选择') {
    pickAndReturn();
    return;
  }
  if (grant.textContent === '重试') {
    shareFile();
    return;
  }
  msg.textContent = '在系统设置里找到「本应用」→ 允许「管理所有文件」，开完回来自动继续。';
  await askPermission();
});
back.addEventListener('click', () => goBack());

if (mode === 'share') {
  shareFile();
} else {
  pickFlow();
}

// 选文件那套：先要权限，再开系统选择器
async function pickFlow() {
  if (!(await granted())) {
    msg.textContent = '直接读写外部文件需要「所有文件访问」权限。点下面按钮去系统设置里开启，开完回来自动打开文件选择器。';
    grant.hidden = false;
    grant.textContent = '去开启权限';
    showBack();
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
}
