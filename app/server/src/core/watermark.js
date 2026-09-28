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
const { isBmp, bmpToPng, encodeBmp } = require('../formats/bmp');
const { readExif } = require('./exif');
const { formatCameraText } = require('./exiftext');
const { renderTextWatermark } = require('./textmark');
const { applyFrame } = require('./framemark');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif']);
const WM_INPUT_EXTS = new Set(['.ai', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif']);
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_INPUT_PAGES = 100;
const MAX_WATERMARK_PIXELS = 40_000_000;

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
  let {
    bg = 'auto', tolerance = 40, maxSize = 1600, force = false,
    crop = null, trim = false,
  } = opts;
  maxSize = clampNum(Math.round(Number(maxSize) || 1600), 200, 4000);
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
    if (targetPx > maxSize * 72) throw new Error('SVG 声明尺寸过大');
    const density = targetPx > 0 ? Math.max(1, Math.min(2400, 72 * (maxSize / targetPx))) : 300;
    png = await sharp(inputBuffer, { density: Math.round(density) }).png().toBuffer();
    notes.push(`SVG 已栅格化（density ${Math.round(density)}）`);
  } else {
    png = isBmp(inputBuffer) ? await bmpToPng(inputBuffer) : inputBuffer;
  }

  // 裁剪参考系 = 栅格化后的原始画布（不受裁剪/去边/缩放影响）
  const srcMeta = await sharp(png).metadata();
  const sourceWidth = srcMeta.width, sourceHeight = srcMeta.height;
  if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_WATERMARK_PIXELS) {
    throw new Error(`水印源尺寸过大（最多 ${MAX_WATERMARK_PIXELS.toLocaleString()} 像素）`);
  }
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
    // 逐像素取反（按灰度，消掉单色墨的轻微色偏），而不是把所有不透明像素涂成同一色：
    // 去底时被笔画包围的白色区域（相机机身内部、字母 a/g 的内圈）会保留为不透明白，
    // 统一涂色会让它们和笔画糊成实心色块
    const out = Buffer.from(data);
    for (let i = 0; i < px; i++) {
      const o = i * 4;
      const v = 255 - Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
      out[o] = v; out[o + 1] = v; out[o + 2] = v;
    }
    altBuffer = await sharp(out, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  }
  return { monochrome, dark, inkLum: Math.round(inkLum), altBuffer };
}

/** 墨迹平均亮度（只统计较实的不透明像素；缩放/透明度缩放不影响 RGB）。
 *  批量任务里同一个水印 Buffer 会被每张图反复传入，按 Buffer 身份缓存，避免每张图重复解码水印 */
const inkLumCache = new WeakMap();
function inkLuminance(buffer) {
  let p = inkLumCache.get(buffer);
  if (!p) { p = computeInkLuminance(buffer); inkLumCache.set(buffer, p); }
  return p;
}
async function computeInkLuminance(buffer) {
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
  // 输出 raw 而非 PNG：整图大小的叠加层做 PNG 压缩/解压非常耗时
  const data = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(entries).raw().toBuffer();
  return { input: data, raw: { width: W, height: H, channels: 4 }, left: 0, top: 0 };
}

