'use strict';
/**
 * 选图打分（photo culling）：给文件夹里的图片评星级 + 打问题标记，
 * 结果写进每张图旁的 XMP sidecar（同名 .xmp），Lightroom / Bridge / Capture One
 * 导入即可按星与关键词筛选 —— 不改写原图一个字节。
 *
 * 两条评分路（可单用可并用）：
 *   - 本地启发式（免费、秒级）：直方图判曝光（死黑/死白占比）、
 *     拉普拉斯响应判虚焦、EXIF 快门/焦距判糊片风险
 *   - LLM 视觉（需先在发布页配置模型服务）：复用 copywriting 的 OpenAI 兼容客户端
 *
 * XMP 只带 xmp:Rating（1..5）与 dc:subject 关键词。Lightroom 的旗标（P/拒绝）
 * 是目录私有数据、不落 XMP，所以「淘汰」表达为 1 星 + 「淘汰」关键词。
 * 已有 sidecar（如 LR 写过的）做合并：换掉星级、关键词并集，
 * 且先把本工具上一次写入的固定词表清掉再并入，避免旧标记越积越多。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { readExif } = require('./exif');
const { listImages, mapPool } = require('./batch');
const { httpErr } = require('./copywriting');

// 本工具会写进 dc:subject 的固定问题词表（写 sidecar 前先从旧 sidecar 里剥掉这些）
const FLAGS = {
  overexposed: '曝光过度',
  underexposed: '曝光不足',
  blur: '虚焦',
  slowShutter: '快门过慢',
  reject: '淘汰',
};
const FLAG_SET = new Set(Object.values(FLAGS));

// ---------- 本地启发式 ----------
// 在缩小到 ≤400px 的灰度图上做全部统计：这个尺度下阈值才有可比性，全尺寸像素统计太慢也没必要
const ANALYZE_EDGE = 400;
async function analyzeLocal(buffer) {
  const img = sharp(buffer, { limitInputPixels: 50_000_000 }).rotate();
  const { data, info } = await img.clone()
    .resize(ANALYZE_EDGE, ANALYZE_EDGE, { fit: 'inside', withoutEnlargement: true })
    .greyscale().raw().toBuffer({ resolveWithObject: true });

  let sum = 0, low = 0, high = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum += v;
    if (v <= 2) low++;
    else if (v >= 253) high++;
  }
  const n = data.length || 1;
  const mean = sum / n;

  // 拉普拉斯响应的标准差 = 清晰度经典指标（variance of Laplacian）。
  // 值越大越锐，<3 基本是糊的（400px 缩图上的经验值，只做保守判定）
  let lapStd = null;
  try {
    const st = await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
      .stats();
    lapStd = st.channels[0].stdev;
  } catch { /* 个别格式（如索引色）拿不到 raw；清晰度判不了就跳过 */ }

  return {
    mean,
    clipLow: low / n,
    clipHigh: high / n,
    lapStd,
    width: info.width, height: info.height,
  };
}

/** 本地评分：默认 3 星起，曝光两头截断 -1、疑似虚焦 -2、清晰且曝光居中 +1 */
function rateLocal(metrics, exif) {
  const flags = [];
  let rating = 3;

  if (metrics.clipHigh > 0.03) { flags.push(FLAGS.overexposed); rating -= 1; }
  // 夜景本来就该暗：死黑多但整体不极端时不扣「曝光不足」，只在均值也很低时才判
  if (metrics.clipLow > 0.05 && metrics.mean < 45) { flags.push(FLAGS.underexposed); rating -= 1; }

  if (metrics.lapStd != null && metrics.lapStd < 3) { flags.push(FLAGS.blur); rating -= 2; }

  // 安全快门经验法则：快门慢于 1/等效焦距 且没有任何防抖信息可查 → 糊片风险
  if (exif && exif.ExposureTime && exif.FocalLengthIn35mmFilm >= 30 &&
      exif.ExposureTime > 1 / exif.FocalLengthIn35mmFilm) {
    flags.push(FLAGS.slowShutter);
  }

  if (metrics.lapStd != null && metrics.lapStd > 12 && !flags.length) rating += 1;
  return { rating: Math.max(1, Math.min(5, rating)), flags };
}

