'use strict';
/**
 * 把 EXIF 字段格式化成「相机水印」文字（如 SONY α7 IV · FE 24-70mm F2.8 GM II · 35mm f/2.8 1/250s ISO400）。
 *
 * 设计要点：
 *   - 字段可自由组合（模板化）：用户勾哪几项就出哪几项，中间用分隔符连起来
 *   - 缺失字段静默跳过，不留空占位（「· · 」这种残渣比少一项更难看）
 *   - 品牌归一化：Canon/NIKON CORPORATION/SONY 等写法五花八门，统一成本水印里好看的形态；
 *     Model 里已经含品牌时（"Canon EOS R6"）不再重复拼一次
 */

/** 品牌别名 → 展示名。键统一按「去掉空格、大写」归一后比较 */
const BRAND_ALIAS = {
  canon: 'Canon',
  nikoncorporation: 'Nikon', nikon: 'Nikon',
  sony: 'SONY',
  fujifilm: 'FUJIFILM',
  panasonic: 'Panasonic', panasoniccorporation: 'Panasonic',
  // 机身丝印是 OLYMPUS，就写 OLYMPUS（换标后的新机才写 OM SYSTEM）
  olympus: 'OLYMPUS', olympuscorporation: 'OLYMPUS', olympusimaging: 'OLYMPUS', 'olympusimagingcorp': 'OLYMPUS',
  omsystem: 'OM SYSTEM', omdigital: 'OM SYSTEM', omdigitalsolutions: 'OM SYSTEM',
  leica: 'Leica', leicacameraag: 'Leica',
  ricoh: 'RICOH', pentax: 'PENTAX', ricohimaging: 'RICOH',
  apple: 'Apple',
  samsung: 'Samsung', xiaomi: 'Xiaomi', huawei: 'HUAWEI', oppo: 'OPPO', vivo: 'vivo',
  google: 'Google', motorola: 'Motorola', oneplus: 'OnePlus', honor: 'HONOR',
  dji: 'DJI', gopro: 'GoPro', hasselblad: 'Hasselblad', sigma: 'Sigma', tamron: 'Tamron',
  zeiss: 'ZEISS', carlzeiss: 'ZEISS',
};

function normBrand(make) {
  if (!make) return '';
  const key = String(make).replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (BRAND_ALIAS[key]) return BRAND_ALIAS[key];
  // 没收录的：剥掉公司后缀（"RICOH IMAGING COMPANY, LTD." → "RICOH IMAGING"），保留原样。
  // 逐个剥而不是一次匹配：后缀可能叠着出现（COMPANY, LTD. 连着来）
  let s = String(make).trim();
  for (let i = 0; i < 3; i++) {
    // 后缀前面必须真有分隔（空格/逗号）：写成可空边界会把 TELCO 这类词尾当成 "CO" 剥掉
    const t = s.replace(/[\s,，]+(corporation|corp\.?|company|inc\.?|ltd\.?|limited|co\.?|gmbh|ag|k\.?k\.?|s\.?a\.?s\.?|pty\.?\s*ltd\.?)\s*$/i, '').trim();
    if (t === s) break;
    s = t;
  }
  return s || String(make).trim();
}

/**
 * 相机名：品牌 + 型号，但型号里已含品牌时不重复。
 *   Nikon 的 "NIKON Z 6_2" → "Nikon Z6 II"（下划线是版本号的内部写法）
 */
function cameraName(exif) {
  if (!exif) return '';
  const brand = normBrand(exif.Make);
  let model = String(exif.Model || '').trim();
  if (!model) return brand;
  model = cleanModel(model, brand);
  if (!brand) return model;
  // 型号里已经带了品牌（"Canon EOS R6" / "SONY ILCE-7M4" 不会带，但 Canon 常带）→ 不再拼
  const flatModel = model.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const flatBrand = brand.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (flatBrand && flatModel.startsWith(flatBrand)) return model;
  return `${brand} ${model}`;
}

/** 型号清洗：去掉 Make 的重复前缀、把 Nikon 的 "Z 6_2" 还原成 "Z6 II" */
function cleanModel(model, brand) {
  let s = model;
  // 去掉与品牌重复的前缀（"NIKON CORPORATION NIKON Z 6_2" 这类嵌套）
  s = s.replace(/^(NIKON CORPORATION|NIKON|CANON|SONY|FUJIFILM|PANASONIC|OLYMPUS|OM SYSTEM|LEICA|APPLE)\s+/i, '');
  // Nikon：Z 6_2 → Z6 II，Z 7_2 → Z7 II；D 系列无下划线不受影响
  s = s.replace(/\b([A-Za-z]+)\s*(\d+)_(\d+)\b/, (m, p, a, b) => {
    const roman = ['', 'I', 'II', 'III', 'IV', 'V'][+b] || b;
    return `${p}${a} ${roman}`;
  });
  return s.trim();
}

/**
 * 曝光时间。分界取 ExifTool 的 0.25001（业界惯例）：
 *   < 0.25001s → 分数（1/8000s、1/250s）；≥ → 秒（0.3s、0.5s、30s）
 * 用 1s 当分界的话 0.5s 会被写成「1/2s」，与相机/看图软件显示的不一致。
 */
const EXPOSURE_FRACTION_MAX = 0.25001;
function exposureText(t) {
  if (typeof t !== 'number' || !isFinite(t) || t <= 0) return '';
  if (t < EXPOSURE_FRACTION_MAX) {
    const denom = Math.round(1 / t);
    // 1/250、1/8000 这类整数分母直接写；非整数分母回落到秒
    if (Math.abs(denom - 1 / t) <= 0.01 * denom) return `1/${denom}s`;
  }
  return `${Number(t.toFixed(1))}s`;
}

