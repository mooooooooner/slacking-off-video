'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  shell,
} = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const Store = require('./store');

// ---------------------------------------------------------------- 常量配置

const IS_DEV = process.argv.includes('--dev');

const RENDERER = path.join(__dirname, 'renderer');
const SHELL_PAGE = path.join(RENDERER, 'shell.html');
const START_PAGE = path.join(RENDERER, 'start.html');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1;
const OPACITY_STEP = 0.1;

const SIZE_MIN = { width: 320, height: 200 };
const SIZE_MAX = { width: 100000, height: 100000 };

/** 比例列表，value 为 0 表示“自由”。 */
const ASPECT_RATIOS = [
  { label: '自由', value: 0 },
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '21:9', value: 21 / 9 },
  { label: '3:2', value: 3 / 2 },
  { label: '9:16 竖屏', value: 9 / 16 },
];

const SIZE_PRESETS = [
  { label: '1920 × 1080', width: 1920, height: 1080 },
  { label: '1600 × 900', width: 1600, height: 900 },
  { label: '1280 × 720', width: 1280, height: 720 },
  { label: '1024 × 768', width: 1024, height: 768 },
  { label: '900 × 600', width: 900, height: 600 },
  { label: '640 × 480', width: 640, height: 480 },
];

const OPACITY_PRESETS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];

const DEFAULT_SETTINGS = {
  url: '',
  opacity: 1,
  alwaysOnTop: false,
  clickThrough: false,
  aspectIndex: 0,
  bounds: null,
  mode: 'normal', // 'normal' | 'floating'
  floatingOpacity: 0.85,
  hideScrollbars: true,
};

/**
 * 注入到网页里用来隐藏滚动条。
 * 只隐藏滚动条本身，滚轮 / 触摸板 / 键盘滚动依然可用。
 */
const SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  html, body, * { scrollbar-width: none !important; }
`;

// ---------------------------------------------------------------- 运行时状态

let store = null;
let win = null;
let tray = null;
let boundsTimer = null;

const state = { ...DEFAULT_SETTINGS };
/** 进入悬浮模式前的设置，用于退出时还原。 */
let restore = { opacity: 1, alwaysOnTop: false };

// ---------------------------------------------------------------- 小工具

function clampOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return state.opacity;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(n * 100) / 100));
}

function clampSize(n, axis) {
  const min = SIZE_MIN[axis];
  const max = SIZE_MAX[axis];
  return Math.min(max, Math.max(min, Math.round(Number(n) || min)));
}

function hasWindow() {
  return !!win && !win.isDestroyed();
}

function sendChannel(channel, payload) {
  if (hasWindow()) win.webContents.send(channel, payload);
}

function sendCommand(type, payload = {}) {
  sendChannel('app:command', { type, ...payload });
}

function broadcast() {
  sendChannel('app:state', publicState());
}

/** 顶部短暂提示。 */
function hud(text) {
  sendCommand('hud', { text });
}

function publicState() {
  const aspect = ASPECT_RATIOS[state.aspectIndex] || ASPECT_RATIOS[0];
  return {
    url: state.url,
    startUrl: pathToFileURL(START_PAGE).href,
    opacity: state.opacity,
    alwaysOnTop: state.alwaysOnTop,
    clickThrough: state.clickThrough,
    mode: state.mode,
    floatingOpacity: state.floatingOpacity,
    aspectIndex: state.aspectIndex,
    aspectLabel: aspect.label,
    aspectValue: aspect.value,
    aspects: ASPECT_RATIOS.map((a) => a.label),
    sizePresets: SIZE_PRESETS,
    opacityMin: Math.round(OPACITY_MIN * 100),
    opacityMax: Math.round(OPACITY_MAX * 100),
    hideScrollbars: state.hideScrollbars,
    platform: process.platform,
  };
}

/** 把用户输入变成可加载的 URL。 */
function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (/^(https?|file|about|view-source|chrome|edge|devtools):/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(u)) {
    return 'http://' + u;
  }
  if (/^[^\s/?#]+\.[^\s/?#]+([/?#].*)?$/.test(u)) return 'https://' + u;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(u);
}

// ---------------------------------------------------------------- 网页滚动条

/** 记录各 webContents 已注入的滚动条样式 key，便于撤销。 */
const scrollbarCssKeys = new WeakMap();
/** 当前 webview 的 webContents（同一时刻只有一个）。 */
let viewContents = null;

async function setScrollbarCss(contents, on) {
  if (!contents || contents.isDestroyed()) return;
  const existing = scrollbarCssKeys.get(contents);
  try {
    if (on) {
      if (existing) return;
      const key = await contents.insertCSS(SCROLLBAR_CSS);
      scrollbarCssKeys.set(contents, key);
    } else {
      if (!existing) return;
      scrollbarCssKeys.delete(contents);
      await contents.removeInsertedCSS(existing);
    }
  } catch {
    // 导航过程中可能失败，忽略；下一次 dom-ready 会重新注入
  }
}

function setHideScrollbars(v, quiet) {
  state.hideScrollbars = !!v;
  store.set('hideScrollbars', state.hideScrollbars);
  void setScrollbarCss(viewContents, state.hideScrollbars);
  if (!quiet) {
    hud(state.hideScrollbars ? '网页滚动条：已隐藏' : '网页滚动条：已显示');
  }
  broadcast();
  refreshTray();
}

// ---------------------------------------------------------------- 各项能力

function setOpacity(v, quiet) {
  const o = clampOpacity(v);
  state.opacity = o;
  store.set('opacity', o);
  if (hasWindow()) win.setOpacity(o);
  if (!quiet) hud(`不透明度 ${Math.round(o * 100)}%`);
  broadcast();
  refreshTray();
  return o;
}

function setAlwaysOnTop(v, quiet) {
  state.alwaysOnTop = !!v;
  if (hasWindow()) win.setAlwaysOnTop(state.alwaysOnTop, 'floating');
  store.set('alwaysOnTop', state.alwaysOnTop);
  if (state.mode === 'floating') restore.alwaysOnTop = state.alwaysOnTop;
  if (!quiet) hud(state.alwaysOnTop ? '置顶：开' : '置顶：关');
  broadcast();
  refreshTray();
}

function setClickThrough(v, quiet) {
  state.clickThrough = !!v;
  if (hasWindow()) {
    if (state.clickThrough) {
      // forward:true 让窗口在穿透时仍能收到 mousemove（Windows / macOS）
      win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      win.setIgnoreMouseEvents(false);
    }
  }
  store.set('clickThrough', state.clickThrough);
  if (!quiet) {
    hud(state.clickThrough ? '鼠标穿透：开（Ctrl+Alt+M 关闭）' : '鼠标穿透：关');
  }
  broadcast();
  refreshTray();
}

/** 悬浮浏览模式：置顶 + 预设不透明度。 */
function toggleFloatingMode() {
  if (!hasWindow()) return;
  if (state.mode === 'normal') {
    // 先记下当前状态，再改；顺序不能颠倒，
    // 否则 setAlwaysOnTop 内部会认为已经处于悬浮模式而覆盖 restore。
    const prev = { opacity: state.opacity, alwaysOnTop: state.alwaysOnTop };
    setOpacity(state.floatingOpacity, true);
    setAlwaysOnTop(true, true);
    state.mode = 'floating';
    restore = prev;
    hud(`悬浮模式：开 · 不透明度 ${Math.round(state.opacity * 100)}%`);
  } else {
    state.mode = 'normal';
    setOpacity(restore.opacity, true);
    setAlwaysOnTop(restore.alwaysOnTop, true);
    hud('悬浮模式：关');
  }
  store.set('mode', state.mode);
  broadcast();
  refreshTray();
}

function setAspectIndex(index, quiet) {
  const n = ASPECT_RATIOS.length;
  const i = ((Math.trunc(Number(index) || 0) % n) + n) % n;
  state.aspectIndex = i;
  const aspect = ASPECT_RATIOS[i];
  if (hasWindow()) win.setAspectRatio(aspect.value);
  store.set('aspectIndex', i);
  if (!quiet) hud(`宽高比：${aspect.label}`);
  broadcast();
  refreshTray();
}

function resizeBy(ratio, quiet) {
  if (!hasWindow()) return;
  const b = win.getBounds();
  const width = clampSize(b.width * (1 + ratio), 'width');
  const height = clampSize(b.height * (1 + ratio), 'height');
  win.setBounds({ x: b.x, y: b.y, width, height });
  // setBounds 会绕过比例约束，重新应用一次
  win.setAspectRatio(ASPECT_RATIOS[state.aspectIndex].value);
  if (!quiet) hud(`窗口 ${width} × ${height}`);
  scheduleBoundsSave();
}

function resizeTo(value, quiet) {
  if (!hasWindow() || !value) return;
  const b = win.getBounds();
  const width = clampSize(value.width || b.width, 'width');
  const height = clampSize(value.height || b.height, 'height');
  win.setBounds({ x: b.x, y: b.y, width, height });
  win.setAspectRatio(ASPECT_RATIOS[state.aspectIndex].value);
  if (!quiet) hud(`窗口 ${width} × ${height}`);
  scheduleBoundsSave();
}

function resetAll() {
  state.mode = 'normal';
  store.set('mode', 'normal');
  setAspectIndex(0, true);
  setClickThrough(false, true);
  setAlwaysOnTop(false, true);
  setOpacity(1, true);
  setHideScrollbars(true, true);
  hud('已重置');
  broadcast();
  refreshTray();
}

function toggleVisible() {
  if (!hasWindow()) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    showWindow();
  }
}

function showWindow() {
  if (!hasWindow()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (hasWindow()) win.destroy();
  app.quit();
}

function runCommand(cmd, value) {
  switch (cmd) {
    case 'toggle-mode':
      return toggleFloatingMode();
    case 'opacity-up':
      return setOpacity(state.opacity + OPACITY_STEP);
    case 'opacity-down':
      return setOpacity(state.opacity - OPACITY_STEP);
    case 'opacity-set':
      return setOpacity(value);
    case 'size-up':
      return resizeBy(0.1);
    case 'size-down':
      return resizeBy(-0.1);
    case 'size-set':
      return resizeTo(value);
    case 'aspect-next':
      return setAspectIndex(state.aspectIndex + (Math.trunc(Number(value)) || 1));
    case 'aspect-set':
      return setAspectIndex(value);
    case 'toggle-top':
      return setAlwaysOnTop(!state.alwaysOnTop);
    case 'toggle-clickthrough':
      return setClickThrough(!state.clickThrough);
    case 'toggle-scrollbars':
      return setHideScrollbars(!state.hideScrollbars);
    case 'toggle-panel':
      return sendCommand('toggle-panel');
    case 'toggle-urlbar':
      return sendCommand('toggle-urlbar');
    case 'hide-overlay':
      return sendCommand('hide-overlay');
    case 'show-window':
      return showWindow();
    case 'hide-window':
      return hasWindow() && win.hide();
    case 'toggle-visible':
      return toggleVisible();
    case 'minimize':
      return hasWindow() && win.minimize();
    case 'reset':
      return resetAll();
    case 'reload':
      // 重载的是 webview 里的网页，而不是外壳自身
      return sendCommand('reload-view');
    case 'quit':
      return quitApp();
    default:
      console.warn('[cmd] 未知命令:', cmd);
  }
}

// ---------------------------------------------------------------- 窗口

function scheduleBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!hasWindow() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    state.bounds = win.getBounds();
    store.set('bounds', state.bounds);
  }, 400);
}

/** 屏幕分辨率变化后，把越界的记忆位置丢弃，交给系统居中。 */
function sanitizeBounds(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  const ok = screen.getAllDisplays().some((display) => {
    const a = display.workArea;
    return (
      b.x < a.x + a.width - 40 &&
      b.x + b.width > a.x + 40 &&
      b.y < a.y + a.height - 40 &&
      b.y + b.height > a.y + 20
    );
  });
  return ok ? b : null;
}

function createWindow() {
  const saved = sanitizeBounds(state.bounds) || {};

  win = new BrowserWindow({
    width: clampSize(saved.width || 1100, 'width'),
    height: clampSize(saved.height || 680, 'height'),
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: SIZE_MIN.width,
    minHeight: SIZE_MIN.height,
    // 无边框：没有标题栏 / 菜单栏 / 地址栏 / 标签栏
    frame: false,
    resizable: true,
    maximizable: true,
    // 保留 fullscreenable：设成 false 会让 requestFullscreen() 直接失败；
    // 真正的「只在窗口内全屏」靠 disableHtmlFullscreenWindowResize。
    fullscreenable: true,
    disableHtmlFullscreenWindowResize: true,
    hasShadow: true,
    show: false,
    backgroundColor: '#0f1015',
    title: 'FramelessViewer',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false,
      // 网页内的全屏（视频播放器等）只撑满本窗口，不改变窗口尺寸
      disableHtmlFullscreenWindowResize: true,
    },
  });

  // 注入式安全加固：网页永远拿不到 Node，也不允许挂 preload
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^(https?|file|about):/i.test(params.src || '')) event.preventDefault();
  });

  win.once('ready-to-show', () => {
    win.setOpacity(clampOpacity(state.opacity));
    win.setAlwaysOnTop(state.alwaysOnTop, 'floating');
    win.setAspectRatio(ASPECT_RATIOS[state.aspectIndex].value);
    if (state.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    win.show();
    broadcast();
  });

  win.on('resize', scheduleBoundsSave);
  win.on('move', scheduleBoundsSave);
  win.on('maximize', () => broadcast());
  win.on('unmaximize', () => broadcast());

  // 关闭 = 收到托盘（这样穿透状态下也能找回窗口），退出走托盘菜单
  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.loadFile(SHELL_PAGE);
}

function forwardConsole(contents, tag) {
  contents.on('console-message', (...args) => {
    let message = '';
    let level = 'log';
    const second = args[1];
    if (second && typeof second === 'object' && 'message' in second) {
      message = second.message;
      level = second.level ?? level;
    } else {
      level = args[1];
      message = args[2];
    }
    console.log(`[${tag}:${level}] ${message}`);
  });
}

// ---------------------------------------------------------------- 托盘

function makeTrayIcon() {
  const img = nativeImage.createFromPath(APP_ICON);
  if (img.isEmpty()) return nativeImage.createEmpty();
  return img.resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('FramelessViewer — 无边框浏览器');
  tray.on('click', () => toggleVisible());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const template = [
    { label: '显示 / 隐藏窗口 (Ctrl+Alt+H)', click: () => toggleVisible() },
    { type: 'separator' },
    {
      label: '悬浮模式 (Ctrl+Alt+F)',
      type: 'checkbox',
      checked: state.mode === 'floating',
      click: () => toggleFloatingMode(),
    },
    {
      label: '窗口置顶 (Ctrl+Alt+T)',
      type: 'checkbox',
      checked: state.alwaysOnTop,
      click: () => setAlwaysOnTop(!state.alwaysOnTop),
    },
    {
      label: '鼠标穿透 (Ctrl+Alt+M)',
      type: 'checkbox',
      checked: state.clickThrough,
      click: () => setClickThrough(!state.clickThrough),
    },
    {
      label: '隐藏网页滚动条',
      type: 'checkbox',
      checked: state.hideScrollbars,
      click: () => setHideScrollbars(!state.hideScrollbars),
    },
    { type: 'separator' },
    {
      label: `不透明度 ${Math.round(state.opacity * 100)}%`,
      submenu: OPACITY_PRESETS.map((p) => ({
        label: `${p}%`,
        type: 'radio',
        checked: Math.round(state.opacity * 100) === p,
        click: () => setOpacity(p / 100),
      })),
    },
    {
      label: `宽高比 ${ASPECT_RATIOS[state.aspectIndex].label}`,
      submenu: ASPECT_RATIOS.map((a, i) => ({
        label: a.label,
        type: 'radio',
        checked: state.aspectIndex === i,
        click: () => setAspectIndex(i),
      })),
    },
    {
      label: '窗口尺寸',
      submenu: SIZE_PRESETS.map((s) => ({
        label: s.label,
        click: () => resizeTo(s),
      })),
    },
    { type: 'separator' },
    {
      label: '输入网址… (Ctrl+L)',
      click: () => {
        showWindow();
        sendCommand('toggle-urlbar');
      },
    },
    { label: '重置全部', click: () => resetAll() },
    { label: '重新加载页面', click: () => sendCommand('reload-view') },
    { type: 'separator' },
    { label: '退出 (Ctrl+Alt+Q)', click: () => quitApp() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- 快捷键

/**
 * 只把「必须全局可用」的几个注册为系统级快捷键（会抢占其他软件的组合，
 * 因此能少则少）。其余快捷键仅在窗口有焦点时生效，见 IN_WINDOW_KEYS。
 */
const GLOBAL_SHORTCUTS = {
  'CommandOrControl+Alt+F': 'toggle-mode',
  'CommandOrControl+Alt+M': 'toggle-clickthrough',
  'CommandOrControl+Alt+T': 'toggle-top',
  'CommandOrControl+Alt+H': 'toggle-visible',
  'CommandOrControl+Alt+Q': 'quit',
};

function registerGlobalShortcuts() {
  for (const [accel, cmd] of Object.entries(GLOBAL_SHORTCUTS)) {
    try {
      const ok = globalShortcut.register(accel, () => runCommand(cmd));
      if (!ok) {
        console.warn(`[shortcut] 全局注册失败（可能被其他软件占用）: ${accel} → ${cmd}`);
      }
    } catch (err) {
      console.warn(`[shortcut] 全局注册异常 ${accel}: ${err.message}`);
    }
  }
}

/** 窗口有焦点时的快捷键（不抢占系统）。 */
const IN_WINDOW_KEYS = {
  // 调整窗口大小不再提供快捷键：直接拖窗口边缘即可
  arrowup: 'opacity-up',
  arrowdown: 'opacity-down',
  r: 'aspect-next',
  m: 'toggle-clickthrough',
  t: 'toggle-top',
  f: 'toggle-mode',
  p: 'toggle-panel',
  l: 'toggle-urlbar',
  h: 'toggle-visible',
  s: 'toggle-scrollbars',
  q: 'quit',
  '0': 'reset',
};

function onBeforeInput(event, input) {
  if (input.type !== 'keyDown') return;
  const key = String(input.key || '').toLowerCase();
  const mod = input.control || input.meta;

  // Esc 无修饰键，必须在 mod 判断之前处理
  if (input.key === 'Escape') {
    sendCommand('hide-overlay');
    if (state.clickThrough) setClickThrough(false);
    return;
  }

  if (!mod) return;

  // Ctrl+L：唤出网址输入条，不注册为全局，避免抢占其他软件
  if (!input.alt && !input.shift && key === 'l') {
    event.preventDefault();
    runCommand('toggle-urlbar');
    return;
  }

  if (input.alt && !input.shift) {
    const cmd = IN_WINDOW_KEYS[key];
    if (cmd) {
      event.preventDefault();
      runCommand(cmd);
    }
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:get-state', () => publicState());

  ipcMain.handle('app:run', (_event, payload) => {
    const cmd = payload && payload.cmd;
    const value = payload && payload.value;
    runCommand(cmd, value);
    return publicState();
  });

  ipcMain.handle('app:navigate', (_event, input) => {
    const url = normalizeUrl(input);
    if (url) {
      state.url = url;
      store.set('url', url);
    }
    broadcast();
    return url;
  });
}

// ---------------------------------------------------------------- 启动

function initSettings() {
  const file = path.join(app.getPath('userData'), 'settings.json');
  store = new Store(file, DEFAULT_SETTINGS);
  Object.assign(state, {
    url: store.get('url') || '',
    opacity: clampOpacity(store.get('opacity') ?? 1),
    alwaysOnTop: !!store.get('alwaysOnTop'),
    clickThrough: false, // 穿透状态不跨重启保留，避免开机点不到窗口
    aspectIndex: Math.min(
      ASPECT_RATIOS.length - 1,
      Math.max(0, Math.trunc(Number(store.get('aspectIndex')) || 0)),
    ),
    bounds: store.get('bounds') || null,
    mode: store.get('mode') === 'floating' ? 'floating' : 'normal',
    floatingOpacity: Number(store.get('floatingOpacity')) || 0.85,
    hideScrollbars: store.get('hideScrollbars') !== false,
  });

  // 命令行传 URL：npm start -- https://example.com
  const cliUrl = urlFromArgv(process.argv);
  if (cliUrl) state.url = cliUrl;
}

function urlFromArgv(argv) {
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-')) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[^\s/?#\\]+\.[^\s/?#\\]{2,}([/?#].*)?$/.test(raw)) return 'https://' + raw;
  }
  return '';
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = urlFromArgv(argv);
    if (url && hasWindow()) {
      state.url = url;
      store.set('url', url);
      broadcast();
      sendCommand('open-url', { url });
    }
    showWindow();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // 有托盘，保持常驻
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('before-input-event', onBeforeInput);

    if (IS_DEV) forwardConsole(contents, contents.getType());

    if (contents.getType() === 'webview') {
      viewContents = contents;
      contents.once('destroyed', () => {
        if (viewContents === contents) viewContents = null;
      });

      // 隐藏网页滚动条：每次导航后注入的 CSS 会失效，需要重新注入
      contents.on('dom-ready', () => {
        scrollbarCssKeys.delete(contents);
        void setScrollbarCss(contents, state.hideScrollbars);
      });

      // 网页内的全屏只在窗口内生效；万一窗口被顶成全屏，立刻还原
      contents.on('enter-html-full-screen', () => {
        if (hasWindow() && win.isFullScreen()) win.setFullScreen(false);
        sendCommand('html-fullscreen', { on: true });
      });
      contents.on('leave-html-full-screen', () => {
        sendCommand('html-fullscreen', { on: false });
      });

      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) {
          contents.loadURL(url);
        } else if (/^file:|^about:/i.test(url)) {
          contents.loadURL(url);
        } else {
          shell.openExternal(url).catch(() => {});
        }
        return { action: 'deny' };
      });

      // 只记住真实网页地址，方便下次启动恢复
      contents.on('did-navigate', (_ev, url) => {
        if (!/^https?:/i.test(url)) return;
        if (state.url === url) return;
        state.url = url;
        store.set('url', url);
      });
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.framelessviewer.app');
    initSettings();
    registerIpc();
    createWindow();
    createTray();
    registerGlobalShortcuts();
  });
}
