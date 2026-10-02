# Vocabulary 助手 · 安卓版（路线三）

把同一个 Node 后端嵌进 APK：`capacitor-nodejs`（内嵌 nodejs-mobile 内核，Node 18.20）在手机上跑 `server.js`，WebView 加载页收到「服务已就绪」后把主界面导航到 `http://127.0.0.1:5317/`——之后看到的就是与桌面完全相同的前端与后端。后端代码零重写，桌面端通过 `import.meta.dirname` 垫片与平台守卫保持原样。

## 结构

```
mobile/
├── capacitor.config.json     appId / webDir / startMode: manual
├── www/index.html + loader.js   加载页：订阅 bridge → NodeJS.start() → 收端口 → 跳转主界面
├── nodejs-src/mobile-main.cjs   移动版入口：把数据路径指进应用沙盒，拉起 server.js，广播端口
├── build-nodejs.mjs           组装 www/nodejs/（后端 9 个模块 + public/ + data/cefr.json + 入口）
├── fetch-vendor.mjs           下载 capacitor-nodejs 发布包到 vendor/（GitHub 直连不通走镜像）
├── smoke-desktop.cjs          桌面冒烟：mock bridge 跑整条移动启动链路
├── vendor/capacitor-nodejs-1.0.0-beta.10.tgz   插件发布包（含 Android 的 libnode，约 57MB，不入库）
└── android/                   Capacitor 生成的安卓工程（已提交，含明文回环的网络配置补丁）
```

## 从零构建 APK

前置：JDK 21、Android SDK（platform 36 + build-tools 36 + NDK 28 + CMake，插件要用 NDK 编 JNI 胶水）。环境变量 `JAVA_HOME`、`ANDROID_HOME` 指好，或者让 `android/local.properties` 写着 `sdk.dir`。

```bash
cd mobile
npm run fetch-vendor     # 下载插件包到 vendor/（已有则跳过）
npm install              # 装 Capacitor 8 + 插件；postinstall 顺带组装 www/nodejs
npm run android          # = 组装 nodejs + cap sync + gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（约 160MB，arm64/armv7/x86_64 三架构 debug 包）。传到手机安装即可；release 签名以后再说。

## 首次启动

1. 加载页转圈几秒（内核解包 nodejs 项目 + Node 起服务），收到端口后自动进入主界面。
2. 移动版的数据全部在应用沙盒里（`getDataPath()`）：`Vocabulary.md`、`settings.json`、`keys.json`、`backups/`、`.state/`。首次启动没有词表时自动种一份空的。
3. 把词表带进手机：设置 →「词表文件」→「从文件导入并替换」（选 Obsidian 导出的 md），或先空表开始、用「加词」慢慢攒。带出去用「下载当前词表」。
4. AI 功能（加词/判定/重构/定档）需要密钥：设置 →「模型」→「新增候选」里加模型（接入点 + 密钥名），密钥**值**在「密钥管理」里填（只写不读，存应用沙盒的 `keys.json`；桌面版没有这一块，密钥仍在 `.env`）。

## 已知边界

- 内嵌内核停在 Node 18.20（nodejs-mobile 上游已停维护，`import.meta.dirname` 这类新 API 由 `dirname.js` 垫片兜住）；换来的是后端零重写。插件作者自己都建议新项目改用 Tauri——那是以后想换架构时的另一条路。
- 端口与局域网访问设置在移动版同样生效（bridge 报的就是设置里的端口）；开了局域网访问，同网络设备可以访问手机上这份服务。
- 桌面专属的「打开 .env / 打开 settings.json」在移动版隐藏；`/api/open-config` 在非 Windows 上返回 501。
- 加载页 15 秒等不到服务会给「重新等待」；引擎崩溃走 `server-failed` 消息显示原因。
