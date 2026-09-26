'use strict';
/**
 * ImgMark 冒烟测试：fixtures 生成 → 去底 → 合成 → 批量 → CLI → HTTP API 全链路。
 * 运行：node scripts/smoke-test.js（在仓库根目录）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const sharp = require(path.join(__dirname, '..', 'app', 'server', 'node_modules', 'sharp'));

const { prepareWatermark, mergeWatermarks, composeWatermark } = require('../app/server/src/core/watermark');
const { runBatch, expectedExt, isInside } = require('../app/server/src/core/batch');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'imgmark-test-'));
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name, e) => { fail++; console.error(`  ✗ ${name}: ${e.message}`); };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// ---------- fixtures ----------
async function makeFixtures() {
  const f = {};
  const logoSvg = (bg) => `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="300" fill="${bg}"/>
    <circle cx="150" cy="120" r="70" fill="#2563eb"/>
    <path d="M240 190 L300 90 L360 190 Z" fill="#16a34a"/>
    <text x="80" y="260" font-size="56" font-family="sans-serif" fill="#111" font-weight="bold">LOGO</text>
  </svg>`;
  f.dir = TMP;
  f.logoWhiteJpg = path.join(TMP, 'logo-white.jpg');
  await sharp(Buffer.from(logoSvg('#ffffff'))).jpeg({ quality: 92 }).toFile(f.logoWhiteJpg);
  f.logoBlackPng = path.join(TMP, 'logo-black.png');
  await sharp(Buffer.from(logoSvg('#0a0a0a'))).png().toFile(f.logoBlackPng);
  f.wmSvg = path.join(TMP, 'wm-color.svg');
  await fs.promises.writeFile(f.wmSvg, `<svg width="200" height="120" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="100" cy="60" rx="90" ry="50" fill="#ef4444"/>
    <text x="55" y="75" font-size="36" font-family="sans-serif" fill="#fff" font-weight="bold">IMG</text>
  </svg>`);
  // 最小合法 PDF（红方块），改名 .ai —— 模拟 PDF 兼容 AI 文件
  f.logoAi = path.join(TMP, 'logo.ai');
  const content = '0.85 0.15 0.15 rg\n40 40 120 120 re f\n';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  await fs.promises.writeFile(f.logoAi, pdf, 'binary');

  f.photoJpg = path.join(TMP, 'photo.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7f9bb3' } })
    .composite([{ input: Buffer.from('<svg width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#64748b"/><stop offset="1" stop-color="#f1d3b3"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="300" cy="260" r="120" fill="#fff" opacity="0.3"/></svg>') }])
    .jpeg({ quality: 90 }).toFile(f.photoJpg);
  f.photoPng = path.join(TMP, 'photo.png');
  await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 90, g: 130, b: 170, alpha: 1 } } })
    .png().toFile(f.photoPng);

  // 批量目录：3 张图 + 1 个 txt + 嵌套子目录 2 张图
  f.batchDir = path.join(TMP, 'batch');
  f.nested = path.join(f.batchDir, 'sub');
  fs.mkdirSync(f.nested, { recursive: true });
  for (const [dir, name] of [[f.batchDir, 'a.jpg'], [f.batchDir, 'b.png'], [f.batchDir, 'notes.txt'], [f.nested, 'c.jpg'], [f.nested, 'd.webp']]) {
    const src = name.endsWith('.jpg') ? f.photoJpg : f.photoPng;
    fs.copyFileSync(src, path.join(dir, name));
  }
  return f;
}

function alphasAt(pngBuffer, points) {
  return sharp(pngBuffer).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
    const { width, channels } = info;
    return points.map(([x, y]) => data[(y * width + x) * channels + 3]);
  });
}

async function regionDiff(bufA, bufB, region) {
  const [a, b] = await Promise.all([bufA, bufB].map((x) => sharp(x).raw().toBuffer({ resolveWithObject: true })));
  assert.strictEqual(a.info.width, b.info.width);
  const [x0, y0, x1, y1] = region;
  let sum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * a.info.width + x) * a.info.channels;
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / ((x1 - x0) * (y1 - y0) * 3);
}

async function main() {
  const F = await makeFixtures();
  console.log('fixtures →', TMP);

  console.log('\n[1] 水印准备（白底/黑底/SVG/AI → 透明 PNG）');
  let wmWhite, wmBlack, wmSvg, wmAi;
  await t('白底 JPG 自动识别并去底', async () => {
    wmWhite = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'logo-white.jpg', {});
    assert.strictEqual(wmWhite.bgColor.kind, 'white');
    assert.strictEqual(wmWhite.removed, true);
    const [c1, c2, c3] = await alphasAt(wmWhite.buffer, [[2, 2], [397, 2], [2, 297]]);
    assert(c1 < 10 && c2 < 10 && c3 < 10, `边角 alpha 应为 0，实际 ${c1},${c2},${c3}`);
    const [ctr, blue] = await alphasAt(wmWhite.buffer, [[200, 20], [150, 120]]);
    assert.strictEqual(ctr, 0, '画布顶部空白应透明');
    assert.strictEqual(blue, 255, '蓝色圆内应不透明');
  });
  await t('黑底 PNG 自动识别并去底', async () => {
    wmBlack = await prepareWatermark(fs.readFileSync(F.logoBlackPng), 'logo-black.png', {});
    assert.strictEqual(wmBlack.bgColor.kind, 'black');
    const [c1, c2] = await alphasAt(wmBlack.buffer, [[2, 2], [397, 297]]);
    assert(c1 < 10 && c2 < 10, `边角 alpha 应为 0，实际 ${c1},${c2}`);
  });
  await t('SVG 保留透明通道', async () => {
    wmSvg = await prepareWatermark(fs.readFileSync(F.wmSvg), 'wm-color.svg', {});
    assert.strictEqual(wmSvg.alreadyTransparent ?? false, true, 'SVG 无底色时不应再去底');
  });
  await t('AI（PDF 兼容）渲染为透明 PNG', async () => {
    wmAi = await prepareWatermark(fs.readFileSync(F.logoAi), 'logo.ai', {});
    assert(wmAi.width >= 200, 'AI 渲染尺寸异常');
    const [corner, center] = await alphasAt(wmAi.buffer, [[1, 1], [Math.floor(wmAi.width / 2), Math.floor(wmAi.height / 2)]]);
    assert(corner < 10, `AI 画布角应透明，实际 ${corner}`);
    assert.strictEqual(center, 255, 'AI 红方块中心应不透明');
  });
  await t('容差变化有效（tolerance=8 更保守）', async () => {
    const strict = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'l.jpg', { tolerance: 8 });
    const loose = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'l.jpg', { tolerance: 120 });
    const alphaSum = async (wm) => (await sharp(wm.buffer).stats()).channels[3].mean;
    const [s, l] = await Promise.all([alphaSum(strict), alphaSum(loose)]);
    assert(s > l, '容差越大保留的像素应越少');
  });
  await t('手动裁剪：百分比裁剪 + 裁剪后仍正常去底', async () => {
    const cropped = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'l.jpg', { crop: { x: 55, y: 55, w: 40, h: 40 } });
    assert.strictEqual(cropped.sourceWidth, 400, 'sourceWidth 应为原始画布宽');
    assert.strictEqual(cropped.sourceHeight, 300);
    assert(cropped.cropApplied, '应回传 cropApplied');
    assert.strictEqual(cropped.cropApplied.width, 160);
    assert.strictEqual(cropped.width, 160);
    assert.strictEqual(cropped.height, 120);
    const [corner, tri] = await alphasAt(cropped.buffer, [[2, 2], [80, 10]]);
    assert(corner < 10, `裁剪区边缘白底仍应被去除，实际 ${corner}`);
    assert.strictEqual(tri, 255, '裁剪区内的三角形应保留');
  });
  await t('自动去边（trim）收紧画布', async () => {
    const full = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'l.jpg', {});
    const trimmed = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'l.jpg', { trim: true });
    assert(trimmed.width < full.width && trimmed.height < full.height, `trim 后应更小: ${trimmed.width}×${trimmed.height} vs ${full.width}×${full.height}`);
    assert(trimmed.width > 200, 'trim 不应裁掉内容');
    const meanAlpha = (await sharp(trimmed.buffer).stats()).channels[3].mean;
    assert(meanAlpha > 80, `trim 后内容占比应明显上升，mean=${meanAlpha.toFixed(1)}`);
    assert(typeof trimmed.sourcePreview === 'string' && trimmed.sourcePreview.startsWith('data:image/'), '应返回 sourcePreview');
  });
  await t('多 logo 并排合并（等高 + 间距 + 透明底）', async () => {
    const a = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'a.jpg', { trim: true });
    const b = await prepareWatermark(fs.readFileSync(F.wmSvg), 'b.svg', {});
    const c = await prepareWatermark(fs.readFileSync(F.logoBlackPng), 'c.png', { trim: true });
    const m = await mergeWatermarks([a, b, c], { gapPct: 10, equalHeight: true });
    // 公共高 = 三者高度的下中位数
    const hs = [a.height, b.height, c.height].sort((x, y) => x - y);
    const H = hs[1];
    const gap = Math.round(H * 0.1);
    const scaledW = (p) => (p.height === H ? p.width : Math.round(p.width * H / p.height));
    assert.strictEqual(m.height, H, `合并高度应为下中位数 ${H}，实际 ${m.height}`);
    assert.strictEqual(m.width, scaledW(a) + gap + scaledW(b) + gap + scaledW(c), '总宽应为三者宽 + 2×间距');
    const [corner, midB] = await alphasAt(m.buffer, [[1, 1], [scaledW(a) + gap + Math.round(scaledW(b) / 2), Math.round(H / 2)]]);
    assert(corner < 10, `画布角应透明，实际 ${corner}`);
    assert.strictEqual(midB, 255, '第二个 logo（椭圆中心）应不透明');
    assert(m.notes.join('').includes('并排'), 'notes 应包含并排信息');
  });

  console.log('\n[2] 合成引擎');
  await t('单张合成：JPEG 目标保持格式、右下角有水印', async () => {
    const target = fs.readFileSync(F.photoJpg);
    const { buffer, ext } = await composeWatermark(target, wmWhite.buffer, { position: 'se', sizePct: 25, opacity: 90 });
    assert.strictEqual(ext, '.jpg');
    const meta = await sharp(buffer).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.strictEqual(meta.width, 1200);
    const diff = await regionDiff(buffer, target, [760, 520, 1190, 790]);
    assert(diff > 3, `右下角应有明显水印差异，平均差 ${diff.toFixed(2)}`);
    const diffTL = await regionDiff(buffer, target, [10, 10, 300, 200]);
    assert(diffTL < 1, `左上角不应被改动，平均差 ${diffTL.toFixed(3)}`);
  });
  await t('平铺模式', async () => {
    const target = fs.readFileSync(F.photoPng);
    const { buffer, ext } = await composeWatermark(target, wmSvg.buffer, { tile: true, sizePct: 15, opacity: 60 });
    assert.strictEqual(ext, '.png');
    const diff = await regionDiff(buffer, target, [0, 0, 800, 600]);
    assert(diff > 5, `平铺后整图应有差异，平均差 ${diff.toFixed(2)}`);
  });
  await t('EXIF 摆正 + 旋转水印 + 输出格式转换', async () => {
    const { buffer, ext } = await composeWatermark(fs.readFileSync(F.photoJpg), wmAi.buffer, { rotate: 30, format: 'png', sizePct: 20 });
    assert.strictEqual(ext, '.png');
    assert.strictEqual((await sharp(buffer).metadata()).format, 'png');
  });
  await t('元数据保留（EXIF 透传到输出）', async () => {
    const withExif = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#8899aa' } })
      .withExif({ IFD0: { ImageDescription: 'imgmark-meta-test' } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const { buffer } = await composeWatermark(withExif, wmWhite.buffer, { position: 'c', sizePct: 20 });
    const meta = await sharp(buffer).metadata();
    assert(meta.exif, '输出应带 EXIF');
    assert(meta.exif.toString('binary').includes('imgmark-meta-test'), 'EXIF ImageDescription 应透传');
  });

  console.log('\n[3] 批量目录');
  await t('递归批量 + 跳过非图片 + 输出子目录结构', async () => {
    const outDir = path.join(F.batchDir, '_watermarked');
    const r = await runBatch({
      inputDir: F.batchDir, outputDir: outDir, watermark: wmWhite.buffer,
      options: { position: 'c', sizePct: 20 }, recursive: true, concurrency: 2,
      onProgress: () => {},
    });
    assert.strictEqual(r.total, 4, `应处理 4 张图（跳过 txt），实际 ${r.total}`);
    assert.strictEqual(r.failed, 0);
    assert(fs.existsSync(path.join(outDir, 'a_wm.jpg')), 'auto 格式应保持 jpg 并加后缀');
    assert(fs.existsSync(path.join(outDir, 'sub', 'c_wm.jpg')), '递归时应保留子目录结构');
    assert(!fs.existsSync(path.join(outDir, 'notes.txt')), 'txt 不应被复制');
    const outMeta = await sharp(fs.readFileSync(path.join(outDir, 'b_wm.png'))).metadata();
    assert.strictEqual(outMeta.format, 'png', 'auto 格式应保持 png');
  });

  console.log('\n[4] CLI');
  await t('imgmark apply 全链路', async () => {
    const outDir = path.join(TMP, 'cli-out');
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'app', 'server', 'bin', 'wm.js'), 'apply',
      '-w', F.logoBlackPng, '-w', F.wmSvg, '-i', F.batchDir, '-o', outDir,
      '--pos', 'nw', '--size', '30', '--opacity', '70', '--format', 'png', '--recursive', '--trim',
    ], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, `CLI 退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert(fs.existsSync(path.join(outDir, 'a_wm.png')), 'CLI 输出 a_wm.png 缺失');
    assert(fs.existsSync(path.join(outDir, 'sub', 'c_wm.png')), 'CLI 递归输出缺失');
    console.log(r.stdout.trim().split('\n').slice(0, 3).map((s) => '      ' + s).join('\n'));
  });

  console.log('\n[5] HTTP API 全链路（含 fnOS 路由降级检查）');
  await t('server /api/health → /api/prepare → /api/preview → /api/process(local)', async () => {
    const port = 28117;
    const srv = spawn(process.execPath, [path.join(ROOT, 'app', 'server', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port), IMGMARK_DATA_DIR: path.join(TMP, 'data') },
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 50; i++) {
        try { await (await fetch(`${base}/api/health`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.strictEqual(health.ok, true);

      const fnos = await (await fetch(`${base}/api/fnos/status`)).json();
      assert.strictEqual(fnos.available, false, '非 fnOS 环境 available 应为 false');
      const fnosList = await fetch(`${base}/api/fnos/list`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: 1000, path: '/vol1/x' }),
      });
      assert.strictEqual(fnosList.status, 501, '非 fnOS 环境 fnos/list 应 501');

      const fd = new FormData();
      fd.append('watermark', new Blob([fs.readFileSync(F.logoWhiteJpg)], { type: 'image/jpeg' }), 'logo-white.jpg');
      fd.append('bg', 'auto');
      const prepared = await (await fetch(`${base}/api/prepare`, { method: 'POST', body: fd })).json();
      assert(prepared.id, 'prepare 应返回 id');
      assert.strictEqual(prepared.bgColor.kind, 'white');

      // HTTP 裁剪 + 去边
      const fd2 = new FormData();
      fd2.append('watermark', new Blob([fs.readFileSync(F.logoWhiteJpg)], { type: 'image/jpeg' }), 'logo-white.jpg');
      fd2.append('crop', '55,55,40,40');
      fd2.append('trim', 'true');
      const prepared2 = await (await fetch(`${base}/api/prepare`, { method: 'POST', body: fd2 })).json();
      assert.strictEqual(prepared2.sourceWidth, 400);
      assert.strictEqual(prepared2.cropApplied.width, 160);
      assert(typeof prepared2.sourcePreview === 'string' && prepared2.sourcePreview.startsWith('data:image/'), '应返回 sourcePreview');
      assert(prepared2.notes.join('\n').includes('裁掉边缘空白'), 'notes 应包含去边信息');

      // HTTP 多 logo 并排
      const fd3 = new FormData();
      fd3.append('watermark', new Blob([fs.readFileSync(F.logoWhiteJpg)], { type: 'image/jpeg' }), 'a.jpg');
      fd3.append('watermark', new Blob([fs.readFileSync(F.wmSvg)], { type: 'image/svg+xml' }), 'b.svg');
      fd3.append('gap', '10');
      const prepared3 = await (await fetch(`${base}/api/prepare`, { method: 'POST', body: fd3 })).json();
      assert.strictEqual(prepared3.logoCount, 2);
      assert(prepared3.notes.join('\n').includes('并排'), '多 logo 应返回并排 notes');
      assert(prepared3.width > prepared3.height, '两个横版 logo 等高拼排后应更宽');
      assert.strictEqual(prepared3.sourcePreview, null, '多 logo 不提供单一裁剪参考系');

      // HTTP 多 logo 逐个裁剪（JSON 数组，每项相对各自画布）
      const fd4 = new FormData();
      fd4.append('watermark', new Blob([fs.readFileSync(F.logoWhiteJpg)], { type: 'image/jpeg' }), 'a.jpg');
      fd4.append('watermark', new Blob([fs.readFileSync(F.wmSvg)], { type: 'image/svg+xml' }), 'b.svg');
      fd4.append('crop', JSON.stringify([{ x: 55, y: 55, w: 40, h: 40 }, null]));
      const prepared4 = await (await fetch(`${base}/api/prepare`, { method: 'POST', body: fd4 })).json();
      const n4 = prepared4.notes.join('\n');
      assert(n4.includes('[a.jpg] 已裁剪'), `第一个 logo 应有裁剪记录: ${n4}`);
      assert(!n4.includes('[b.svg] 已裁剪'), '第二个 logo（null）不应被裁剪');
      assert(Array.isArray(prepared4.cropApplied) && prepared4.cropApplied[0] && prepared4.cropApplied[1] === null, 'cropApplied 应为逐文件数组');
      assert(Array.isArray(prepared4.sourcePreviews) && prepared4.sourcePreviews.length === 2, '应返回每 logo 的裁剪参考系');

      // 回归：gap=0 应生效（不再被当作默认 10）
      const fd5 = new FormData();
      fd5.append('watermark', new Blob([fs.readFileSync(F.logoWhiteJpg)], { type: 'image/jpeg' }), 'a.jpg');
      fd5.append('watermark', new Blob([fs.readFileSync(F.wmSvg)], { type: 'image/svg+xml' }), 'b.svg');
      fd5.append('gap', '0');
      const prepared5 = await (await fetch(`${base}/api/prepare`, { method: 'POST', body: fd5 })).json();
      const soloA = await prepareWatermark(fs.readFileSync(F.logoWhiteJpg), 'a.jpg', {});
      const soloB = await prepareWatermark(fs.readFileSync(F.wmSvg), 'b.svg', {});
      const expect0 = await mergeWatermarks([soloA, soloB], { gapPct: 0, equalHeight: true });
      assert.strictEqual(prepared5.width, expect0.width, `gap=0 时应为无缝拼接宽 ${expect0.width}，实际 ${prepared5.width}`);

      // 回归：local-files 模式（桌面壳显式文件列表）+ 相对输出目录名锚定到图片目录
      const pfd2 = new FormData();
      pfd2.append('payload', JSON.stringify({ watermarkId: prepared.id, mode: 'local-files', files: [F.photoJpg, F.photoPng], options: { position: 'w' }, outputDir: '_watermarked2' }));
      const { jobId: lJobId } = await (await fetch(`${base}/api/process`, { method: 'POST', body: pfd2 })).json();
      let lJob;
      for (let i = 0; i < 60; i++) {
        lJob = await (await fetch(`${base}/api/jobs/${lJobId}`)).json();
        if (lJob.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.strictEqual(lJob.status, 'done', `local-files 应完成: ${JSON.stringify(lJob.error)}`);
      assert.strictEqual(lJob.ok, 2, `local-files 应成功 2 张: ${JSON.stringify(lJob.results)}`);
      assert(path.isAbsolute(lJob.outputDir) && lJob.outputDir.startsWith(F.photoJpg ? path.dirname(F.photoJpg) : ''), `相对输出目录应锚定到图片目录，实际 ${lJob.outputDir}`);
      assert(fs.existsSync(lJob.results[0].output), `输出文件应真实存在: ${lJob.results[0].output}`);

      const preview = await (await fetch(`${base}/api/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watermarkId: prepared.id, options: { position: 'ne' } }),
      })).json();
      assert(preview.preview.startsWith('data:image/jpeg'), 'preview 应为 dataURL');

      const pfd = new FormData();
      pfd.append('payload', JSON.stringify({ watermarkId: prepared.id, mode: 'local', inputDir: F.batchDir, options: { position: 'n' }, recursive: true }));
      const { jobId } = await (await fetch(`${base}/api/process`, { method: 'POST', body: pfd })).json();
      let job;
      for (let i = 0; i < 60; i++) {
        job = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
        if (job.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.strictEqual(job.status, 'done', `任务应完成: ${JSON.stringify(job.error)}`);
      assert.strictEqual(job.ok, 4);

      // 回归：上传模式 + recursive 曾因 inputDir=null 走 path.relative 崩溃
      const ufd = new FormData();
      ufd.append('payload', JSON.stringify({ watermarkId: prepared.id, mode: 'upload', options: { position: 'c' }, recursive: true }));
      ufd.append('files', new Blob([fs.readFileSync(F.photoJpg)], { type: 'image/jpeg' }), '2025_08_17_09_44_IMG_3793.JPG');
      ufd.append('files', new Blob([fs.readFileSync(F.photoPng)], { type: 'image/png' }), 'img2.png');
      const { jobId: uJobId } = await (await fetch(`${base}/api/process`, { method: 'POST', body: ufd })).json();
      let uJob;
      for (let i = 0; i < 60; i++) {
        uJob = await (await fetch(`${base}/api/jobs/${uJobId}`)).json();
        if (uJob.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.strictEqual(uJob.status, 'done', `上传任务应完成: ${JSON.stringify(uJob.error)}`);
      assert.strictEqual(uJob.ok, 2, `上传模式应成功 2 张，实际 ok=${uJob.ok} results=${JSON.stringify(uJob.results)}`);
      assert(uJob.results.every((r) => r.ok), `上传逐文件应全部成功: ${JSON.stringify(uJob.results)}`);
    } finally {
      srv.kill();
    }
  });

  console.log('\n[6] 回归：边界尺寸 / 格式 / 路径判断');
  await t('超大水印（竖图 + long 基准 + 100%）不再报 composite 尺寸错误', async () => {
    const portrait = await sharp({ create: { width: 400, height: 900, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const { buffer } = await composeWatermark(portrait, wmWhite.buffer, { sizePct: 100, sizeBase: 'long', rotate: 30 });
    const m = await sharp(buffer).metadata();
    assert.strictEqual(m.width, 400); assert.strictEqual(m.height, 900);
  });
  await t('AVIF 输入 format=auto 仍输出 AVIF（此前 heif 被当成 PNG）', async () => {
    const avif = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#468' } }).avif().toBuffer();
    const { ext } = await composeWatermark(avif, wmWhite.buffer, {});
    assert.strictEqual(ext, '.avif');
    assert.strictEqual(expectedExt('x.avif', {}), '.avif');
    assert.strictEqual(expectedExt('x.tif', {}), '.tiff');
    assert.strictEqual(expectedExt('x.JPEG', {}), '.jpg');
  });
  await t('isInside 按路径段判断（/out 不误伤 /out2）', async () => {
    assert(isInside(path.join(TMP, 'out', 'a.jpg'), path.join(TMP, 'out')));
    assert(isInside(path.join(TMP, 'out'), path.join(TMP, 'out')));
    assert(!isInside(path.join(TMP, 'out2', 'a.jpg'), path.join(TMP, 'out')));
    assert(!isInside(path.join(TMP, 'a.jpg'), path.join(TMP, 'out')));
  });

  await t('亮度自适应反色变体保留 logo 内部结构（被笔画包围的白色区域不再糊成实心）', async () => {
    const { analyzeInk } = require('../app/server/src/core/watermark');
    // 白底上的黑色方框，框内白色区域与外部背景不连通 → 去底后保留为不透明白
    const svg = '<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#fff"/><rect x="40" y="40" width="120" height="120" fill="none" stroke="#000" stroke-width="40"/></svg>';
    const wm = await prepareWatermark(await sharp(Buffer.from(svg)).png().toBuffer(), 'box.png', { force: true });
    const ink = await analyzeInk(wm.buffer);
    assert(ink.monochrome && ink.dark, '应识别为深色单色墨');
    const { data, info } = await sharp(ink.altBuffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => data[(y * info.width + x) * info.channels];
    assert(px(30, 100) > 200, `边框应反成白色，实际 ${px(30, 100)}`);
    assert(px(100, 100) < 50, `框内白色区域应反成黑色（此前被涂成白色糊成实心块），实际 ${px(100, 100)}`);
  });

  console.log('\n[7] 回归：分组 / 去重 / 上传文件名 / 目录浏览 / 递归监听');
  await t('HTTP 分组 + skipProcessed + 中文上传名 + browse 排序 + 递归监听', async () => {
    const port = 28118;
    const dataDir = path.join(TMP, 'data7');
    const srv = spawn(process.execPath, [path.join(ROOT, 'app', 'server', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port), IMGMARK_DATA_DIR: dataDir },
    });
    const base = `http://127.0.0.1:${port}`;
    const waitJob = async (jobId) => {
      for (let i = 0; i < 100; i++) {
        const j = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
        if (j.status !== 'running') return j;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error('任务超时');
    };
    try {
      for (let i = 0; i < 50; i++) {
        try { await (await fetch(`${base}/api/health`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      // 分组模式 prepare
      const fd = new FormData();
      fd.append('watermark', new Blob([fs.readFileSync(F.logoWhiteJpg)], { type: 'image/jpeg' }), '标志.jpg');
      fd.append('watermark', new Blob([fs.readFileSync(F.wmSvg)], { type: 'image/svg+xml' }), 'b.svg');
      fd.append('split', 'true');
      const set = await (await fetch(`${base}/api/prepare`, { method: 'POST', body: fd })).json();
      assert.strictEqual(set.logos.length, 2);
      assert.strictEqual(set.logos[0].name, '标志.jpg', `水印源中文名应正确解码，实际 ${set.logos[0].name}`);
      const groups = [{ logos: [0, 1], position: 'se', sizePct: 30 }, { logos: [1], position: 'nw', sizePct: 10 }];

      // 分组批量 + skipProcessed：第二次全部跳过
      const dir = path.join(TMP, 'batch7');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(F.photoJpg, path.join(dir, 'p1.jpeg'));
      fs.copyFileSync(F.photoPng, path.join(dir, 'p2.png'));
      const body = { watermarkId: set.id, mode: 'local', inputDir: dir, groups, skipProcessed: true, options: { format: 'auto' } };
      const run = async () => {
        const pfd = new FormData();
        pfd.append('payload', JSON.stringify(body));
        const { jobId } = await (await fetch(`${base}/api/process`, { method: 'POST', body: pfd })).json();
        return waitJob(jobId);
      };
      const j1 = await run();
      assert.strictEqual(j1.ok, 2, `分组批量应成功 2 张: ${JSON.stringify(j1)}`);
      const j2 = await run();
      assert.strictEqual(j2.total, 0, '第二次应无待处理文件');
      assert.strictEqual(j2.skipped, 2, `第二次应跳过 2 张: ${JSON.stringify(j2)}`);

      // 上传：中文文件名 + 同名文件不互相覆盖
      const ufd = new FormData();
      ufd.append('payload', JSON.stringify({ watermarkId: set.id, mode: 'upload', groups }));
      ufd.append('files', new Blob([fs.readFileSync(F.photoJpg)], { type: 'image/jpeg' }), '风景.jpg');
      ufd.append('files', new Blob([fs.readFileSync(F.photoJpg)], { type: 'image/jpeg' }), '风景.jpg');
      const { jobId: uId } = await (await fetch(`${base}/api/process`, { method: 'POST', body: ufd })).json();
      const uj = await waitJob(uId);
      const names = uj.results.map((r) => r.name).sort();
      assert(names.includes('风景.jpg') && names.includes('风景(2).jpg'), `上传名应为 UTF-8 且去重: ${names}`);
      const dl = await fetch(`${base}/api/jobs/${uId}/file/1`);
      assert.strictEqual(dl.status, 200, '上传结果应可下载');

      // 目录浏览：子目录按名称排序
      for (const n of ['c', 'a', 'b']) fs.mkdirSync(path.join(TMP, 'browse7', n), { recursive: true });
      const br = await (await fetch(`${base}/api/browse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.join(TMP, 'browse7') }),
      })).json();
      assert.deepStrictEqual(br.dirs, ['a', 'b', 'c']);

      // 递归监听：子目录里的图也要处理，且保留 format 选项
      const wdir = path.join(TMP, 'watch7');
      fs.mkdirSync(path.join(wdir, 'sub'), { recursive: true });
      const old = new Date(Date.now() - 60000);
      for (const f of [path.join(wdir, 'top.jpg'), path.join(wdir, 'sub', 'deep.jpg')]) {
        fs.copyFileSync(F.photoJpg, f);
        fs.utimesSync(f, old, old); // 规避"写入未稳定"的 2s 等待
      }
      const w = await (await fetch(`${base}/api/watchers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputDir: wdir, outputDir: '_out', recursive: true, watermarkId: set.id, groups, options: { format: 'png' } }),
      })).json();
      assert.strictEqual(w.options.format, 'png', `监听应保留 format 选项: ${JSON.stringify(w.options)}`);
      let st;
      for (let i = 0; i < 60; i++) {
        st = (await (await fetch(`${base}/api/watchers`)).json()).watchers[0];
        if (st.stats.processed + st.stats.failed >= 2) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.strictEqual(st.stats.processed, 2, `递归监听应处理 2 张: ${JSON.stringify(st)}`);
      assert(fs.existsSync(path.join(wdir, '_out', 'sub', 'deep_wm.png')), '子目录输出缺失（递归扫描未生效）');
      assert(fs.existsSync(path.join(wdir, '_out', 'top_wm.png')), '顶层输出缺失');
      // 立即重扫：已处理的应命中去重，不重复输出
      await fetch(`${base}/api/watchers/${w.id}/rescan`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 800));
      st = (await (await fetch(`${base}/api/watchers`)).json()).watchers[0];
      assert.strictEqual(st.stats.processed, 2, `重扫不应重复处理: ${JSON.stringify(st.stats)}`);
      await fetch(`${base}/api/watchers/${w.id}`, { method: 'DELETE' });
    } finally {
      srv.kill();
    }
  });

  console.log('\n[8] BMP 编解码 / JPEG 编码器 / 批内重名 / 数据库清理 / 监听重名');
  const { isBmp, decodeBmp, encodeBmp } = require('../app/server/src/formats/bmp');
  await t('BMP：24 位 / 32 位带透明 / 8 位调色板 / 自上而下 均可解码', async () => {
    // 编码器往返（不透明 → 24 位，带透明 → 32 位 V4 位域）
    const rgba = Buffer.alloc(3 * 2 * 4);
    for (let i = 0; i < 6; i++) rgba.set([i * 40, 255 - i * 40, 100, 255], i * 4);
    const b24 = encodeBmp(rgba, 3, 2, 4);
    assert.strictEqual(b24.readUInt16LE(28), 24);
    assert.deepStrictEqual(decodeBmp(b24).data, rgba);
    rgba[3] = 128;
    const b32 = encodeBmp(rgba, 3, 2, 4);
    assert.strictEqual(b32.readUInt16LE(28), 32);
    assert.deepStrictEqual(decodeBmp(b32).data, rgba);
    // 手工构造 8 位调色板、自上而下（height 为负）的 2×2 BMP
    const row = 4, off = 14 + 40 + 2 * 4, pal = Buffer.alloc(off + row * 2);
    pal.write('BM'); pal.writeUInt32LE(pal.length, 2); pal.writeUInt32LE(off, 10); pal.writeUInt32LE(40, 14);
    pal.writeInt32LE(2, 18); pal.writeInt32LE(-2, 22); pal.writeUInt16LE(1, 26); pal.writeUInt16LE(8, 28); pal.writeUInt32LE(2, 46);
    pal.set([0, 0, 255, 0, 255, 0, 0, 0], 54); // 调色板 BGRx：0=红 1=蓝
    pal.set([0, 1, 0, 0, 1, 0, 0, 0], off);    // 第一行 红 蓝，第二行 蓝 红
    const d = decodeBmp(pal);
    assert.deepStrictEqual([...d.data.slice(0, 8)], [255, 0, 0, 255, 0, 0, 255, 255], '第一行应为 红 蓝（自上而下）');
    assert.deepStrictEqual([...d.data.slice(8, 16)], [0, 0, 255, 255, 255, 0, 0, 255]);
  });
  await t('BMP 作为目标图：format=auto 写回 BMP；作为水印源可去底', async () => {
    const { data, info } = await sharp(F.photoJpg).resize(300).raw().toBuffer({ resolveWithObject: true });
    const bmp = encodeBmp(data, info.width, info.height, info.channels);
    const { buffer, ext } = await composeWatermark(bmp, wmWhite.buffer, {});
    assert.strictEqual(ext, '.bmp');
    assert(isBmp(buffer));
    assert.strictEqual(decodeBmp(buffer).width, 300);
    assert.strictEqual(expectedExt('x.bmp', {}), '.bmp');
    const logo = await sharp(F.logoWhiteJpg).raw().toBuffer({ resolveWithObject: true });
    const wm = await prepareWatermark(encodeBmp(logo.data, logo.info.width, logo.info.height, logo.info.channels), 'logo.bmp', {});
    assert.strictEqual(wm.bgColor.kind, 'white');
  });
  await t('JPEG 默认 libjpeg-turbo，mozjpeg:true 可切换', async () => {
    const a = await composeWatermark(fs.readFileSync(F.photoJpg), wmWhite.buffer, {});
    const b = await composeWatermark(fs.readFileSync(F.photoJpg), wmWhite.buffer, { mozjpeg: true });
    assert.strictEqual(a.ext, '.jpg'); assert.strictEqual(b.ext, '.jpg');
    assert.notDeepStrictEqual(a.buffer, b.buffer, '两种编码器输出应不同');
  });
  await t('批内输出重名自动加序号（a.jpg / a.png 强制 JPEG）', async () => {
    const dir = path.join(TMP, 'dup8'), out = path.join(TMP, 'dup8', 'out');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(F.photoJpg, path.join(dir, 'a.jpg'));
    fs.copyFileSync(F.photoPng, path.join(dir, 'a.png'));
    const r = await runBatch({ inputDir: dir, outputDir: out, watermark: wmWhite.buffer, options: { format: 'jpeg' }, concurrency: 4 });
    assert.strictEqual(r.ok, 2);
    const byInput = Object.fromEntries(r.results.map((x) => [path.basename(x.input), path.basename(x.output)]));
    assert.deepStrictEqual(byInput, { 'a.jpg': 'a_wm.jpg', 'a.png': 'a(2)_wm.jpg' });
  });
  await t('数据库 compact：清理输入已改动 / 输出已删除的记录', async () => {
    const { ProcessDB } = require('../app/server/src/core/db');
    const dir = path.join(TMP, 'db8');
    fs.mkdirSync(dir, { recursive: true });
    const inp = path.join(dir, 'in.jpg'), outp = path.join(dir, 'out.jpg');
    fs.copyFileSync(F.photoJpg, inp); fs.copyFileSync(F.photoJpg, outp);
    const db = new ProcessDB(path.join(dir, 'db.json'));
    const st = fs.statSync(inp);
    db.put(ProcessDB.keyFor(inp, st), { output: outp });                              // 有效
    db.put(ProcessDB.keyFor(inp, { mtimeMs: 1, size: st.size }), { output: outp });   // 旧版本身份
    db.put(ProcessDB.keyFor(path.join(dir, 'gone.jpg'), st), { output: outp });       // 输入已删
    const inp2 = path.join(dir, 'in2.jpg'); fs.copyFileSync(F.photoJpg, inp2);
    db.put(ProcessDB.keyFor(inp2, fs.statSync(inp2)), { output: path.join(dir, 'nope.jpg') }); // 输出已删
    assert.strictEqual(await db.compact(), 3);
    assert.strictEqual(db.size, 1);
    assert.strictEqual(path.resolve(db.ownerOf(outp)), path.resolve(inp));
    db.flushNow();
  });
  await t('监听：别的源文件占用同名输出时换序号，不再误判为已处理', async () => {
    const { ProcessDB } = require('../app/server/src/core/db');
    const { WatcherManager } = require('../app/server/src/core/watcher');
    const dir = path.join(TMP, 'watch8'), out = path.join(dir, 'out');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60000);
    for (const [src, name] of [[F.photoJpg, 'a.jpg'], [F.photoPng, 'a.png']]) {
      fs.copyFileSync(src, path.join(dir, name)); fs.utimesSync(path.join(dir, name), old, old);
    }
    const db = new ProcessDB(path.join(dir, 'db.json'));
    const mgr = new WatcherManager({
      db, stateFile: path.join(dir, 'watchers.json'),
      resolveTarget: async () => ({ watermark: wmWhite.buffer, options: { format: 'jpeg' } }),
    });
    const w = mgr.create({ inputDir: dir, outputDir: out, watermarkId: 'x', options: { format: 'jpeg' } });
    let st;
    for (let i = 0; i < 60; i++) {
      st = mgr.status(w.id);
      if (st.stats.processed + st.stats.failed >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    mgr.remove(w.id);
    assert.strictEqual(st.stats.processed, 2, `应处理 2 张: ${JSON.stringify(st.stats)} ${st.lastError}`);
    assert(fs.existsSync(path.join(out, 'a_wm.jpg')) && fs.existsSync(path.join(out, 'a(2)_wm.jpg')), `输出: ${fs.readdirSync(out)}`);
  });

  console.log(`\n结果：${pass} 通过，${fail} 失败  （fixtures 保留在 ${TMP}）`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