// ---------- XMP 与元数据评星 (内嵌 JPG / 独立 XMP) ----------
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function subjectBag(labels) {
  return `<dc:subject><rdf:Bag>${labels.map((l) => `<rdf:li xml:lang="x-default">${xmlEsc(l)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`;
}

/** 全新 sidecar 文本 */
function buildXmp(rating, labels) {
  const finalRating = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  const msRating = finalRating === 0 ? 0 : (finalRating === 1 ? 1 : (finalRating === 2 ? 25 : (finalRating === 3 ? 50 : (finalRating === 4 ? 75 : 99))));
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ImgMark">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmp:Rating="${finalRating}"
    MicrosoftPhoto:Rating="${msRating}">
   ${subjectBag(labels)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** 从 XMP 字符串中解析 rating 与 dc:subject 关键词 */
function parseXmpData(xmpText) {
  if (!xmpText) return { rating: 0, labels: [] };
  const m1 = xmpText.match(/xmp:Rating\s*=\s*["'](\d+)["']/i);
  const m2 = xmpText.match(/<xmp:Rating\b[^>]*>(\d+)<\/xmp:Rating>/i);
  const rating = m1 ? parseInt(m1[1]) : (m2 ? parseInt(m2[1]) : 0);

  const labels = [];
  const bag = xmpText.match(/<dc:subject\b[\s\S]*?<\/dc:subject>/i);
  if (bag) {
    for (const m of bag[0].matchAll(/<rdf:li\b[^>]*>([^<]*)<\/rdf:li>/gi)) {
      const v = m[1].trim();
      if (v) labels.push(v);
    }
  }
  return { rating, labels };
}

/** 在已有 XMP 字符串中安全更新 rating 与 dc:subject，不破坏任何原有属性或子标签 */
function updateXmpData(xmpText, { rating, labels = [] }) {
  let s = xmpText;
  const clean = [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];
  const finalRating = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  // 1 星附带淘汰，0 星或 >=2 星移除淘汰
  const finalLabels = finalRating === 1
    ? (!clean.includes(FLAGS.reject) ? [...clean, FLAGS.reject] : clean)
    : clean.filter(l => l !== FLAGS.reject);
  const msRating = finalRating === 0 ? 0 : (finalRating === 1 ? 1 : (finalRating === 2 ? 25 : (finalRating === 3 ? 50 : (finalRating === 4 ? 75 : 99))));

  // 1. 保留原图自带的非本工具自动标记
  const existing = parseXmpData(s);
  const keep = existing.labels.filter(l => !FLAG_SET.has(l) && !finalLabels.includes(l));
  const allLabels = [...finalLabels, ...keep];

  // 2. 更新或插入 xmp:Rating
  if (/xmp:Rating\s*=\s*["']\d+["']/i.test(s)) {
    s = s.replace(/xmp:Rating\s*=\s*["']\d+["']/i, `xmp:Rating="${finalRating}"`);
  } else if (/<xmp:Rating\b[^>]*>[\s\S]*?<\/xmp:Rating>/i.test(s)) {
    s = s.replace(/<xmp:Rating\b[^>]*>[\s\S]*?<\/xmp:Rating>/i, `<xmp:Rating>${finalRating}</xmp:Rating>`);
  } else {
    s = s.replace(/<rdf:Description\b/i, `<rdf:Description xmp:Rating="${finalRating}"`);
  }

  // 3. 更新或插入 MicrosoftPhoto:Rating (让 Windows 资源管理器直接认出星级)
  if (/MicrosoftPhoto:Rating\s*=\s*["']\d+["']/i.test(s)) {
    s = s.replace(/MicrosoftPhoto:Rating\s*=\s*["']\d+["']/i, `MicrosoftPhoto:Rating="${msRating}"`);
  } else if (/<MicrosoftPhoto:Rating\b[^>]*>[\s\S]*?<\/MicrosoftPhoto:Rating>/i.test(s)) {
    s = s.replace(/<MicrosoftPhoto:Rating\b[^>]*>[\s\S]*?<\/MicrosoftPhoto:Rating>/i, `<MicrosoftPhoto:Rating>${msRating}</MicrosoftPhoto:Rating>`);
  } else if (s.includes('xmlns:MicrosoftPhoto=')) {
    // 命名空间已声明（如 Lightroom 写过的文件），只补属性 —— 重复 xmlns 声明是非法 XML
    s = s.replace(/<rdf:Description\b/i, `<rdf:Description MicrosoftPhoto:Rating="${msRating}"`);
  } else {
    s = s.replace(/<rdf:Description\b/i, `<rdf:Description xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/" MicrosoftPhoto:Rating="${msRating}"`);
  }

  // 4. 确保命名空间存在
  if (!s.includes('xmlns:xmp=')) {
    s = s.replace(/<rdf:Description\b/i, '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"');
  }

  // 5. 更新或插入 dc:subject
  const bagContent = allLabels.map(l => `<rdf:li xml:lang="x-default">${xmlEsc(l)}</rdf:li>`).join('');
  const newSubject = `<dc:subject><rdf:Bag>${bagContent}</rdf:Bag></dc:subject>`;
  if (/<dc:subject\b[\s\S]*?<\/dc:subject>/i.test(s)) {
    s = s.replace(/<dc:subject\b[\s\S]*?<\/dc:subject>/i, newSubject);
  } else {
    s = s.replace(/<\/rdf:Description>/i, `   ${newSubject}\n  </rdf:Description>`);
  }

  return s;
}

