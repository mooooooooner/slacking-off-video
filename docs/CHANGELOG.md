# 版本变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。
需求目标与验收标准见 [`requirements.md`](./requirements.md)。

---

## [0.2.0] — 2026-09-30

聚焦「全屏、滚动条、快捷键」三类使用体验问题，并首次产出可分发的 exe。

### 新增

- **网页内全屏限制在窗口内**（FR-7）
  - 网页调用 `requestFullscreen()`（如视频播放器）时只让画面铺满本窗口，不再把窗口顶成系统全屏。
  - 采用 `fullscreenable: true` + `disableHtmlFullscreenWindowResize: true`；保留 `fullscreenable` 是因为设成
    `false` 会让 `requestFullscreen()` 直接被浏览器拒绝。
  - 进入网页全屏时自动收起浮层，并把顶部 10px 拖拽条高度归零，避免遮挡播放器自身控件；退出后自动恢复。
  - 以 `enter-html-full-screen` 兜底：万一窗口仍被顶成全屏，立即 `setFullScreen(false)` 还原。
- **隐藏网页滚动条**（FR-8）
  - 通过 `webContents.insertCSS()` 注入样式，只隐藏滚动条外观，滚轮 / 触摸板 / 键盘滚动不受影响。
  - 每次导航后自动重新注入（导航会清除已注入的 CSS）。
  - 外壳自身（控制面板、网址输入条）同步禁用滚动条。
  - 提供开关：`Ctrl+Alt+S` 或托盘菜单「隐藏网页滚动条」。
- **一键关闭快捷键 `Ctrl+Alt+Q`**（FR-9，全局生效）
- **Windows 免安装 exe 打包**（NFR-5）
  - 引入 `electron-builder`，`npm run dist` 产出 portable 单文件 exe。
  - 新增 `build/icon.ico`（由 `build/icon.png` 生成，供 Windows 打包与任务栏使用）。

### 变更

- **移除调整窗口大小的快捷键** `Ctrl+Alt+←/→`：改为纯鼠标操作（拖窗口边缘 / 四角）。
  控制面板中的「－ 缩小 / ＋ 放大」按钮与常用尺寸预设保留。
- 控制面板底部与起始页的快捷键说明同步更新。

### 修复

- 无

---

## [0.1.0] — 2026-09-30

首个可运行版本。

### 新增

- **无边框窗口**（FR-1）：`frame: false`，只有网页内容，没有标题栏 / 菜单 / 地址栏 / 标签栏。
- **自由调整大小与宽高比**（FR-2）：拖动边缘 / 四角缩放、贴边吸附；`Ctrl+Alt+R` 循环锁定宽高比。
- **透明度调节**（FR-3）：`win.setOpacity()`，10% ~ 100%，步进 10%，数值持久化。
- **一键切换悬浮模式**（FR-4）：`Ctrl+Alt+F` 全局快捷键，置顶 + 预设不透明度，退出时完整还原。
- **隐藏式网址输入条**（FR-5）：`Ctrl+L` 唤出，回车加载、`Esc` 取消。
- **控制面板**：右上角 `⚙` 入口（`Ctrl+Alt+P`），含不透明度滑块、宽高比、尺寸预设、各项开关。
- **鼠标穿透**（FR-6）：`Ctrl+Alt+M` 手动开关，`setIgnoreMouseEvents(true, { forward: true })`。
- **系统托盘**：显示 / 隐藏、悬浮模式、置顶、穿透、滚动条、不透明度预设、宽高比、窗口尺寸、重置、退出。
- **设置持久化**（FR-10）：`%APPDATA%\framelessviewer\settings.json`。
- **默认起始页**：深色页面，列出全部快捷键说明。
- **程序化生成的应用图标**：无第三方依赖，纯 Node 生成 PNG。

### 安全

- 窗口渲染进程启用 `contextIsolation` + `sandbox`，关闭 `nodeIntegration`（NFR-1）。
- 通过 `will-attach-webview` 强制剥离网页 preload 并禁用其 Node 能力。
- 渲染进程仅能访问 `window.frameless` 白名单方法（NFR-2）。

### 修复（发布前自查发现）

- **`Escape` 完全失效**：`if (!mod) return` 写在了 Escape 判断之前，导致无修饰键的 `Esc` 被提前拦截。
- **退出悬浮模式无法还原置顶状态**：进入悬浮模式时 `restore` 被后续的 `setAlwaysOnTop` 覆盖，
  调整赋值顺序后修复。
- **「重新加载」重载的是外壳而非网页**：改为向渲染层发命令重载 `<webview>`。
- **`Ctrl+Alt+H` 只能隐藏不能恢复**：改为切换显隐。

### 变更

- 全局快捷键由 12 个收窄到 4 个。原先把 `Ctrl+Alt+←/→/↑/↓` 注册为系统级快捷键，
  会直接抢占并破坏其他软件的这些组合键；现改为仅在窗口有焦点时生效（NFR-3）。
