'use strict';
/**
 * HTTP 路由冒烟测试：把服务真的起在一个随机回环端口上，用真实请求打各个端点。
 *
 * 为什么单独做这一层：core 层的 exif-smoke 已经覆盖了合成逻辑，但「哪条路由收哪类请求」
 * 是另一套判定，且历史上正是在这里漏过 —— 批量处理允许「只加边框」，预览/监听却拿
 * watermarkId 去查水印集，于是纯边框与纯文字（只写相机参数）被 404 挡掉。
 * 这类 bug core 测试照不到，只有真发请求才看得见。
 *
 * 用法：node scripts/routes-smoke.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sharp = require('sharp');

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const eq = (a, b, msg) => assert.strictEqual(a, b, `${msg || ''}\n  实际: ${JSON.stringify(a)}\n  期望: ${JSON.stringify(b)}`);

const PORT = 28170 + (process.pid % 300); // 避开常见占用，多进程并行也不撞
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'imgmark-routes-'));
process.env.IMGMARK_DATA_DIR = path.join(TMP, 'data'); // 必须在 require server 之前
process.env.PORT = String(PORT);

const { start } = require('../src/server.js');

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
    (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode, json: j, text: s });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const srv = await start({ port: PORT, host: '127.0.0.1' });

  const inDir = path.join(TMP, 'in');
  fs.mkdirSync(inDir, { recursive: true });
  // 一张有 EXIF、一张没有：覆盖「写到文字」与「静默跳过」两条路
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3b6ea5' } })
    .withMetadata({ exif: { IFD0: { Make: 'Canon', Model: 'Canon EOS R6' },
      IFD2: { LensModel: 'RF24-70mm F2.8 L IS USM', ExposureTime: '1/250', FNumber: '2.8', ISO: '400' } } })
    .jpeg().toFile(path.join(inDir, 'has-exif.jpg'));
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#8899aa' } })
    .jpeg().toFile(path.join(inDir, 'no-exif.jpg'));

  const postJob = async (payload) => {
    const r = await req('POST', '/api/process', payload);
    eq(r.status, 200, '提交任务应 200：' + r.text.slice(0, 200));
    return r.json.jobId;
  };
  const waitJob = async (id) => {
    for (let i = 0; i < 100; i++) {
      const r = await req('GET', '/api/jobs/' + id);
      if (r.json && (r.json.status === 'done' || r.json.status === 'error')) return r.json;
      await new Promise((s) => setTimeout(s, 100));
    }
    throw new Error('任务超时未结束: ' + id);
  };

  console.log('\n[1] 健康检查与字段清单');
  {
    const h = await req('GET', '/api/health');
    ok('GET /api/health 返回 ok', () => { eq(h.status, 200); eq(h.json.ok, true); });
    const f = await req('GET', '/api/exif-fields');
    ok('GET /api/exif-fields 列出可选字段', () => {
      eq(f.status, 200);
      assert(Array.isArray(f.json.fields) && f.json.fields.length >= 8, '字段数应 ≥8');
      for (const k of ['camera', 'lens', 'exposure', 'date']) {
        assert(f.json.fields.some((x) => x.key === k), `缺字段 ${k}`);
      }
    });
  }

  console.log('\n[2] 纯文字组（只写相机参数，不给 watermarkId）');
  {
    const id = await postJob({ mode: 'local', inputDir: inDir, outputDir: path.join(TMP, 'out-text'),
      options: { format: 'auto', quality: 90 },
      groups: [{ text: { enabled: true, fields: ['camera', 'lens', 'exposure'] }, position: 'se', sizePct: 30 }] });
    const j = await waitJob(id);
    ok('无 watermarkId 也能跑，两张都成功', () => { eq(j.status, 'done'); eq(j.ok, 2); eq(j.failed, 0); });
    // 核心保证：没有 EXIF 的那张不能被重编码（否则白掉一次画质）
    const a = path.join(inDir, 'no-exif.jpg');
    const b = j.results.find((r) => /no-exif/.test(r.name)).output;
    ok('无 EXIF 的图原样输出（字节不变）', () =>
      assert(fs.readFileSync(a).equals(fs.readFileSync(b)), '字节应当完全一致'));
  }

  console.log('\n[3] 纯边框（不给 watermarkId、groups 也为空）');
  {
    const id = await postJob({ mode: 'local', inputDir: inDir, outputDir: path.join(TMP, 'out-frame'),
      options: { format: 'auto', quality: 92, frame: { style: 'band', lines: ['A', 'B'], align: 'left' } } });
    const j = await waitJob(id);
    ok('只加边框不叠水印也能跑', () => { eq(j.status, 'done'); eq(j.ok, 2); });
    // 套边框会把中间产物变成 PNG，但绝不能因此改掉用户选的输出格式
    const m = await sharp(j.results[0].output).metadata();
    ok('边框不改变输出格式（JPEG 仍是 JPEG）', () => eq(m.format, 'jpeg'));
    ok('边框把画布撑高了', () => assert(m.height > 600, `得到 ${m.height}`));
  }

  console.log('\n[4] 预览：纯文字 / 纯边框（曾在此 404）');
  {
    const r1 = await req('POST', '/api/preview', { orient: 'landscape', groups: [
      { text: { enabled: true, fields: ['camera', 'lens'] }, position: 'se', sizePct: 30 }] });
    ok('无 watermarkId 的文字预览可出图', () => {
      eq(r1.status, 200, r1.text.slice(0, 150));
      assert(String(r1.json.preview || '').startsWith('data:image/'), '应返回 data URL');
    });
    const r2 = await req('POST', '/api/preview', { orient: 'portrait', groups: [],
      options: { frame: { style: 'frame', lines: ['MY STUDIO', ''], align: 'center' } } });
    ok('纯边框预览可出图（不再被「水印不存在」挡掉）', () => {
      eq(r2.status, 200, r2.text.slice(0, 150));
      assert(String(r2.json.preview || '').startsWith('data:image/'), '应返回 data URL');
    });
    // 真给了 logo 组却不给 watermarkId，仍该明确报错（别把这条也放行了）
    const r3 = await req('POST', '/api/preview', { groups: [{ logos: [0], position: 'se', sizePct: 20 }] });
    ok('logo 组缺 watermarkId 仍报 404', () => eq(r3.status, 404));
  }

  console.log('\n[5] 监听：纯文字 / 纯边框（曾在此 404）');
  {
    const mk = (body) => req('POST', '/api/watchers', body);
    const r1 = await mk({ inputDir: inDir, outputDir: path.join(TMP, 'w1'),
      groups: [{ text: { enabled: true, fields: ['camera'] }, position: 'se', sizePct: 30 }] });
    ok('纯文字监听可创建', () => eq(r1.status, 200, r1.text.slice(0, 150)));
    const r2 = await mk({ inputDir: inDir, outputDir: path.join(TMP, 'w2'),
      options: { frame: { style: 'band', lines: ['X', ''], align: 'left' } } });
    ok('纯边框监听可创建', () => eq(r2.status, 200, r2.text.slice(0, 150)));
    const r3 = await mk({ inputDir: inDir, outputDir: path.join(TMP, 'w3'),
      groups: [{ logos: [0], position: 'se', sizePct: 20 }] });
    ok('logo 组缺 watermarkId 的监听仍被拒', () => eq(r3.status, 404));
    // 清掉，别让监听在测试结束后还跑着
    const list = await req('GET', '/api/watchers');
    for (const w of (list.json.watchers || [])) await req('DELETE', '/api/watchers/' + w.id);
    ok('监听可删除（收尾）', () => {});
  }

  console.log('\n[6] 参数校验');
  {
    // 未知版式被 normFrame 静默丢弃（→ null），于是这个请求变成「什么都没说要画」，
    // 被明确拒掉。重点是它不能悄悄跑成一张没有边框的图
    const r1 = await req('POST', '/api/process', { mode: 'local', inputDir: inDir, outputDir: path.join(TMP, 'x'),
      options: { frame: { style: 'nonsense' } } });
    ok('非法边框版式不会静默产出没边框的图', () => eq(r1.status, 400, r1.text.slice(0, 120)));
    // 字段名非法 → normTextSpec 归 null → 这个分组没有 logo 也没有文字 → 报「存在没有 logo 的分组」
    const r2 = await req('POST', '/api/process', { mode: 'local', inputDir: inDir, outputDir: path.join(TMP, 'y'),
      groups: [{ text: { enabled: true, fields: ['not-a-field'] }, position: 'se', sizePct: 30 }] });
    ok('非法参数字段被拒（400，不是 500）', () => eq(r2.status, 400, r2.text.slice(0, 120)));
    const r3 = await req('POST', '/api/process', { mode: 'local', inputDir: inDir, outputDir: path.join(TMP, 'z'), groups: [] });
    ok('既无水印也无边框 → 400', () => eq(r3.status, 400, r3.text.slice(0, 120)));
    // 水印集整个不存在：在更早的地方就被挡下（404），走不到分组解析
    const r4 = await req('POST', '/api/process', { mode: 'local', inputDir: inDir, outputDir: path.join(TMP, 'w'),
      watermarkId: 'no-such-set', groups: [{ logos: [3], position: 'se', sizePct: 20 }] });
    ok('水印集不存在 → 404（早于分组解析）', () => eq(r4.status, 404, r4.text.slice(0, 120)));
  }

  srv.close();
  console.log(`\n全部通过（${pass} 项）\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