/**
 * 扫描 JPEG 缓冲的段头，找 XMP APP1 段。
 * 返回 { seg, complete }：seg = {offset, len, xmpText} 或 null；
 * complete = 是否扫到了 SOS/EOI（即看完了全部段头）。false 表示缓冲被截断、
 * 后面可能还有段没看到 —— 调用方据此决定要不要整文件重读，不能就此断定「没有 XMP」。
 */
function scanJpegXmp(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) {
    return { seg: null, complete: false };
  }
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xFF) return { seg: null, complete: false }; // 结构异常，不下结论
    const marker = buf[offset + 1];
    if (marker === 0xDA || marker === 0xD9) return { seg: null, complete: true }; // 进入图像数据
    const len = buf.readUInt16BE(offset + 2);
    if (offset + 2 + len > buf.length) return { seg: null, complete: false }; // 段本身被截断
    if (marker === 0xE1 && len >= 2 + XMP_HEADER.length) {
      const head = buf.toString('latin1', offset + 4, offset + 4 + XMP_HEADER.length);
      if (head === XMP_HEADER) {
        return { seg: { offset, len, xmpText: buf.toString('utf8', offset + 4 + XMP_HEADER.length, offset + 2 + len) }, complete: true };
      }
    }
    offset += 2 + len;
  }
  return { seg: null, complete: false };
}

const isJpgExt = (f) => /\.(jpe?g)$/i.test(String(f || ''));

/**
 * 读取图片星级与标签：
 * - 如果是 JPG，先只读文件头部 128KB 解析内嵌 XMP（极速，避免网络盘/机械盘读整张大图）；
 *   只有当 128KB 没扫完段头（EXIF/ICC 段把 XMP 挤到更靠后，或段被截断）时才整文件重读 ——
 *   正常相机 JPG 的段头远小于 128KB，扫到 SOS 就能确定没有 XMP，不会为它读整张图；
 * - 若无内嵌 XMP 或非 JPG 格式，尝试读取同名 .xmp sidecar。
 */
