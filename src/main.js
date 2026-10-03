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

/** 统一窗口模式：把「置顶 / 鼠标穿透 / 悬浮」合并成一个循环快捷键。 */
const MODES = [
  { value: 'normal', label: '普通', hint: '普通 · 不置顶' },
  { value: 'floating', label: '悬浮', hint: '悬浮 · 置顶 + 透明度' },
  { value: 'through', label: '穿透', hint: '穿透 · 置顶 + 鼠标穿透' },
];

function modeLabel(value) {
  const m = MODES.find((x) => x.value === value);
  return m ? m.label : MODES[0].label;
}

function modeHint(value) {
  const m = MODES.find((x) => x.value === value);
  return m ? m.hint : MODES[0].hint;
}

/** 穿透状态不跨重启保留：重启后若上次是「穿透」，降级为「悬浮」。 */
function normalizeMode(value) {
  if (value === 'through') return 'floating';
  return value === 'floating' ? 'floating' : 'normal';
}

const DEFAULT_SETTINGS = {
  url: '',
  opacity: 1,
  alwaysOnTop: false,
  clickThrough: false,
  aspectIndex: 0,
  bounds: null,
  mode: 'normal', // 'normal' | 'floating' | 'through'
  floatingOpacity: 0.85,
  hideScrollbars: true,
  startAnimation: true,
};

/**
 * 注入到网页里用来隐藏滚动条。
 * 只隐藏滚动条本身，滚轮 / 触摸板 / 键盘滚动依然可用。
 */
const SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  html, body, * { scrollbar-width: none !important; }
`;

/**
 * 关闭开屏动画时注入到起始页的样式：跳过所有动画，直接呈现最终静态画面。
 * （起始页的静态样式是 opacity: 0，靠动画出场，所以这里必须把终态补上。）
 */
const START_STATIC_CSS = `
  .aurora, .mark, .mark .ring, .mark .page, h1, .tagline, .rule, .hint, kbd {
    animation: none !important;
  }
  .mark, h1, .tagline, .hint { opacity: 1 !important; }
  .rule { width: min(320px, 62vw) !important; opacity: 0.7 !important; }
  .mark .ring, .mark .page { stroke-dashoffset: 0 !important; }
