'use strict';
/**
 * BMP 编解码（sharp/libvips 预编译版不含 BMP 加载器，读 BMP 会报 unsupported image format）。
 *
 * 解码：1/4/8 位调色板、16/24/32 位，BI_RGB / BI_BITFIELDS / BI_ALPHABITFIELDS，
 *       CORE / INFO / V2~V5 各版本信息头，自下而上与自上而下两种行序。RLE 与内嵌 JPEG/PNG 不支持。
 * 编码：不透明 → 24 位 BI_RGB（兼容性最好）；有透明 → 32 位 BITMAPV4HEADER + alpha 掩码。
 */
const sharp = require('sharp');

const MAX_PIXELS = 268402689; // 与 sharp 默认 limitInputPixels 一致

function isBmp(buf) {
  return Buffer.isBuffer(buf) && buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d; // 'BM'
}

/** 掩码 → { shift, max }，用于把位域分量缩放到 0-255 */
function maskInfo(mask) {
  if (!mask) return null;
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  let bits = 0;
  while ((mask >>> (shift + bits)) & 1) bits++;
  return { mask, shift, max: 2 ** bits - 1 };
}
const channel = (px, m) => (m ? Math.round((((px & m.mask) >>> m.shift) * 255) / m.max) : 0);

/** @returns {{ data: Buffer, width: number, height: number }} RGBA */
function decodeBmp(buf) {
  if (!isBmp(buf)) throw new Error('不是 BMP 文件');
  const dataOffset = buf.readUInt32LE(10);
  const hdrSize = buf.readUInt32LE(14);
  let width, height, bpp, compression = 0, clrUsed = 0;
  if (hdrSize === 12) { // BITMAPCOREHEADER
    width = buf.readUInt16LE(18); height = buf.readInt16LE(20); bpp = buf.readUInt16LE(24);
  } else if (hdrSize >= 40) {
    width = buf.readInt32LE(18); height = buf.readInt32LE(22); bpp = buf.readUInt16LE(28);
    compression = buf.readUInt32LE(30); clrUsed = buf.readUInt32LE(46);
  } else {
    throw new Error(`BMP 信息头长度异常（${hdrSize}）`);
  }
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw new Error(`BMP 尺寸无效：${width}×${height}`);
  if (compression === 1 || compression === 2) throw new Error('不支持 RLE 压缩的 BMP，请另存为未压缩 BMP 或 PNG');
  if (compression === 4 || compression === 5) throw new Error('不支持内嵌 JPEG/PNG 的 BMP，请直接使用 JPG/PNG 文件');
  if (![0, 3, 6].includes(compression)) throw new Error(`不支持的 BMP 压缩方式（${compression}）`);
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new Error(`不支持的 BMP 位深（${bpp}）`);

  // 位域掩码：INFO 头时紧跟在头后面，V2+ 头时在头内部——两种情况偏移都是 54
  let masks = null;
  if (bpp === 16 || bpp === 32) {
    if (compression === 3 || compression === 6) {
      const hasAlphaMask = compression === 6 || hdrSize >= 56;
      masks = {
        r: maskInfo(buf.readUInt32LE(54)), g: maskInfo(buf.readUInt32LE(58)), b: maskInfo(buf.readUInt32LE(62)),
        a: hasAlphaMask ? maskInfo(buf.readUInt32LE(66)) : null,
      };
    } else if (bpp === 16) {
      masks = { r: maskInfo(0x7c00), g: maskInfo(0x03e0), b: maskInfo(0x001f), a: null }; // 默认 X1R5G5B5
    }
  }

  let palette = null;
  if (bpp <= 8) {
    const entry = hdrSize === 12 ? 3 : 4;
    const extra = hdrSize === 40 ? (compression === 3 ? 12 : compression === 6 ? 16 : 0) : 0;
    const palOff = 14 + hdrSize + extra;
    const count = Math.min(clrUsed || 2 ** bpp, 256, Math.floor((dataOffset - palOff) / entry));
    palette = [];
    for (let i = 0; i < count; i++) {
      const o = palOff + i * entry;
      palette.push([buf[o + 2], buf[o + 1], buf[o]]);
    }
  }

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + rowSize * height > buf.length) throw new Error('BMP 文件不完整（像素数据被截断）');

  const out = Buffer.alloc(width * height * 4);
  let sawAlpha = false; // 32 位 BI_RGB 的第 4 字节多数软件写 0：全为 0 时视为不透明
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      let r, g, b, a = 255;
      if (bpp === 24) {
        const i = row + x * 3; b = buf[i]; g = buf[i + 1]; r = buf[i + 2];
      } else if (bpp === 32 && !masks) {
        const i = row + x * 4; b = buf[i]; g = buf[i + 1]; r = buf[i + 2]; a = buf[i + 3];
        if (a) sawAlpha = true;
      } else if (bpp === 16 || bpp === 32) {
        const px = bpp === 16 ? buf.readUInt16LE(row + x * 2) : buf.readUInt32LE(row + x * 4);
        r = channel(px, masks.r); g = channel(px, masks.g); b = channel(px, masks.b);
        if (masks.a) { a = channel(px, masks.a); if (a) sawAlpha = true; }
      } else {
        const bit = x * bpp;
        const idx = (buf[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        [r, g, b] = palette[idx] || [0, 0, 0];
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  const alphaChannel = bpp === 32 && (!masks || masks.a);
  if (alphaChannel && !sawAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { data: out, width, height };
}

/** BMP → PNG Buffer（低压缩级别：只是给 sharp 管线中转用） */
async function bmpToPng(buf) {
  const { data, width, height } = decodeBmp(buf);
  return sharp(data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
}

/** raw 像素（3 或 4 通道 RGB(A)）→ BMP Buffer */
function encodeBmp(data, width, height, channels) {
  let opaque = true;
  if (channels === 4) for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 24 : 32;
  const hdrSize = opaque ? 40 : 108;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const dataOffset = 14 + hdrSize;
  const out = Buffer.alloc(dataOffset + rowSize * height);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(dataOffset, 10);
  out.writeUInt32LE(hdrSize, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // 正数 = 自下而上，兼容性最好
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bpp, 28);
  out.writeUInt32LE(opaque ? 0 : 3, 30); // BI_RGB / BI_BITFIELDS
  out.writeUInt32LE(rowSize * height, 34);
  out.writeInt32LE(2835, 38); out.writeInt32LE(2835, 42); // 72 DPI
  if (!opaque) {
    out.writeUInt32LE(0x00ff0000, 54); out.writeUInt32LE(0x0000ff00, 58);
    out.writeUInt32LE(0x000000ff, 62); out.writeUInt32LE(0xff000000, 66);
    out.write('BGRs', 70, 'ascii'); // LCS_sRGB（小端存储即 'BGRs'）
  }
  for (let y = 0; y < height; y++) {
    let o = dataOffset + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      out[o++] = data[i + 2]; out[o++] = data[i + 1]; out[o++] = data[i];
      if (!opaque) out[o++] = data[i + 3];
    }
  }
  return out;
}

module.exports = { isBmp, decodeBmp, bmpToPng, encodeBmp };