function readRating(file) {
  if (isJpgExt(file)) {
    const verdict = (seg) => {
      if (seg) {
        const res = parseXmpData(seg.xmpText);
        if (res.rating > 0 || res.labels.length) return { embedded: true, ...res };
      }
      return null;
    };
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const headBuf = Buffer.alloc(131072);
      const bytesRead = fs.readSync(fd, headBuf, 0, 131072, 0);
      fs.closeSync(fd);
      fd = null;
      const { seg, complete } = scanJpegXmp(headBuf.slice(0, bytesRead));
      const hit = verdict(seg);
      if (hit) return hit;
      if (complete) return finishRead(file); // 段头已扫完且没有 XMP → 不用再读，直接看 sidecar
    } catch {
      if (fd) try { fs.closeSync(fd); } catch {}
    }
    // 头部结论不可靠（截断/结构异常/IO 失败）→ 整文件读一次兜底
    try {
      const hit = verdict(scanJpegXmp(fs.readFileSync(file)).seg);
      if (hit) return hit;
    } catch { /* 读不了就当没有内嵌 XMP */ }
  }
  return finishRead(file);
}

// 内嵌没有 → 找同名 .xmp sidecar
function finishRead(file) {
  const xmp = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.xmp');
  try {
    const text = fs.readFileSync(xmp, 'utf8');
    const res = parseXmpData(text);
    return { sidecar: true, xmp, ...res };
  } catch { return { rating: 0, labels: [] }; }
}

async function readRatingAsync(file) {
  if (isJpgExt(file)) {
    const verdict = (seg) => {
      if (seg) {
        const res = parseXmpData(seg.xmpText);
        if (res.rating > 0 || res.labels.length) return { embedded: true, ...res };
      }
      return null;
    };
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
      const headBuf = Buffer.alloc(131072);
      const { bytesRead } = await fh.read(headBuf, 0, 131072, 0);
      await fh.close();
      fh = null;
      const { seg, complete } = scanJpegXmp(headBuf.slice(0, bytesRead));
      const hit = verdict(seg);
      if (hit) return hit;
      if (complete) return finishReadAsync(file);
    } catch {
      if (fh) try { await fh.close(); } catch {}
    }
    try {
      const hit = verdict(scanJpegXmp(await fs.promises.readFile(file)).seg);
      if (hit) return hit;
    } catch { /* 读不了就当没有内嵌 XMP */ }
  }
  return finishReadAsync(file);
}

async function finishReadAsync(file) {
  const xmp = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.xmp');
  try {
    const text = await fs.promises.readFile(xmp, 'utf8');
    const res = parseXmpData(text);
    return { sidecar: true, xmp, ...res };
  } catch { return { rating: 0, labels: [] }; }
}

/**
 * 写入图片星级与标签：
 * - 如果是 JPG，采用无损二进制注入直接写回 JPG 头部 XMP 段（Windows 资源管理器、Lightroom 瞬间识别，0 画质损失）；
 *   内嵌成功后清理旁边的同名 .xmp sidecar（其内容已并入内嵌 XMP，不会丢）；
 * - 如果是非 JPG，写入同名 .xmp sidecar（已有则合并）。
 */
function writeRating(file, { rating, labels = [] }) {
  const sidecarPath = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.xmp');
  // 同名 sidecar 里已有的关键词先并进来：JPG 内嵌成功后会删掉它，不并就丢了。
  // 只并用户自己的关键词 —— 本工具词表的旧标记不并，随新一轮评分清掉再重写
  let carried = [];
  try { carried = parseXmpData(fs.readFileSync(sidecarPath, 'utf8')).labels; } catch {}
  const provided = [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];
  const merged = [...provided, ...carried.filter((l) => !provided.includes(l) && !FLAG_SET.has(l))];

  if (isJpgExt(file)) {
    try {
      const buf = fs.readFileSync(file);
      const { seg } = scanJpegXmp(buf);
      // 没有内嵌 XMP 时构造一个空骨架，统一走 updateXmpData（评分/标签的规范化只写一处）
      const newXmp = updateXmpData(
        seg ? seg.xmpText : buildXmp(0, []),
        { rating, labels: merged },
      );
      const payload = Buffer.from(newXmp, 'utf8');
      const header = Buffer.from(XMP_HEADER, 'latin1');
      const segLen = 2 + header.length + payload.length;
      const app1 = Buffer.concat([
        Buffer.from([0xFF, 0xE1, segLen >> 8, segLen & 0xFF]),
        header,
        payload
      ]);
      const outBuf = seg
        ? Buffer.concat([buf.slice(0, seg.offset), app1, buf.slice(seg.offset + 2 + seg.len)])
        : Buffer.concat([buf.slice(0, 2), app1, buf.slice(2)]);
      fs.writeFileSync(file, outBuf);

      // 内嵌成功，sidecar 里的东西已在上面并入，删掉碎片保持目录整洁
      if (fs.existsSync(sidecarPath)) {
        try { fs.unlinkSync(sidecarPath); } catch {}
      }

      return { file, embedded: true, rating };
    } catch (e) {
      console.warn(`[culling] 内嵌写入 JPG 失败，回退到 sidecar: ${e.message}`);
    }
  }

  // 非 JPG 或 JPG 内嵌失败的回退：写入同名 .xmp sidecar
  let oldXmp = null;
  try { oldXmp = fs.readFileSync(sidecarPath, 'utf8'); } catch {}
  const newXmp = oldXmp ? updateXmpData(oldXmp, { rating, labels: merged }) : buildXmp(rating, merged);
  fs.writeFileSync(sidecarPath, newXmp);
  return { file, sidecar: true, xmp: sidecarPath, rating };
}

