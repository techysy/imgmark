'use strict';
/**
 * ImgMark — 批量图片水印服务
 * 依赖：sharp（图像）、pdfjs-dist + @napi-rs/canvas（AI 渲染）、express + multer（HTTP）
 * fnOS：src/fnos/trimapp.js（开放平台后端 API，Unix Socket）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { prepareWatermark, mergeWatermarks, composeWatermark, composeGroups, buildGroupWatermark, analyzeInk, IMAGE_EXTS, WM_INPUT_EXTS, extOf } = require('./core/watermark');
const { runBatch } = require('./core/batch');
const { ProcessDB } = require('./core/db');
const { WatcherManager } = require('./core/watcher');
const { TrimAppClient } = require('./fnos/trimapp');
const { createFnosRouter } = require('./fnos/routes');

const PORT = Number(process.env.PORT || 28110);
const HOST = process.env.HOST || '0.0.0.0';
const APPNAME = process.env.TRIM_APPNAME || 'imgmark';
const APP_VERSION = require('../package.json').version;

// 数据目录：fpk 环境 TRIM_PKGVAR，本地开发用项目内 data/
const DATA_DIR = process.env.IMGMARK_DATA_DIR || process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const WM_DIR = path.join(os.tmpdir(), 'imgmark-wm');
const JOBS_DIR = path.join(os.tmpdir(), 'imgmark-jobs');
const UPLOAD_DIR = path.join(os.tmpdir(), 'imgmark-uploads');
for (const d of [WM_DIR, JOBS_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

// 水印映射只在内存里，重启后旧的临时产物全是孤儿；清理 24h 前的（留余量给同机其它实例）
function sweepStale(dir, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
for (const d of [WM_DIR, JOBS_DIR, UPLOAD_DIR]) sweepStale(d, 24 * 3600 * 1000);

// ---- 配置（fpk 设置页可写 TRIM_PKGVAR/config.json）----
const DEFAULT_CFG = { outputDirName: '_watermarked', concurrency: 3, maxWatermarkSize: 1600 };
function loadConfig() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')) }; }
  catch { return { ...DEFAULT_CFG }; }
}

const fnos = new TrimAppClient();
const app = express();

// ---- 水印与任务状态 ----
const watermarks = new Map(); // id -> {path,width,height,bgColor,notes,preview}
const logoSets = new Map();   // setId -> { logos: [{key,path,altPath,name,width,height,monochrome,inkDark}] }（分组模式）
const jobs = new Map();       // id -> {status,total,done,ok,failed,current,results,error,outputDir,dirKind}
const JOB_TTL_MS = 6 * 3600 * 1000; // 结束超过该时长的任务从内存移除，上传模式的临时结果一并删除

// 本地处理数据库 + 文件夹监听（DATA_DIR 下持久化）
const db = new ProcessDB(path.join(DATA_DIR, 'process-db.json'));
// 后台清理失效记录：启动时一次 + 每天一次（不阻塞启动）
const compactDb = () => db.compact()
  .then((n) => { if (n) console.log(`[db] 清理失效记录 ${n} 条，剩余 ${db.size}`); })
  .catch((e) => console.error('[db] 清理失败:', e.message));
setTimeout(compactDb, 5000).unref();
setInterval(compactDb, 24 * 3600 * 1000).unref();
const watchers = new WatcherManager({
  db,
  stateFile: path.join(DATA_DIR, 'watchers.json'),
  resolveTarget: async (w) => {
    const options = { ...(w.cfg.options || {}) };
    if (Array.isArray(w.cfg.groups) && w.cfg.groups.length) {
      const set = logoSets.get(w.cfg.watermarkId);
      if (!set) return null;
      return { groups: await resolveGroups(set, w.cfg.groups, !!options.autoColor), options };
    }
    const wm = watermarks.get(w.cfg.watermarkId);
    if (!wm) return null;
    const watermarkAlt = options.autoColor && wm.altPath ? fs.readFileSync(wm.altPath) : null;
    return { watermark: fs.readFileSync(wm.path), watermarkAlt, options };
  },
});
const numOr = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
// 水印源小而少，放内存；批量图片走磁盘（最多 500×100MB，放内存会撑爆进程）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 40 },
  defParamCharset: 'utf8', // 浏览器按 UTF-8 发文件名，multer 默认按 latin1 解码会让中文名乱码
});
const uploadImages = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024, files: 500 },
  defParamCharset: 'utf8',
});

function sweepJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status === 'running' || !job.finishedAt || job.finishedAt > cutoff) continue;
    jobs.delete(id);
    if (job.dirKind === 'upload') fs.rm(path.join(JOBS_DIR, id), { recursive: true, force: true }, () => {});
  }
}
setInterval(sweepJobs, 10 * 60 * 1000).unref();

const POSITIONS = new Set(['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']);
const clampNum = (v, min, max) => Math.max(min, Math.min(max, v));

function savePrepared(id, prepared) {
  const file = path.join(WM_DIR, `${id}.png`);
  fs.writeFileSync(file, prepared.buffer);
  return file;
}

async function smallPreview(buffer, width = 320) {
  const out = await sharp(buffer).resize({ width }).png().toBuffer();
  return `data:image/png;base64,${out.toString('base64')}`;
}

// ---- 基础路由 ----
app.get('/api/health', (req, res) => res.json({ ok: true, app: APPNAME, dataDir: DATA_DIR }));
app.get('/api/config', (req, res) => res.json({ ...loadConfig(), version: APP_VERSION }));
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', '@trimjs', 'web-app', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/fnos', createFnosRouter({ client: fnos, listImages: null }));

// ---- 水印准备 ----
// 裁剪参数："x,y,w,h"（百分比 0-100）或 {x,y,w,h} 对象；无效返回 null
function parseCropField(v) {
  if (!v) return null;
  let c = v;
  if (typeof c === 'string') {
    const parts = c.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    c = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  if (typeof c !== 'object') return null;
  const { x, y, w, h } = c;
  if ([x, y, w, h].some((n) => !Number.isFinite(n) || n < 0 || n > 100) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

// 多文件：每文件各自的裁剪，JSON 数组字符串 "[{x,y,w,h}|null, ...]"（无效项/ null 表示不裁）
function parseCropArray(v, count) {
  if (!v) return null;
  let arr = v;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return null; }
  }
  if (!Array.isArray(arr) || arr.length !== count) return null;
  return arr.map((c) => (c ? parseCropField(c) : null));
}

app.post('/api/prepare', upload.fields([
  { name: 'watermark', maxCount: 20 },
  { name: 'pairBlack', maxCount: 1 },
  { name: 'pairWhite', maxCount: 1 },
]), async (req, res) => {
  try {
    const groups = req.files || {};
    const wmFiles = groups.watermark || [];
    const pairBlack = (groups.pairBlack || [])[0] || null;
    const pairWhite = (groups.pairWhite || [])[0] || null;
    const pairMode = !!(pairBlack && pairWhite);
    const files = wmFiles.length ? wmFiles : [pairBlack, pairWhite].filter(Boolean);
    if (!files.length && !pairMode) return res.status(400).json({ error: '未收到水印文件' });
    for (const f of [...files, pairBlack, pairWhite].filter(Boolean)) {
      const fext = extOf(f.originalname);
      if (!WM_INPUT_EXTS.has(fext)) {
        return res.status(400).json({ error: `不支持的水印格式 ${fext || '(未知)'}：${f.originalname}，支持：AI / SVG / PNG / JPG / WebP / BMP / GIF / TIFF / AVIF` });
      }
    }
    const base = {
      bg: ['auto', 'white', 'black'].includes(req.body.bg) ? req.body.bg : 'auto',
      tolerance: Math.max(1, Math.min(200, numOr(req.body.tolerance, 40))),
      maxSize: Math.max(200, Math.min(4000, numOr(req.body.maxSize, loadConfig().maxWatermarkSize))),
      force: req.body.force === 'true' || req.body.force === '1',
      trim: req.body.trim === 'true' || req.body.trim === '1',
      // 逐文件单独传
      crop: null,
    };

    // ---- 黑白 logo 对模式：黑版为主变体、白版为反色变体 ----
    // 不做彩色墨分析：autoColor 开启时 composeWatermark 直接按落点亮度二选一
    if (pairMode) {
      const pb = await prepareWatermark(pairBlack.buffer, pairBlack.originalname, { ...base });
      const pw = await prepareWatermark(pairWhite.buffer, pairWhite.originalname, { ...base });
      const notes = [
        ...pb.notes.map((n) => `[黑] ${n}`),
        ...pw.notes.map((n) => `[白] ${n}`),
        '黑白 logo 对已就绪：开启「亮度自适应黑白」后亮图盖黑标、暗图自动换白标',
      ];
      const prepared = {
        buffer: pb.buffer, width: pb.width, height: pb.height, notes,
        sourcePreview: null, sourceWidth: null, sourceHeight: null,
        sourcePreviews: null, sourceSizes: null, cropApplied: null,
        bgColor: pb.bgColor,
        monochrome: false, pairMode: true, inkDark: true,
      };
      const id = crypto.randomUUID();
      savePrepared(id, prepared);
      const altPath = path.join(WM_DIR, `${id}.alt.png`);
      fs.writeFileSync(altPath, pw.buffer);
      watermarks.set(id, {
        path: path.join(WM_DIR, `${id}.png`), altPath,
        width: prepared.width, height: prepared.height,
        bgColor: prepared.bgColor, notes: prepared.notes,
        monochrome: false, inkDark: true, pairMode: true,
        preview: await smallPreview(prepared.buffer),
        sourcePreview: null, sourceWidth: null, sourceHeight: null,
        sourcePreviews: null, sourceSizes: null, cropApplied: null,
        logoCount: 1,
      });
      const { path: _p, preview, ...meta } = watermarks.get(id);
      return res.json({ id, preview, ...meta });
    }

    // ---- 分组模式：每个 logo 独立准备（不合并），布局由前端在 preview/process 时以 groups 传入 ----
    if (req.body.split === 'true' && wmFiles.length) {
      const cropArr = parseCropArray(req.body.crop, wmFiles.length);
      const entries = [];
      for (let i = 0; i < wmFiles.length; i++) {
        const crop = wmFiles.length === 1 ? parseCropField(req.body.crop) : (cropArr ? cropArr[i] : null);
        const p = await prepareWatermark(wmFiles[i].buffer, wmFiles[i].originalname, { ...base, crop });
        const ink = await analyzeInk(p.buffer);
        const key = crypto.randomUUID();
        const logoPath = path.join(WM_DIR, `${key}.png`);
        fs.writeFileSync(logoPath, p.buffer);
        let altPath = null;
        if (ink.monochrome && ink.altBuffer) {
          altPath = path.join(WM_DIR, `${key}.alt.png`);
          fs.writeFileSync(altPath, ink.altBuffer);
        }
        entries.push({
          key, name: wmFiles[i].originalname, path: logoPath, altPath,
          width: p.width, height: p.height,
          monochrome: ink.monochrome, inkDark: ink.dark,
          notes: p.notes, preview: await smallPreview(p.buffer),
          sourcePreview: p.sourcePreview, sourceWidth: p.sourceWidth, sourceHeight: p.sourceHeight,
          cropApplied: p.cropApplied,
        });
      }
      const setId = crypto.randomUUID();
      logoSets.set(setId, { logos: entries });
      res.json({
        id: setId, split: true, pairMode: false,
        logos: entries.map(({ path: _p2, altPath: _a2, ...rest }) => ({ ...rest, hasAlt: !!_a2 })),
      });
      return;
    }

    const cropList = files.length > 1 ? parseCropArray(req.body.crop, files.length) : null;
    const preparedList = [];
    for (let i = 0; i < files.length; i++) {
      const crop = files.length === 1 ? parseCropField(req.body.crop) : (cropList ? cropList[i] : null);
      const p = await prepareWatermark(files[i].buffer, files[i].originalname, { ...base, crop });
      p.ink = await analyzeInk(p.buffer); // 亮度自适应黑白：单色墨才生成反色变体
      preparedList.push(p);
    }
    const mergeOpts = {
      gapPct: Math.max(0, Math.min(100, numOr(req.body.gap, 10))),
      equalHeight: req.body.equalHeight !== 'false' && req.body.equalHeight !== '0',
    };
    const merged = await mergeWatermarks(preparedList, mergeOpts);
    // 全部 logo 都是纯黑白墨时，按同样参数合并出反色变体（供亮度自适应选用）
    const allMonochrome = preparedList.every((p) => p.ink.monochrome);
    let mergedAlt = null;
    if (allMonochrome) {
      const altList = preparedList.map((p) => ({ buffer: p.ink.altBuffer, width: p.width, height: p.height }));
      mergedAlt = await mergeWatermarks(altList, mergeOpts);
    }
    const notes = files.length > 1
      ? [...preparedList.flatMap((p, i) => p.notes.map((n) => `[${files[i].originalname}] ${n}`)), ...merged.notes]
      : preparedList[0].notes;
    if (allMonochrome) notes.push('已生成反色变体，可开启「亮度自适应黑白」按图片明暗自动切换');
    const multi = files.length > 1;
    const prepared = {
      buffer: merged.buffer, width: merged.width, height: merged.height, notes,
      // 单文件：单一裁剪参考系；多文件：每个 logo 各自的参考系数组（供逐个框选裁剪）
      sourcePreview: multi ? null : preparedList[0].sourcePreview,
      sourceWidth: multi ? null : preparedList[0].sourceWidth,
      sourceHeight: multi ? null : preparedList[0].sourceHeight,
      sourcePreviews: multi ? preparedList.map((p) => p.sourcePreview) : null,
      sourceSizes: multi ? preparedList.map((p) => [p.sourceWidth, p.sourceHeight]) : null,
      cropApplied: multi ? preparedList.map((p) => p.cropApplied) : preparedList[0].cropApplied,
      bgColor: preparedList[0].bgColor,
      monochrome: allMonochrome,
      inkDark: multi ? null : preparedList[0].ink.dark,
      pairMode: false,
    };
    const id = crypto.randomUUID();
    savePrepared(id, prepared);
    const altPath = allMonochrome ? path.join(WM_DIR, `${id}.alt.png`) : null;
    if (altPath) fs.writeFileSync(altPath, mergedAlt.buffer);
    watermarks.set(id, {
      path: path.join(WM_DIR, `${id}.png`),
      altPath,
      width: prepared.width, height: prepared.height,
      bgColor: prepared.bgColor, notes: prepared.notes,
      monochrome: prepared.monochrome, inkDark: prepared.inkDark,
      pairMode: prepared.pairMode,
      preview: await smallPreview(prepared.buffer),
      sourcePreview: prepared.sourcePreview,
      sourceWidth: prepared.sourceWidth, sourceHeight: prepared.sourceHeight,
      sourcePreviews: prepared.sourcePreviews,
      sourceSizes: prepared.sourceSizes,
      cropApplied: prepared.cropApplied,
      logoCount: files.length,
    });
    const { path: _p, preview, ...meta } = watermarks.get(id);
    res.json({ id, preview, ...meta });
  } catch (e) {
    console.error('[prepare]', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 分组模式：把前端 groups 配置解析成可合成的 groupDefs ----
function normGroup(g) {
  const src = g || {};
  return {
    logos: (Array.isArray(src.logos) ? src.logos : []).map((i) => Math.max(0, Math.floor(Number(i) || 0))).slice(0, 8),
    position: POSITIONS.has(src.position) ? src.position : 'se',
    sizePct: clampNum(numOr(src.sizePct, 20), 2, 100),
    marginPct: clampNum(numOr(src.marginPct, 3), 0, 30),
    direction: src.direction === 'v' ? 'v' : 'h',
    gapX: clampNum(numOr(src.gapX, 12), 0, 200),
    gapY: clampNum(numOr(src.gapY, 12), 0, 200),
    ratios: Array.isArray(src.ratios) ? src.ratios.map((r) => clampNum(numOr(r, 1), 0.05, 6)) : null,
    opacity: clampNum(numOr(src.opacity, 80), 1, 100),
    offsetX: numOr(src.offsetX, 0),
    offsetY: numOr(src.offsetY, 0),
  };
}

async function resolveGroups(set, rawGroups, autoColor) {
  const defs = [];
  for (const raw of rawGroups.slice(0, 8)) {
    const g = normGroup(raw);
    if (!g.logos.length) throw new Error('存在没有 logo 的分组');
    const picked = g.logos.map((i) => set.logos[i]).filter(Boolean);
    if (!picked.length) throw new Error('分组引用了不存在的 logo');
    const baseList = picked.map((l) => ({ buffer: fs.readFileSync(l.path), width: l.width, height: l.height }));
    const useAlt = autoColor && picked.every((l) => l.altPath);
    const altList = useAlt ? picked.map((l) => ({ buffer: fs.readFileSync(l.altPath), width: l.width, height: l.height })) : null;
    defs.push({
      wmBuffer: (await buildGroupWatermark(baseList, g)).buffer,
      wmAltBuffer: useAlt ? (await buildGroupWatermark(altList, g)).buffer : null,
      options: {
        position: g.position, sizePct: g.sizePct, marginPct: g.marginPct,
        offsetX: g.offsetX, offsetY: g.offsetY, opacity: g.opacity, autoColor,
      },
    });
  }
  return defs;
}

// ---- 样式预览：把水印合成到内置示例图（亮/暗两张，验证亮度自适应）----
const sampleImages = {};
async function getSampleImage(kind = 'light') {
  if (!sampleImages[kind]) {
    const svg = kind === 'dark'
      ? `<svg width="960" height="640" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#1c2530"/><stop offset="0.5" stop-color="#2c3a4a"/><stop offset="1" stop-color="#0f141a"/>
          </linearGradient></defs>
          <rect width="960" height="640" fill="url(#g)"/>
          <circle cx="200" cy="180" r="90" fill="#ffffff" opacity="0.08"/>
          <rect x="600" y="380" width="260" height="160" fill="#0a0e13" opacity="0.5" rx="12"/>
        </svg>`
      : `<svg width="960" height="640" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#7f9bb3"/><stop offset="0.5" stop-color="#b8c9d9"/><stop offset="1" stop-color="#e8dfd0"/>
          </linearGradient></defs>
          <rect width="960" height="640" fill="url(#g)"/>
          <circle cx="200" cy="180" r="90" fill="#ffffff" opacity="0.25"/>
          <rect x="600" y="380" width="260" height="160" fill="#3d4f63" opacity="0.35" rx="12"/>
        </svg>`;
    sampleImages[kind] = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  }
  return sampleImages[kind];
}

app.post('/api/preview', express.json(), async (req, res) => {
  try {
    const options = req.body.options || {};
    const groups = Array.isArray(req.body.groups) && req.body.groups.length ? req.body.groups : null;
    // 分组模式：多个分组一次性合成到示例图
    if (groups) {
      const set = logoSets.get(req.body.watermarkId);
      if (!set) return res.status(404).json({ error: 'logo 组不存在或服务已重启，请重新上传' });
      const auto = !!options.autoColor;
      const groupDefs = await resolveGroups(set, groups, auto);
      const toPreviewG = async (kind) => {
        const { buffer } = await composeGroups(await getSampleImage(kind), groupDefs, { sizeBase: options.sizeBase });
        const out = await sharp(buffer).resize({ width: 520 }).jpeg({ quality: 88 }).toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
      };
      const preview = await toPreviewG('light');
      const previewAuto = auto && groupDefs.some((g) => g.wmAltBuffer) ? await toPreviewG('dark') : null;
      return res.json({ preview, previewAuto });
    }
    const wm = watermarks.get(req.body.watermarkId);
    if (!wm) return res.status(404).json({ error: '水印不存在或服务已重启，请重新上传' });
    const altBuf = options.autoColor && wm.altPath ? fs.readFileSync(wm.altPath) : null;
    const toPreview = async (sample) => {
      const { buffer } = await composeWatermark(await getSampleImage(sample), fs.readFileSync(wm.path), options, altBuf);
      const out = await sharp(buffer).resize({ width: 520 }).jpeg({ quality: 88 }).toBuffer();
      return `data:image/jpeg;base64,${out.toString('base64')}`;
    };
    const preview = await toPreview('light');
    // 亮度自适应开启时附暗底预览，直观看到"暗图自动换白标"
    const previewAuto = altBuf ? await toPreview('dark') : null;
    res.json({ preview, previewAuto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 批量处理 ----
function parseOptions(raw) {
  const o = raw || {};
  return {
    position: o.position || 'se',
    sizePct: Math.max(2, Math.min(100, numOr(o.sizePct, 20))),
    opacity: Math.max(1, Math.min(100, numOr(o.opacity, 80))),
    marginPct: Math.max(0, Math.min(30, numOr(o.marginPct, 3))),
    offsetX: numOr(o.offsetX, 0),
    offsetY: numOr(o.offsetY, 0),
    rotate: ((numOr(o.rotate, 0) % 360) + 360) % 360,
    tile: !!o.tile,
    tileGapPct: Math.max(0, Math.min(200, numOr(o.tileGapPct, 10))),
    autoColor: !!o.autoColor, // 亮度自适应黑白（无反色变体时服务端自动忽略）
    sizeBase: ['long', 'short', 'width'].includes(o.sizeBase) ? o.sizeBase : 'long',
    format: ['auto', 'png', 'jpeg', 'webp'].includes(o.format) ? o.format : 'auto',
    quality: Math.max(50, Math.min(100, numOr(o.quality, 90))),
    mozjpeg: !!o.mozjpeg, // JPEG 体积优先（小 10-15%，编码慢约 5 倍）
  };
}

app.post('/api/process', uploadImages.array('files'), express.json(), async (req, res) => {
  // 请求结束后清掉 multer 的落盘文件（上传模式已 rename 走的不受影响）
  res.on('finish', () => { for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {}); });
  try {
    const payload = req.body.payload ? JSON.parse(req.body.payload) : req.body;
    const options = parseOptions(payload.options);
    const cfg = loadConfig();
    const overwrite = !!payload.overwrite;
    const jobId = crypto.randomUUID();
    const mode = payload.mode; // local | fnos | upload | local-files（桌面壳：本地显式文件列表）

    // 分组模式：watermarkId 是 logo 组 id，groups 描述布局；否则走单/合并水印
    let groupDefs = null;
    let wm = null;
    if (Array.isArray(payload.groups) && payload.groups.length) {
      const set = logoSets.get(payload.watermarkId);
      if (!set) return res.status(404).json({ error: 'logo 组不存在或服务已重启，请重新上传' });
      groupDefs = await resolveGroups(set, payload.groups, options.autoColor);
    } else {
      wm = watermarks.get(payload.watermarkId);
      if (!wm) return res.status(404).json({ error: '水印不存在或服务已重启，请重新上传' });
    }

    let inputDir, outputDir, dirKind;
    let filesArgExplicit = null; // local-files：显式文件列表（桌面壳原生对话框）
    if (mode === 'upload') {
      if (!req.files || !req.files.length) return res.status(400).json({ error: '未收到图片文件' });
      const jobTmp = path.join(JOBS_DIR, jobId, 'out');
      fs.mkdirSync(jobTmp, { recursive: true });
      dirKind = 'upload';
      inputDir = null;
      outputDir = jobTmp;
    } else if (mode === 'local-files') {
      // 桌面壳：原生文件对话框选出的绝对路径列表，不走目录扫描
      const list = Array.isArray(payload.files) ? payload.files.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
      if (!list.length) return res.status(400).json({ error: '未提供有效的文件路径' });
      for (const fp of list) {
        if (!fs.existsSync(fp)) return res.status(400).json({ error: `文件不存在：${fp}` });
      }
      inputDir = path.dirname(list[0]);
      dirKind = 'local';
      outputDir = overwrite ? null : (payload.outputDir && String(payload.outputDir).trim()) || path.join(inputDir, cfg.outputDirName);
      filesArgExplicit = list;
    } else {
      inputDir = String(payload.inputDir || '').trim();
      if (!path.isAbsolute(inputDir)) return res.status(400).json({ error: '请输入绝对路径' });
      if (mode === 'fnos') {
        if (!fnos.isAvailable()) return res.status(501).json({ error: 'fnOS 开放 API 不可用：请在 fnOS 应用环境内使用，或改用本地路径/上传模式' });
        // 网关身份头可信、payload.uid 由客户端填写不可信：有头时以头为准，防止冒用他人 uid 越权读写
        const uid = Number(req.headers['x-trim-userid'] || payload.uid || 0);
        if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'uid 无效' });
        const acl = await fnos.checkUserACL(uid, inputDir);
        const entry = Array.isArray(acl) ? acl[0] : acl;
        if (!entry || !entry.readable) return res.status(403).json({ error: '该目录未授权或当前用户不可读，请先在"飞牛目录"里选择授权' });
        if (overwrite && !entry.writable) return res.status(403).json({ error: '当前用户对该目录没有写权限，无法覆盖原图' });
        dirKind = 'fnos';
      } else {
        if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
          return res.status(400).json({ error: `目录不存在：${inputDir}` });
        }
        dirKind = 'local';
      }
      outputDir = overwrite ? null : (payload.outputDir && String(payload.outputDir).trim()) || path.join(inputDir, cfg.outputDirName);
    }
    // 相对输出目录名（UI 默认传 "_watermarked"）锚定到图片所在目录，而非服务进程 CWD
    if (mode !== 'upload' && outputDir && !path.isAbsolute(outputDir)) {
      outputDir = path.join(inputDir, outputDir);
    }

    let filesArg = filesArgExplicit;
    if (mode === 'upload') {
      // multer 已落盘到 UPLOAD_DIR，按原文件名移进任务目录，统一走 fs 管线；同名文件自动加序号防互相覆盖
      const inDir = path.join(JOBS_DIR, jobId, 'in');
      fs.mkdirSync(inDir, { recursive: true });
      const used = new Set();
      filesArg = [];
      for (const f of req.files) {
        const ext = extOf(f.originalname);
        if (!IMAGE_EXTS.has(ext)) continue;
        const stem = path.basename(f.originalname, path.extname(f.originalname)).replace(/[\\/:*?"<>|]/g, '_') || 'image';
        let name = stem + ext;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}(${n})${ext}`;
        used.add(name.toLowerCase());
        const tmpFile = path.join(inDir, name);
        fs.renameSync(f.path, tmpFile);
        filesArg.push(tmpFile);
      }
    }

    if (filesArg && !filesArg.length) {
      fs.rm(path.join(JOBS_DIR, jobId), { recursive: true, force: true }, () => {});
      return res.status(400).json({ error: '没有可处理的图片文件' });
    }

    const job = {
      id: jobId, status: 'running', mode, dirKind, inputDir, outputDir, overwrite,
      total: 0, done: 0, ok: 0, failed: 0, current: null, results: [], error: null,
      startedAt: Date.now(),
    };
    jobs.set(jobId, job);
    res.locals.jobId = jobId;
    res.json({ jobId, total: null });

    const watermark = groupDefs ? null : fs.readFileSync(wm.path);
    // 亮度自适应黑白：logo 有反色变体且开关开启时才读取（分组模式在 resolveGroups 内处理）
    const watermarkAlt = groupDefs || !wm ? null : (options.autoColor && wm.altPath ? fs.readFileSync(wm.altPath) : null);
    const onProgress = (p) => {
      job.total = p.total; job.done = p.done; job.current = p.current || job.current;
      if (p.ok !== undefined) {
        if (p.ok) job.ok++; else job.failed++;
        if (p.current) job.results.push({ name: path.basename(p.current), ok: p.ok, error: p.error || null });
      }
    };

    try {
      const result = await runBatch({
        inputDir, files: filesArg, outputDir,
        watermark, watermarkAlt, groups: groupDefs, options,
        db, skipProcessed: !!payload.skipProcessed && !overwrite, watermarkId: payload.watermarkId,
        recursive: !!payload.recursive,
        overwrite,
        suffix: payload.suffix || '_wm',
        concurrency: Math.max(1, Math.min(8, Number(payload.concurrency) || cfg.concurrency)),
        onProgress,
      });
      job.skipped = result.skipped.length;
      Object.assign(job, { status: 'done', total: result.total, ok: result.ok, failed: result.failed, results: result.results.map((r) => ({ name: path.basename(r.input), ok: r.ok, error: r.error || null, output: r.output })), finishedAt: Date.now() });
    } catch (e) {
      job.status = 'error'; job.error = e.message; job.finishedAt = Date.now();
    } finally {
      if (mode === 'upload') fs.rm(path.join(JOBS_DIR, jobId, 'in'), { recursive: true, force: true }, () => {});
    }
  } catch (e) {
    console.error('[process]', e);
    // 已回过 jobId 后再出错：记到任务上（再写响应会抛 ERR_HTTP_HEADERS_SENT，未处理的 rejection 会让进程退出）
    const job = res.headersSent && jobs.get(res.locals.jobId);
    if (job) Object.assign(job, { status: 'error', error: e.message, finishedAt: Date.now() });
    else if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

// 上传模式下逐个下载处理结果
app.get('/api/jobs/:id/file/:idx', (req, res) => {
  const job = jobs.get(req.params.id);
  const r = job && job.results[Number(req.params.idx)];
  if (!job || !r || !r.output || job.dirKind !== 'upload') return res.status(404).json({ error: '文件不存在' });
  res.download(r.output, r.name);
});

// ---- 文件夹监听（新图落盘自动加水印，本地数据库去重） ----
app.get('/api/watchers', (req, res) => res.json({ watchers: watchers.list() }));
app.post('/api/watchers', express.json(), async (req, res) => {
  try {
    const { inputDir, outputDir, recursive, suffix, watermarkId, groups, options } = req.body || {};
    if (!inputDir || !path.isAbsolute(String(inputDir))) return res.status(400).json({ error: '监听目录需为绝对路径' });
    if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) return res.status(400).json({ error: `目录不存在：${inputDir}` });
    const inDir = path.resolve(inputDir);
    // 相对输出名锚定到监听目录（同 process 端点约定，避免落到服务进程 CWD）
    let outDir = outputDir && String(outputDir).trim() ? String(outputDir).trim() : loadConfig().outputDirName;
    if (!path.isAbsolute(outDir)) outDir = path.join(inDir, outDir);
    outDir = path.resolve(outDir);
    if (outDir === inDir) return res.status(400).json({ error: '输出目录不能与监听目录相同（防止水印图再次被处理）' });
    const hasTarget = (Array.isArray(groups) && groups.length && logoSets.get(watermarkId)) || watermarks.get(watermarkId);
    if (!hasTarget) return res.status(404).json({ error: '水印不存在或服务已重启，请先在页面重新准备' });
    const cfg = {
      inputDir: inDir, outputDir: outDir,
      recursive: !!recursive, overwrite: false,
      suffix: suffix || '_wm', watermarkId,
      groups: Array.isArray(groups) ? groups : null,
      options: parseOptions(options), // 完整保留输出格式/质量/位置等（此前只存了 autoColor+sizeBase）
    };
    res.json(watchers.create(cfg));
  } catch (e) {
    console.error('[watchers]', e);
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/watchers/:id', (req, res) => res.json({ ok: watchers.remove(req.params.id) }));
app.post('/api/watchers/:id/rescan', (req, res) => res.json({ ok: watchers.rescan(req.params.id) }));
app.get('/api/db/stats', (req, res) => res.json({ records: db.size }));

// 本地模式目录浏览（辅助选路径）
app.post('/api/browse', express.json(), async (req, res) => {
  try {
    const dir = String(req.body.path || '').trim() || path.parse(process.cwd()).root;
    if (!path.isAbsolute(dir)) return res.status(400).json({ error: '请输入绝对路径' });
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const dirs = [], images = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (d.isDirectory()) dirs.push(d.name);
      else if (WM_INPUT_EXTS.has(extOf(d.name)) && extOf(d.name) !== '.ai' && extOf(d.name) !== '.svg') images.push(d.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    images.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    res.json({ path: dir, parent: path.dirname(dir), dirs: dirs.slice(0, 300), imageCount: images.length, images: images.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 启动 HTTP 服务（Electron 桌面壳复用：require('./server').start({port})）
 *  SOCKET_PATH 环境变量非空时额外监听 Unix Socket（fnOS 统一网关模式，见官方 Native 示例） */
function start({ port = PORT, host = HOST, socketPath = process.env.SOCKET_PATH || '' } = {}) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.log(`[imgmark] 监听 http://${host}:${port}  (数据目录 ${DATA_DIR})`);
      console.log(`[imgmark] fnOS 开放 API: ${fnos.isAvailable() ? '可用' : '不可用（本地模式：本地路径 / 上传图片）'}`);
      if (socketPath) {
        try { fs.rmSync(socketPath, { force: true }); } catch {}
        app.listen(socketPath, () => console.log(`[imgmark] 网关 socket: ${socketPath}`));
      }
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

if (require.main === module) {
  start().catch((e) => { console.error('[imgmark] 启动失败:', e.message); process.exit(1); });
  // fnOS stop / Ctrl+C：默认信号处理不触发 'exit'，显式 exit 让数据库在退出前刷盘
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
}

module.exports = { app, start, loadConfig };
