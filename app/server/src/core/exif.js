'use strict';
/**
 * 极简 EXIF 读取器：只取「相机水印」用得上的几个字段。
 *
 * 为什么自己写而不是装 exifr/piexif：
 *   - 只需要 IFD0 的 Make/Model + Exif 子 IFD 的十来个 tag，一个 200 行的解析器就够；
 *     多一个依赖意味着桌面壳打包体积、npm ci 时间、以及上游 CVE 都要跟着涨
 *   - sharp 已经能把 EXIF 抽成一段 TIFF/EXIF 缓冲（metadata().exif），
 *     免去了在 JPEG/HEIC 里找 APP1 段的活
 *
 * 容错优先：任何一处不符合预期就返回已解析到的部分（或 null），绝不抛异常 ——
 * 水印合成不该因为一张图的 EXIF 长得怪就整个失败。
 *
 * 输入缓冲的两种形态都支持：
 *   - 'Exif\0\0' + TIFF  （sharp 给的形态）
 *   - 裸 TIFF            （直接读文件时可能遇到）
 */

// 只列需要的 tag。0x0112/0x8769 等结构性 tag 在代码里单独处理
const IFD0_TAGS = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x0112: 'Orientation',
};
const EXIF_TAGS = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8822: 'ExposureProgram',
  0x8827: 'ISO',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9204: 'ExposureBiasValue',
  0x9207: 'MeteringMode',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0x9290: 'SubSecTimeOriginal',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa432: 'LensSpecification',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
  0xa435: 'LensSerialNumber',
};
// GPS：可选的「拍摄地点」水印。值多为 RATIONAL
const GPS_TAGS = {
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0006: 'GPSAltitude',
  0x001d: 'GPSDateStamp',
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** TIFF 条目里的定长数值：≤4 字节时内联在条目末尾，否则在别处（vo 是相对 TIFF 头的偏移） */
function readValue(view, tiffStart, buf, entryOff, type, count) {
  const size = TYPE_SIZE[type];
  if (!size) return null;
  const total = size * count;
  const dataOff = entryOff + 8; // 条目里 4 字节的值/偏移字段
  const start = total <= 4 ? dataOff : tiffStart + view.getUint32(dataOff, view._le);
  if (start < 0 || start + total > buf.length) return null;

  if (type === 2) { // ASCII：读到 NUL 为止，去掉尾部空白
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = buf[start + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\0+$/, '').trim();
  }

  const one = (o) => {
    const le = view._le;
    switch (type) {
      case 1: case 7: return view.getUint8(o);
      case 3: return view.getUint16(o, le);
      case 4: return view.getUint32(o, le);
      case 6: return view.getInt8(o);
      case 8: return view.getInt16(o, le);
      case 9: return view.getInt32(o, le);
      case 5: { const n = view.getUint32(o, le), d = view.getUint32(o + 4, le); return d ? n / d : 0; }
      case 10: { const n = view.getInt32(o, le), d = view.getInt32(o + 4, le); return d ? n / d : 0; }
      case 11: return view.getFloat32(o, le);
      case 12: return view.getFloat64(o, le);
      default: return null;
    }
  };
  const vals = [];
  for (let i = 0; i < count; i++) vals.push(one(start + i * size));
  return count === 1 ? vals[0] : vals;
}

/**
 * 解析一段 EXIF/TIFF 缓冲。
 * @param {Buffer} buf sharp 的 metadata().exif，或裸 TIFF 缓冲
 * @returns {object|null} 扁平化的字段对象（缺失的字段不出现在结果里）
 */
function parseExif(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  // sharp 给的缓冲带 JPEG APP1 的 'Exif\0\0' 头；裸 TIFF 没有
  let base = 0;
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'Exif') base = 6;
  if (base + 8 > buf.length) return null;

  const bo = buf.toString('latin1', base, base + 2);
  const le = bo === 'II';
  if (!le && bo !== 'MM') return null;
  const view = { getUint8: (o) => buf.readUInt8(o), getUint16: (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    getUint32: (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
    getInt8: (o) => buf.readInt8(o), getInt16: (o) => (le ? buf.readInt16LE(o) : buf.readInt16BE(o)),
    getInt32: (o) => (le ? buf.readInt32LE(o) : buf.readInt32BE(o)),
    getFloat32: (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o)),
    getFloat64: (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o)), _le: le };
  if (view.getUint16(base + 2) !== 0x2a) return null;

  /** 读一个 IFD，返回 { tag: {type,count,entryOff} } */
  const readIfd = (off) => {
    const at = base + off;
    if (off <= 0 || at + 2 > buf.length) return null;
    const n = view.getUint16(at);
    if (n > 4096) return null; // 条目数离谱 → 缓冲错位，放弃
    const out = {};
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > buf.length) break;
      out[view.getUint16(e)] = { type: view.getUint16(e + 2), count: view.getUint32(e + 4), entryOff: e };
    }
    return out;
  };

  const ifd0 = readIfd(view.getUint32(base + 4));
  if (!ifd0) return null;
  const out = {};
  const take = (ifd, map) => {
    if (!ifd) return;
    for (const [tagStr, name] of Object.entries(map)) {
      const ent = ifd[+tagStr];
      if (!ent) continue;
      // 数组形态的 tag 只在真有多个值时才取数组，单值直接取标量
      const v = readValue(view, base, buf, ent.entryOff, ent.type, ent.count);
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v) && v.length === 1) out[name] = v[0];
      else out[name] = v;
    }
  };
  take(ifd0, IFD0_TAGS);
  // 子 IFD 的指针恰好是 4 字节内联值，直接取
  const subIfd = (tag) => {
    const ent = ifd0[tag];
    if (!ent) return null;
    const off = readValue(view, base, buf, ent.entryOff, 4, 1);
    return typeof off === 'number' ? readIfd(off) : null;
  };
  take(subIfd(0x8769), EXIF_TAGS); // Exif 子 IFD
  take(subIfd(0x8825), GPS_TAGS);  // GPS 子 IFD
  return Object.keys(out).length ? out : null;
}

/** 从 sharp 的 metadata() 结果里取 EXIF 并解析（BMP 之类没有 EXIF 的返回 null） */
async function readExif(sharpLib, buffer) {
  try {
    const meta = await sharpLib(buffer).metadata();
    if (!meta || !meta.exif) return null;
    return parseExif(meta.exif);
  } catch { return null; }
}

module.exports = { parseExif, readExif, IFD0_TAGS, EXIF_TAGS, GPS_TAGS };
