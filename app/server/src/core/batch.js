'use strict';
/**
 * 文件夹批量水印引擎：并发池 + 逐文件进度回调。
 * 输入来源无关（本地 fs 已由上层保证可读：本地路径或 fnOS 授权目录）。
 */
const fs = require('fs');
const path = require('path');
const { composeWatermark, composeGroups, IMAGE_EXTS, extOf } = require('./watermark');
const { ProcessDB } = require('./db');

/** skipProcessed 的输出存在性预判（format=auto 时按源扩展名，jpeg 归一为 .jpg） */
function expectedExt(file, options) {
  const fmt = (options && options.format) || 'auto';
  if (fmt === 'auto') {
    const e = extOf(file);
    return e === '.jpeg' ? '.jpg' : (e || '.png');
  }
  return '.' + (fmt === 'jpeg' ? 'jpg' : fmt);
}

async function listImages(dir, { recursive, skipDirs, out = [] }) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (e) { throw new Error(`无法读取目录 ${dir}: ${e.message}`); }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.has(path.resolve(full))) continue;
      if (recursive) await listImages(full, { recursive, skipDirs, out });
    } else if (IMAGE_EXTS.has(extOf(ent.name))) {
      out.push(full);
    }
  }
  return out;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  });
  await Promise.all(runners);
  return results;
}

function outPathFor(file, inputDir, outputDir, { suffix, overwrite, keepStructure, ext }) {
  if (overwrite) return file;
  const rel = keepStructure ? path.relative(inputDir, file) : path.basename(file);
  const dir = path.dirname(path.join(outputDir, rel));
  const base = path.basename(path.join(outputDir, rel), extOf(path.join(outputDir, rel)));
  return path.join(dir, `${base}${suffix}${ext}`);
}

/**
 * @param {object} p
 *   inputDir 输入目录（fnOS 授权目录 / 本地目录）
 *   files    显式文件列表（给了就忽略 inputDir 扫描）
 *   outputDir 输出目录（overwrite 时可省）
 *   watermark 透明 PNG Buffer
 *   watermarkAlt 反色变体 Buffer（可选；options.autoColor 开启时逐图按亮度选用）
 *   groups   分组模式 groupDefs（给了就忽略 watermark，走 composeGroups）
 *   db       ProcessDB 实例（配合 skipProcessed 做已输出校验）
 *   skipProcessed 跳过已输出过水印的文件（本地数据库 + 输出已存在双重校验；overwrite 时无效）
 *   options  composeWatermark 选项
 *   recursive, overwrite, suffix='_wm', concurrency=3
 *   onProgress({done,total,current,ok,error})
 */
async function runBatch(p) {
  const {
    inputDir, files = null, outputDir, watermark, watermarkAlt = null, groups = null, options = {},
    db = null, skipProcessed = false, watermarkId = null,
    recursive = false, overwrite = false, suffix = '_wm', concurrency = 3,
    onProgress = () => {},
  } = p;

  let list = files;
  if (!list) {
    const skipDirs = new Set([outputDir && path.resolve(outputDir)].filter(Boolean));
    list = await listImages(inputDir, { recursive, skipDirs });
  }
  list = [...list].sort();

  if (!overwrite) {
    if (!outputDir) throw new Error('缺少输出目录');
    await fs.promises.mkdir(outputDir, { recursive: true });
  }

  // 本地数据库去重：身份命中（路径+mtime+size 且输出仍在）或输出文件已存在 → 跳过
  let skipped = [];
  if (db && skipProcessed && !overwrite) {
    const keep = [];
    for (const f of list) {
      const chk = await db.alreadyDone(f);
      let done = chk.done;
      if (!done) {
        try {
          const guess = outPathFor(f, inputDir, outputDir,
            { suffix, overwrite, keepStructure: recursive && !!inputDir, ext: expectedExt(f, options) });
          await fs.promises.access(guess);
          done = true;
        } catch { /* 输出不存在，需要处理 */ }
      }
      if (done) skipped.push({ input: f, output: chk.record ? chk.record.output : undefined });
      else keep.push(f);
    }
    list = keep;
  }

  // 上传模式没有 inputDir（文件是平铺临时文件），保持目录结构仅在扫描目录时生效
  const keepStructure = recursive && !overwrite && !!inputDir;
  // 覆盖原图时强制保持原格式，避免"覆盖 a.jpg 却写入 PNG 数据"的错配
  const composeOptions = overwrite && options.format && options.format !== 'auto'
    ? { ...options, format: 'auto' } : options;
  const results = [];
  let done = 0, okCount = 0, failCount = 0;
  onProgress({ done: 0, total: list.length, current: null });

  // 逐文件实时回调进度（此前在全部完成后才统一触发，进度条会停在 0% 直到瞬间跳完）
  const settled = await mapPool(list, concurrency, async (file) => {
    let inputStat = null;
    try {
      inputStat = await fs.promises.stat(file);
      const buf = await fs.promises.readFile(file);
      const { buffer, ext } = groups
        ? await composeGroups(buf, groups, composeOptions)
        : await composeWatermark(buf, watermark, composeOptions, watermarkAlt);
      const target = outPathFor(file, inputDir, outputDir,
        { suffix, overwrite, keepStructure: recursive && !!inputDir, ext });
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, buffer);
      if (db) db.put(ProcessDB.keyFor(file, inputStat), { output: target, watermarkId: watermarkId || null });
      done++;
      onProgress({ done, total: list.length, current: file, ok: true, error: null });
      return { file, target };
    } catch (e) {
      done++;
      onProgress({ done, total: list.length, current: file, ok: false, error: e.message });
      throw e; // mapPool 统一记为失败，避免双重包装
    }
  });

  for (let i = 0; i < list.length; i++) {
    const s = settled[i];
    if (s.ok) { okCount++; results.push({ input: list[i], output: s.value.target, ok: true }); }
    else { failCount++; results.push({ input: list[i], ok: false, error: s.error.message }); }
  }

  return { total: list.length, ok: okCount, failed: failCount, skipped, results };
}

module.exports = { runBatch, listImages, outPathFor };
