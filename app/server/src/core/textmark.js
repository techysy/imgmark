'use strict';
/**
 * 把一行文字渲染成透明 PNG「水印」——产物与 prepareWatermark 的输出同构
 * （buffer/width/height），因此能直接进现有的分组/合成管线，不需要在
 * composeWatermark 里为文字单开一条分支。
 *
 * 走 SVG（librsvg）而不是 sharp 的 text 图：sharp 0.33 没有文字 API，
 * 且 SVG 能顺手拿到字体度量（textLength 不用，靠 canvas 估宽即可）。
 *
 * 字体可用性是这里最大的不确定性：Windows/macOS/Linux 上 sans-serif 的
 * 实际字形不同，宽高会有差异。所以宽度靠「按字号估」+ 渲染后实测兜底，
 * 而不是写死一个假设值。
 */
const sharp = require('sharp');

/** 渲染尺寸的基准：字号（px）。最终大小由 compose 阶段按 sizePct 缩放，这里只要清晰 */
const DEFAULT_FONT_SIZE = 96;

/** XML 要转义的字符（文字水印的内容来自 EXIF，可能带 & < >） */
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 估宽度：按经验比例，宁大勿小 —— 它只决定临时画布的下限，渲染后按墨迹 trim 收掉，
 * 估大了无害（多占点临时内存），估小了会把字裁掉。
 * 系数取自 bold 无衬线实测（W≈0.95em 最宽、大写平均≈0.7em）再留跨机器字体差异的余量：
 * CJK/全角/emoji 按 1.0 em，em dash 一类按 1.15 em，M/W/m/w 宽字形按 1.05 em，其余 0.85 em。
 * 正字距按字符间隙累加；负字距只会更窄，忽略。
 */
const WIDE_GLYPHS = new Set(['M', 'W', 'm', 'w']);
function estimateWidth(text, fontSize, letterSpacing = 0) {
  let em = 0, chars = 0;
  for (const ch of String(text)) {
    chars++;
    const cp = ch.codePointAt(0);
    // 全角/CJK/emoji 约 1em
    em += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff))) ? 1.0
      : (cp >= 0x2013 && cp <= 0x2015) ? 1.15
      : WIDE_GLYPHS.has(ch) ? 1.05
      : 0.85;
  }
  return Math.ceil(em * fontSize + Math.max(0, letterSpacing) * Math.max(0, chars - 1));
}

/**
 * 生成文字水印的透明 PNG。
 * @param {string} text 要渲染的文字（可含换行符 \n → 多行）
 * @param {object} o
 *   fontSize: 基准字号 px（默认 96；最终大小由 compose 的 sizePct 决定，这里只影响清晰度）
 *   color: 文字颜色（默认 '#000000'，配合 autoColor 会自动换成反色变体）
 *   fontFamily: 字体族（默认 'sans-serif'）
 *   fontWeight: 'normal'|'bold'（默认 'normal'）
 *   letterSpacing: 字距 px（默认 0）
 *   bg: 背景（'none' 透明；给颜色则填底色 —— 做「黑底白字」这类标牌样式用）
 *   padding: 内边距 px（默认 0；有底色时建议给值）
 *   stroke/strokeWidth: 描边（描边能让浅色背景上的白字也看得清）
 * @returns {{buffer:Buffer, width:number, height:number}}
 */
