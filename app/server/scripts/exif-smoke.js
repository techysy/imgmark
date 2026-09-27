'use strict';
/**
 * 相机参数水印的冒烟测试：EXIF 解析 → 文字格式化 → 渲染 → 合成。
 *
 * 覆盖的都是「真实相机文件里长这样」的形态，不是理想化输入：
 *   - Canon 的 Model 自带品牌（"Canon EOS R6"）与不带两种
 *   - Nikon 的 Z 6_2 / Z6_3 两代下划线写法（2023-10 起 Z 后不带空格）
 *   - 镜头值拖的候选尾巴（"or Tamron Lens" / "or similar"）
 *   - 曝光时间在 ExifTool 那个 0.25001 分界两侧的表现
 *   - 无 EXIF / 空 EXIF 时整组跳过（不能画出空白水印）
 * 用法：node scripts/exif-smoke.js
 */
const assert = require('assert');
const sharp = require('sharp');
const { parseExif, readExif } = require('../src/core/exif');
const { formatCameraText } = require('../src/core/exiftext');
const { renderTextWatermark, checkFontAvailable } = require('../src/core/textmark');
const { composeGroups, applyCrop } = require('../src/core/watermark');

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const eq = (a, b, msg) => assert.strictEqual(a, b, `${msg || ''}\n  实际: ${JSON.stringify(a)}\n  期望: ${JSON.stringify(b)}`);

/** 造一张带指定 EXIF 的 JPEG（sharp 的 withMetadata 能写 EXIF） */
async function jpegWithExif(exif, w = 64, h = 48) {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: '#8899aa' } });
  if (exif) p = p.withMetadata({ exif });
  return p.jpeg().toBuffer();
}