// 兼容别名
const readXmpSidecar = readRating;
const writeXmpSidecar = writeRating;

// ---------- 批量选图 ----------
// 并发池复用 batch.js 的 mapPool

/**
 * 批量评分：本地启发式（直方图判曝光、拉普拉斯判虚焦、EXIF 安全快门判糊片风险）。
 * AI 视觉评分已移除——评星这件事人眼看更靠谱，AI 只在发布文案里用。
 *
 * @param {object} p
 *   inputDir 输入目录（sidecar 写在图片旁边，需可写）
 *   recursive 含子目录
 *   writeXmp 默认 true；false 只回传结果不落盘
 *   concurrency 默认 4
 *   authorizeInput(file) 每个文件处理前的授权钩子（fnOS）
 *   onProgress({done,total,current,ok,error})
 */
async function runCull(p) {
  const {
    inputDir, recursive = false, writeXmp = true, concurrency = null,
    authorizeInput = async () => {}, onProgress = () => {},
  } = p;

  const list = (await listImages(inputDir, { recursive, skipDirs: new Set() })).sort();
  const limit = concurrency || 4;
  let done = 0;
  const results = [];

  const processOne = async (file) => {
    await authorizeInput(file);
    const buf = await fs.promises.readFile(file);
    const metrics = await analyzeLocal(buf);
    const exif = await readExif(sharp, buf);
    const verdict = rateLocal(metrics, exif);
    let xmpPath = null;
    if (writeXmp) xmpPath = writeXmpSidecar(file, { rating: verdict.rating, labels: verdict.flags }).xmp || null;
    return { input: file, rating: verdict.rating, flags: verdict.flags,
      metrics: { clipLow: +metrics.clipLow.toFixed(4), clipHigh: +metrics.clipHigh.toFixed(4), lapStd: metrics.lapStd == null ? null : +metrics.lapStd.toFixed(2) },
      xmp: xmpPath };
  };

  // done 统计成功与失败：job.done 必须能走到 total，失败数也要在进度里可见
  const settled = await mapPool(list, limit, async (file) => {
    done++;
    try {
      const value = await processOne(file);
      onProgress({ done, total: list.length, current: file, ok: true, error: null });
      return value;
    } catch (e) {
      onProgress({ done, total: list.length, current: file, ok: false, error: e.message });
      throw e;
    }
  });

  let ok = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const s = settled[i];
    if (s.ok) { ok++; results.push(s.value); }
    else { failed++; results.push({ input: list[i], rating: null, flags: [], error: s.error.message }); }
  }
  return { total: list.length, ok, failed, results };
}

module.exports = {
  FLAGS, FLAG_SET,
  analyzeLocal, rateLocal,
  readRating, readRatingAsync, writeRating,
  readXmpSidecar, writeXmpSidecar, buildXmp,
  runCull,
};
