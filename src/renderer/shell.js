'use strict';

const api = window.frameless;

const view = document.getElementById('view');
const pill = document.getElementById('pill');
const panel = document.getElementById('panel');
const panelClose = document.getElementById('panel-close');
const opacityInput = document.getElementById('opacity');
const opacityValue = document.getElementById('opacity-value');
const aspectLabel = document.getElementById('aspect-label');
const sizeLabel = document.getElementById('size-label');
const sizePresets = document.getElementById('size-presets');
const urlbar = document.getElementById('urlbar');
const urlInput = document.getElementById('url-input');
const hud = document.getElementById('hud');
const loading = document.getElementById('loading');
const modeBadge = document.getElementById('mode-badge');

let state = null;
/** webview 当前实际地址，用来避免广播导致重复导航 */
let currentUrl = '';
let webviewReady = false;
let pendingUrl = '';
let hudTimer = null;
let presetsBuilt = false;

/** 开屏页地址，由主进程下发。 */
let startUrl = '';
/** 开屏动画进行中，以及动画结束后要进入的网页。 */
let splashActive = false;
let splashTarget = '';
let splashTimer = null;

/**
 * 每次启动都先播一段开屏动画，动画结束后再进入记忆的网页。
 * 系统开启「减少动态效果」时用静态画面，快速跳过。
 */
const PREFERS_REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPLASH_MS = PREFERS_REDUCED_MOTION ? 600 : 2600;

function isStartUrl(url) {
  return !!url && !!startUrl && url === startUrl;
}

function clearSplash() {
  clearTimeout(splashTimer);
  splashTimer = null;
  splashActive = false;
}

/** 展示开屏页；若记忆了网页，动画结束后自动进入。 */
function beginSplash(target) {
  clearSplash();
  splashTarget = target || '';
  splashActive = true;
  loadUrl(startUrl);
  if (!splashTarget) return;
  splashTimer = setTimeout(finishSplash, SPLASH_MS);
}

function finishSplash() {
  if (!splashActive) return;
  const target = splashTarget;
  clearSplash();
  // 只有仍停在开屏页时才自动进入网页，避免覆盖用户自己的导航
  if (target && isStartUrl(currentUrl)) loadUrl(target);
}

// ---------------------------------------------------------------- 基础工具

function show(el) {
  el.classList.remove('hidden');
}

function hide(el) {
  el.classList.add('hidden');
}

function toggle(el) {
  el.classList.toggle('hidden');
}

function showHud(text) {
  if (!text) return;
  hud.textContent = text;
  show(hud);
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hide(hud), 1600);
}

function setChip(name, active) {
  const el = panel.querySelector(`.chip[data-toggle="${name}"]`);
  if (el) el.classList.toggle('active', !!active);
}

