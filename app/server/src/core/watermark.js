'use strict';
/**
 * 水印准备 + 合成引擎。
 *
 * prepareWatermark: AI/SVG/PNG/JPG/WebP… → 统一转成"去底透明 PNG"水印
 * composeWatermark: 把透明水印合成到目标图上（九宫格定位/平铺/透明度/缩放/旋转）
 */
const path = require('path');
const sharp = require('sharp');
const { removeBackground } = require('./transparency');
const { renderAiToPng } = require('../formats/ai');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif']);
const WM_INPUT_EXTS = new Set(['.ai', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif']);

const extOf = (name) => path.extname(name || '').toLowerCase();
const clampNum = (v, min, max) => Math.max(min, Math.min(max, v));

async function toSmallDataUrl(buffer, width = 512) {
  const out = await sharp(buffer).resize({ width, withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${out.toString('base64')}`;
}

/** 内容包围盒（alpha > threshold）；内容占满画布或全空时返回 null */
async function contentBBox(buffer, threshold = 8) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return null;
  const pad = 2; // 留 2px 过渡，避免把羽化边切掉
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
  return {
    left, top,
    width: Math.min(width, maxX + 1 + pad) - left,
    height: Math.min(height, maxY + 1 + pad) - top,
  };
}

/**
 * 把任意支持的水印源文件转成透明 PNG。
 * @param {Buffer} inputBuffer
 * @param {string} filename 用于判断格式
 * @param {object} opts
 *   bg:'auto'|'white'|'black'  tolerance  maxSize  force
 *   crop: {x,y,w,h} 0-100 百分比（相对栅格化后的原始画布），先裁剪再去底
 *   trim: true 自动裁掉边缘空白（按内容包围盒）
 * @returns {{buffer, width, height, sourceWidth, sourceHeight, sourcePreview, cropApplied, bgColor, removed, alreadyTransparent, notes}}
 */
async function prepareWatermark(inputBuffer, filename, opts = {}) {
  const {
    bg = 'auto', tolerance = 40, maxSize = 1600, force = false,
    crop = null, trim = false,
  } = opts;
  const ext = extOf(filename);
  const notes = [];
  let png;

  if (ext === '.ai') {
    png = await renderAiToPng(inputBuffer, { maxDim: maxSize });
    notes.push('AI 文件按 PDF 兼容模式渲染第 1 页');
  } else if (ext === '.svg') {
    // 交给 libvips(librsvg) 栅格化；density 提高避免小 viewBox 模糊
    const meta = await sharp(inputBuffer).metadata();
    const targetPx = Math.max(meta.width || 0, meta.height || 0, 0);
    const density = targetPx > 0 && targetPx < maxSize ? Math.min(2400, 72 * (maxSize / targetPx)) : 300;
    png = await sharp(inputBuffer, { density: Math.round(density) }).png().toBuffer();
    notes.push(`SVG 已栅格化（density ${Math.round(density)}）`);
  } else {
    png = inputBuffer;
  }

  // 裁剪参考系 = 栅格化后的原始画布（不受裁剪/去边/缩放影响）
  const srcMeta = await sharp(png).metadata();
  const sourceWidth = srcMeta.width, sourceHeight = srcMeta.height;
  const sourcePreview = await toSmallDataUrl(png, 512);

  let cropApplied = null;
  if (crop && [crop.x, crop.y, crop.w, crop.h].every((n) => Number.isFinite(n))) {
    const left = clampNum(Math.round(sourceWidth * crop.x / 100), 0, sourceWidth - 1);
    const top = clampNum(Math.round(sourceHeight * crop.y / 100), 0, sourceHeight - 1);
    const cWidth = clampNum(Math.round(sourceWidth * crop.w / 100), 1, sourceWidth - left);
    const cHeight = clampNum(Math.round(sourceHeight * crop.h / 100), 1, sourceHeight - top);
    if (cWidth < 4 || cHeight < 4) throw new Error('裁剪区域太小，请重新框选');
    png = await sharp(png).extract({ left, top, width: cWidth, height: cHeight }).png().toBuffer();
    cropApplied = { left, top, width: cWidth, height: cHeight, pct: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
    notes.push(`已裁剪：保留 (${left},${top}) 起 ${cWidth}×${cHeight}`);
  }

  const r = await removeBackground(png, { bg, tolerance, force });
  const notes2 = [...notes];
  if (r.alreadyTransparent) notes2.push('水印源已有透明通道，未做去底');
  else notes2.push(`已去底：识别为${r.bgColor.kind === 'white' ? '白' : '黑'}底 RGB(${r.bgColor.r},${r.bgColor.g},${r.bgColor.b})，容差 ${tolerance}`);

  let buffer = r.buffer;
  let width = r.width, height = r.height;

  if (trim) {
    const bb = await contentBBox(buffer);
    if (bb) {
      buffer = await sharp(buffer).extract(bb).png().toBuffer();
      notes2.push(`已自动裁掉边缘空白：${width}×${height} → ${bb.width}×${bb.height}`);
      width = bb.width; height = bb.height;
    } else {
      notes2.push('自动去边：内容已贴边，无需裁剪');
    }
  }

  // 限制水印尺寸，避免大 logo 拖慢批量合成
  const maxSide = Math.max(width, height);
  if (maxSide > maxSize) {
    const scale = maxSize / maxSide;
    buffer = await sharp(buffer).resize(Math.round(width * scale), Math.round(height * scale)).png({ compressionLevel: 9 }).toBuffer();
    width = Math.round(width * scale); height = Math.round(height * scale);
    notes2.push(`水印过大，已缩放到 ${width}×${height}`);
  }

  return {
    buffer, width, height,
    sourceWidth, sourceHeight, sourcePreview, cropApplied,
    bgColor: r.bgColor,
    removed: r.removed && !r.alreadyTransparent, alreadyTransparent: r.alreadyTransparent,
    notes: notes2,
  };
}

function scaledAlphaOpacity(buffer, opacity) {
  return sharp(buffer).ensureAlpha().linear([1, 1, 1, opacity / 100], [0, 0, 0, 0]).png().toBuffer();
}

/** 亮度自适应的黑白分界：区域平均亮度高于它用深色墨，低于用浅色墨 */
const LUM_THRESHOLD = 128;

/**
 * 分析水印墨色：是否纯黑白（单色）、墨色深浅，并为单色墨生成反色变体
 * （彩色 logo 不生成变体——亮度自适应仅对黑白 logo 生效）。
 */
async function analyzeInk(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const px = width * height;
  let opaque = 0, colored = 0, lumSum = 0, lumN = 0;
  for (let i = 0; i < px; i++) {
    const a = data[i * 4 + 3];
    if (a <= 32) continue;
    opaque++;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 28) colored++;
    if (a >= 200) { lumSum += 0.299 * r + 0.587 * g + 0.114 * b; lumN++; }
  }
  if (!opaque) return { monochrome: false, dark: false, inkLum: 0, altBuffer: null };
  const monochrome = colored / opaque < 0.02;
  const inkLum = lumN ? lumSum / lumN : LUM_THRESHOLD;
  const dark = inkLum < LUM_THRESHOLD;
  let altBuffer = null;
  if (monochrome) {
    const c = dark ? 255 : 0;
    const out = Buffer.from(data);
    for (let i = 0; i < px; i++) { out[i * 4] = c; out[i * 4 + 1] = c; out[i * 4 + 2] = c; }
    altBuffer = await sharp(out, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  }
  return { monochrome, dark, inkLum: Math.round(inkLum), altBuffer };
}

/** 墨迹平均亮度（只统计较实的不透明像素；缩放/透明度缩放不影响 RGB） */
async function inkLuminance(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let lumSum = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    if (a < 100) continue;
    lumSum += 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    n++;
  }
  return n ? lumSum / n : LUM_THRESHOLD;
}

/** 目标图（按 EXIF 摆正后）某区域或全图的平均亮度。
 *  注意：sharp 的 stats() 会忽略管线操作（永远算原图），必须走 raw() 自己求均值 */
async function regionLuminance(targetBuffer, region) {
  let pipe = sharp(targetBuffer).rotate();
  if (region && region.width > 4 && region.height > 4) {
    pipe = pipe.extract(region);
  } else {
    region = null;
  }
  const { data } = await pipe.resize(48, 48, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  return sum / data.length;
}

/** 九宫格 → 左上角坐标 */
function positionXY(position, W, H, wmW, wmH, margin) {
  const map = {
    nw: [margin, margin], n: [(W - wmW) / 2, margin], ne: [W - wmW - margin, margin],
    w: [margin, (H - wmH) / 2], c: [(W - wmW) / 2, (H - wmH) / 2], e: [W - wmW - margin, (H - wmH) / 2],
    sw: [margin, H - wmH - margin], s: [(W - wmW) / 2, H - wmH - margin], se: [W - wmW - margin, H - wmH - margin],
  };
  const [x, y] = map[position] || map.se;
  return [Math.round(x), Math.round(y)];
}

async function renderTileOverlay(wmBuffer, wmW, wmH, W, H, gapPx) {
  const stepX = wmW + gapPx, stepY = wmH + gapPx;
  const cols = Math.max(1, Math.ceil((W + gapPx) / stepX));
  const rows = Math.max(1, Math.ceil((H + gapPx) / stepY));
  const totalW = cols * stepX - gapPx, totalH = rows * stepY - gapPx;
  const x0 = Math.round((W - totalW) / 2), y0 = Math.round((H - totalH) / 2);
  const entries = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      entries.push({ input: wmBuffer, left: Math.round(x0 + c * stepX), top: Math.round(y0 + r * stepY) });
    }
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(entries).png().toBuffer();
}

/**
 * 合成水印到目标图。
 * @param {Buffer} targetBuffer 目标图
 * @param {Buffer} wmBuffer 透明 PNG 水印（prepareWatermark 的产物）
 * @param {object} o
 *   position: nw|n|ne|w|c|e|sw|s|se (默认 se)
 *   sizePct: 水印宽 = 目标宽 × sizePct%（默认 20）
 *   opacity: 0-100（默认 80）
 *   marginPct: 边距 = min(W,H) × marginPct%（默认 3）
 *   offsetX/offsetY: 自定义偏移（像素，叠加在 position 之后）
 *   rotate: 角度（默认 0）
 *   tile: 平铺；tileGapPct: 平铺间距 = 水印宽 × %（默认 10）
 *   format: auto|png|jpeg|webp（auto 保持原格式）
 *   quality: jpeg/webp 质量（默认 90）
 *   autoColor: 亮度自适应黑白（需第 4 参提供反色变体，否则忽略）
 * @param {Buffer} [wmAltBuffer] 反色变体（analyzeInk 生成）；autoColor 开启时按落点区域亮度二选一
 * @returns {{buffer, ext}}
 */
async function composeWatermark(targetBuffer, wmBuffer, o = {}, wmAltBuffer = null) {
  const {
    position = 'se', sizePct = 20, opacity = 80, marginPct = 3,
    offsetX = 0, offsetY = 0, rotate = 0, tile = false, tileGapPct = 10,
    format = 'auto', quality = 90,
  } = o;

  const meta = await sharp(targetBuffer).metadata();
  const oriented = meta.orientation && meta.orientation >= 5; // 5-8 需交换宽高
  const W = oriented ? meta.height : meta.width;
  const H = oriented ? meta.width : meta.height;

  // 缩放水印（反色变体与主变体走同一条缩放/旋转管线，保证尺寸一致）
  const targetW = Math.max(8, Math.round(W * sizePct / 100));
  const buildWm = async (src) => {
    let p = sharp(src).resize({ width: targetW });
    if (rotate) p = p.rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    return p.png().toBuffer();
  };
  let wmBuf = await buildWm(wmBuffer);
  const wmMeta = await sharp(wmBuf).metadata();
  let wmW = wmMeta.width; const wmH = wmMeta.height;

  const margin = Math.round(Math.min(W, H) * marginPct / 100);

  // 亮度自适应黑白：平铺按全图亮度，单点按水印落点矩形亮度，
  // 亮区域配深色墨、暗区域配浅色墨（分界 LUM_THRESHOLD）
  if (o.autoColor && Buffer.isBuffer(wmAltBuffer)) {
    let region = null;
    if (!tile) {
      const [x, y] = positionXY(position, W, H, wmW, wmH, margin);
      const left = Math.max(0, Math.min(W - 2, x + offsetX));
      const top = Math.max(0, Math.min(H - 2, y + offsetY));
      region = { left, top, width: Math.max(2, Math.min(wmW, W - left)), height: Math.max(2, Math.min(wmH, H - top)) };
    }
    const lum = await regionLuminance(targetBuffer, region);
    const [lumBase, lumAlt] = await Promise.all([inkLuminance(wmBuffer), inkLuminance(wmAltBuffer)]);
    const altBuf = await buildWm(wmAltBuffer);
    const wantDark = lum > LUM_THRESHOLD;
    const baseIsDarker = lumBase <= lumAlt;
    wmBuf = wantDark ? (baseIsDarker ? wmBuf : altBuf) : (baseIsDarker ? altBuf : wmBuf);
  }

  // 透明度
  wmBuf = await scaledAlphaOpacity(wmBuf, Math.max(1, Math.min(100, opacity)));

  const base = sharp(targetBuffer).rotate().withMetadata(); // 自动按 EXIF 摆正 + 保留 EXIF/ICC 等元数据

  let overlay;
  if (tile) {
    const gap = Math.max(0, Math.round(wmW * tileGapPct / 100));
    overlay = await renderTileOverlay(wmBuf, wmW, wmH, W, H, gap);
  } else {
    const [x, y] = positionXY(position, W, H, wmW, wmH, margin);
    overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: wmBuf, left: Math.max(0, x + offsetX), top: Math.max(0, y + offsetY) }])
      .png().toBuffer();
  }

  base.composite([{ input: overlay, left: 0, top: 0 }]);

  return encodeCompose(base, meta, { format, quality });
}

/** 合成结果编码（保持原格式/指定格式 + 质量）。composeWatermark / composeGroups 共用 */
async function encodeCompose(base, meta, { format = 'auto', quality = 90 }) {
  const fmt = format === 'auto' ? (meta.format || 'png') : format;
  let out, ext;
  switch (fmt) {
    case 'jpeg': case 'jpg': out = base.jpeg({ quality, mozjpeg: true }); ext = '.jpg'; break;
    case 'webp': out = base.webp({ quality }); ext = '.webp'; break;
    case 'avif': out = base.avif({ quality }); ext = '.avif'; break;
    case 'tiff': out = base.tiff(); ext = '.tiff'; break;
    case 'gif': out = base.gif(); ext = '.gif'; break;
    default: out = base.png({ compressionLevel: 9 }); ext = '.png';
  }
  return { buffer: await out.toBuffer(), ext };
}

/**
 * 把一个分组内的若干透明 logo 排成一个组合水印。
 * 产物只表达比例关系（ratio=1 → 高(h 排)/宽(v 排) 100px 为基准），最终大小由
 * composeGroups 按该分组的 sizePct 统一缩放。
 * @param {Array<{buffer,width,height}>} logoList
 * @param {object} o direction:'h'|'v'  gapX/gapY: 间距 = 基准高(宽) × %  ratios: 每 logo 比例
 * @returns {{buffer, width, height}}
 */
async function buildGroupWatermark(logoList, o = {}) {
  const { direction = 'h', gapX = 12, gapY = 12, ratios = null } = o;
  if (!logoList.length) throw new Error('分组内没有 logo');
  const n = logoList.length;
  const r = (Array.isArray(ratios) && ratios.length === n ? ratios : Array(n).fill(1))
    .map((x) => Math.max(0.05, Math.min(6, Number(x) || 1)));
  const BASE = 100;
  const scaled = [];
  for (let i = 0; i < n; i++) {
    const p = logoList[i];
    let w, h;
    if (direction === 'v') {
      w = Math.max(1, Math.round(BASE * r[i]));
      h = Math.max(1, Math.round(p.height * w / p.width));
    } else {
      h = Math.max(1, Math.round(BASE * r[i]));
      w = Math.max(1, Math.round(p.width * h / p.height));
    }
    scaled.push({ buf: await sharp(p.buffer).resize(w, h).png().toBuffer(), w, h });
  }
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  if (n === 1) return { buffer: scaled[0].buf, width: scaled[0].w, height: scaled[0].h };
  const entries = [];
  if (direction === 'v') {
    const W = Math.max(...scaled.map((s) => s.w));
    const gap = Math.max(0, Math.round(BASE * gapY / 100));
    let y = 0;
    for (const s of scaled) { entries.push({ input: s.buf, left: Math.round((W - s.w) / 2), top: y }); y += s.h + gap; }
    const H = y - gap;
    const buffer = await sharp({ create: { width: W, height: H, channels: 4, background: transparent } })
      .composite(entries).png().toBuffer();
    return { buffer, width: W, height: H };
  }
  const H = Math.max(...scaled.map((s) => s.h));
  const gap = Math.max(0, Math.round(BASE * gapX / 100));
  let x = 0;
  for (const s of scaled) { entries.push({ input: s.buf, left: x, top: Math.round((H - s.h) / 2) }); x += s.w + gap; }
  const W = x - gap;
  const buffer = await sharp({ create: { width: W, height: H, channels: 4, background: transparent } })
    .composite(entries).png().toBuffer();
  return { buffer, width: W, height: H };
}

/**
 * 多分组合成：一次叠加所有分组的水印并编码输出（相比多次 composeWatermark 少几次编解码）。
 * @param {Buffer} targetBuffer
 * @param {Array<{wmBuffer:Buffer, wmAltBuffer?:Buffer, options:object}>} groupDefs
 *   options: position/sizePct/marginPct/offsetX/offsetY/opacity/autoColor
 * @param {object} o format/quality（输出编码，全局）
 */
async function composeGroups(targetBuffer, groupDefs, o = {}) {
  const { format = 'auto', quality = 90 } = o;
  if (!groupDefs.length) throw new Error('没有可合成的分组');
  const meta = await sharp(targetBuffer).metadata();
  const oriented = meta.orientation && meta.orientation >= 5;
  const W = oriented ? meta.height : meta.width;
  const H = oriented ? meta.width : meta.height;
  const entries = [];
  for (const g of groupDefs) {
    const go = g.options || {};
    const targetW = Math.max(8, Math.round(W * clampNum(go.sizePct ?? 20, 2, 100) / 100));
    const buildWm = (src) => sharp(src).resize({ width: targetW }).png().toBuffer();
    let wmBuf = await buildWm(g.wmBuffer);
    const wmMeta = await sharp(wmBuf).metadata();
    const wmW = wmMeta.width, wmH = wmMeta.height;
    // 亮度自适应黑白：分组内所有 logo 都有反色变体时，整组按落点亮度二选一
    if (go.autoColor && Buffer.isBuffer(g.wmAltBuffer)) {
      const margin = Math.round(Math.min(W, H) * clampNum(go.marginPct ?? 3, 0, 30) / 100);
      const [gx, gy] = positionXY(go.position || 'se', W, H, wmW, wmH, margin);
      const left = Math.max(0, Math.min(W - 2, Math.round(gx + (go.offsetX || 0))));
      const top = Math.max(0, Math.min(H - 2, Math.round(gy + (go.offsetY || 0))));
      const region = { left, top, width: Math.max(2, Math.min(wmW, W - left)), height: Math.max(2, Math.min(wmH, H - top)) };
      const lum = await regionLuminance(targetBuffer, region);
      const [lumBase, lumAlt] = await Promise.all([inkLuminance(g.wmBuffer), inkLuminance(g.wmAltBuffer)]);
      const altBuf = await buildWm(g.wmAltBuffer);
      const wantDark = lum > LUM_THRESHOLD;
      const baseIsDarker = lumBase <= lumAlt;
      wmBuf = wantDark ? (baseIsDarker ? wmBuf : altBuf) : (baseIsDarker ? altBuf : wmBuf);
    }
    wmBuf = await scaledAlphaOpacity(wmBuf, Math.max(1, Math.min(100, go.opacity ?? 80)));
    const margin = Math.round(Math.min(W, H) * clampNum(go.marginPct ?? 3, 0, 30) / 100);
    const [x, y] = positionXY(go.position || 'se', W, H, wmW, wmH, margin);
    entries.push({
      input: wmBuf,
      left: Math.max(0, Math.round(x + (go.offsetX || 0))),
      top: Math.max(0, Math.round(y + (go.offsetY || 0))),
    });
  }
  const base = sharp(targetBuffer).rotate().withMetadata();
  base.composite(entries);
  return encodeCompose(base, meta, { format, quality });
}

/**
 * 多个已准备的水印（透明 PNG）水平拼排成一个组合水印。
 * @param {Array<{buffer,width,height,notes?}>} preparedList
 * @param {object} o gapPct: 间距 = 公共高 × %（默认 10）
 *   equalHeight: 等高对齐（默认 true）。公共高取各 logo 高度的"下中位数"——
 *   保证只缩不放的偏保守选择：2 个时较小者保持原大，其余缩小对齐。
 * @returns {{buffer, width, height, notes}}
 */
async function mergeWatermarks(preparedList, o = {}) {
  const { gapPct = 10, equalHeight = true } = o;
  if (!preparedList.length) throw new Error('没有可合并的水印');
  if (preparedList.length === 1) {
    return { buffer: preparedList[0].buffer, width: preparedList[0].width, height: preparedList[0].height, notes: [] };
  }

  const heights = preparedList.map((p) => p.height);
  const H = equalHeight
    ? [...heights].sort((a, b) => a - b)[Math.floor((heights.length - 1) / 2)]
    : Math.max(...heights);
  const gap = Math.max(0, Math.round(H * gapPct / 100));

  const entries = [];
  let x = 0;
  for (const p of preparedList) {
    let buf = p.buffer, w = p.width, h = p.height;
    if (equalHeight && h !== H) {
      w = Math.max(1, Math.round(p.width * H / p.height));
      h = H;
      buf = await sharp(p.buffer).resize(w, h).png().toBuffer();
    }
    entries.push({ input: buf, left: x, top: Math.round((H - h) / 2) });
    x += w + gap;
  }
  const totalW = x - gap;
  const buffer = await sharp({ create: { width: totalW, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(entries).png({ compressionLevel: 9 }).toBuffer();
  const notes = [`已合并 ${preparedList.length} 个 logo 并排（${equalHeight ? `等高 ${H}px，` : '保持原大小，'}间距 ${gap}px，总宽 ${totalW}px）`];
  return { buffer, width: totalW, height: H, notes };
}

module.exports = { prepareWatermark, mergeWatermarks, composeWatermark, composeGroups, buildGroupWatermark, analyzeInk, IMAGE_EXTS, WM_INPUT_EXTS, extOf };
