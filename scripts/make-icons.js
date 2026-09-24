'use strict';
// 生成 fpk 应用图标：ICON.PNG(512) / ICON_256.PNG / app/ui/images/icon_{64,128,256}.png
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'app', 'server', 'node_modules', 'sharp'));

const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e3a8a"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#bg)"/>
  <rect x="96" y="120" width="256" height="200" rx="24" fill="#ffffff" opacity="0.96"/>
  <circle cx="164" cy="186" r="24" fill="#fbbf24"/>
  <path d="M96 292 L190 208 L250 262 L306 214 L352 260 L352 296 a24 24 0 0 1 -24 24 L120 320 a24 24 0 0 1 -24 -24 Z" fill="#60a5fa"/>
  <path d="M300 208 L352 256 L352 296 a24 24 0 0 1 -24 24 L236 320 Z" fill="#2563eb" opacity="0.55"/>
  <circle cx="356" cy="330" r="118" fill="#0f172a" opacity="0.28"/>
  <circle cx="344" cy="318" r="106" fill="#22d3ee"/>
  <path d="M344 246 C300 306 316 356 344 368 C372 356 388 306 344 246 Z" fill="#0e7490"/>
  <path d="M344 252 C318 300 330 340 344 352" stroke="#a5f3fc" stroke-width="8" fill="none" stroke-linecap="round"/>
</svg>`;

async function main() {
  const root = path.join(__dirname, '..');
  const jobs = [
    [path.join(root, 'ICON.PNG'), 512],
    [path.join(root, 'ICON_256.PNG'), 256],
    [path.join(root, 'app', 'ui', 'images', 'icon_64.png'), 64],
    [path.join(root, 'app', 'ui', 'images', 'icon_128.png'), 128],
    [path.join(root, 'app', 'ui', 'images', 'icon_256.png'), 256],
  ];
  for (const [file, size] of jobs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
    console.log('✓', path.relative(root, file), size);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