function setModeChips(mode) {
  for (const btn of panel.querySelectorAll('.chip[data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

function updateSizeLabel() {
  sizeLabel.textContent = `${window.innerWidth} × ${window.innerHeight}`;
}

/** 非普通模式时常驻一个小徽标：既提示当前模式，也解释穿透时点击为何落空。 */
function updateModeBadge(mode) {
  if (!modeBadge) return;
  if (!mode || mode === 'normal') {
    hide(modeBadge);
    modeBadge.classList.remove('through');
    return;
  }
  const through = mode === 'through';
  modeBadge.classList.toggle('through', through);
  modeBadge.textContent = through
    ? '穿透中 · 点击已穿透 · 按 Ctrl+Alt+F 切回'
    : '悬浮 · 按 Ctrl+Alt+F 切换';
  show(modeBadge);
}

// ---------------------------------------------------------------- 导航

function loadUrl(url) {
  if (!url) return;
  // 用户自己导航去别处时，取消尚未结束的开屏跳转
  if (!isStartUrl(url)) clearSplash();
  currentUrl = url;
  if (!webviewReady) {
    pendingUrl = url;
    return;
  }
  try {
    const p = view.loadURL(url);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    view.src = url;
  }
}

function flushPending() {
  if (pendingUrl) {
    const url = pendingUrl;
    pendingUrl = '';
    loadUrl(url);
  }
}

// ---------------------------------------------------------------- 状态同步

function applyState(next) {
  if (!next) return;
  state = next;

  const percent = Math.round(next.opacity * 100);
  opacityInput.value = String(percent);
  opacityValue.textContent = `${percent}%`;
  aspectLabel.textContent = next.aspectLabel;

  setModeChips(next.mode);
  setChip('scrollbars', next.hideScrollbars);
  setChip('startanimation', next.startAnimation);

  buildSizePresets(next.sizePresets);

  // 记住开屏页地址
  startUrl = next.startUrl || startUrl;

  // 首次拿到状态时决定加载哪个页面：
  // 默认先播一段开屏动画，动画结束后再进入记忆的网页；关掉开屏动画则直接进入。
  if (!currentUrl && !pendingUrl) {
    if (next.startAnimation) beginSplash(next.url);
    else loadUrl(next.url || next.startUrl);
  } else if (splashActive && !next.startAnimation) {
    // 开屏途中把「开屏动画」关掉：立即进入网页
    finishSplash();
  }

  updateModeBadge(next.mode);
}

function buildSizePresets(presets) {
  if (presetsBuilt || !Array.isArray(presets) || !presets.length) return;
  presetsBuilt = true;
  sizePresets.textContent = '';
  for (const preset of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      void api.run('size-set', { width: preset.width, height: preset.height });
    });
    sizePresets.appendChild(btn);
  }
}

// ---------------------------------------------------------------- 覆盖层

function hideOverlays() {
  hide(panel);
  hide(urlbar);
  document.body.classList.remove('panel-open');
}

function togglePanel() {
  hide(urlbar);
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  document.body.classList.toggle('panel-open', willOpen);
}

function toggleUrlbar() {
  hide(panel);
  document.body.classList.remove('panel-open');
  const willOpen = urlbar.classList.contains('hidden');
  if (willOpen) {
    show(urlbar);
    urlInput.value = currentUrl && !currentUrl.startsWith('file:') ? currentUrl : '';
    urlInput.focus();
    urlInput.select();
  } else {
    hide(urlbar);
  }
}

// ---------------------------------------------------------------- 交互

pill.addEventListener('click', togglePanel);
panelClose.addEventListener('click', hideOverlays);

opacityInput.addEventListener('input', () => {
  const percent = Number(opacityInput.value);
  opacityValue.textContent = `${percent}%`;
});
opacityInput.addEventListener('change', () => {
  void api.run('opacity-set', Number(opacityInput.value) / 100);
});

panel.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  const mode = target.dataset.mode;
  if (mode) {
    void api.run('set-mode', mode);
    return;
  }

  const toggleName = target.dataset.toggle;
  if (toggleName) {
    const map = {
      scrollbars: 'toggle-scrollbars',
      startanimation: 'toggle-start-animation',
    };
    void api.run(map[toggleName]);
    return;
  }

  const run = target.dataset.run;
  if (!run) return;
  if (run === 'aspect-prev') void api.run('aspect-next', -1);
  else if (run === 'aspect-next') void api.run('aspect-next', 1);
  else void api.run(run);
});

urlInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const url = await api.navigate(urlInput.value);
    if (url) loadUrl(url);
    hide(urlbar);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    hide(urlbar);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!urlbar.classList.contains('hidden')) {
      hide(urlbar);
      // 让网络视图重新拿回键盘焦点
      view.focus();
      return;
    }
    hideOverlays();
    view.focus();
  }
});

window.addEventListener('resize', updateSizeLabel);

// ---------------------------------------------------------------- webview 事件

view.addEventListener('dom-ready', () => {
  webviewReady = true;
  console.log('[shell] webview ready:', view.getURL());
  flushPending();
});

view.addEventListener('did-start-loading', () => show(loading));
view.addEventListener('did-stop-loading', () => hide(loading));

view.addEventListener('did-navigate', (event) => {
  currentUrl = event.url;
  if (state && !event.url.startsWith('file:')) state.url = event.url;
});

view.addEventListener('did-navigate-in-page', (event) => {
  currentUrl = event.url;
});

view.addEventListener('did-fail-load', (event) => {
  if (event.errorCode === -3) return; // 用户主动取消，忽略
  showHud(`加载失败：${event.errorDescription || event.errorCode}`);
});

// 注：target="_blank" / window.open 由主进程的 setWindowOpenHandler 统一处理
// （在同一 webview 内打开），<webview> 的 new-window 事件已在 Electron 22 移除。

// ---------------------------------------------------------------- 主进程命令

if (!api) {
  hud.textContent = 'preload 未加载，无法与主进程通信';
  show(hud);
} else {
  api.onCommand((payload) => {
    if (!payload) return;
    switch (payload.type) {
      case 'hud':
        showHud(payload.text);
        break;
      case 'toggle-panel':
        togglePanel();
        break;
      case 'toggle-urlbar':
        toggleUrlbar();
        break;
      case 'hide-overlay':
        hideOverlays();
        break;
      case 'html-fullscreen':
        // 网页全屏时收起浮层，并让出顶部拖拽条，避免挡住播放器控件
        if (payload.on) hideOverlays();
        document.body.classList.toggle('page-fullscreen', !!payload.on);
        break;
      case 'open-url':
        if (payload.url) loadUrl(payload.url);
        break;
      case 'reload-view':
        try {
          view.reload();
        } catch {
          /* webview 尚未就绪，忽略 */
        }
        break;
      default:
        break;
    }
  });

  api.onState(applyState);

  updateSizeLabel();
  api.getState().then(applyState);
}
