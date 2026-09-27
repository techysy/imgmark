'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const expected = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const server = require(path.join(root, 'app/server/package.json')).version;
const desktop = require(path.join(root, 'desktop/package.json')).version;
const serverLock = require(path.join(root, 'app/server/package-lock.json')).packages[''].version;
const desktopLock = require(path.join(root, 'desktop/package-lock.json')).packages[''].version;
const manifest = fs.readFileSync(path.join(root, 'manifest'), 'utf8').match(/^version\s*=\s*(\S+)/m)?.[1];
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const latestChangelog = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
const tag = process.argv[2] || '';
const tagVersion = /^v\d+\.\d+\.\d+$/.test(tag) ? tag.slice(1) : '';

const values = {
  VERSION: expected, manifest: manifest || '(missing)', server, desktop,
  'server lock': serverLock, 'desktop lock': desktopLock,
  changelog: latestChangelog || '(missing)',
};
const mismatches = Object.entries(values).filter(([, value]) => value !== expected);
if (tagVersion && tagVersion !== expected) mismatches.push(['git tag', tagVersion]);

if (mismatches.length) {
  console.error('版本号不一致：');
  for (const [name, value] of mismatches) console.error(`  ${name}: ${value}（应为 ${expected}）`);
  process.exit(1);
}
console.log(`版本一致：${expected}${tagVersion ? ` (${tag})` : ''}`);