/** 水印不能超出目标图（sharp composite 要求叠加层 ≤ 底图），超出时等比缩进 W×H */
async function fitInside(buf, W, H) {
  const m = await sharp(buf).metadata();
  if (m.width <= W && m.height <= H) return { buf, width: m.width, height: m.height };
  const out = await sharp(buf).resize(W, H, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  return { buf: out.data, width: out.info.width, height: out.info.height };
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
    format = 'auto', quality = 90, sizeBase = 'width', mozjpeg = false,
  } = o;

  const src = await loadTarget(targetBuffer);
  targetBuffer = src.buffer;
  const meta = src.meta;
  const oriented = meta.orientation && meta.orientation >= 5; // 5-8 需交换宽高
  const W = oriented ? meta.height : meta.width;
  const H = oriented ? meta.width : meta.height;

  // （相机参数文字水印只走 composeGroups 的 textSpec 路径，这里不再保留第二套实现）

  // 缩放水印（反色变体与主变体走同一条缩放/旋转管线，保证尺寸一致）
  const targetW = Math.max(8, Math.round(sizeBaseDim(W, H, sizeBase) * sizePct / 100));
  const buildWm = async (src) => {
    let p = sharp(src).resize({ width: targetW });
    if (rotate) p = p.rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    return p.png().toBuffer();
  };
  const built = await fitInside(await buildWm(wmBuffer), W, H);
  let wmBuf = built.buf;
  const wmW = built.width, wmH = built.height;

  const margin = Math.round(Math.min(W, H) * marginPct / 100);

  // 亮度自适应黑白：平铺按全图亮度，单点按水印落点矩形亮度，
  // 亮区域配深色墨、暗区域配浅色墨（分界 LUM_THRESHOLD）
  if (o.autoColor && Buffer.isBuffer(wmAltBuffer)) {
    let region = null;
    if (!tile) {
      const [x, y] = positionXY(position, W, H, wmW, wmH, margin);
      const left = clampNum(Math.round(x + offsetX), 0, W - 2);
      const top = clampNum(Math.round(y + offsetY), 0, H - 2);
      region = { left, top, width: Math.max(2, Math.min(wmW, W - left)), height: Math.max(2, Math.min(wmH, H - top)) };
    }
    const lum = await regionLuminance(targetBuffer, region);
    const [lumBase, lumAlt] = await Promise.all([inkLuminance(wmBuffer), inkLuminance(wmAltBuffer)]);
    const wantDark = lum > LUM_THRESHOLD;
    const baseIsDarker = lumBase <= lumAlt;
    if (wantDark !== baseIsDarker) wmBuf = (await fitInside(await buildWm(wmAltBuffer), W, H)).buf; // 只在需要时才缩放反色变体
  }

  // 透明度
  wmBuf = await scaledAlphaOpacity(wmBuf, Math.max(1, Math.min(100, opacity)));

  const base = sharp(targetBuffer).rotate().withMetadata(); // 自动按 EXIF 摆正 + 保留 EXIF/ICC 等元数据

  if (tile) {
    const gap = Math.max(0, Math.round(wmW * tileGapPct / 100));
    base.composite([await renderTileOverlay(wmBuf, wmW, wmH, W, H, gap)]);
  } else {
    // 直接把水印叠到底图上（不再先生成一张与原图等大的透明 PNG，大图上省掉一次整图编解码）
    const [x, y] = positionXY(position, W, H, wmW, wmH, margin);
    base.composite([{ input: wmBuf, left: clampNum(Math.round(x + offsetX), 0, W - wmW), top: clampNum(Math.round(y + offsetY), 0, H - wmH) }]);
  }

  return encodeCompose(base, meta, { format, quality, mozjpeg });
}

/** 合成结果编码（保持原格式/指定格式 + 质量）。composeWatermark / composeGroups 共用 */
/** 读目标图元数据；BMP 先转 PNG 进 sharp 管线，但 meta.format 仍记为 bmp（auto 格式时按 BMP 写回） */
async function loadTarget(buffer) {
  if (!isBmp(buffer)) {
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) {
      throw new Error(`图片尺寸过大（最多 ${MAX_INPUT_PIXELS.toLocaleString()} 像素）`);
    }
    if ((meta.pages || 1) > MAX_INPUT_PAGES) throw new Error(`图片页数过多（最多 ${MAX_INPUT_PAGES} 页）`);
    return { buffer, meta };
  }
  const png = await bmpToPng(buffer);
  const meta = await sharp(png, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) {
    throw new Error(`图片尺寸过大（最多 ${MAX_INPUT_PIXELS.toLocaleString()} 像素）`);
  }
  if ((meta.pages || 1) > MAX_INPUT_PAGES) throw new Error(`图片页数过多（最多 ${MAX_INPUT_PAGES} 页）`);
  return { buffer: png, meta: { ...meta, format: 'bmp' } };
}

/** format → 输出扩展名。encodeCompose 与「没有可合成内容时原样返回」共用，两边必须一致 */
function extForFormat(f) {
  switch (f) {
    case 'jpeg': case 'jpg': return '.jpg';
    case 'avif': case 'heif': return '.avif'; // sharp 把 AVIF 输入报告为 heif
    case 'tiff': return '.tiff';
    case 'gif': return '.gif';
    case 'bmp': return '.bmp';
    default: return '.png';
  }
}