async function renderTextWatermark(text, o = {}) {
  const {
    fontSize = DEFAULT_FONT_SIZE, color = '#000000', fontFamily = 'sans-serif',
    fontWeight = 'normal', letterSpacing = 0, bg = 'none', padding = 0,
    stroke = null, strokeWidth = 0, lineGap = 0.28,
  } = o;

  const lines = String(text == null ? '' : text).slice(0, 256).split(/\r?\n/).map((s) => s.replace(/\s+$/, ''));
  if (!lines.some((l) => l.trim())) throw new Error('文字水印内容为空');

  const size = Math.max(8, Math.min(400, Math.round(fontSize)));
  const pad = Math.max(0, Math.round(padding));
  const lineH = Math.round(size * 1.32); // 行高 = 字号 × 1.32（含行距）
  const gap = Math.round(size * lineGap);

  const bgRect = bg && bg !== 'none'
    ? `<rect width="100%" height="100%" fill="${escXml(bg)}"/>` : '';
  const strokeAttr = stroke && strokeWidth > 0
    ? ` stroke="${escXml(stroke)}" stroke-width="${strokeWidth}" paint-order="stroke"` : '';
  // dominant-baseline 不可靠（librsvg 版本差异），用 dy 手动定位基线
  const tspans = lines.map((l, i) => {
    const dy = i === 0 ? Math.round(size * 0.82) : lineH + gap;
    return `<tspan x="${pad}" dy="${dy}">${escXml(l)}</tspan>`;
  }).join('');

  // 画布大小只求装得下文字：估宽再准也不如实测 —— 不同系统的 sans-serif 字形差异大，
  // 画布小于墨迹会把字裁掉。估宽之外再留两倍字号的余量兜住极端字体，多出的透明边
  // 由下面的 trim 收掉
  const estW = Math.max(1, ...lines.map((l) => estimateWidth(l, size, letterSpacing)));
  const width = estW + pad * 2 + size * 2;
  const height = lines.length * lineH + (lines.length - 1) * gap + pad * 2 + lineH;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}">${bgRect}`
    + `<text font-family="${escXml(fontFamily)}" font-size="${size}" font-weight="${escXml(fontWeight)}"`
    + (letterSpacing ? ` letter-spacing="${letterSpacing}"` : '')
    + ` fill="${escXml(color)}"${strokeAttr}>${tspans}</text></svg>`;

  // 渲染 + 按墨迹裁边：得到精确的文字块尺寸（描边/字距/系统字体差异一并兜住）。
  // 有底色时文字先在透明底上渲染（边上不能有底色，否则 trim 不掉），再贴回
  // 一张正好墨迹大小 + 2×pad 的底色画布 —— 估宽带来的松散右边距也随之消失
  let out = await sharp(Buffer.from(svg)).png().toBuffer();
  out = await sharp(out).trim({ threshold: 0 }).png().toBuffer();
  if (bg && bg !== 'none') {
    const ink = await sharp(out).metadata();
    out = await sharp({
      create: { width: ink.width + pad * 2, height: ink.height + pad * 2, channels: 4, background: bg },
    }).composite([{ input: out, left: pad, top: pad }]).png().toBuffer();
  }
  const meta = await sharp(out).metadata();
  if (!meta.width || !meta.height) throw new Error('文字水印渲染结果为空（字体或内容有问题）');
  return { buffer: out, width: meta.width, height: meta.height };
}

/**
 * 字体自检：渲染一个探针字符，确认真的画出了墨迹。
 *
 * 为什么需要：系统一个字体都没有时（精简的 Linux 镜像常见），libvips 不会报错 ——
 * 它照样返回一张 PNG，只是里面什么都没有，sharp 也正常 exit 0。结果就是水印"成功地"
 * 加了个空白，用户看到的是「明明勾了相机参数却什么都没有」。唯一能发现的办法就是
 * 数一下像素：有墨迹才算字体可用。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function checkFontAvailable(fontFamily = 'sans-serif') {
  try {
    // 用一个一定有字形、且笔画密度不低的字符；同时验证非 ASCII 路径
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">`
      + `<text x="4" y="30" font-family="${escXml(fontFamily)}" font-size="30" fill="#000">Aα</text></svg>`;
    // 必须先压平到白底再数墨：透明背景的像素灰度是 0，直接数会把「什么都没画」
    // 误判成满页墨迹，自检永远通过 —— 而它要抓的恰恰就是这种全透明输出
    const { data } = await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).greyscale().raw()
      .toBuffer({ resolveWithObject: true });
    let ink = 0;
    for (let i = 0; i < data.length; i++) if (data[i] < 240) ink++;
    if (ink < 20) return { ok: false, reason: `字体 ${fontFamily} 渲染不出内容（系统可能没装任何字体）` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `字体自检失败：${e.message}` };
  }
}

module.exports = { renderTextWatermark, checkFontAvailable, estimateWidth, DEFAULT_FONT_SIZE };
