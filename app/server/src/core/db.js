'use strict';
/**
 * 本地处理数据库：记录「输入文件身份 → 水印输出路径」映射，用于校验一张图
 * 是否已经输出过带水印的结果（跳过重复处理）。
 *
 * - 身份 = 绝对路径 + mtime(秒) + size：同一文件改动（重新保存/重拍）即视为新任务，
 *   无需读内容哈希即可廉价判重
 * - 校验时同时确认输出文件仍在磁盘上：输出被删则视为未处理
 * - JSON 存储（DATA_DIR/process-db.json），写入 800ms 防抖合并
 */
const fs = require('fs');
const path = require('path');

class ProcessDB {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.map.set(k, v);
    } catch { /* 首次或损坏时从空开始 */ }
    this._timer = null;
  }

  static keyFor(file, stat) {
    return `${file}|${Math.round(stat.mtimeMs)}|${stat.size}`;
  }

  /** 输入文件是否已输出过水印（输出仍存在才算）；返回 { done, key, record? } */
  async alreadyDone(inputPath) {
    let stat;
    try { stat = await fs.promises.stat(inputPath); } catch { return { done: false, key: null }; }
    const key = ProcessDB.keyFor(inputPath, stat);
    const rec = this.map.get(key);
    if (!rec || !rec.output) return { done: false, key };
    try { await fs.promises.access(rec.output); return { done: true, key, record: rec }; }
    catch { return { done: false, key }; }
  }

  put(key, record) {
    if (!key) return;
    this.map.set(key, { ...record, at: Date.now() });
    this._schedule();
  }

  get size() { return this.map.size; }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flushNow(), 800);
  }

  flushNow() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)));
    } catch (e) { console.error('[db] flush 失败:', e.message); }
  }
}

module.exports = { ProcessDB };
