'use strict';
/**
 * 本地处理数据库：记录「输入文件身份 → 水印输出路径」映射，用于校验一张图
 * 是否已经输出过带水印的结果（跳过重复处理）。
 *
 * - 身份 = 绝对路径 + mtime(秒) + size：同一文件改动（重新保存/重拍）即视为新任务，
 *   无需读内容哈希即可廉价判重
 * - 校验时同时确认输出文件仍在磁盘上：输出被删则视为未处理
 * - JSON 存储（DATA_DIR/process-db.json），写入 800ms 防抖合并；原子写（tmp + rename），
 *   进程退出时同步刷盘，避免崩溃/断电写出半截 JSON 导致整库丢失
 */
const fs = require('fs');
const path = require('path');

/** 先写临时文件再 rename：rename 在同一文件系统上是原子的，读方永远看不到半截文件 */
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class ProcessDB {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.map.set(k, v);
    } catch { /* 首次或损坏时从空开始 */ }
    this._timer = null;
    // 'exit' 回调只能做同步操作，flushNow 恰好是同步的
    process.on('exit', () => { if (this._timer) this.flushNow(); });
  }

  static keyFor(file, stat) {
    return `${path.resolve(file)}|${Math.round(stat.mtimeMs)}|${stat.size}`;
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

  /** 某个输出文件是由哪个输入文件生成的（返回输入路径，查不到返回 null）。线性扫描，只在输出重名时调用 */
  ownerOf(output) {
    const o = path.resolve(output);
    for (const [key, rec] of this.map) {
      if (rec.output && path.resolve(rec.output) === o) return key.slice(0, key.lastIndexOf('|', key.lastIndexOf('|') - 1));
    }
    return null;
  }

  /**
   * 清理永远不会再命中的记录：输入文件已删除/已改动（身份变了，旧 key 成了孤儿），或输出已被删除。
   * 不清理的话库只增不减，而每次落盘都是整库重写。
   * @returns {Promise<number>} 删除的记录数
   */
  async compact({ batch = 64 } = {}) {
    const keys = [...this.map.keys()];
    let removed = 0;
    const alive = async (key) => {
      // key = 路径|mtime|size；路径本身可能含 "|"（Linux），从右往左拆
      const j = key.lastIndexOf('|'), i = key.lastIndexOf('|', j - 1);
      if (i < 0) return false;
      const file = key.slice(0, i), mtime = Number(key.slice(i + 1, j)), size = Number(key.slice(j + 1));
      const rec = this.map.get(key);
      if (!rec || !rec.output) return false;
      try {
        const st = await fs.promises.stat(file);
        if (Math.round(st.mtimeMs) !== mtime || st.size !== size) return false;
        await fs.promises.access(rec.output);
        return true;
      } catch { return false; }
    };
    for (let k = 0; k < keys.length; k += batch) {
      const slice = keys.slice(k, k + batch);
      const before = slice.map((key) => this.map.get(key));
      const flags = await Promise.all(slice.map(alive));
      slice.forEach((key, n) => {
        // 检查期间被重新 put 的记录（对象已换）保留，避免误删刚写入的结果
        if (!flags[n] && this.map.get(key) === before[n] && this.map.delete(key)) removed++;
      });
    }
    if (removed) this._schedule();
    return removed;
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flushNow(), 800);
  }

  flushNow() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.map)));
    } catch (e) { console.error('[db] flush 失败:', e.message); }
  }
}

module.exports = { ProcessDB, writeFileAtomic };
