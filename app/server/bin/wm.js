#!/usr/bin/env node
'use strict';
/**
 * ImgMark CLI
 *   imgmark prepare <水印文件...> [-o out.png] [--bg auto|white|black] [--tolerance 40] [--max-size 1600] [--force]
 *                   [--trim] [--crop x,y,w,h] [--merge] [--gap 10] [--unequal]
 *   imgmark apply   -w <水印文件>... -i <图片目录> [-o <输出目录>] [--pos se] [--size 20] [--opacity 80]
 *                   [--margin 3] [--tile] [--tile-gap 10] [--rotate 0] [--format auto|png|jpeg|webp]
 *                   [--quality 90] [--recursive] [--overwrite] [--suffix _wm] [--concurrency 3]
 *                   [--bg auto|white|black] [--tolerance 40] [--force] [--trim] [--crop x,y,w,h]
 *                   [--gap 10] [--unequal]
 *
 *   -w 可重复传入多个 logo，自动并排合并（--gap 间距%，--unequal 关闭等高对齐）
 *   prepare --merge 把多个水印源合并成一个透明 PNG 输出
 *
 * apply 会自动把 AI/SVG/PNG/JPG 水印先转成透明 PNG（白底/黑底自动去底）再合成。
 */
const fs = require('fs');
const path = require('path');
const { prepareWatermark, mergeWatermarks, composeWatermark, IMAGE_EXTS, WM_INPUT_EXTS, extOf } = require('../src/core/watermark');
const { runBatch } = require('../src/core/batch');

