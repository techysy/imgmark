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
const { outPathFor } = require('./batch');

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
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify([...this.watchers.values()].map((w) => w.cfg)));
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
    const { dirWatch, scanTimer, pending, cfg, ...rest } = w;
    return { ...cfg, ...rest, pending: pending ? pending.size : 0 };
  }

  _spawn(cfg, fromRestore) {
    const w = { cfg, status: 'watching', lastError: null, note: null,
      stats: { processed: 0, skipped: 0, failed: 0 }, pending: new Set() };
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

  /** 周期扫描兜底 */
  async _scan(w) {
    if (w.status === 'paused') return;
    let names;
    try { names = await fs.promises.readdir(w.cfg.inputDir, { withFileTypes: true }); }
    catch (e) { w.lastError = `读取目录失败: ${e.message}`; return; }
    for (const ent of names) {
      const full = path.join(w.cfg.inputDir, ent.name);
      if (ent.isDirectory()) {
        if (w.cfg.recursive) await this._walk(w, full);
        continue;
      }
      await this._process(w, full);
    }
  }

  async *_walk(w, dir) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) yield* this._walk(w, full);
      else await this._process(w, full);
    }
  }

  _inOutputTree(w, full) {
    return !!w.cfg.outputDir && path.resolve(full).startsWith(path.resolve(w.cfg.outputDir));
  }

  async _process(w, full) {
    if (w.status === 'paused') return;
    if (!IMAGE_EXTS.has(extOf(full))) return;
    if (this._inOutputTree(w, full)) return;
    if (path.resolve(full) === path.resolve(w.cfg.outputDir || '')) return;

    // 查重 1：本地数据库（身份命中且输出仍在磁盘）
    const chk = await this.db.alreadyDone(full);
    if (chk.done) { w.stats.skipped++; return; }
    // 查重 2：非覆盖模式下同名输出已存在
    const targetGuess = outPathFor(full, w.cfg.inputDir, w.cfg.outputDir,
      { suffix: w.cfg.suffix, overwrite: w.cfg.overwrite, keepStructure: !!w.cfg.recursive, ext: extOf(full) });
    if (!w.cfg.overwrite) {
      try { await fs.promises.access(targetGuess); w.stats.skipped++; return; } catch { /* 不存在，继续 */ }
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
      target = outPathFor(full, w.cfg.inputDir, w.cfg.outputDir,
        { suffix: w.cfg.suffix, overwrite: w.cfg.overwrite, keepStructure: !!w.cfg.recursive, ext: composed.ext });
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, composed.buffer);
      this.db.put(chk.key, { output: target, watermarkId: w.cfg.watermarkId, watcher: w.cfg.id });
      w.stats.processed++;
    } catch (e) {
      w.stats.failed++;
      w.lastError = `${path.basename(full)}: ${e.message}`;
    }
  }

  async _resolve(w) {
    try { return await this.resolveTarget(w); } catch { return null; }
  }
}

module.exports = { WatcherManager };