async function encodeCompose(base, meta, { format = 'auto', quality = 90, mozjpeg = false }) {
  const fmt = format === 'auto' ? (meta.format || 'png') : format;
  const ext = extForFormat(fmt);
  let out;
  switch (fmt) {
    // mozjpeg 体积小约 10-15%，但编码慢约 5 倍（24MP 约 570ms vs 90ms），默认用 libjpeg-turbo
    case 'jpeg': case 'jpg': out = base.jpeg({ quality, mozjpeg: !!mozjpeg }); break;
    case 'webp': out = base.webp({ quality }); break;
    case 'avif': case 'heif': out = base.avif({ quality }); break;
    case 'tiff': out = base.tiff(); break;
    case 'gif': out = base.gif(); break;
    case 'bmp': { // sharp 不能写 BMP，取 raw 自行编码
      const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
      return { buffer: encodeBmp(data, info.width, info.height, info.channels), ext: '.bmp' };
    }
    default: out = base.png({ compressionLevel: 6 }); // 照片类内容上 6 比 9 快约 2 倍且不更大
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

/** 大小基准尺寸：long=长边（横竖构图同实际大小）/ short=短边 / width=图宽（旧行为） */
function sizeBaseDim(W, H, sizeBase) {
  if (sizeBase === 'long') return Math.max(W, H);
  if (sizeBase === 'short') return Math.min(W, H);
  return W;
}

/** 把 group 的 position/offset 从「整张成品」换算到「照片所在的那块矩形」内 */
function offsetEntry(entry, frame) {
  if (!frame) return entry;
  const { padLeft, padTop, photoW, photoH } = frame;
  return { ...entry, left: entry.left + padLeft, top: entry.top + padTop };
}

/**
 * 多分组合成：一次叠加所有分组的水印并编码输出（相比多次 composeWatermark 少几次编解码）。
 * @param {Buffer} targetBuffer
 * @param {Array<{wmBuffer:Buffer, wmAltBuffer?:Buffer, textSpec?:object, options:object}>} groupDefs
 *   textSpec: 给了就按「这张图的 EXIF」现场渲染文字水印（相机参数），忽略 wmBuffer
 *   options: position/sizePct/marginPct/offsetX/offsetY/opacity/autoColor
 * @param {object} o format/quality（输出编码，全局）+ sizeBase: 'long'|'short'|'width'（大小基准，默认 width）
 *   frame: {style, lines, bg, color, subColor, align} —— 给了就先把画布撑大套边框，
 *          水印全部按「照片那块矩形」定位（否则会落进留白里）
 */
async function composeGroups(targetBuffer, groupDefs, o = {}) {
  const { format = 'auto', quality = 90, sizeBase = 'width', mozjpeg = false } = o;
  // 允许「只加边框、不叠任何水印」：此时没有分组，但边框本身就是要输出的内容。
  // 边框随后可能因为这张图没 EXIF 而被跳过，那种情况下真就没有任何可输出的了
  if (!groupDefs.length && !o.frame) {
    const e = new Error('没有可合成的分组');
    e.status = 400; // 调用方没给任何要画的东西，属于请求有误
    throw e;
  }
  const src = await loadTarget(targetBuffer);
  targetBuffer = src.buffer;
  const meta = src.meta;

  // 边框：先撑大画布，之后所有水印都相对照片区域定位
  let frame = null;
  if (o.frame) {
    const frameOpts = { ...o.frame };
    // 两行留空 → 用这张图自己的 EXIF 自动填（机型 / 曝光参数）。
    // 一张都没有的话，这个边框只会是块空白，不如不加 —— 与文字水印同样的取舍
    if (!Array.isArray(frameOpts.lines) || !frameOpts.lines.some((s) => String(s || '').trim())) {
      const exif = o.frame.previewExif || await readExif(sharp, targetBuffer);
      const l1 = formatCameraText(exif, { fields: ['camera'] });
      const l2 = formatCameraText(exif, { fields: ['exposure'] });
      if (!l1 && !l2) {
        frameOpts.skip = true;
      } else {
        frameOpts.lines = [l1, l2];
      }
    }
    if (!frameOpts.skip) {
      const fr = await applyFrame(targetBuffer, frameOpts);
      frame = { padLeft: fr.cropRect.left, padTop: fr.cropRect.top, photoW: fr.cropRect.width, photoH: fr.cropRect.height };
      targetBuffer = fr.buffer;
      // targetBuffer 变成了 PNG（中间产物，无所谓），但 meta.format 必须保留原格式 ——
      // encodeCompose 在 format=auto 时要照旧写成 JPEG，否则套个边框就把用户的 .jpg 变成了 .png
    }
  }

  const oriented = !frame && meta.orientation && meta.orientation >= 5;
  const W = frame ? frame.photoW : (oriented ? meta.height : meta.width);
  const H = frame ? frame.photoH : (oriented ? meta.width : meta.height);
  // 文字水印要按「这张图」的 EXIF 渲染：同一批里每张图的相机参数都可能不同，
  // 所以不能像 logo 那样在提交任务前预先建好 —— 这里按需解析一次，多组共用。
  // 样式预览的示例图没有 EXIF，靠 group 上的 previewExif 注入一份「典型相机参数」
  let exifCache;
  const exifOf = async () => {
    if (exifCache === undefined) exifCache = await readExif(sharp, targetBuffer);
    return exifCache;
  };
  const exifFor = async (g) => (g.previewExif || await exifOf());
  const baseDim = sizeBaseDim(W, H, sizeBase);
  const entries = [];
  for (const g of groupDefs) {
    const go = g.options || {};
    const targetW = Math.max(8, Math.round(baseDim * clampNum(go.sizePct ?? 20, 2, 100) / 100));
    // 文字水印：按本图 EXIF 渲染 → 变成 wmBuffer，之后与 logo 走完全相同的定位/缩放/透明度逻辑
    let wmSource = g.wmBuffer;
    if (g.textSpec) {
      const text = formatCameraText(await exifFor(g), g.textSpec);
      wmSource = text ? (await renderTextWatermark(text, g.textSpec.style || {})).buffer : null;
    }
    if (!wmSource) continue; // 这张图没有可用的相机信息 → 这一组整体跳过，不留空水印
    const buildWm = async (src) => fitInside(await sharp(src).resize({ width: targetW }).png().toBuffer(), W, H);
    const built = await buildWm(wmSource);
    let wmBuf = built.buf;
    const wmW = built.width, wmH = built.height;
    // 亮度自适应黑白：整组按落点亮度二选一。
    //   logo 组用 prepare 阶段备好的反色变体；
    //   文字组没有备用变体，就在这儿按同一套字段换个墨色再渲一遍（文字量很小，开销可忽略）
    if (go.autoColor) {
      const margin = Math.round(Math.min(W, H) * clampNum(go.marginPct ?? 3, 0, 30) / 100);
      const [gx, gy] = positionXY(go.position || 'se', W, H, wmW, wmH, margin);
      const left = Math.max(0, Math.min(W - 2, Math.round(gx + (go.offsetX || 0))));
      const top = Math.max(0, Math.min(H - 2, Math.round(gy + (go.offsetY || 0))));
      // 采样坐标在「画布」上：套了边框时照片矩形相对画布有 padLeft/padTop 偏移，得加回去，
      // 否则采到的是留白/错位区域的亮度，黑白标会选反
      const region = {
        left: left + (frame ? frame.padLeft : 0),
        top: top + (frame ? frame.padTop : 0),
        width: Math.max(2, Math.min(wmW, W - left)),
        height: Math.max(2, Math.min(wmH, H - top)),
      };
      const lum = await regionLuminance(targetBuffer, region);
      const wantDark = lum > LUM_THRESHOLD;
      let altSource = g.wmAltBuffer;
      if (g.textSpec) {
        const style = g.textSpec.style || {};
        // 「亮底要深墨」：主变体已按用户选的墨色渲染，反色变体就换成对侧
        const text = formatCameraText(await exifFor(g), g.textSpec);
        const flipped = { ...style, color: wantDark ? '#000000' : '#ffffff' };
        altSource = text ? (await renderTextWatermark(text, flipped)).buffer : null;
      }
      if (Buffer.isBuffer(altSource) && Buffer.isBuffer(wmSource)) {
        const [lumBase, lumAlt] = await Promise.all([inkLuminance(wmSource), inkLuminance(altSource)]);
        const baseIsDarker = lumBase <= lumAlt;
        if (wantDark !== baseIsDarker) wmBuf = (await buildWm(altSource)).buf;
      }
    }
    wmBuf = await scaledAlphaOpacity(wmBuf, Math.max(1, Math.min(100, go.opacity ?? 80)));
    const margin = Math.round(Math.min(W, H) * clampNum(go.marginPct ?? 3, 0, 30) / 100);
    const [x, y] = positionXY(go.position || 'se', W, H, wmW, wmH, margin);
    entries.push(offsetEntry({
      input: wmBuf,
      left: clampNum(Math.round(x + (go.offsetX || 0)), 0, W - wmW),
      top: clampNum(Math.round(y + (go.offsetY || 0)), 0, H - wmH),
    }, frame));
  }
  // 一组都没叠上（例如全是文字组、而这张图没有 EXIF）→ 能原样返回就原样返回，
  // 不要白跑一次有损编码：没水印的图再压一遍纯属掉画质。
  // 但调用方强制了不同输出格式时必须照办（否则 PNG 字节被写成 .jpg 更糟）；
  // ext 与 encodeCompose 的输出一致，跳过时也没有「换格式而重命名」的问题
  const srcExt = extForFormat(meta.format || 'png');
  const outExt = extForFormat(format === 'auto' ? (meta.format || 'png') : format);
  if (!entries.length && !frame && outExt === srcExt) {
    return { buffer: targetBuffer, ext: srcExt, skipped: true };
  }
  const base = frame
    ? sharp(targetBuffer).withMetadata()      // 边框产物已摆正，再 rotate 会按 EXIF 二次旋转
    : sharp(targetBuffer).rotate().withMetadata();
  base.composite(entries);
  return encodeCompose(base, meta, { format, quality, mozjpeg });
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

/**
 * 输出裁剪：按指定宽高比裁剪已合成的图片，通过亮度分析智能选择裁剪区域。
 * 分析上/下（或左/右）半区亮度方差，方差大的区域更可能包含主体/细节，裁剪时尽量保留。
 *
 * ratio 支持两种写法：
 *   '4:5'      —— 不看图片方向，一律按 4:5 裁（横图会得到竖幅画面）
 *   'land@5:4' —— 只对横图生效，竖图原样输出（'port@' 反之）
 * 带方向前缀的写法用来把「横图裁成 5:4」和「竖图裁成 5:4」分开表达：
 * 同一组比例下，横图最常见的诉求是裁宽、竖图是裁高，混在一起选不出想要的那条。
 * 不带前缀的比例仍然有效（老方案里存的就是这种），行为与旧版完全一致。
 */
const CROP_RATIOS = {
  '1:1':   [1, 1],
  '4:5':   [4, 5],
  '5:4':   [5, 4],
  '3:4':   [3, 4],
  '4:3':   [4, 3],
  '2:3':   [2, 3],
  '3:2':   [3, 2],
  '9:16':  [9, 16],
  '16:9':  [16, 9],
  '21:9':  [21, 9],
};
// 解析 'land@4:5' / 'port@5:4' / '16:9' 三种写法
function parseCropRatio(ratio) {
  const m = /^(land|port)@(.+)$/.exec(String(ratio || ''));
  const ratioKey = m ? m[2] : String(ratio || '');
  const wh = CROP_RATIOS[ratioKey];
  if (!wh) return null;
  return { scope: m ? m[1] : 'any', rw: wh[0], rh: wh[1] };
}
// 源图是不是竖幅（含 EXIF 方向修正）
function sourceIsPortrait(meta) {
  const oriented = meta.orientation && meta.orientation >= 5;
  const W = oriented ? meta.height : meta.width;
  const H = oriented ? meta.width : meta.height;
  return W < H;
}

/**
 * 按 options 里的裁剪配置处理一张已合成的图。
 *   options.cropRatio     —— 横图用的比例（不带 land@/port@ 前缀时两个方向都套用）
 *   options.cropRatioPort —— 仅当勾了「横竖分开设置」才有值，只作用于竖图
 * 竖图会优先用 cropRatioPort；没配置或对竖图不生效时，回落到 cropRatio
 * （落在不带前缀的比例上 → 仍然裁剪，所以「不勾分开设置」的行为与旧版一致）。
 * options.format/quality/mozjpeg —— 裁剪必然重编码，用与合成同一套编码参数写回，
 * 否则质量滑杆 / mozjpeg 会被 sharp 默认值（JPEG q80、AVIF q50）悄悄盖掉。
 */
async function applyCrop(buffer, opts) {
  const o = opts || {};
  if (!o.cropRatio && !o.cropRatioPort) return buffer;
  // 与合成管线同一条解码路：BMP 由内置编解码器转 PNG 进 sharp，meta.format 仍记为 bmp
  const { buffer: work, meta } = await loadTarget(buffer);
  const enc = {
    format: o.format || 'auto',
    quality: Number.isFinite(+o.quality) ? Math.max(50, Math.min(100, +o.quality)) : 90,
    mozjpeg: !!o.mozjpeg,
  };
  const ratio = sourceIsPortrait(meta) && o.cropRatioPort ? o.cropRatioPort : o.cropRatio;
  const out = await cropOutput(work, ratio, meta, enc);
  // 没裁动时 cropOutput 原样交回 work —— 此时要把没转过格式的原始字节还回去
  return out === work ? buffer : out;
}

async function cropOutput(buffer, ratio, metaIn, enc = {}) {
  const spec = parseCropRatio(ratio);
  if (!spec) return buffer;

  const meta = metaIn || (await loadTarget(buffer)).meta;
  const oriented = meta.orientation && meta.orientation >= 5;
  const W = oriented ? meta.height : meta.width;
  if (spec.scope !== 'any' && spec.scope !== (sourceIsPortrait(meta) ? 'port' : 'land')) {
    return buffer;
  }
  const { rw, rh } = spec;
  if (!rw || !rh) return buffer;

  const H = oriented ? meta.width : meta.height;
  const targetAR = rw / rh;
  const srcAR = W / H;

  if (Math.abs(targetAR - srcAR) < 0.01) return buffer;

  let cropW, cropH, cropLeft, cropTop;

  if (targetAR > srcAR) {
    cropW = W;
    cropH = Math.round(W / targetAR);
    cropLeft = 0;
    cropTop = await smartOffset(buffer, W, H, cropW, cropH, 'vertical');
  } else {
    cropH = H;
    cropW = Math.round(H * targetAR);
    cropTop = 0;
    cropLeft = await smartOffset(buffer, W, H, cropW, cropH, 'horizontal');
  }

  cropW = Math.min(cropW, W);
  cropH = Math.min(cropH, H);
  cropLeft = Math.max(0, Math.min(cropLeft, W - cropW));
  cropTop = Math.max(0, Math.min(cropTop, H - cropH));

  // 裁剪改了像素，输出必须重编码 —— 走 encodeCompose 与合成共用同一套格式/质量规则
  const { buffer: out } = await encodeCompose(
    sharp(buffer).rotate()
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .withMetadata({ orientation: undefined }),
    meta,
    enc,
  );
  return out;
}

async function smartOffset(buffer, W, H, cropW, cropH, axis) {
  const thumbSize = 64;
  const { data } = await sharp(buffer).rotate()
    .resize(thumbSize, thumbSize, { fit: 'fill' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });

  if (axis === 'vertical') {
    const excess = H - cropH;
    const half = Math.floor(thumbSize / 2);
    let varTop = 0, varBot = 0;
    const avg = (start, end) => {
      let s = 0, n = 0;
      for (let y = start; y < end; y++)
        for (let x = 0; x < thumbSize; x++) { s += data[y * thumbSize + x]; n++; }
      return n ? s / n : 128;
    };
    const variance = (start, end, mean) => {
      let s = 0, n = 0;
      for (let y = start; y < end; y++)
        for (let x = 0; x < thumbSize; x++) { const d = data[y * thumbSize + x] - mean; s += d * d; n++; }
      return n ? s / n : 0;
    };
    const mTop = avg(0, half), mBot = avg(half, thumbSize);
    varTop = variance(0, half, mTop);
    varBot = variance(half, thumbSize, mBot);
    if (varTop > varBot * 1.3) return 0;
    if (varBot > varTop * 1.3) return excess;
    return Math.round(excess / 2);
  }

  const excess = W - cropW;
  const half = Math.floor(thumbSize / 2);
  const avg = (start, end) => {
    let s = 0, n = 0;
    for (let y = 0; y < thumbSize; y++)
      for (let x = start; x < end; x++) { s += data[y * thumbSize + x]; n++; }
    return n ? s / n : 128;
  };
  const variance = (start, end, mean) => {
    let s = 0, n = 0;
    for (let y = 0; y < thumbSize; y++)
      for (let x = start; x < end; x++) { const d = data[y * thumbSize + x] - mean; s += d * d; n++; }
    return n ? s / n : 0;
  };
  const mLeft = avg(0, half), mRight = avg(half, thumbSize);
  const varLeft = variance(0, half, mLeft);
  const varRight = variance(half, thumbSize, mRight);
  if (varLeft > varRight * 1.3) return 0;
  if (varRight > varLeft * 1.3) return excess;
  return Math.round(excess / 2);
}

module.exports = { prepareWatermark, mergeWatermarks, composeWatermark, composeGroups, buildGroupWatermark, analyzeInk, cropOutput, applyCrop, parseCropRatio, CROP_RATIOS, IMAGE_EXTS, WM_INPUT_EXTS, extOf };
