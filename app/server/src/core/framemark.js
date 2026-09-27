'use strict';
/**
 * 边框 / 条幅容器：把相机参数放进**新增的画布区域**，而不是浮在画面之上。
 *
 * 和「文字水印」的区别是本模块存在的全部理由：
 *   文字水印是 composite 到原图上的 —— 它盖住画面内容，因此背景只能是透明或半透明；
 *   边框是先把画布撑大（下方加一条 / 四周加一圈），再把照片摆进去、文字排进留白里。
 *   所以它必须在**合成之前**改画布尺寸，不能塞进 composeGroups（那里画布已定）。
 *
 * 三种版式（与截图里的样式对应）：
 *   band   —— 画面下方接一条纯色横条，参数排在条内（截图里的 "banner camera"）
 *   frame  —— 四周加一圈等宽留白，参数居中压在下方留白里（"frame camera"）
 *   inset  —— 四周留白 + 照片内缩一圈细线，参数排在下方（打印装裱的观感）
 */
const sharp = require('sharp');

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const clampNum = (v, min, max) => Math.max(min, Math.min(max, v));

/** 版式定义：每种给出「四周留白」与「下方额外留白」 */
const FRAME_PRESETS = {
  band: { pad: 0, bottom: 0.18 },   // 只在下方加条；底部高度按短边比例
  frame: { pad: 0.045, bottom: 0.10 },
  inset: { pad: 0.055, bottom: 0.12 },
};

/**
 * 把一行/两行文字排进一个矩形区域（左对齐或居中），返回可 composite 的叠加层。
 * 行距与字号按区域高度自适应，不写死。
 */
function buildTextBlock(lines, boxW, boxH, o = {}) {
  const {
    bg = '#ffffff', color = '#111111', subColor = null,
    align = 'left', padX = 0, lineSpacing = 1.35, maxFontPx = 0,
  } = o;
  const rows = lines.filter(Boolean);
  if (!rows.length) return null;
  // 字号：按行数与区域高度摊，并受 maxFontPx 限制（大图上别把字放到夸张）
  const n = rows.length;
  const byHeight = Math.floor(boxH / (n * lineSpacing + 0.6));
  const fontPx = Math.max(9, Math.min(maxFontPx || 999, byHeight));
  const anchor = align === 'center' ? 'middle' : 'start';
  const tx = align === 'center' ? boxW / 2 : padX;
  const tspans = rows.map((r, i) => {
    const dy = i === 0 ? Math.round(fontPx * 0.95) : Math.round(fontPx * lineSpacing);
    const fill = i === 0 ? color : (subColor || color);
    const size = i === 0 ? fontPx : Math.round(fontPx * 0.82);
    return `<tspan x="${tx}" dy="${dy}" fill="${fill}" font-size="${size}">${escXml(r)}</tspan>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">`
    + `<rect width="100%" height="100%" fill="${bg}"/>`
    + `<text font-family="sans-serif" font-weight="bold" text-anchor="${anchor}">${tspans}</text></svg>`;
  return Buffer.from(svg);
}

/**
 * 给图片套上边框并写入相机参数。
 * @param {Buffer} srcBuffer 原图（未合成过任何水印）
 * @param {object} o
 *   style: 'band'|'frame'|'inset'
 *   lines: string[] 要排进留白的文字行（通常两行：主行 / 副行），空数组则只加边框不写字
 *   bg: 留白底色（默认 #ffffff）
 *   color / subColor: 第一行 / 第二行文字颜色
 *   align: left|center（默认 left；frame/inset 通常用 center）
 *   padPct / bottomPct: 覆盖预设的留白比例（相对短边）
 *   border: inset 版式的内缩细线颜色（默认 #d8dde3），传 null 不画
 * @returns {{buffer:Buffer, width:number, height:number, cropRect:{left,top,width,height}}}
 *   cropRect 是照片在成品里的位置 —— 后续的水印分组要用它把坐标换算过去，
 *   否则水印会按新画布定位，落进留白里
 */
async function applyFrame(srcBuffer, o = {}) {
  const {
    style = 'band', lines = [], bg = '#ffffff', color = '#111111', subColor = null,
    align = 'left', border = '#d8dde3',
  } = o;
  const preset = FRAME_PRESETS[style] || FRAME_PRESETS.band;
  const meta = await sharp(srcBuffer).metadata();
  const oriented = meta.orientation && meta.orientation >= 5;
  const srcW = oriented ? meta.height : meta.width;
  const srcH = oriented ? meta.width : meta.height;
  const short = Math.min(srcW, srcH);

  const padPct = o.padPct != null ? o.padPct : preset.pad;
  const botPct = o.bottomPct != null ? o.bottomPct : preset.bottom;
  const pad = Math.round(short * clampNum(padPct, 0, 0.3));
  const bot = Math.round(short * clampNum(botPct, 0, 0.4));

  const outW = srcW + pad * 2;
  const outH = srcH + pad * 2 + bot;
  // 照片在成品里的位置
  const cropRect = { left: pad, top: pad, width: srcW, height: srcH };

  // 先把原图摆正+编码一次，再作为叠加层贴进新画布（sharp 不能直接把 buffer 当背景画进更大的画布）
  const photo = await sharp(srcBuffer).rotate().toBuffer();

  const overlays = [];
  // 文字排在下方留白区：band 没有左右 pad，frame/inset 有
  if (bot > 8 && lines.filter(Boolean).length) {
    const boxH = bot - Math.round(pad * 0.4);
    const boxW = outW - pad * 2;
    const block = buildTextBlock(lines, Math.max(40, boxW), Math.max(24, boxH), {
      bg, color, subColor, align,
      // 居中排版时内边距由 text-anchor 处理；左对齐时留出 pad
      padX: align === 'center' ? 0 : Math.round(pad || short * 0.03),
      maxFontPx: Math.round(short * 0.055),
    });
    if (block) {
      overlays.push({
        input: block,
        left: pad,
        top: pad + srcH + Math.round((bot - boxH) / 2),
      });
    }
  }

  const canvas = sharp({
    create: { width: outW, height: outH, channels: 4, background: bg },
  });

  const composite = [{ input: photo, left: pad, top: pad }, ...overlays];
  // inset：照片四周压一圈细线，做出"装裱"的分界
  if (style === 'inset' && border) {
    const stroke = await sharp({
      create: { width: srcW + 2, height: srcH + 2, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${srcW + 2}" height="${srcH + 2}">`
        + `<rect x="0.5" y="0.5" width="${srcW + 1}" height="${srcH + 1}" fill="none" `
        + `stroke="${escXml(border)}" stroke-width="1"/></svg>`),
      left: 0, top: 0,
    }]).png().toBuffer();
    composite.push({ input: stroke, left: pad - 1, top: pad - 1 });
  }

  const buffer = await canvas.composite(composite).png().toBuffer();
  return { buffer, width: outW, height: outH, cropRect };
}

module.exports = { applyFrame, buildTextBlock, FRAME_PRESETS };
