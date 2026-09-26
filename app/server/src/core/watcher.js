'use strict';
/**
 * 文件夹监听：目录里新图片落盘 → 查重（本地数据库 / 输出已存在）→ 自动合成水印。
 *
 * - fs.watch 快速触发（Windows/macOS 支持递归；Linux 仅顶层）+ 周期扫描兜底，两条路都进
 *   同一处理管线，漏事件也不会漏处理
 * - 防回环：输出目录内的文件不处理（输出=输入目录时也不会自己水印自己）
 * - 防半写：事件先入 1.5s 防抖队列，处理前再确认 mtime 已稳定 >2s
 * - 配置持久化（watchers.json）：服务重启自动重挂；水印映射在内存里、重启后失效，
 *   此时监听转 paused 并提示重新创建
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IMAGE_EXTS, extOf, composeWatermark, composeGroups } = require('./watermark');
const { outPathFor, expectedExt, isInside, pathKey } = require('./batch');
const { writeFileAtomic } = require('./db');

const exists = (p) => fs.promises.access(p).then(() => true, () => false);

class WatcherManager {
  /**
   * @param {object} o
   *   db: ProcessDB 实例
   *   resolveTarget: async (cfg) => { watermark, watermarkAlt?, options } | { groups, options } | null
   *     由服务端注入：按 cfg.watermarkId/cfg.groups 解析出可合成的 buffer（重启后解析不到返回 null）
   *   stateFile: watchers.json 路径（持久化）
   */
  constructor({ db, resolveTarget, stateFile }) {
    this.db = db;
    this.resolveTarget = resolveTarget;
    this.stateFile = stateFile;
    this.watchers = new Map(); // id -> watcher 运行时
    this._load();
  }

  _load() {
    try {
      for (const cfg of JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))) this._spawn(cfg, true);
      if (this.watchers.size) console.log(`[watcher] 恢复 ${this.watchers.size} 个监听`);
    } catch { /* 首次无文件 */ }
  }

  _save() {
    try {
      writeFileAtomic(this.stateFile, JSON.stringify([...this.watchers.values()].map((w) => w.cfg)));
    } catch (e) { console.error('[watcher] 持久化失败:', e.message); }
  }

  create(cfg) {
    cfg = {
      recursive: false, overwrite: false, suffix: '_wm',
      scanIntervalMs: 30000, createdAt: Date.now(), ...cfg,
    };
    cfg.id = cfg.id || crypto.randomUUID();
    this._spawn(cfg, false);
    this._save();
    return this.status(cfg.id);
  }

  remove(id) {
    const w = this.watchers.get(id);
    if (!w) return false;
    w.stopped = true; // 已排队的防抖/重试定时器到点后直接放弃
    if (w.dirWatch) { try { w.dirWatch.close(); } catch {} }
    clearInterval(w.scanTimer);
    this.watchers.delete(id);
    this._save();
    return true;
  }

  rescan(id) {
    const w = this.watchers.get(id);
    if (!w) return false;
    this._scan(w);
    return true;
  }

  list() { return [...this.watchers.values()].map((w) => this._view(w)); }
  status(id) { const w = this.watchers.get(id); return w ? this._view(w) : null; }
  _view(w) {
    const { dirWatch, scanTimer, pending, inflight, target, scanning, stopped, cfg, ...rest } = w;
    return { ...cfg, ...rest, pending: pending ? pending.size : 0 };
  }

  _spawn(cfg, fromRestore) {
    const w = { cfg, status: 'watching', lastError: null, note: null,
      stats: { processed: 0, skipped: 0, failed: 0 },
      pending: new Set(),  // 防抖队列中的路径
      inflight: new Set(), // 正在处理的路径（事件/扫描/重试三路并发时防重复处理）
      target: null,        // 解析好的水印（配置不可变，首次解析后缓存，避免每张图重建分组水印）
      scanning: false, stopped: false };
    try {
      const recursive = !!cfg.recursive && process.platform !== 'linux';
      w.dirWatch = fs.watch(cfg.inputDir, { recursive }, (ev, fname) => {
        if (fname) this._queue(w, path.join(cfg.inputDir, fname));
      });
      if (cfg.recursive && process.platform === 'linux') w.note = 'Linux 不支持递归 fs.watch，仅监听顶层目录（周期扫描兜底）';
    } catch (e) {
      w.dirWatch = null;
      w.note = `fs.watch 不可用（${e.message}），仅周期扫描`;
    }
    w.scanTimer = setInterval(() => this._scan(w), cfg.scanIntervalMs);
    if (fromRestore) {
      this._resolve(w).then((t) => {
        if (!t) { w.status = 'paused'; w.lastError = '服务重启后水印已失效，请重新创建监听'; }
      });
    }
    this.watchers.set(cfg.id, w);
    setImmediate(() => this._scan(w));
  }

  /** 事件入口：入防抖队列 */
  _queue(w, full) {
    if (!IMAGE_EXTS.has(extOf(full))) return;
    if (this._inOutputTree(w, full)) return;
    if (w.pending.has(full)) return;
    w.pending.add(full);
    setTimeout(async () => {
      w.pending.delete(full);
      await this._process(w, full);
    }, 1500);
  }

  /** 周期扫描兜底（上一轮没扫完时跳过本轮，避免大目录扫描叠加） */
  async _scan(w) {
    if (w.status === 'paused' || w.stopped || w.scanning) return;
    w.scanning = true;
    try {
      await fs.promises.access(w.cfg.inputDir);
      await this._walk(w, w.cfg.inputDir, !!w.cfg.recursive);
    } catch (e) {
      w.lastError = `读取目录失败: ${e.message}`;
    } finally {
      w.scanning = false;
    }
  }

  async _walk(w, dir, recursive) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (w.stopped) return;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive && !this._inOutputTree(w, full)) await this._walk(w, full, true);
      } else {
        await this._process(w, full);
      }
    }
  }

  _inOutputTree(w, full) {
    return !!w.cfg.outputDir && isInside(full, w.cfg.outputDir);
  }

  async _process(w, full) {
    if (w.status === 'paused' || w.stopped) return;
    if (!IMAGE_EXTS.has(extOf(full))) return;
    if (this._inOutputTree(w, full)) return;
    if (w.inflight.has(full)) return;
    w.inflight.add(full);
    try { await this._processOne(w, full); }
    finally { w.inflight.delete(full); }
  }

  async _processOne(w, full) {
    // 查重 1：本地数据库（身份命中且输出仍在磁盘）
    const chk = await this.db.alreadyDone(full);
    if (chk.done) { w.stats.skipped++; return; }
    // 查重 2：非覆盖模式下同名输出已存在
    //   已存在的输出若是别的源文件生成的（a.jpg / a.png 强制同格式时重名），不算已处理，后面换带序号的名字
    if (!w.cfg.overwrite) {
      const guess = this._outPath(w, full, expectedExt(full, w.cfg.options));
      if (await exists(guess)) {
        const owner = this.db.ownerOf(guess);
        if (!owner || pathKey(owner) === pathKey(full)) { w.stats.skipped++; return; }
      }
    }
    // 防半写：mtime 距今 <2s 说明可能还在写，稍后重查
    let stat;
    try { stat = await fs.promises.stat(full); } catch { return; }
    if (Date.now() - stat.mtimeMs < 2000) {
      setTimeout(() => this._process(w, full), 2500);
      return;
    }

    let target;
    try {
      const t = await this._resolve(w);
      if (!t) { w.status = 'paused'; w.lastError = '水印已失效（服务重启后未恢复），请重新创建监听'; return; }
      const buf = await fs.promises.readFile(full);
      const composed = t.groups
        ? await composeGroups(buf, t.groups, t.options)
        : await composeWatermark(buf, t.watermark, t.options, t.watermarkAlt);
      target = w.cfg.overwrite ? full : await this._freeTarget(w, full, composed.ext);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, composed.buffer);
      this.db.put(chk.key, { output: target, watermarkId: w.cfg.watermarkId, watcher: w.cfg.id });
      w.stats.processed++;
    } catch (e) {
      w.stats.failed++;
      w.lastError = `${path.basename(full)}: ${e.message}`;
    }
  }

  _outPath(w, full, ext, tag = '') {
    return outPathFor(full, w.cfg.inputDir, w.cfg.outputDir,
      { suffix: w.cfg.suffix, overwrite: w.cfg.overwrite, keepStructure: !!w.cfg.recursive, ext, tag });
  }

  /** 第一个"不存在或本来就属于该源文件"的输出路径：a_wm.jpg → a(2)_wm.jpg → a(3)_wm.jpg … */
  async _freeTarget(w, full, ext) {
    for (let n = 1; n < 1000; n++) {
      const t = this._outPath(w, full, ext, n === 1 ? '' : `(${n})`);
      if (!(await exists(t))) return t;
      const owner = this.db.ownerOf(t);
      if (owner && pathKey(owner) === pathKey(full)) return t;
    }
    throw new Error('同名输出过多，无法分配文件名');
  }

  async _resolve(w) {
    if (w.target) return w.target;
    try { w.target = (await this.resolveTarget(w)) || null; } catch { w.target = null; }
    return w.target;
  }
}

module.exports = { WatcherManager };
