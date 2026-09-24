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

const { prepareWatermark, mergeWatermarks, composeWatermark, WM_INPUT_EXTS, extOf } = require('./core/watermark');
const { runBatch } = require('./core/batch');
const { TrimAppClient } = require('./fnos/trimapp');
const { createFnosRouter } = require('./fnos/routes');

const PORT = Number(process.env.PORT || 28110);
const HOST = process.env.HOST || '0.0.0.0';
const APPNAME = process.env.TRIM_APPNAME || 'imgmark';

// 数据目录：fpk 环境 TRIM_PKGVAR，本地开发用项目内 data/
const DATA_DIR = process.env.IMGMARK_DATA_DIR || process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const WM_DIR = path.join(os.tmpdir(), 'imgmark-wm');
fs.mkdirSync(WM_DIR, { recursive: true });

// ---- 配置（fpk 设置页可写 TRIM_PKGVAR/config.json）----
const DEFAULT_CFG = { outputDirName: '_watermarked', concurrency: 3, maxWatermarkSize: 1600 };
function loadConfig() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')) }; }
  catch { return { ...DEFAULT_CFG }; }
}

const fnos = new TrimAppClient();
const app = express();
const numOr = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 500 },
});

// ---- 水印与任务状态 ----
const watermarks = new Map(); // id -> {path,width,height,bgColor,notes,preview}
const jobs = new Map();       // id -> {status,total,done,ok,failed,current,results,error,outputDir,dirKind}

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
app.get('/api/config', (req, res) => res.json(loadConfig()));
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