(async () => {
  console.log('\n[1] EXIF 解析');
  {
    // sharp 把 EXIF 写成 'Exif\0\0' + TIFF；两种字节序都要能读
    const buf = await jpegWithExif({
      IFD0: { Make: 'Canon', Model: 'Canon EOS R6', DateTime: '2026:09:27 10:30:00' },
      IFD2: { LensModel: 'RF24-70mm F2.8 L IS USM', ExposureTime: '1/250' },
    });
    const e = await readExif(sharp, buf);
    ok('读得到 Make/Model', () => { eq(e.Make, 'Canon'); eq(e.Model, 'Canon EOS R6'); });
    ok('Rational 曝光时间换算成秒', () => assert(Math.abs(e.ExposureTime - 0.004) < 1e-6, `得到 ${e.ExposureTime}`));
    ok('子 IFD 的镜头被读到', () => eq(e.LensModel, 'RF24-70mm F2.8 L IS USM'));
  }
  {
    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    eq(await readExif(sharp, plain), null, '无 EXIF 应为 null');
    eq(parseExif(null), null);
    eq(parseExif(Buffer.alloc(0)), null);
    eq(parseExif(Buffer.from('not an exif buffer at all')), null);
    // 截断的缓冲也不算崩：缓冲头声明了长度但内容不够
    eq(parseExif(Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0])), null);
    ok('垃圾/空/截断输入一律 null，不抛异常', () => {});
  }

  console.log('\n[2] 机身名（品牌归一 + 去重）');
  const cam = (make, model) => formatCameraText({ Make: make, Model: model }, { fields: ['camera'] });
  ok('Canon：Model 自带品牌则不重复', () => eq(cam('Canon', 'Canon EOS R6'), 'Canon EOS R6'));
  ok('Canon：Model 不带品牌则拼上', () => eq(cam('Canon', 'EOS R5'), 'Canon EOS R5'));
  ok('Nikon CORPORATION → Nikon', () => eq(cam('NIKON CORPORATION', 'NIKON D850'), 'Nikon D850'));
  ok('Nikon Z 6_2（旧写法有空格）', () => eq(cam('NIKON CORPORATION', 'NIKON Z 6_2'), 'Nikon Z6 II'));
  ok('Nikon Z6_3（2023-10 起无空格）', () => eq(cam('NIKON CORPORATION', 'NIKON Z6_3'), 'Nikon Z6 III'));
  ok('Sony 不重复品牌', () => eq(cam('SONY', 'ILCE-7M4'), 'SONY ILCE-7M4'));
  ok('FUJIFILM 原样', () => eq(cam('FUJIFILM', 'X-T5'), 'FUJIFILM X-T5'));
  ok('Apple 手机', () => eq(cam('Apple', 'iPhone 15 Pro'), 'Apple iPhone 15 Pro'));
  // Leica 的 Model 是 "LEICA Q3"，品牌前缀会被 cleanModel 去掉（大小写不同也算重复）
  ok('Leica Camera AG → Leica，且不重复品牌', () => eq(cam('Leica Camera AG', 'LEICA Q3'), 'Leica Q3'));
  ok('OLYMPUS CORPORATION 归一为 OLYMPUS', () => eq(cam('OLYMPUS CORPORATION', 'OM-1'), 'OLYMPUS OM-1'));
  ok('大小写不敏感', () => eq(cam('sony', 'ILCE-7M4'), 'SONY ILCE-7M4'));
  ok('未知品牌剥公司后缀', () => eq(cam('RICOH IMAGING COMPANY, LTD.', 'GR III'), 'RICOH IMAGING GR III'));

  console.log('\n[3] 镜头');
  const lens = (l) => formatCameraText({ LensModel: l }, { fields: ['lens'] });
  ok('Canon RF 原样', () => eq(lens('RF24-70mm F2.8 L IS USM'), 'RF24-70mm F2.8 L IS USM'));
  ok('Sony FE 原样', () => eq(lens('FE 24-70mm F2.8 GM II'), 'FE 24-70mm F2.8 GM II'));
  ok('Nikon NIKKOR 原样（大写 NIKKOR + 小写 f/）', () => eq(lens('NIKKOR Z 14-24mm f/2.8 S'), 'NIKKOR Z 14-24mm f/2.8 S'));
  ok('砍掉 "or Tamron Lens" 候选尾巴', () => eq(lens('EF 300mm f/2.8L IS II USM or Tamron Lens'), 'EF 300mm f/2.8L IS II USM'));
  ok('砍掉 "or similar"', () => eq(lens('Canon EF 50mm f/1.8 STM or similar'), 'Canon EF 50mm f/1.8 STM'));
  ok('没有 LensModel 时用 LensSpecification 拼', () =>
    eq(formatCameraText({ LensSpecification: [15, 45, 3.5, 5.6] }, { fields: ['lens'] }), '15-45mm F3.5'));
  ok('定焦规格不写成区间', () =>
    eq(formatCameraText({ LensSpecification: [50, 50, 1.8, 1.8] }, { fields: ['lens'] }), '50mm F1.8'));

  console.log('\n[4] 曝光');
  const exp = (o) => formatCameraText(o, { fields: ['exposure'] });
  ok('1/250s', () => eq(exp({ ExposureTime: 0.004, FNumber: 2.8, ISO: 400 }), 'f/2.8 1/250s ISO400'));
  ok('快速门 1/8000s', () => eq(exp({ ExposureTime: 0.000125 }), '1/8000s'));
  ok('0.25s 仍用分数（ExifTool 分界 0.25001）', () => eq(exp({ ExposureTime: 0.25 }), '1/4s'));
  ok('0.5s 用秒而不是 1/2s', () => eq(exp({ ExposureTime: 0.5 }), '0.5s'));
  ok('长曝光 30s', () => eq(exp({ ExposureTime: 30, FNumber: 8 }), 'f/8 30s'));
  ok('ISO 数组取首个', () => eq(exp({ ISO: [100, 200] }), 'ISO100'));
  ok('缺 FNumber 时用 ApertureValue 反算', () => eq(exp({ ApertureValue: 3 }), 'f/2.8'));
  ok('等效焦距与物理不同时并记', () =>
    eq(exp({ FocalLength: 15, FocalLengthIn35mmFilm: 23 }), '15mm（等效 23mm）'));
  ok('等效焦距相同时只写一个', () => eq(exp({ FocalLength: 35, FocalLengthIn35mmFilm: 35 }), '35mm'));

  console.log('\n[5] 日期与整行');
  ok('EXIF 冒号格式转成短横线', () =>
    eq(formatCameraText({ DateTimeOriginal: '2026:09:27 16:55:56' }, { fields: ['date'] }), '2026-09-27 16:55'));
  ok('要秒时保留秒', () =>
    eq(formatCameraText({ DateTimeOriginal: '2026:09:27 16:55:56' }, { fields: ['datetime'] }), '2026-09-27 16:55:56'));
  ok('相机没设时间（0000）当没有', () =>
    eq(formatCameraText({ DateTimeOriginal: '0000:00:00 00:00:00' }, { fields: ['date'] }), ''));
  // 两个都勾会重复输出同一时间，规则是丢掉 date、保留更精确的 datetime
  ok('date 与 datetime 同时勾选只出一个（保留带秒的）', () =>
    eq(formatCameraText({ DateTimeOriginal: '2026:09:27 16:55:56' }, { fields: ['date', 'datetime'] }), '2026-09-27 16:55:56'));
  ok('字段缺失时不留空占位', () =>
    eq(formatCameraText({ Make: 'Canon', Model: 'EOS R6' }, { fields: ['camera', 'lens', 'exposure'] }), 'Canon EOS R6'));
  ok('前缀后缀生效', () =>
    eq(formatCameraText({ Make: 'Canon', Model: 'EOS R6' },
      { fields: ['camera'], prefix: 'shot on ', suffix: ' ©2026' }), 'shot on Canon EOS R6 ©2026'));
  ok('自定义分隔符', () =>
    eq(formatCameraText({ Make: 'Canon', Model: 'EOS R6' },
      { fields: ['brand', 'model'], separator: ' | ' }), 'Canon | EOS R6'));
  ok('无 EXIF → 空串（调用方据此跳过）', () => eq(formatCameraText(null), ''));
  ok('空对象 → 空串', () => eq(formatCameraText({}), ''));

  console.log('\n[6] 文字渲染');
  const font = await checkFontAvailable();
  ok('系统字体可用于渲染', () => assert(font.ok, font.reason));
  {
    const r = await renderTextWatermark('SONY ILCE-7M4 · FE 24-70mm F2.8 GM II');
    ok('渲染出非空 PNG 且尺寸合理', () => {
      assert(r.width > 100 && r.height > 10, `得到 ${r.width}x${r.height}`);
      assert(r.width / r.height > 10, '单行文字该是细长的');
    });
    const m = await renderTextWatermark('第一行\n第二行');
    ok('多行渲染更高', () => assert(m.height > r.height, `${m.height} vs ${r.height}`));
    const b = await renderTextWatermark('Canon EOS R6', { bg: '#000000', color: '#ffffff', padding: 16 });
    ok('带底色时不去边（底色是内容）', () => assert(b.height > 30, `得到 ${b.height}`));
    let threw = false;
    try { await renderTextWatermark('   '); } catch { threw = true; }
    ok('空白内容抛错而不是画出空白图', () => assert(threw, '应当抛错'));
    const cjk = await renderTextWatermark('2026-09-27 16:55 · 富士 X-E4');
    ok('中文/非 ASCII 可渲染', () => assert(cjk.width > 100, `得到 ${cjk.width}`));
    const esc = await renderTextWatermark('A & B < C > D "E"');
    ok('XML 特殊字符被转义（否则 librsvg 报错）', () => assert(esc.width > 50));
  }

  console.log('\n[7] 合成（含无 EXIF 跳过）');
  {
    const src = await jpegWithExif({
      IFD0: { Make: 'FUJIFILM', Model: 'X-E4' },
      IFD2: { LensModel: 'XC15-45mmF3.5-5.6 OIS PZ', ExposureTime: '1/125' },
    }, 400, 300);
    const spec = { fields: ['camera', 'lens', 'date'], style: { color: '#ffffff' } };
    const r = await composeGroups(src, [{ textSpec: spec, options: { position: 'se', sizePct: 40, marginPct: 3 } }],
      { format: 'jpeg', quality: 88, sizeBase: 'long' });
    const a = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(r.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let changed = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      for (let c = 0; c < 3; c++) if (Math.abs(a.data[i + c] - b.data[i + c]) > 30) { changed++; break; }
    }
    ok('有 EXIF 的图被画上文字', () => assert(changed > 100, `变化像素 ${changed}`));

    // 无 EXIF：整组跳过，原图字节不变（不能白跑一次有损编码）
    const plain = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#88aacc' } }).jpeg().toBuffer();
    const r2 = await composeGroups(plain, [{ textSpec: spec, options: { position: 'se', sizePct: 40 } }],
      { format: 'jpeg', quality: 88 });
    ok('无 EXIF 的图原样返回（字节不变、无重编码）', () => assert(plain.equals(r2.buffer), '字节应当完全一致'));
    ok('跳过时带 skipped 标记与正确扩展名', () => { eq(r2.skipped, true); eq(r2.ext, '.jpg'); });
  }

  console.log(`\n全部通过（${pass} 项）\n`);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
