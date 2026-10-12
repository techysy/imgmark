'use strict';
/**
 * 相机参数文字水印的字体清单。
 *
 * 两个坑，决定了这个模块要做两件事：
 *
 * 1) 文字是 librsvg 画的，走 fontconfig/Pango 查字体，**查不到不报错**：照样出一张
 *    PNG，只是里面没有字。所以 startup 的自检只能看出「一个字体都没有」这种极端情况，
 *    认不出「雅黑这一款缺了」。
 * 2) 反过来更隐蔽：字体名写错/系统没装时，librsvg 会**回落到默认字体**再画。所以只
 *    问「画得出墨吗」是不够的 —— 实测 23 个候选名（含 macOS 专有的苹方、冬青黑体，
 *    以及一个故意瞎编的名字）在 Windows 上全都「画得出字」，全都通过。
 *
 * 区分的办法是**墨迹指纹**：用同一个探针串渲染一次，对灰度像素取哈希。真的字体各有各
 * 的像素；凡是回落到同一个默认字体的，字节级一模一样。于是拿「一个故意瞎编的名字」
 * 的指纹当回落基准，指纹相同的即视为缺失（同时也能把同一个字体的多个别名收敛掉）。
 * 探针串里带一个汉字，只靠拉丁字母量不准 CJK 字体。
 */
const sharp = require('sharp');
const crypto = require('node:crypto');

// 探针串：汉字 + 拉丁 + 数字，大小写混排 —— 字形差异最大化，便于指纹区分
const PROBE_TEXT = 'Wm样Rg8';
// 一定不存在、必定回落的字体名，用作「回落指纹」基准
const FALLBACK_FAMILY = '__imgmark_missing_font__';

/**
 * 候选字体。family 交给 librsvg，label 是界面上的中文说明。
 * kind 仅用于界面分组：cjk 中文正文 / latin 西文 / mono 等宽 / generic 通用族。
 * 顺序即界面顺序；缺字体的机器上它们会自动消失（见 listAvailableFonts）。
 */
const CANDIDATES = [
  // 中文正文字体
  { family: 'Microsoft YaHei', label: '微软雅黑', kind: 'cjk', note: 'Windows 自带' },
  { family: 'SimHei', label: '黑体', kind: 'cjk', note: 'Windows 自带' },
  { family: 'SimSun', label: '宋体', kind: 'cjk', note: 'Windows 自带' },
  { family: 'KaiTi', label: '楷体', kind: 'cjk', note: 'Windows 自带' },
  { family: 'FangSong', label: '仿宋', kind: 'cjk', note: 'Windows 自带' },
  { family: 'DengXian', label: '等线', kind: 'cjk', note: 'Windows 自带' },
  { family: 'Source Han Sans SC', label: '思源黑体', kind: 'cjk', note: '需自行安装' },
  { family: 'Noto Sans CJK SC', label: 'Noto 黑体', kind: 'cjk', note: 'Linux 常见' },
  { family: 'PingFang SC', label: '苹方', kind: 'cjk', note: 'macOS 自带' },
  { family: 'Hiragino Sans GB', label: '冬青黑体', kind: 'cjk', note: 'macOS 自带' },
  // 西文
  { family: 'Arial', label: 'Arial', kind: 'latin', note: '通用' },
  { family: 'Helvetica', label: 'Helvetica', kind: 'latin', note: 'macOS 自带' },
  { family: 'Times New Roman', label: 'Times New Roman', kind: 'latin', note: '衬线' },
  { family: 'Georgia', label: 'Georgia', kind: 'latin', note: '衬线' },
  { family: 'Verdana', label: 'Verdana', kind: 'latin', note: '宽字面' },
  { family: 'Tahoma', label: 'Tahoma', kind: 'latin', note: 'Windows 自带' },
  { family: 'Trebuchet MS', label: 'Trebuchet MS', kind: 'latin', note: 'Windows 自带' },
  { family: 'Impact', label: 'Impact', kind: 'latin', note: '粗标题' },
  // 等宽
  { family: 'Courier New', label: 'Courier New', kind: 'mono', note: '等宽' },
  { family: 'Consolas', label: 'Consolas', kind: 'mono', note: 'Windows 自带' },
  // 通用族：由 fontconfig 兜底，必定画得出字
  { family: 'sans-serif', label: '系统默认（无衬线）', kind: 'generic', note: '通用族' },
  { family: 'serif', label: '系统默认（衬线）', kind: 'generic', note: '通用族' },
  { family: 'monospace', label: '系统默认（等宽）', kind: 'generic', note: '通用族' },
];

// payload 里的 fontFamily 只认这张表（全体候选，不只是可用的那几款）——
// 认不出来的回落 sans-serif：既防注入，也防「填了个没用的名字还不知道」
const ALLOWED = new Set(CANDIDATES.map((c) => c.family));
const DEFAULT_FONT_FAMILY = 'sans-serif';

/** 归一化用户传入的 fontFamily：不在白名单里就回落 sans-serif */
function normalizeFontFamily(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 60) : '';
  return ALLOWED.has(s) ? s : 'sans-serif';
}

/** 渲染探针串，取灰度像素指纹；画不出字返回 null */
async function inkFingerprint(fontFamily) {
  const esc = String(fontFamily).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="80">`
    + `<text x="4" y="58" font-family="${esc}" font-size="44" fill="#000">${PROBE_TEXT}</text></svg>`;
  // 必须先压平到白底再取指纹：透明底的像素全是 0，一整张纯色本来就区分不出字体
  const { data } = await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  // 全白 = 真的一笔没画出来
  let ink = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 240) ink++;
  if (ink < 20) return null;
  return crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
}

let cache = null; // 每款一次 sharp 渲染，不便宜；同一进程只探一次

/**
 * 列出本机**真正可用**的字体（保持候选顺序）。
 *
 * 判定：先探一个故意不存在的名字拿到「回落指纹」，凡是指纹与它相同的候选一律剔除
 * （这些是系统没装、被 librsvg 悄悄换掉的）；其余按指纹去重，保留第一个 —— 同一个字体
 * 的多个别名（典型：Arial 装着的机器上 Helvetica 也指向它）只留一个。
 *
 * sans-serif 无条件保留：它是默认项，也是最后保底；它在某些机器上确实就等于回落字体
 * （实测 librsvg 在 Windows 上把 serif/monospace 也一并回落了），这种时候保留它、
 * 剔掉 serif/monospace 才是对的 —— 免得给出「选了就变样」的选项。
 * @returns {Promise<Array<{family:string,label:string,kind:string,note?:string}>>}
 */
async function listAvailableFonts() {
  if (cache) return cache;
  const fallbackFp = await inkFingerprint(FALLBACK_FAMILY);
  const seen = new Set();
  const out = [];
  for (const c of CANDIDATES) {
    const fp = await inkFingerprint(c.family);
    if (!fp) continue;                       // 一笔没画出来
    if (fp === fallbackFp) {                 // 回落到了默认字体 → 视作没装
      if (c.family !== 'sans-serif') continue;
      out.push(c); seen.add(fp);
      continue;
    }
    if (seen.has(fp)) continue;              // 同一款字体的别名，保留第一个
    seen.add(fp);
    out.push(c);
  }
  cache = out.length ? out : CANDIDATES.filter((c) => c.family === 'sans-serif');
  return cache;
}

module.exports = { listAvailableFonts, normalizeFontFamily, DEFAULT_FONT_FAMILY, FONT_FAMILIES: ALLOWED };