function usage() {
  console.log(`ImgMark — 批量图片水印（AI/SVG/PNG/JPG 水印源白底黑底自动去底转透明）

用法:
  imgmark prepare <水印文件...> [-o out.png] [--bg auto|white|black] [--tolerance 40]
                  [--max-size 1600] [--force] [--trim] [--crop "x,y,w,h[;...]"] [--merge] [--gap 10] [--unequal]
  imgmark apply   -w <水印文件>... -i <图片目录> [-o <输出目录>] [--pos se] [--size 20] [--opacity 80]
                  [--margin 3] [--tile] [--tile-gap 10] [--rotate 0] [--format auto|png|jpeg|webp]
                  [--quality 90] [--recursive] [--overwrite] [--suffix _wm] [--concurrency 3]
                  [--bg auto|white|black] [--tolerance 40] [--force] [--trim] [--crop "..."] [--gap 10] [--unequal]
  imgmark serve   启动 Web 界面（浏览器批量操作 + fnOS 授权目录；PORT/HOST 环境变量可覆盖）

说明:
  -w 可重复传入多个 logo，自动等高并排合并（--gap 间距%，--unequal 关闭等高）
  --crop "x,y,w,h" 裁剪水印源（百分比）；多 logo 用分号逐个指定，空段=不裁
  --trim 自动裁掉水印源边缘空白；--overwrite 覆盖原图（危险，强制保持原格式）

Web 界面与飞牛 fnOS 应用打包: https://github.com/techysy/imgmark#readme
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--') || (next.startsWith('-') && next !== '-' && isNaN(Number(next)))) {
        args[key] = true;
      } else { args[key] = next; i++; }
    } else if (a === '-o') { args.o = argv[++i]; }
    else if (a === '-w') {
      const v = argv[++i];
      args.w = args.w === undefined ? [v] : [].concat(args.w, v);
    }
    else if (a === '-i') { args.i = argv[++i]; }
    else args._.push(a);
  }
  return args;
}

const numOr = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };

function parseCropArg(v) {
  if (!v) return null;
  const p = String(v).split(',').map((s) => Number(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 100) || p[2] <= 0 || p[3] <= 0) {
    throw new Error(`--crop 格式应为 "x,y,w,h"（百分比 0-100，如 55,55,40,40），收到: ${v}`);
  }
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

/** 多 logo：--crop "55,55,40,40;70,70,30,30" 按顺序对应各 logo，空段 = 不裁剪；单段仅对单文件生效 */
function parseCropArgs(v, count) {
  if (!v) return null;
  const segs = String(v).split(';').map((s) => s.trim());
  if (segs.length === 1) {
    const c = parseCropArg(segs[0]);
    return count === 1 ? [c] : null;
  }
  if (segs.length !== count) {
    throw new Error(`--crop 段数(${segs.length})与 logo 数(${count})不一致；多 logo 用分号分隔，空段表示不裁剪`);
  }
  return segs.map((s) => (s ? parseCropArg(s) : null));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const bg = ['auto', 'white', 'black'].includes(args.bg) ? args.bg : 'auto';
  const wmOpts = {
    bg,
    tolerance: Number(args.tolerance) || 40,
    maxSize: Number(args['max-size']) || 1600,
    force: !!args.force,
    trim: !!args.trim,
  };

  if (cmd === 'serve') {
    require('../src/server'); // 启动 Web 界面（PORT/HOST 环境变量可覆盖，默认 28110）
    return;
  }

  if (cmd === 'prepare') {
    const files = args._;
    if (!files.length) { usage(); process.exit(1); }
    for (const f of files) {
      if (!WM_INPUT_EXTS.has(extOf(f))) { console.error(`✗ 不支持的水印格式: ${f}`); process.exit(1); }
    }
    const crops = parseCropArgs(args.crop, files.length);
    const preparedList = [];
    for (let i = 0; i < files.length; i++) {
      preparedList.push(await prepareWatermark(fs.readFileSync(files[i]), path.basename(files[i]), { ...wmOpts, crop: crops ? crops[i] : null }));
    }
    if (args.merge) {
      const merged = await mergeWatermarks(preparedList, {
        gapPct: numOr(args.gap, 10),
        equalHeight: !args.unequal,
      });
      const out = args.o || path.join(path.dirname(files[0]), 'watermark-merged.png');
      fs.writeFileSync(out, merged.buffer);
      console.log(`✓ ${files.length} 个 logo 并排合并 → ${out}  (${merged.width}×${merged.height})`);
      merged.notes.forEach((n) => console.log(`    · ${n}`));
      return;
    }
    for (let i = 0; i < files.length; i++) {
      const f = files[i], prepared = preparedList[i];
      const out = args.o && files.length === 1 ? args.o : path.join(path.dirname(f), path.basename(f, extOf(f)) + '-transparent.png');
      fs.writeFileSync(out, prepared.buffer);
      console.log(`✓ ${f} → ${out}  (${prepared.width}×${prepared.height}${prepared.removed ? '' : '，已是透明底'})`);
      prepared.notes.forEach((n) => console.log(`    · ${n}`));
    }
    return;
  }

  if (cmd === 'apply') {
    if (!args.w || !args.w.length || !args.i) { usage(); process.exit(1); }
    console.log('准备水印…');
    const crops = parseCropArgs(args.crop, args.w.length);
    const preparedList = [];
    for (let i = 0; i < args.w.length; i++) {
      preparedList.push(await prepareWatermark(fs.readFileSync(args.w[i]), path.basename(args.w[i]), { ...wmOpts, crop: crops ? crops[i] : null }));
    }
    const merged = preparedList.length > 1
      ? await mergeWatermarks(preparedList, { gapPct: numOr(args.gap, 10), equalHeight: !args.unequal })
      : preparedList[0];
    console.log(`  水印 ${merged.width}×${merged.height}${preparedList.length > 1 ? `（${preparedList.length} 个 logo 并排）` : ''}`);
    merged.notes && merged.notes.forEach((n) => console.log(`  · ${n}`));
    const inputDir = path.resolve(args.i);
    const outputDir = args.o ? path.resolve(args.o) : null;
    const result = await runBatch({
      inputDir,
      outputDir,
      watermark: merged.buffer,
      recursive: !!args.recursive,
      overwrite: !!args.overwrite,
      suffix: args.suffix || '_wm',
      concurrency: Number(args.concurrency) || 3,
      onProgress: ({ done, total, current, ok, error }) => {
        if (current) console.log(`[${done}/${total}]${ok ? '✓' : '✗'} ${path.basename(current)}${ok ? '' : '  ' + error}`);
      },
      options: {
        position: args.pos || 'se',
        sizePct: Number(args.size) || 20,
        opacity: numOr(args.opacity, 80),
        marginPct: args.margin === undefined ? 3 : Number(args.margin),
        rotate: Number(args.rotate) || 0,
        tile: !!args.tile,
        tileGapPct: numOr(args['tile-gap'], 10),
        format: ['auto', 'png', 'jpeg', 'webp'].includes(args.format) ? args.format : 'auto',
        quality: Number(args.quality) || 90,
      },
    });
    console.log(`\n完成：成功 ${result.ok}，失败 ${result.failed}，共 ${result.total}`);
    if (outputDir) console.log(`输出目录：${outputDir}`);
    process.exit(result.failed ? 1 : 0);
    return;
  }

  usage();
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
