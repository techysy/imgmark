'use strict';
/**
 * 生成 GitHub Release 正文：CHANGELOG.md 中对应版本的小节 + 下载表 + 安装说明。
 * build-fpk / build-desktop 两个工作流都用它（body_path），谁后跑写入的内容都一样。
 *
 * 用法：node scripts/release-notes.js v0.7.3 [输出文件]   （不给输出文件则打印到 stdout）
 */
const fs = require('fs');
const path = require('path');

const REPO = 'techysy/imgmark';
const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('用法: node scripts/release-notes.js vX.Y.Z [输出文件]');
  process.exit(1);
}
const version = tag.slice(1);
const root = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

// 截取 "## [x.y.z]" 到下一个 "## [" 之间的内容
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md 中没有 ${version} 的小节，请先补充更新日志再发版`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
if (end < 0) end = lines.length;
const section = lines.slice(start + 1, end).join('\n').trim()
  .replace(/^### /gm, '#### ') // 小节标题降一级，放在「更新内容」下面
  // 仓库内相对链接在 Release 页面会失效，改成指向该 tag 的绝对链接
  .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, `](https://github.com/${REPO}/blob/${tag}/$1)`);

const dl = (file) => `[${file}](https://github.com/${REPO}/releases/download/${tag}/${file})`;
const prev = (() => {
  const m = lines.slice(end).find((l) => /^## \[\d+\.\d+\.\d+\]/.test(l));
  return m ? m.match(/\[(\d+\.\d+\.\d+)\]/)[1] : null;
})();

const body = `## 更新内容

${section}

## 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | ${dl(`ImgMark-Setup-${version}.exe`)} | 安装版（推荐） |
| Windows | ${dl(`ImgMark-Portable-${version}.exe`)} | 便携版，免安装，双击运行 |
| macOS（Apple Silicon） | ${dl(`ImgMark-mac-arm64-${version}.dmg`)} | M1 及以后的芯片 |
| macOS（Intel） | ${dl(`ImgMark-mac-x64-${version}.dmg`)} | Intel 芯片；构建较慢，可能比其他文件晚几分钟出现 |
| 飞牛 fnOS | ${dl(`imgmark-${version}-window.fpk`)} | **推荐**：桌面窗口入口，全功能 |
| 飞牛 fnOS | ${dl(`imgmark-${version}-fullscreen.fpk`)} | 全屏 / 新标签页入口，全功能 |
| 飞牛 fnOS | ${dl(`imgmark-${version}-compat.fpk`)} | 兼容旧版应用中心（安装报「设置目录权限失败」时用），无飞牛授权目录功能 |

## 安装说明

- **Windows**：安装版一路下一步即可；便携版无需安装。首次运行若出现 SmartScreen 提示，点「更多信息 → 仍要运行」。
- **macOS**：安装包未做代码签名，首次打开请在「应用程序」里**右键 → 打开**，或在终端执行 \`xattr -cr /Applications/ImgMark.app\`。
- **飞牛 fnOS**：fpk 三选一，放到应用中心扫描目录（如 \`/vol1/1000/fnOS App/fpk/imgmark/\`）后在应用中心「手动安装」。要求 fnOS ≥ 1.2.0401、应用中心 ≥ 1.34.0（window / fullscreen 变体），会自动安装依赖应用 nodejs_v24。

完整说明见 [README](https://github.com/${REPO}/blob/main/README.md)。${prev ? `\n\n**完整变更**：https://github.com/${REPO}/compare/v${prev}...${tag}` : ''}
`;

if (process.argv[3]) fs.writeFileSync(process.argv[3], body);
else process.stdout.write(body);