/** 光圈：Exif 里可能没有 FNumber，只有 ApertureValue（APEX），换算 F = 2^(AV/2) */
function apertureText(exif) {
  let f = exif && exif.FNumber;
  if (typeof f !== 'number' && exif && typeof exif.ApertureValue === 'number') {
    f = Math.pow(2, exif.ApertureValue / 2);
  }
  if (typeof f !== 'number' || !isFinite(f) || f <= 0) return '';
  return `f/${Number(f.toFixed(1))}`;
}

function isoText(exif) {
  let v = exif && exif.ISO;
  if (Array.isArray(v)) v = v[0];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `ISO${Math.round(n)}` : '';
}

/** 焦距：等效焦距（35mm）与物理焦距不同时并记，如 "35mm（等效 52mm）" */
function focalText(exif) {
  const f = Number(exif && exif.FocalLength);
  if (!Number.isFinite(f) || f <= 0) return '';
  const eq = Number(exif && exif.FocalLengthIn35mmFilm);
  const fTxt = `${Number(f.toFixed(f % 1 ? 1 : 0))}mm`;
  if (Number.isFinite(eq) && eq > 0 && Math.abs(eq - f) > 0.5) return `${fTxt}（等效 ${Math.round(eq)}mm）`;
  return fTxt;
}

/**
 * 镜头：LensModel 优先；没有就用 LensSpecification（[最短焦, 最长焦, 最大光圈, 最小光圈]）拼一个。
 * 很多手机/老机器没有 LensModel。
 */
function lensText(exif) {
  if (!exif) return '';
  let lens = String(exif.LensModel || '').trim();
  if (lens) {
    // 一个 LensType 对应多支镜头时，值里会拖一条候选尾巴："…USM or Tamron Lens"。
    // 也有厂商写 "or similar"。水印里只要主名字，尾巴一律砍掉
    lens = lens.replace(/\s+(?:or|and)\s+(?:similar|[A-Za-z][\w&.\- ]*?\s+Lens)\b.*$/i, '').trim();
    return lens;
  }
  const spec = exif.LensSpecification;
  if (Array.isArray(spec) && spec.length >= 2) {
    const [a, b, ap1] = spec.map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
    const range = a === b ? `${a}mm` : `${a}-${b}mm`;
    return Number.isFinite(ap1) ? `${range} F${Number(ap1.toFixed(1))}` : range;
  }
  return '';
}

/** 拍摄时间：EXIF 是 "2026:09:27 16:55:56"，水印里写成 "2026-09-27 16:55" */
function dateText(exif, withSeconds) {
  const raw = (exif && (exif.DateTimeOriginal || exif.DateTime)) || '';
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(raw));
  if (!m) return '';
  const [, Y, Mo, D, H, Mi, S] = m;
  // 相机没设时间时会写 0000:00:00，这种当没有
  if (Y === '0000') return '';
  const base = `${Y}-${Mo}-${D} ${H}:${Mi}`;
  return withSeconds && S ? `${base}:${S}` : base;
}

/** 所有可输出的字段；key 用于前后端约定的选项名 */
const FIELD_BUILDERS = {
  camera: (e) => cameraName(e),
  lens: (e) => lensText(e),
  exposure: (e) => [focalText(e), apertureText(e), exposureText(e && e.ExposureTime), isoText(e)].filter(Boolean).join(' '),
  date: (e) => dateText(e, false),
  datetime: (e) => dateText(e, true),
  software: (e) => String((e && e.Software) || '').trim(),
  brand: (e) => normBrand(e && e.Make),
  model: (e) => cleanModel(String((e && e.Model) || '').trim(), normBrand(e && e.Make)),
};
const FIELD_KEYS = Object.keys(FIELD_BUILDERS);

/** 默认输出顺序：机身 · 镜头 · 曝光 · 日期。brand/model/software 是可选的拆分字段 */
const DEFAULT_FIELDS = ['camera', 'lens', 'exposure', 'date'];

/**
 * 拼出相机水印文字。
 * @param {object} exif parseExif 的结果（可为 null）
 * @param {object} o
 *   fields: string[] 要输出的字段（见 FIELD_KEYS），按给定顺序拼接；默认 DEFAULT_FIELDS
 *   separator: 分隔符（默认 ' · '）
 *   prefix/suffix: 前后缀（默认空）
 * @returns {string} 全字段都取不到时返回空串（调用方据此跳过文字水印）
 */
function formatCameraText(exif, o = {}) {
  const { separator = ' · ', prefix = '', suffix = '' } = o;
  // date 与 datetime 同时勾选时只出一个，否则同一时间会连着出现两遍
  let fields = Array.isArray(o.fields) && o.fields.length ? o.fields.slice() : DEFAULT_FIELDS.slice();
  if (fields.includes('date') && fields.includes('datetime')) {
    fields = fields.filter((f) => f !== 'date');
  }
  const parts = [];
  for (const k of fields) {
    const build = FIELD_BUILDERS[k];
    if (!build) continue;
    let v = '';
    try { v = build(exif) || ''; } catch { v = ''; }
    if (v) parts.push(v);
  }
  if (!parts.length) return '';
  return `${prefix}${parts.join(separator)}${suffix}`;
}

module.exports = {
  formatCameraText, cameraName, lensText, exposureText, apertureText, isoText,
  focalText, dateText, normBrand, cleanModel, FIELD_KEYS, DEFAULT_FIELDS,
};
