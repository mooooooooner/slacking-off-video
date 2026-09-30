'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 极简 JSON 持久化存储。
 * 读写失败时静默降级到内存，不影响主流程。
 */
class Store {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = { ...defaults };
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ...this.defaults, ...parsed };
      }
    } catch {
      /* 文件不存在或损坏 -> 用默认值 */
    }
    return { ...this.defaults };
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._write();
    return value;
  }

  setAll(obj) {
    Object.assign(this.data, obj);
    this._write();
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] 写入失败:', err.message);
    }
  }
}

module.exports = Store;
