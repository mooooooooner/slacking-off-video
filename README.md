# FramelessViewer

无边框透明浏览器。屏幕上**只有网页内容** —— 没有标题栏、没有地址栏、没有菜单栏、没有标签栏。

- **自由调整大小与比例**：拖窗口边缘即可缩放；可锁定 16:9 / 4:3 / 1:1 等比例
- **自由调节透明度**：窗口整体不透明度 10% ~ 100%
- **一键启用 / 退出悬浮模式**：全局快捷键，窗口没焦点时也生效
- **一键关闭**：`Ctrl + Alt + Q` 直接退出程序
- **网页全屏只在本窗口内生效**：不会把窗口顶成系统全屏
- **无滚动条**：隐藏网页右侧 / 底部滚动条，滚动功能不受影响

基于 Electron 构建，使用 `frame: false` + `win.setOpacity()` 实现。

## 文档

- [需求目标与验收标准](docs/requirements.md)
- [版本变更日志](docs/CHANGELOG.md)

---

## 快速开始

```bash
npm install
npm start
```

开发模式（会把渲染进程的 console 转发到终端，便于排查）：

```bash
npm run dev
```

启动时直接打开某个网址：

```bash
npm start -- https://example.com
```

> 如果 `npm install` 卡在下载 Electron 二进制，可切换镜像后重试：
>
> ```bash
> npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
> npm install
> ```

## 快捷键

| 快捷键 | 功能 | 生效范围 |
| --- | --- | --- |
| `Ctrl + L` | 唤出隐藏的网址输入条（回车加载，`Esc` 取消） | 窗口内 |
| `Ctrl + Alt + F` | **一键进入 / 退出悬浮模式**（置顶 + 预设不透明度） | **全局** |
| `Ctrl + Alt + Q` | **一键关闭程序** | **全局** |
| `Ctrl + Alt + M` | 鼠标穿透开关 | **全局** |
| `Ctrl + Alt + T` | 窗口置顶开关 | **全局** |
| `Ctrl + Alt + H` | 显示 / 隐藏窗口（也可点托盘图标恢复） | **全局** |
| `Ctrl + Alt + ↑` / `↓` | 不透明度 +10% / −10% | 窗口内 |
| `Ctrl + Alt + R` | 循环切换宽高比（自由 → 16:9 → 4:3 → 1:1 → …） | 窗口内 |
| `Ctrl + Alt + S` | 隐藏 / 显示网页滚动条 | 窗口内 |
| `Ctrl + Alt + P` | 打开 / 关闭控制面板 | 窗口内 |
| `Ctrl + Alt + 0` | 重置全部设置 | 窗口内 |
| `Esc` | 隐藏所有浮层（穿透开启时同时关闭穿透） | 窗口内 |

> **调整窗口大小没有快捷键**：直接用鼠标拖动窗口边缘 / 四角即可。
> 控制面板里也保留了「－ 缩小 / ＋ 放大」按钮和常用尺寸预设，纯鼠标操作。

**全局**快捷键即使窗口没有焦点也生效，用于「一键切换」和「穿透后自救」。
**窗口内**快捷键只在窗口有焦点时生效，避免抢占其他软件的组合键
（把 `Ctrl + Alt + 方向键` 注册成全局会直接破坏其他程序，所以不这么做）。

若某个全局组合被其他软件占用，启动时终端会打印警告；此时窗口内的同名组合仍然可用。

## 鼠标与窗口操作

- **移动窗口**：拖动窗口顶部的 10px 空白区（或控制面板标题栏）
- **缩放窗口**：拖动窗口任意边缘 / 四角（无需快捷键）
- **控制面板**：鼠标移到窗口右上角会浮现一个 `⚙` 小按钮，点击打开
- **鼠标穿透**：开启后鼠标点击会穿透到下层窗口，用 `Ctrl + Alt + M` 或托盘菜单关闭

## 网页内全屏（视频播放器等）

网页调用 `requestFullscreen()` 时，**只会让画面铺满本窗口，不会把窗口顶成系统全屏**。

实现方式：窗口保留 `fullscreenable: true`（否则 `requestFullscreen()` 会直接失败），
同时设置 `disableHtmlFullscreenWindowResize: true`，让窗口在 HTML 全屏期间保持原有尺寸。
另外进入网页全屏时会自动收起浮层、并让出顶部 10px 的拖拽条，避免挡住播放器自身的控件。
万一窗口仍被顶成全屏，`enter-html-full-screen` 会立刻把它还原。

## 滚动条

默认隐藏网页的右侧 / 底部滚动条（`Ctrl + Alt + S` 或托盘菜单可切换）：

- 通过 `webContents.insertCSS()` 注入到网页里，**只隐藏滚动条外观**，
  滚轮 / 触摸板 / 键盘滚动照常可用
- 外壳自身（控制面板、输入条）也已禁用滚动条

## 托盘菜单

关闭窗口 = 收进托盘（这样穿透状态下也能找回窗口）。
**退出程序请用托盘菜单里的「退出」**，或控制面板的「退出」按钮。

托盘里还提供了不透明度、宽高比、窗口尺寸预设等快捷入口。

## 透明度说明

窗口透明度使用 `win.setOpacity()`（整窗均匀透明），这样能**同时保留缩放和贴边吸附**。

Electron 的 `transparent: true`（逐像素透明、页面背景可透视到桌面）在官方文档中明确限制**不可缩放**，与「自由调整窗口大小」冲突，因此默认不启用。

## 文件结构

```
src/
├─ main.js            主进程：窗口、托盘、全局快捷键、透明度、缩放、IPC
├─ preload.js         contextBridge 暴露的最小 API（contextIsolation 开启）
├─ store.js           设置持久化（存于 userData/settings.json）
└─ renderer/
   ├─ shell.html      无边框外壳：webview + 隐藏控制层
   ├─ shell.css       控制层 / 拖拽区 / 输入条样式
   ├─ shell.js        交互逻辑
   └─ start.html      默认起始页（快捷键说明）
src/assets/icon.png   运行时图标（窗口 / 托盘）
build/icon.ico        打包用图标（Windows）
docs/                 需求目标与版本变更日志
```

## 安全设计

- 窗口渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 网页内容跑在 `<webview>` 里，通过 `will-attach-webview` 强制剥离 preload 并禁用 Node
- 渲染进程只能访问 `window.frameless` 这几个白名单方法，拿不到 `fs` / 任意 IPC

## 已知行为

- 关闭窗口不会退出程序，只会收进托盘；**一键退出用 `Ctrl + Alt + Q`** 或托盘菜单
- 鼠标穿透状态**不跨重启保留**，避免开机后点不到窗口
- 隐藏滚动条对个别依赖滚动条宽度的站点可能造成轻微布局变化，可用 `Ctrl + Alt + S` 关掉
- Windows 上任务栏缩略图不会变透明，属系统正常现象

## 打包

```bash
npm run dist
```

产物为 Windows 免安装单文件：

```
dist/FramelessViewer-<版本>-portable.exe
```

打包配置在 `electron-builder.yml`。图标固定为 `build/icon.ico`（256×256），
运行时使用的 `src/assets/icon.png` 会被一并打进 app。

> 首次打包需要下载 electron 与 NSIS 等工具，若缓慢可先设置镜像：
>
> ```powershell
> $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
> $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```
