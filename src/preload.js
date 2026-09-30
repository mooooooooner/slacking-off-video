'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const stateListeners = new Set();
const commandListeners = new Set();

ipcRenderer.on('app:state', (_event, payload) => {
  for (const fn of stateListeners) {
    try {
      fn(payload);
    } catch (err) {
      console.error('[preload] state listener error', err);
    }
  }
});

ipcRenderer.on('app:command', (_event, payload) => {
  for (const fn of commandListeners) {
    try {
      fn(payload);
    } catch (err) {
      console.error('[preload] command listener error', err);
    }
  }
});

/**
 * 暴露给渲染进程的最小 API。渲染进程只能通过这里与主进程通信，
 * 拿不到 Node、fs 或任意 ipcRenderer。
 */
contextBridge.exposeInMainWorld('frameless', {
  /** 拉取当前完整状态 */
  getState: () => ipcRenderer.invoke('app:get-state'),
  /** 执行一条命令，value 视命令而定 */
  run: (cmd, value) => ipcRenderer.invoke('app:run', { cmd, value }),
  /** 规范化并记录一个网址，返回最终 URL */
  navigate: (input) => ipcRenderer.invoke('app:navigate', input),
  /** 退出程序 */
  quit: () => ipcRenderer.invoke('app:run', { cmd: 'quit' }),
  /** 订阅状态变化，返回取消订阅函数 */
  onState: (cb) => {
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  },
  /** 订阅主进程下发的命令（hud / 面板开关等） */
  onCommand: (cb) => {
    commandListeners.add(cb);
    return () => commandListeners.delete(cb);
  },
});
