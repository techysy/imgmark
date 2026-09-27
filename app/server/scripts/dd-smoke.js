'use strict';
/**
 * 自定义下拉组件（enhanceSelect）逻辑冒烟测试。
 * 用 jsdom 提供真实 DOM，从 app.js 抽取组件源码后注入执行，
 * 覆盖：渲染 / 选择 / 触底向上弹 / 空间充足向下弹 / 实例回收 / 重复增强幂等。
 * 依赖 jsdom（仅测试用，不随生产包发布）：npm i -D jsdom
 * 用法：node scripts/dd-smoke.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch { console.error('需要 jsdom：请在 app/server 下执行  npm i -D jsdom  （或设置 NODE_PATH 指向含 jsdom 的目录）'); process.exit(2); }

// ---------- 抽取组件源码 ----------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
const start = appSrc.indexOf('// ---------- 自定义下拉');
const end = appSrc.indexOf('// ---------- 水印准备');
assert(start > 0 && end > start, '未能定位组件源码段');
let componentSrc = appSrc.slice(start, end);
// 组件里用到外部 esc()：去掉其声明，由注入参数提供
componentSrc = componentSrc.replace(/\bconst esc\b[^\n]*\n/, '');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function makeApi(dom) {
  const factory = new Function('document', 'window', 'esc', 'Event', componentSrc +
    '\nreturn { enhanceSelect, ddRegistry, closeAllDD, destroyDDWithin, refreshDD };');
  return factory(dom.window.document, dom.window, esc, dom.window.Event);
}

function fresh() {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>',
    { pretendToBeVisual: true });
  return { dom, api: makeApi(dom) };
}

function mkSelect(dom, hostSel, opts, selected = 0) {
  const doc = dom.window.document;
  const sel = doc.createElement('select');
  opts.forEach(([v, t]) => { const o = doc.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
  sel.selectedIndex = selected;
  doc.querySelector(hostSel).appendChild(sel);
  return sel;
}

const pass = [];
const fail = [];
const t = (name, fn) => { try { fn(); pass.push(name); } catch (e) { fail.push(name + ' :: ' + e.message); } };

// 1. 渲染
t('渲染：原生 select 被 .dd 包裹并加 dd-native，按钮显示当前选项', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['a', '选项A'], ['b', '选项B']], 1);
  api.enhanceSelect(sel);
  assert.ok(sel.classList.contains('dd-native'), '原生 select 应加 dd-native');
  const wrap = sel.parentNode;
  assert.strictEqual(wrap.className, 'dd', 'wrapper 应为 .dd');
  assert.strictEqual(wrap.querySelector('.dd-label').textContent, '选项B', '按钮应显示当前项文字');
});

// 2. 选择
t('选择：点击菜单项更新 selectedIndex 并派发一次 change', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['a', '选项A'], ['b', '选项B'], ['c', '选项C']], 0);
  api.enhanceSelect(sel);
  let changed = 0;
  sel.addEventListener('change', () => { changed++; });
  const inst = [...api.ddRegistry][0];
  inst.open();
  const items = inst.menu.querySelectorAll('.dd-item');
  assert.strictEqual(items.length, 3, '菜单应有 3 项');
  items[2].click();
  assert.strictEqual(sel.selectedIndex, 2, 'selectedIndex 应变为 2');
  assert.strictEqual(changed, 1, 'change 应触发一次');
  assert.strictEqual(inst.menu.classList.contains('hidden'), true, '选择后菜单应关闭');
});

// 3. 触底向上弹
t('触底避让：下方空间不足时加 .up 向上弹', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['a', '选项A']]);
  api.enhanceSelect(sel);
  const inst = [...api.ddRegistry][0];
  // 桩掉按钮矩形：贴近视口底部（innerHeight=768）
  inst.btn.getBoundingClientRect = () => ({ top: 700, bottom: 730, left: 100, right: 200, width: 100, height: 30 });
  Object.defineProperty(inst.menu, 'scrollHeight', { value: 200, configurable: true });
  inst.open();
  assert.ok(inst.menu.classList.contains('up'), '应加 .up');
  assert.ok(!inst.menu.classList.contains('down'), '不应有 .down');
});

// 4. 空间充足向下弹
t('空间充足：加 .down 向下弹', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['a', '选项A']]);
  api.enhanceSelect(sel);
  const inst = [...api.ddRegistry][0];
  inst.btn.getBoundingClientRect = () => ({ top: 50, bottom: 80, left: 100, right: 200, width: 100, height: 30 });
  Object.defineProperty(inst.menu, 'scrollHeight', { value: 200, configurable: true });
  inst.open();
  assert.ok(inst.menu.classList.contains('down'), '应加 .down');
});

// 5. 实例回收
t('回收：destroyDDWithin 清空容器内的实例注册', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['a', '选项A']]);
  api.enhanceSelect(sel);
  assert.strictEqual(api.ddRegistry.size, 1);
  api.destroyDDWithin(dom.window.document.querySelector('#host'));
  assert.strictEqual(api.ddRegistry.size, 0);
});

// 6. 幂等
t('幂等：重复 enhanceSelect 不重复包装', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['a', '选项A']]);
  api.enhanceSelect(sel);
  api.enhanceSelect(sel);
  assert.strictEqual(api.ddRegistry.size, 1);
  assert.strictEqual(dom.window.document.querySelectorAll('.dd').length, 1, '应只有一个 .dd 包裹层');
});

// 7. 程序改 value 后 refreshDD 同步显示
t('同步：程序改原生 value 后 refreshDD 更新按钮文字', () => {
  const { dom, api } = fresh();
  const sel = mkSelect(dom, '#host', [['auto', '保持原格式'], ['jpeg', 'JPEG']], 0);
  api.enhanceSelect(sel);
  sel.value = 'jpeg';
  api.refreshDD(sel);
  assert.strictEqual(sel.parentNode.querySelector('.dd-label').textContent, 'JPEG');
});

// ---------- 结果 ----------
console.log(`\n自定义下拉冒烟测试：通过 ${pass.length} / ${pass.length + fail.length}`);
for (const p of pass) console.log('  ✓ ' + p);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
