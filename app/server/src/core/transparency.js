'use strict';
/**
 * 白底/黑底 → 透明 PNG 引擎。
 *
 * 策略：
 *  1. 从图像四边采样求"底色"（逐通道中位数，抗 JPEG 噪点）；
 *  2. 默认用洪泛填充（flood fill）只清除与边缘连通的背景区，
 *     保护 logo 内部的白色/黑色内容；可选 global 模式全局去底；
 *  3. 边缘羽化 + 去色染（decontamination），消除白边/黑边。
 */
const sharp = require('sharp');

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** 边缘像素逐通道中位数 */
function detectBackgroundColor(data, width, height, channels) {
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.floor(Math.max(width, height) / 256));
  const push = (x, y) => {
    const i = (y * width + x) * channels;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  };
  for (let x = 0; x < width; x += step) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += step) { push(0, y); push(width - 1, y); }
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const c = { r: median(rs), g: median(gs), b: median(bs) };
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return { ...c, kind: lum >= 128 ? 'white' : 'black' };
}

function dist2(data, i, bg) {
  const dr = data[i] - bg.r, dg = data[i + 1] - bg.g, db = data[i + 2] - bg.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * @param {Buffer} buffer 任意 sharp 可解码图片
 * @param {object} opts
 *   bg: 'auto' | 'white' | 'black'
 *   tolerance: 0-255 欧氏距离容差（默认 40）
 *   global: true 时不去连通性，直接全图去底
 *   force: 已有透明通道时仍强制去底
 * @returns {buffer:PNG, bgColor, width, height, removed, alreadyTransparent}
 */
async function removeBackground(buffer, opts = {}) {
  const { bg = 'auto', tolerance = 40, global = false, force = false } = opts;
  const tol = Math.max(1, Math.min(255, tolerance));

  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // 已有透明像素 → 认为已是透明图（除非 force）
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += channels) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }
  if (hasAlpha && !force) {
    const png = await sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 9 }).toBuffer();
    return { buffer: png, bgColor: null, width, height, removed: false, alreadyTransparent: true };
  }

  const detected = detectBackgroundColor(data, width, height, channels);
  const bgColor = bg === 'white' ? { r: 255, g: 255, b: 255 }
    : bg === 'black' ? { r: 0, g: 0, b: 0 }
    : detected;
  const tol2 = tol * tol;

  const n = width * height;
  const isBg = new Uint8Array(n);

  if (!global) {
    // 洪泛填充：从四边种子出发
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    const trySeed = (x, y) => {
      const p = y * width + x, i = p * channels;
      if (!isBg[p] && data[i + 3] > 8 && dist2(data, i, bgColor) <= tol2) {
        isBg[p] = 1; queue[tail++] = p;
      }
    };
    for (let x = 0; x < width; x++) { trySeed(x, 0); trySeed(x, height - 1); }
    for (let y = 0; y < height; y++) { trySeed(0, y); trySeed(width - 1, y); }
    while (head < tail) {
      const p = queue[head++];
      const x = p % width, y = (p / width) | 0;
      if (x > 0) { const q = p - 1, i = q * channels; if (!isBg[q] && data[i + 3] > 8 && dist2(data, i, bgColor) <= tol2) { isBg[q] = 1; queue[tail++] = q; } }
      if (x < width - 1) { const q = p + 1, i = q * channels; if (!isBg[q] && data[i + 3] > 8 && dist2(data, i, bgColor) <= tol2) { isBg[q] = 1; queue[tail++] = q; } }
      if (y > 0) { const q = p - width, i = q * channels; if (!isBg[q] && data[i + 3] > 8 && dist2(data, i, bgColor) <= tol2) { isBg[q] = 1; queue[tail++] = q; } }
      if (y < height - 1) { const q = p + width, i = q * channels; if (!isBg[q] && data[i + 3] > 8 && dist2(data, i, bgColor) <= tol2) { isBg[q] = 1; queue[tail++] = q; } }
    }
  } else {
    for (let p = 0; p < n; p++) {
      const i = p * channels;
      if (data[i + 3] > 8 && dist2(data, i, bgColor) <= tol2) isBg[p] = 1;
    }
  }

  // 羽化 + 去色染：非背景但与背景相邻的像素按距离算软 alpha
  const tLow = tol * 0.35, tHigh = Math.max(tol * 1.35, tLow + 1);
  const bgRGB = [bgColor.r, bgColor.g, bgColor.b];
  const applyRamp = (p) => {
    const i = p * channels;
    const d = Math.sqrt(dist2(data, i, bgColor));
    const a = clamp01((d - tLow) / (tHigh - tLow));
    const outA = Math.round(a * data[i + 3]);
    if (a > 0.02 && a < 1) {
      // decontaminate: C' = (C - bg·(1-a)) / a
      for (let c = 0; c < 3; c++) {
        const v = (data[i + c] - bgRGB[c] * (1 - a)) / a;
        data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    data[i + 3] = outA;
  };
  for (let p = 0; p < n; p++) {
    if (isBg[p]) { data[p * channels + 3] = 0; continue; }
    if (global) { applyRamp(p); continue; }
    const x = p % width, y = (p / width) | 0;
    const near =
      (x > 0 && isBg[p - 1]) || (x < width - 1 && isBg[p + 1]) ||
      (y > 0 && isBg[p - width]) || (y < height - 1 && isBg[p + width]);
    if (near) applyRamp(p);
  }

  const png = await sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 9 }).toBuffer();
  return { buffer: png, bgColor: detected, width, height, removed: true, alreadyTransparent: false };
}

module.exports = { removeBackground, detectBackgroundColor };