app.post('/api/prepare', upload.array('watermark', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '未收到水印文件' });
    for (const f of files) {
      const fext = extOf(f.originalname);
      if (!WM_INPUT_EXTS.has(fext)) {
        return res.status(400).json({ error: `不支持的水印格式 ${fext || '(未知)'}：${f.originalname}，支持：AI / SVG / PNG / JPG / WebP / BMP / GIF / TIFF / AVIF` });
      }
    }
    const cropList = files.length > 1 ? parseCropArray(req.body.crop, files.length) : null;
    const base = {
      bg: ['auto', 'white', 'black'].includes(req.body.bg) ? req.body.bg : 'auto',
      tolerance: Math.max(1, Math.min(200, numOr(req.body.tolerance, 40))),
      maxSize: Math.max(200, Math.min(4000, numOr(req.body.maxSize, loadConfig().maxWatermarkSize))),
      force: req.body.force === 'true' || req.body.force === '1',
      trim: req.body.trim === 'true' || req.body.trim === '1',
      // 逐文件单独传
      crop: null,
    };
    const preparedList = [];
    for (let i = 0; i < files.length; i++) {
      const crop = files.length === 1 ? parseCropField(req.body.crop) : (cropList ? cropList[i] : null);
      preparedList.push(await prepareWatermark(files[i].buffer, files[i].originalname, { ...base, crop }));
    }
    const merged = await mergeWatermarks(preparedList, {
      gapPct: Math.max(0, Math.min(100, numOr(req.body.gap, 10))),
      equalHeight: req.body.equalHeight !== 'false' && req.body.equalHeight !== '0',
    });
    const notes = files.length > 1
      ? [...preparedList.flatMap((p, i) => p.notes.map((n) => `[${files[i].originalname}] ${n}`)), ...merged.notes]
      : preparedList[0].notes;
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
    };
    const id = crypto.randomUUID();
    savePrepared(id, prepared);
    watermarks.set(id, {
      path: path.join(WM_DIR, `${id}.png`),
      width: prepared.width, height: prepared.height,
      bgColor: prepared.bgColor, notes: prepared.notes,
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

// ---- 样式预览：把水印合成到内置示例图 ----
let sampleImage = null;
async function getSampleImage() {
  if (!sampleImage) {
    const svg = `<svg width="960" height="640" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#7f9bb3"/><stop offset="0.5" stop-color="#b8c9d9"/><stop offset="1" stop-color="#e8dfd0"/>
      </linearGradient></defs>
      <rect width="960" height="640" fill="url(#g)"/>
      <circle cx="200" cy="180" r="90" fill="#ffffff" opacity="0.25"/>
      <rect x="600" y="380" width="260" height="160" fill="#3d4f63" opacity="0.35" rx="12"/>
    </svg>`;
    sampleImage = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  }
  return sampleImage;
}

app.post('/api/preview', express.json(), async (req, res) => {
  try {
    const wm = watermarks.get(req.body.watermarkId);
    if (!wm) return res.status(404).json({ error: '水印不存在或服务已重启，请重新上传' });
    const { buffer } = await composeWatermark(await getSampleImage(), fs.readFileSync(wm.path), req.body.options || {});
    const out = await sharp(buffer).resize({ width: 520 }).jpeg({ quality: 88 }).toBuffer();
    res.json({ preview: `data:image/jpeg;base64,${out.toString('base64')}` });
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
    format: ['auto', 'png', 'jpeg', 'webp'].includes(o.format) ? o.format : 'auto',
    quality: Math.max(50, Math.min(100, numOr(o.quality, 90))),
  };
}

app.post('/api/process', upload.array('files'), express.json(), async (req, res) => {
  try {
    const payload = req.body.payload ? JSON.parse(req.body.payload) : req.body;
    const wm = watermarks.get(payload.watermarkId);
    if (!wm) return res.status(404).json({ error: '水印不存在或服务已重启，请重新上传' });
    const options = parseOptions(payload.options);
    const cfg = loadConfig();
    const overwrite = !!payload.overwrite;
    const jobId = crypto.randomUUID();
    const mode = payload.mode; // local | fnos | upload | local-files（桌面壳：本地显式文件列表）

    let inputDir, outputDir, dirKind;
    let filesArgExplicit = null; // local-files：显式文件列表（桌面壳原生对话框）
    if (mode === 'upload') {
      if (!req.files || !req.files.length) return res.status(400).json({ error: '未收到图片文件' });
      const jobTmp = path.join(os.tmpdir(), 'imgmark-jobs', jobId, 'out');
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
        const uid = Number(payload.uid || 0);
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

    const job = {
      id: jobId, status: 'running', mode, dirKind, inputDir, outputDir, overwrite,
      total: 0, done: 0, ok: 0, failed: 0, current: null, results: [], error: null,
      startedAt: Date.now(),
    };
    jobs.set(jobId, job);
    res.json({ jobId, total: null });

    const watermark = fs.readFileSync(wm.path);
    const onProgress = (p) => {
      job.total = p.total; job.done = p.done; job.current = p.current || job.current;
      if (p.ok !== undefined) {
        if (p.ok) job.ok++; else job.failed++;
        if (p.current) job.results.push({ name: path.basename(p.current), ok: p.ok, error: p.error || null });
      }
    };

    const filesArg = mode === 'upload'
      ? req.files.filter((f) => ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'].includes(extOf(f.originalname)))
          .map((f) => { // 上传的文件落盘成临时文件，统一走 fs 管线
            const tmpFile = path.join(os.tmpdir(), 'imgmark-jobs', jobId, 'in', f.originalname.replace(/[\\/]/g, '_'));
            fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
            fs.writeFileSync(tmpFile, f.buffer);
            return tmpFile;
          })
      : filesArgExplicit;

    try {
      const result = await runBatch({
        inputDir, files: filesArg, outputDir,
        watermark, options,
        recursive: !!payload.recursive,
        overwrite,
        suffix: payload.suffix || '_wm',
        concurrency: Math.max(1, Math.min(8, Number(payload.concurrency) || cfg.concurrency)),
        onProgress,
      });
      Object.assign(job, { status: 'done', total: result.total, ok: result.ok, failed: result.failed, results: result.results.map((r) => ({ name: path.basename(r.input), ok: r.ok, error: r.error || null, output: r.output })), finishedAt: Date.now() });
    } catch (e) {
      job.status = 'error'; job.error = e.message; job.finishedAt = Date.now();
    }
  } catch (e) {
    console.error('[process]', e);
    res.status(500).json({ error: e.message });
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
    dirs.sort((a, b) => a.name && a.localeCompare(b, 'zh-CN'));
    images.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    res.json({ path: dir, parent: path.dirname(dir), dirs: dirs.slice(0, 300), imageCount: images.length, images: images.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 启动 HTTP 服务（Electron 桌面壳复用：require('./server').start({port})） */
function start({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.log(`[imgmark] 监听 http://${host}:${port}  (数据目录 ${DATA_DIR})`);
      console.log(`[imgmark] fnOS 开放 API: ${fnos.isAvailable() ? '可用' : '不可用（本地模式：本地路径 / 上传图片）'}`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

if (require.main === module) {
  start().catch((e) => { console.error('[imgmark] 启动失败:', e.message); process.exit(1); });
}

module.exports = { app, start, loadConfig };
