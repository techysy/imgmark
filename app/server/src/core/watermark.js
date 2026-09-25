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
 * @returns {{buffer, ext}}
 */
async function composeWatermark(targetBuffer, wmBuffer, o = {}) {
  const {
    position = 'se', sizePct = 20, opacity = 80, marginPct = 3,
    offsetX = 0, offsetY = 0, rotate = 0, tile = false, tileGapPct = 10,
    format = 'auto', quality = 90,
  } = o;

  const meta = await sharp(targetBuffer).metadata();
  const oriented = meta.orientation && meta.orientation >= 5; // 5-8 需交换宽高
  const W = oriented ? meta.height : meta.width;
  const H = oriented ? meta.width : meta.height;

  // 缩放水印
  let wmW = Math.max(8, Math.round(W * sizePct / 100));
  let wm = sharp(wmBuffer).resize({ width: wmW });
  if (rotate) wm = wm.rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  let wmBuf = await wm.png().toBuffer();
  const wmMeta = await sharp(wmBuf).metadata();
  wmW = wmMeta.width; const wmH = wmMeta.height;

  // 透明度
  wmBuf = await scaledAlphaOpacity(wmBuf, Math.max(1, Math.min(100, opacity)));

  const margin = Math.round(Math.min(W, H) * marginPct / 100);
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

module.exports = { prepareWatermark, mergeWatermarks, composeWatermark, IMAGE_EXTS, WM_INPUT_EXTS, extOf };