`;

// ---------------------------------------------------------------- 运行时状态

let store = null;
let win = null;
let tray = null;
let boundsTimer = null;

const state = { ...DEFAULT_SETTINGS };
/** 进入悬浮 / 穿透前普通模式的不透明度，退出时还原。 */
let restore = { opacity: 1 };

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
    modeLabel: modeLabel(state.mode),
    modes: MODES.map((m) => m.label),
    floatingOpacity: state.floatingOpacity,
    aspectIndex: state.aspectIndex,
    aspectLabel: aspect.label,
    aspectValue: aspect.value,
    aspects: ASPECT_RATIOS.map((a) => a.label),
    sizePresets: SIZE_PRESETS,
    opacityMin: Math.round(OPACITY_MIN * 100),
    opacityMax: Math.round(OPACITY_MAX * 100),
    hideScrollbars: state.hideScrollbars,
    startAnimation: state.startAnimation,
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

// ---------------------------------------------------------------- 开屏动画

/** 记录起始页已注入的「静态样式」key，便于撤销。 */
const startStaticKeys = new WeakMap();

function isStartPage(contents) {
  try {
    return contents.getURL().startsWith(pathToFileURL(START_PAGE).href);
  } catch {
    return false;
  }
}

/** 起始页按需注入「跳过动画」样式；其他网页不受影响。 */
async function applyStartAnimationCss(contents) {
  if (!contents || contents.isDestroyed()) return;
  const existing = startStaticKeys.get(contents);
  try {
    if (isStartPage(contents) && !state.startAnimation) {
      if (existing) return;
      const key = await contents.insertCSS(START_STATIC_CSS);
      startStaticKeys.set(contents, key);
    } else if (existing) {
      startStaticKeys.delete(contents);
      await contents.removeInsertedCSS(existing);
    }
  } catch {
    // 导航过程中可能失败，忽略；下一次 dom-ready 会重新处理
  }
}

function setStartAnimation(v, quiet) {
  state.startAnimation = !!v;
  store.set('startAnimation', state.startAnimation);
  void applyStartAnimationCss(viewContents);
  if (!quiet) hud(state.startAnimation ? '开屏动画：开' : '开屏动画：关');
  broadcast();
  refreshTray();
}

// ---------------------------------------------------------------- 网页缩放

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

/** 网页缩放：direction > 0 放大，< 0 缩小，0 重置。 */
function zoomView(direction, quiet) {
  if (!viewContents || viewContents.isDestroyed()) return;
  const cur = viewContents.getZoomFactor() || 1;
  let next = 1;
  if (direction > 0) next = cur * (1 + ZOOM_STEP);
  else if (direction < 0) next = cur / (1 + ZOOM_STEP);
  next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 1000) / 1000));
  viewContents.setZoomFactor(next);
  if (!quiet) hud(`网页缩放 ${Math.round(next * 100)}%`);
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
  if (!quiet) hud(state.alwaysOnTop ? '置顶：开' : '置顶：关');
  broadcast();
  refreshTray();
}

/**
 * 重新申明置顶。
 * Windows 在焦点切走（点击其他窗口、Alt+Tab、别的程序抢焦点）之后，
 * 会把置顶窗口的 topmost 降级，导致本窗口退到后面、快捷键看起来「失灵」。
 * 先取消再设置，确保 WS_EX_TOPMOST 被重新应用。
 */
function reassertAlwaysOnTop() {
  if (!hasWindow() || !state.alwaysOnTop) return;
  if (!win.isVisible() || win.isMinimized()) return;
  win.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, 'floating');
}

function setClickThrough(v, quiet) {
  const wasThrough = state.clickThrough;
  state.clickThrough = !!v;
  if (hasWindow()) {
    if (state.clickThrough) {
      // forward:true 让窗口在穿透时仍能收到 mousemove（Windows / macOS）
      win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      win.setIgnoreMouseEvents(false);
      // 从穿透切回来时把窗口抬到最前，否则它可能还压在其他窗口后面，点了像没反应。
      if (wasThrough) {
        if (state.alwaysOnTop) reassertAlwaysOnTop();
        win.moveTop();
      }
    }
  }
  store.set('clickThrough', state.clickThrough);
  if (!quiet) {
    hud(state.clickThrough ? '鼠标穿透：开（Ctrl+Alt+F 切回）' : '鼠标穿透：关');
  }
  broadcast();
  refreshTray();
}

/** 由当前窗口状态推导模式（穿透 > 悬浮 > 普通）。 */
function currentMode() {
  if (!state.alwaysOnTop) return 'normal';
  return state.clickThrough ? 'through' : 'floating';
}

/**
 * 应用统一窗口模式，把「置顶 / 鼠标穿透 / 悬浮」合并成一件事：
 * - 普通：不置顶、不穿透
 * - 悬浮：置顶 + 预设不透明度
 * - 穿透：置顶 + 预设不透明度 + 鼠标穿透
 */
function setOverlayMode(mode, quiet) {
  if (!hasWindow()) return;
  const next = MODES.some((m) => m.value === mode) ? mode : 'normal';
  const from = currentMode();
  if (next === from) {
    if (!quiet) hud(`窗口模式：${modeHint(next)}`);
    return;
  }

  // 从普通切到悬浮 / 穿透时，记下普通模式的不透明度，退出时还原
  if (from === 'normal') restore.opacity = state.opacity;

  state.mode = next;
  store.set('mode', next);

  setAlwaysOnTop(next !== 'normal', true);
  setClickThrough(next === 'through', true);

  if (next === 'normal') {
    setOpacity(restore.opacity, true);
  } else if (from === 'normal') {
    setOpacity(state.floatingOpacity, true);
  }

  if (!quiet) hud(`窗口模式：${modeHint(next)}`);
  broadcast();
  refreshTray();
}

/** 循环切换：普通 → 悬浮 → 穿透 → 普通 …（Ctrl+Alt+F）。 */
function cycleOverlayMode() {
  const order = MODES.map((m) => m.value);
  const next = order[(order.indexOf(currentMode()) + 1) % order.length];
  setOverlayMode(next);
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
  setStartAnimation(true, true);
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
  if (state.alwaysOnTop) reassertAlwaysOnTop();
  win.show();
  win.moveTop();
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
    case 'cycle-mode':
      return cycleOverlayMode();
    case 'set-mode':
      return setOverlayMode(value);
    case 'opacity-up':
      return setOpacity(state.opacity + OPACITY_STEP);
    case 'opacity-down':
      return setOpacity(state.opacity - OPACITY_STEP);
    case 'opacity-set':
      return setOpacity(value);
    case 'zoom-in':
      return zoomView(1);
    case 'zoom-out':
      return zoomView(-1);
    case 'zoom-reset':
      return zoomView(0);
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
    case 'toggle-scrollbars':
      return setHideScrollbars(!state.hideScrollbars);
    case 'toggle-start-animation':
      return setStartAnimation(!state.startAnimation);
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

  // 点击其他窗口 / Alt+Tab 会让本窗口失焦，Windows 可能顺手丢掉 topmost。
  // 只要还开着置顶，就重新抬一次，保证它始终浮在最前。
  win.on('blur', () => {
    if (!state.alwaysOnTop) return;
    setTimeout(reassertAlwaysOnTop, 80);
  });

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
      label: `窗口模式：${modeLabel(currentMode())} (Ctrl+Alt+F)`,
      submenu: MODES.map((m) => ({
        label: m.label,
        type: 'radio',
        checked: currentMode() === m.value,
        click: () => setOverlayMode(m.value),
      })),
    },
    {
      label: '隐藏网页滚动条',
      type: 'checkbox',
      checked: state.hideScrollbars,
      click: () => setHideScrollbars(!state.hideScrollbars),
    },
    {
      label: '开屏动画',
      type: 'checkbox',
      checked: state.startAnimation,
      click: () => setStartAnimation(!state.startAnimation),
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
// 置顶 / 穿透 / 悬浮已合并为一个统一的「窗口模式」循环键（Ctrl+Alt+F），
// 因此不再单独注册 Ctrl+Alt+T / Ctrl+Alt+M。
const GLOBAL_SHORTCUTS = {
  'CommandOrControl+Alt+F': 'cycle-mode',
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
  // 置顶 / 穿透 / 悬浮已合并：f 循环切换窗口模式
  arrowup: 'opacity-up',
  arrowdown: 'opacity-down',
  r: 'aspect-next',
  f: 'cycle-mode',
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
    // 穿透 / 悬浮时按 Esc：退出穿透，回到可交互的「悬浮」；确认没有残留
    if (state.mode !== 'normal') setOverlayMode('floating', true);
    return;
  }

  if (!mod) return;

  // Ctrl+L：唤出网址输入条，不注册为全局，避免抢占其他软件
  if (!input.alt && !input.shift && key === 'l') {
    event.preventDefault();
    runCommand('toggle-urlbar');
    return;
  }

  // 网页缩放：Ctrl + = / +（含小键盘 +）放大，Ctrl + - 缩小，Ctrl + 0 重置
  if (!input.alt) {
    if (key === '=' || key === '+' || key === 'add') {
      event.preventDefault();
      zoomView(1);
      return;
    }
    if (key === '-' || key === '_' || key === 'subtract') {
      event.preventDefault();
      zoomView(-1);
      return;
    }
    if (key === '0') {
      event.preventDefault();
      zoomView(0);
      return;
    }
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

  const floatingOpacity = Number(store.get('floatingOpacity')) || DEFAULT_SETTINGS.floatingOpacity;
  // 统一模式决定置顶与透明度；穿透状态不跨重启保留，避免开机点不到窗口
  const mode = normalizeMode(store.get('mode'));

  Object.assign(state, {
    url: store.get('url') || '',
    mode,
    alwaysOnTop: mode !== 'normal',
    clickThrough: false,
    opacity: mode !== 'normal' ? floatingOpacity : clampOpacity(store.get('opacity') ?? 1),
    aspectIndex: Math.min(
      ASPECT_RATIOS.length - 1,
      Math.max(0, Math.trunc(Number(store.get('aspectIndex')) || 0)),
    ),
    bounds: store.get('bounds') || null,
    floatingOpacity,
    hideScrollbars: store.get('hideScrollbars') !== false,
    startAnimation: store.get('startAnimation') !== false,
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

      // 隐藏网页滚动条 / 关闭开屏动画：每次导航后注入的 CSS 都会失效，需要重新注入
      contents.on('dom-ready', () => {
        scrollbarCssKeys.delete(contents);
        void setScrollbarCss(contents, state.hideScrollbars);
        startStaticKeys.delete(contents);
        void applyStartAnimationCss(contents);
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
        if (/^(https?|file|about):/i.test(url)) {
          // 在同一个 webview 内打开，不新建窗口。
          // 必须延后到 handler 返回之后再导航，否则会被紧随其后的
          // { action: 'deny' } 取消（表现为点 target="_blank" / window.open 毫无反应）。
          setImmediate(() => {
            if (!contents.isDestroyed()) contents.loadURL(url).catch(() => {});
          });
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
    // 去掉默认应用菜单：既符合「无边框、无菜单栏」的定位，
    // 也避免它自带的缩放加速键与我们的 Ctrl + = / Ctrl + 0 处理重复触发。
    Menu.setApplicationMenu(null);
    initSettings();
    registerIpc();
    createWindow();
    createTray();
    registerGlobalShortcuts();
  });
}
