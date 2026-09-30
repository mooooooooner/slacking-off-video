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

let state = null;
/** webview 当前实际地址，用来避免广播导致重复导航 */
let currentUrl = '';
let webviewReady = false;
let pendingUrl = '';
let hudTimer = null;
let presetsBuilt = false;

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

function updateSizeLabel() {
  sizeLabel.textContent = `${window.innerWidth} × ${window.innerHeight}`;
}

// ---------------------------------------------------------------- 导航

function loadUrl(url) {
  if (!url) return;
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

  setChip('mode', next.mode === 'floating');
  setChip('top', next.alwaysOnTop);
  setChip('through', next.clickThrough);
  setChip('scrollbars', next.hideScrollbars);

  buildSizePresets(next.sizePresets);

  // 首次拿到状态时决定加载哪个页面
  if (!currentUrl && !pendingUrl) {
    loadUrl(next.url || next.startUrl);
  }
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

  const toggleName = target.dataset.toggle;
  if (toggleName) {
    const map = {
      mode: 'toggle-mode',
      top: 'toggle-top',
      through: 'toggle-clickthrough',
      scrollbars: 'toggle-scrollbars',
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

view.addEventListener('new-window', (event) => {
  event.preventDefault();
  loadUrl(event.url);
});

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
