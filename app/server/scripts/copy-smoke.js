'use strict';
/**
 * 文案生成冒烟测试:起一个本地 mock 视觉模型服务(OpenAI 兼容),验证
 * 模型列表过滤、参考截图存取、生成接口的请求构造与 JSON 解析、密钥不外泄。
 *
 * 用法:node scripts/copy-smoke.js
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

const KEY = 'sk-test-secret-key-123';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'imgmark-copy-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });

let lastChat = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad key' } }));
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [
        { id: 'mock/vision-a', owned_by: 'mock', capabilities: { vision: true, contextWindow: 128000 } },
        { id: 'mock/text-only', owned_by: 'mock', capabilities: { vision: false } },
      ] }));
    }
    if (req.url === '/v1/chat/completions') {
      lastChat = JSON.parse(body);
      const text = '```json\n' + JSON.stringify({
        titles: ['标题A', '标题B'], body: '正文内容', hashtags: ['#cycling', '#骑行'], mentions: [],
      }) + '\n```';
      return res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    }
    res.writeHead(404);
    res.end('{}');
  });
});

const MOCK_PORT = 28200 + (process.pid % 200);
const PORT = 28400 + (process.pid % 200);
process.env.IMGMARK_DATA_DIR = DATA;
process.env.PORT = String(PORT);

const { start } = require('../src/server.js');

function req(method, urlPath, { json, form } = {}) {
  return new Promise((resolve, reject) => {
    let data = null;
    const headers = {};
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); headers['Content-Type'] = 'application/json'; }
    if (form) {
      const boundary = '----smoke' + Date.now();
      const parts = [];
      for (const [k, v] of Object.entries(form.fields || {})) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      }
      for (const f of form.files || []) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
        parts.push(f.buffer, Buffer.from('\r\n'));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      data = Buffer.concat(parts);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    }
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json: j, text, buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const srv = await start({ port: PORT, host: '127.0.0.1' });

  console.log('\n[1] 配置与模型列表');
  let r = await req('PUT', '/api/copy/config', { json: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: KEY, model: 'mock/vision-a' } });
  ok('保存配置后响应不含密钥', () => {
    eq(r.status, 200);
    assert.ok(!r.text.includes(KEY), '响应泄露了密钥');
    eq(r.json.hasKey, true);
  });
  r = await req('GET', '/api/copy/config');
  ok('读取配置不回传密钥', () => { assert.ok(!r.text.includes(KEY)); eq(r.json.hasKey, true); });
  r = await req('GET', '/api/copy/models');
  ok('模型列表只保留视觉模型', () => {
    eq(r.status, 200);
    eq(r.json.length, 1);
    eq(r.json[0].id, 'mock/vision-a');
  });

  console.log('\n[2] 参考截图');
  const img = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#3b6ea5' } }).png().toBuffer();
  r = await req('POST', '/api/copy/refs', { form: { fields: { name: 'ref1' }, files: [{ field: 'file', name: 'ref1.png', type: 'image/png', buffer: img }] } });
  const refId = r.json && r.json.id;
  ok('上传参考截图成功', () => { eq(r.status, 200); assert.ok(refId); });
  r = await req('GET', '/api/copy/refs');
  ok('列表包含该截图', () => { eq(r.json.length, 1); eq(r.json[0].id, refId); });
  r = await req('GET', `/api/copy/refs/${refId}/file`);
  ok('截图文件可读且为 JPEG 缩略图', () => {
    eq(r.status, 200);
    assert.ok(r.buf[0] === 0xff && r.buf[1] === 0xd8, '不是 JPEG');
  });

  console.log('\n[3] 生成文案');
  const target = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa8844' } }).jpeg().toBuffer();
  lastChat = null;
  r = await req('POST', '/api/copy/generate', { form: {
    fields: { payload: JSON.stringify({ platform: 'instagram', scene: 'PNS 在成都 CPI 开快闪店', model: 'mock/vision-a', refIds: [refId] }) },
    files: [{ field: 'image', name: 'target.jpg', type: 'image/jpeg', buffer: target }],
  } });
  ok('生成接口返回结构化文案(剥离代码块)', () => {
    eq(r.status, 200, r.text);
    eq(r.json.titles[0], '标题A');
    eq(r.json.body, '正文内容');
    eq(r.json.hashtags.length, 2);
    eq(r.json.platform, 'instagram');
  });
  ok('请求把参考截图与待发布图片都带给模型', () => {
    assert.ok(lastChat, '模型未被调用');
    const imgs = lastChat.messages[1].content.filter((p) => p.type === 'image_url');
    eq(imgs.length, 2, '应有 1 张参考 + 1 张目标');
    assert.ok(lastChat.messages[0].content.includes('Instagram'));
    assert.ok(lastChat.messages[1].content.some((p) => p.text && p.text.includes('成都')));
  });
  ok('生成响应不含密钥', () => assert.ok(!r.text.includes(KEY)));

  r = await req('POST', '/api/copy/generate', { form: {
    fields: { payload: JSON.stringify({ platform: 'instagram', scene: '', model: 'mock/vision-a' }) },
    files: [{ field: 'image', name: 'target.jpg', type: 'image/jpeg', buffer: target }],
  } });
  ok('场景为空时拒绝', () => eq(r.status, 400));

  r = await req('DELETE', `/api/copy/refs/${refId}`);
  ok('删除参考截图', () => { eq(r.status, 200); });
  r = await req('GET', '/api/copy/refs');
  ok('删除后列表为空', () => eq(r.json.length, 0));

  srv.close();
  mock.close();
  console.log(`\n全部通过(${pass} 项)\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
