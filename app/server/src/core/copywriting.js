'use strict';
/**
 * 文案生成引擎:历史截图存储、平台规则、视觉模型调用(OpenAI 兼容接口,如 10router)。
 *
 * 密钥只存 DATA_DIR/llm.json 或环境变量 IMGMARK_LLM_API_KEY,调用方不得把它放进任何响应。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { writeFileAtomic } = require('./db');

// 默认平台规则是未经官方核实的经验值,页面上会标注,用户可据实际发文情况调整。
const PLATFORMS = [
  {
    id: 'instagram',
    label: 'Instagram',
    rules: [
      '标题:Instagram 没有独立标题字段,正文第一行即为标题,建议不超过 80 个字符',
      '正文:可以使用 emoji,段落之间空一行',
      '话题:英文与中文双语混用,以英文为主(如 #cycling #roadbike #骑行),最多 30 个',
      '@:只能使用用户在场景描述里明确写出的账号,绝不猜测或编造账号',
    ],
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    rules: [
      '标题:20 个字以内,带情绪或数字钩子,可含 1 个 emoji',
      '正文:口语化,分段清晰,多用短句与 emoji,约 300-800 字',
      '话题:全部使用中文标签,3-8 个,放在正文末尾',
      '@:只能使用用户在场景描述里明确写出的账号',
    ],
  },
];

const MAX_REFS_PER_GENERATE = 3;
const THUMB_EDGE = 1024;

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

function storeFile(dataDir) { return path.join(dataDir, 'copywriting.json'); }
function refDir(dataDir) { return path.join(dataDir, 'copywriting'); }

function loadStore(dataDir) {
  try { return JSON.parse(fs.readFileSync(storeFile(dataDir), 'utf8')); } catch { return { refs: {} }; }
}
function saveStore(dataDir, store) { writeFileAtomic(storeFile(dataDir), JSON.stringify(store, null, 2)); }

function refFile(dataDir, id) { return path.join(refDir(dataDir), `${id}.jpg`); }

async function makeThumb(buf) {
  try {
    return await sharp(buf, { limitInputPixels: 40_000_000 }).rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer();
  } catch {
    throw httpErr(400, '无法解析的图片,请上传 JPG / PNG / WebP 等常见格式');
  }
}

function loadLlmFile(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'llm.json'), 'utf8')); } catch { return {}; }
}

function llmConfig(dataDir) {
  const f = loadLlmFile(dataDir);
  return {
    baseUrl: String(process.env.IMGMARK_LLM_BASE_URL || f.baseUrl || '').replace(/\/+$/, ''),
    apiKey: process.env.IMGMARK_LLM_API_KEY || f.apiKey || '',
    model: f.model || '',
  };
}

function saveLlmFile(dataDir, patch) {
  const next = { ...loadLlmFile(dataDir), ...patch };
  writeFileAtomic(path.join(dataDir, 'llm.json'), JSON.stringify(next, null, 2));
}

function llmConfigPublic(dataDir) {
  const c = llmConfig(dataDir);
  return { baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey };
}

async function listVisionModels(cfg) {
  if (!cfg.baseUrl) throw httpErr(400, '未配置模型服务地址');
  const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw httpErr(502, `无法连接模型服务:${e.message}`);
  }
  if (!res.ok) throw httpErr(502, `模型列表请求失败 HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return (Array.isArray(body.data) ? body.data : [])
    .filter((m) => m && m.capabilities && m.capabilities.vision)
    .map((m) => ({ id: m.id, owned_by: m.owned_by || '', contextWindow: m.capabilities.contextWindow || null }));
}

function buildMessages({ platform, scene, refImages = [], targetImages, feedback, previous }) {
  const system = [
    '你是社交媒体文案助手。根据待发布图片与场景描述,为指定平台写一篇发布文案。',
    `目标平台:${platform.label}`,
    '平台规则:',
    ...platform.rules.map((r) => `- ${r}`),
    '如果提供了参考截图,那是该账号过去发过的内容,请模仿其语气、分段与话题习惯。',
    '多张待发布图片是同一次发布的组图,请写一篇覆盖整组图片的文案,不要逐张分开写。',
    '只输出一个 JSON 对象,不要解释,不要代码块,结构如下:',
    '{"titles":["候选标题1","候选标题2","候选标题3"],"body":"正文","hashtags":["#标签"],"mentions":[]}',
    'mentions 只能原样填入场景描述里出现过的 @ 账号,没有则为空数组。',
  ].join('\n');
  const user = [
    { type: 'text', text: `场景描述:${scene}` },
  ];
  // 修改意见（单次上下文）：带上上一版结果让模型在其基础上改，而不是从头重写
  if (feedback && previous) {
    user.push({ type: 'text', text: `上一版文案(请在此基础上修改,保留没被意见涉及的部分):\n${previous}` });
    user.push({ type: 'text', text: `修改意见:${feedback}` });
  }
  refImages.forEach((buf, i) => {
    user.push({ type: 'text', text: `参考截图 ${i + 1}:` });
    user.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
  });
  targetImages.forEach((buf, i) => {
    user.push({ type: 'text', text: `待发布图片 ${i + 1}${targetImages.length > 1 ? `/${targetImages.length}` : ''}:` });
    user.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
  });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function chatComplete(cfg, model, messages) {
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1500 }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw httpErr(502, `无法连接模型服务:${e.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw httpErr(502, `模型调用失败 HTTP ${res.status}${body.error && body.error.message ? `:${body.error.message}` : ''}`);
  const text = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  if (!text) throw httpErr(502, '模型没有返回内容');
  return text;
}

function parseModelJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  let obj = null;
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(s.slice(start, end + 1)); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') throw httpErr(502, '模型返回的内容不是合法 JSON,请换个模型重试');
  const strList = (v, n) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, n) : []);
  return {
    titles: strList(obj.titles, 5),
    body: String(obj.body || ''),
    hashtags: strList(obj.hashtags, 30),
    mentions: strList(obj.mentions, 20),
  };
}

async function generateCopy({ cfg, platformId, scene, model, refImages, targetImages, feedback, previous }) {
  const platform = platformById(platformId);
  if (!platform) throw httpErr(400, '未知平台');
  if (!cfg.baseUrl) throw httpErr(400, '未配置模型服务地址');
  if (!cfg.apiKey) throw httpErr(400, '未配置模型密钥');
  if (!model) throw httpErr(400, '未选择模型');
  const images = Array.isArray(targetImages) && targetImages.length ? targetImages : [targetImages];
  if (!images[0]) throw httpErr(400, '缺少待发布图片');
  const messages = buildMessages({ platform, scene, refImages, targetImages: images, feedback, previous });
  const text = await chatComplete(cfg, model, messages);
  const out = { platform: platform.id, model, imageCount: images.length, ...parseModelJson(text) };
  if (feedback && previous) out.revised = true;
  return out;
}

module.exports = {
  PLATFORMS,
  MAX_REFS_PER_GENERATE,
  httpErr,
  platformById,
  loadStore,
  saveStore,
  refFile,
  refDir,
  makeThumb,
  llmConfig,
  llmConfigPublic,
  saveLlmFile,
  listVisionModels,
  chatComplete,
  generateCopy,
  parseModelJson,
};
