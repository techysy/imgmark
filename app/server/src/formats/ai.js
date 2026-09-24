'use strict';
/**
 * Adobe Illustrator (.ai) → PNG。
 *
 * AI 9+ 的文件是"PDF 兼容"的（文件体即 PDF），直接用 pdfjs-dist 渲染第 1 页，
 * 画布保持透明，后续再走去底引擎。渲染失败的旧版 PostScript AI 文件，
 * 若系统装有 Ghostscript（gs / gswin64c）则回退用它转 pngalpha。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_RENDER_DIM = 1600; // 渲染后最长边上限

function pdfjsAssetDir() {
  // pdfjs-dist 的 exports 不暴露 package.json，按 node_modules 扁平布局定位
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'node_modules', 'pdfjs-dist'),
    path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'standard_fonts'))) return dir;
  }
  return null;
}

async function renderWithPdfjs(buffer, maxDim) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');

  const assetDir = pdfjsAssetDir();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: assetDir ? path.join(assetDir, 'standard_fonts') + path.sep : undefined,
    cMapUrl: assetDir ? path.join(assetDir, 'cmaps') + path.sep : undefined,
    cMapPacked: true,
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.max(0.5, Math.min(8, maxDim / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height); // 保持透明底
    await page.render({ canvas, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await loadingTask.destroy();
  }
}

function hasGhostscript() {
  for (const bin of process.platform === 'win32' ? ['gswin64c', 'gswin32c', 'gs'] : ['gs']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

async function renderWithGhostscript(buffer) {
  const bin = hasGhostscript();
  if (!bin) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgmark-ai-'));
  try {
    const inFile = path.join(tmp, 'in.ai');
    const outFile = path.join(tmp, 'out.png');
    fs.writeFileSync(inFile, buffer);
    const r = spawnSync(bin, [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-dFirstPage=1', '-dLastPage=1',
      '-sDEVICE=pngalpha', '-r150',
      `-sOutputFile=${outFile}`, inFile,
    ], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(outFile)) {
      throw new Error(`Ghostscript 渲染失败: ${(r.stderr || r.stdout || '').slice(-300)}`);
    }
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @returns {Buffer} PNG（透明底） */
async function renderAiToPng(buffer, { maxDim = MAX_RENDER_DIM } = {}) {
  try {
    return await renderWithPdfjs(buffer, maxDim);
  } catch (err) {
    const gs = await renderWithGhostscript(buffer);
    if (gs) return gs;
    const hint = process.platform === 'win32'
      ? '可安装 Ghostscript（gswin64c）后重试'
      : '可安装 Ghostscript（gs）后重试';
    throw new Error(`.ai 文件渲染失败：${err.message}。旧版（PostScript）AI 文件需要 Ghostscript，${hint}；` +
      `或在 Illustrator 里另存为勾选"创建 PDF 兼容文件"的 .ai / SVG 后重试。`);
  }
}

module.exports = { renderAiToPng };
