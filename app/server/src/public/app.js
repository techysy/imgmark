'use strict';
/**
 * ImgMark 前端逻辑。
 * fnOS 宿主环境（桌面 iframe，manifest micro_app=true）：用 @trimjs/web-app 的 pickUserFile/pickSharedFile 选目录即授权；
 * 独立浏览器：授权需经 fnOS 宿主路由，这里给出提示并保留"后端查询已授权目录"能力（此前在宿主内授权过的目录仍可用）。
 */

const $ = (id) => document.getElementById(id);
const native = window.imgmarkDesktop || null; // Electron 桌面壳桥接（纯浏览器环境为 null）
const state = {
  watermarkId: null,      // logo 组 id（split 模式：每个 logo 独立去底）
  logoSet: null,          // {id, logos:[{key,name,width,height,preview,monochrome,inkDark,sourcePreview,sourceWidth,sourceHeight,hasAlt}]}
  groups: [],             // 分组布局：{logos:[idx], position, sizePct, marginPct, direction, gapX, gapY, ratios, opacity}
  wmFiles: [],            // 本次待准备/已准备的 logo 文件
  mode: 'fnos',
  fnosPicked: null,
  localPicked: null,
  uploadCount: 0,
  nativePaths: [], // 桌面壳：原生对话框选出的图片绝对路径
  sdk: null,
  fnosAvailable: false,
  // 裁剪（每个 logo 各自一份裁剪框）
  crops: [],
  editingIdx: 0,
  // 水印类型：logo / 文字·画框 两个标签页二选一（文字页内含 浮动文字 / 条幅 / 白框 / 装裱 四种样式）
  layers: { logo: true, text: false },
  layerNoteExtra: '', // 恢复混合方案时的临时提醒，手动切页后清掉
};
// 两类水印是二选一的标签页，不是两个可叠加的开关：一次只跑一类，配置区也只显示一类
// （引擎仍支持任意组合，但页面上不再提供组合入口 —— 组合要配两套参数，用起来比切换麻烦）
const LAYERS = ['logo', 'text'];
const LAYER_NOTE = {
  logo: '上传 logo 后按分组布局叠到画面上；支持多 logo、九宫格定位、平铺与亮度自适应换色',
  text: '把每张照片自己的 EXIF 渲成文字：浮在画面上，或写进条幅 / 白框 / 装裱的留白里',
};
function layerNote() {
  const active = LAYERS.find((k) => state.layers[k]) || 'logo';
  const el = $('layer-note');
  if (!el) return;
  el.textContent = LAYER_NOTE[active] + (state.layerNoteExtra || '');
}
// 切到某一类：另一类自动收起（二选一），面板显隐、状态持久化、联动预览与运行判定
function setLayer(name) {
  for (const k of LAYERS) state.layers[k] = k === name;
  localStorage.setItem('imgmark_layers', JSON.stringify(state.layers));
  applyLayers();
  updateRun();
  refreshPreview();
}
function applyLayers() {
  for (const k of LAYERS) $(`type-${k}`).classList.toggle('hidden', !state.layers[k]);
  document.querySelectorAll('#wm-layer-tabs .tab').forEach((b) => {
    b.classList.toggle('on', !!state.layers[b.dataset.layer]);
  });
  layerNote();
}
let cropMode = false, dragStart = null;
let previewOrient = 'landscape'; // 样式预览示例图方向：landscape|portrait（仅预览用）
let prepareGeneration = 0;

// ---------- 视图导航（CreditDaddy 模式：三个视图 DOM 常驻、只做显隐） ----------
// 表单状态/预览/事件绑定都不随切走而销毁，切回即原样；当前视图存 localStorage
const VIEWS = ['style', 'batch', 'watch'];
function goView(v) {
  if (!VIEWS.includes(v)) v = 'style';
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  VIEWS.forEach((k) => $(`view-${k}`).classList.toggle('active', k === v));
  localStorage.setItem('imgmark_view', v);
}

// ---------- 图标（Lucide 风格线性图标，与 CreditDaddy 同款，currentColor） ----------
const svg = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const I = {
  github: svg('<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  // 单张导出工具条：同样是 Lucide（ISC 开源）线性图标，不用 emoji —— emoji 各平台字形不一
  image: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    // 复制成图到剪贴板（分享到社交平台）
    clipboard: svg('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
};

// 空状态占位图（与 index.html 中的初始 src 保持一致）
const PLACEHOLDER_WM = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='190' height='150'%3E%3Ctext x='95' y='70' text-anchor='middle' font-family='sans-serif' font-size='12' fill='%239aa0a6'%3E添加 logo 后预览%3C/text%3E%3Ctext x='95' y='92' text-anchor='middle' font-family='sans-serif' font-size='11' fill='%23b9bec5'%3E支持 AI / SVG / PNG / JPG%3C/text%3E%3C/svg%3E";
const PLACEHOLDER_STYLE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='420' height='280'%3E%3Crect x='0' y='0' width='420' height='280' fill='%23dde3ea'/%3E%3Ccircle cx='90' cy='70' r='42' fill='%23ffffff' opacity='.35'/%3E%3Crect x='280' y='180' width='110' height='66' fill='%233d4f63' opacity='.3' rx='8'/%3E%3Ctext x='210' y='145' text-anchor='middle' font-family='sans-serif' font-size='13' fill='%237a8494'%3E选择水印样式后预览%3C/text%3E%3C/svg%3E";

// ---------- 工具 ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 自定义下拉（统一替换原生 select） ----------
// 原生 <select> 保留在 DOM 中作为数据源与 change 事件目标：外部读 .value / 绑定 change 的代码完全不变，
// 只在它旁边渲染一层自定义按钮 + 菜单，并负责触底向上弹、右侧空间不足时右对齐。
const ddRegistry = new Set(); // 所有已增强的 select，用于全局关闭 / 重绘

function ddLabelOf(sel) {
  const opt = sel.options[sel.selectedIndex];
  return opt ? opt.textContent : '';
}

function enhanceSelect(sel) {
  if (!sel || sel.dataset.ddDone === '1') return sel;
  sel.dataset.ddDone = '1';
  sel.classList.add('dd-native'); // 视觉隐藏但保留可访问性与表单语义

  const wrap = document.createElement('div');
  wrap.className = 'dd';
  // 原生 select 已在 DOM 里，把它挪进 wrapper 保证位置对应
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `<span class="dd-label"></span><span class="dd-caret"></span>`;

  const menu = document.createElement('div');
  menu.className = 'dd-menu hidden';
  menu.setAttribute('role', 'listbox');

  wrap.appendChild(btn);
  wrap.appendChild(menu);

  const instance = { sel, wrap, btn, menu, close: () => closeDD(instance), render: () => renderDD(instance) };
  ddRegistry.add(instance);

  function renderDD(self) {
    self.btn.querySelector('.dd-label').textContent = ddLabelOf(self.sel);
    self.menu.innerHTML = Array.from(self.sel.options).map((o, i) =>
      `<button type="button" class="dd-item ${i === self.sel.selectedIndex ? 'on' : ''}" role="option"
        aria-selected="${i === self.sel.selectedIndex}" data-i="${i}">${esc(o.textContent)}</button>`).join('');
    self.menu.querySelectorAll('.dd-item').forEach((el) => el.addEventListener('click', () => {
      pickDD(self, +el.dataset.i);
    }));
  }

  function pickDD(self, i) {
    if (i === self.sel.selectedIndex) { closeDD(self); return; }
    self.sel.selectedIndex = i;
    // 先关闭：change 可能触发 renderGroups() 重建 DOM，导致本实例失效
    closeDD(self);
    // 触发原生 change，让既有业务逻辑（预览刷新/格式联动/裁剪提示等）照常执行
    self.sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  instance.destroy = () => { ddRegistry.delete(instance); };

  function openDD(self) {
    closeAllDD(self);
    renderDD(self);
    self.menu.classList.remove('hidden', 'up', 'down', 'right');
    self.btn.classList.add('open');
    self.btn.setAttribute('aria-expanded', 'true');

    // 触底避让：下方放不下就向上弹；默认向下
    const r = self.btn.getBoundingClientRect();
    const menuH = Math.min(self.menu.scrollHeight, 300);
    const spaceBelow = window.innerHeight - r.bottom - 12;
    const spaceAbove = r.top - 12;
    if (spaceBelow < menuH && spaceAbove > spaceBelow) self.menu.classList.add('up');
    else self.menu.classList.add('down');

    // 右侧空间不足则右对齐，避免横向溢出
    if (r.left + self.menu.offsetWidth > window.innerWidth - 8) self.menu.classList.add('right');
  }

  function closeDD(self) {
    self.menu.classList.add('hidden');
    self.btn.classList.remove('open');
    self.btn.setAttribute('aria-expanded', 'false');
  }

  instance.open = () => {
    if (instance.menu.classList.contains('hidden')) openDD(instance); else closeDD(instance);
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); instance.open(); });
  // 原生 select 被程序改动（如恢复方案）时同步显示
  sel.addEventListener('change', () => { if (instance.menu.classList.contains('hidden')) renderDD(instance); });

  renderDD(instance);
  return sel;
}

function closeAllDD(except) {
  for (const inst of ddRegistry) if (inst !== except) inst.close();
}
// 容器被 innerHTML 重建前调用：回收其内部的自定义下拉实例（DOM 即将消失，仅需清理注册表）
function destroyDDWithin(container) {
  if (!container) return;
  for (const inst of [...ddRegistry]) {
    if (container.contains(inst.sel)) inst.destroy();
  }
}
// 外部（恢复方案等）改完原生 select 后调用，刷新显示文字
function refreshDD(sel) {
  for (const inst of ddRegistry) if (inst.sel === sel || !sel) inst.render();
}

// 全局关闭：点击组件外 / Esc
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('.dd')) closeAllDD();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllDD(); });
window.addEventListener('resize', () => closeAllDD());


// ---------- 水印准备（split：每个 logo 独立去底；布局在 ② 分组里配置） ----------
async function prepareWatermark() {
  const generation = ++prepareGeneration;
  state.watermarkId = null;
  updateRun();
  if (!state.wmFiles.length) {
    state.logoSet = null;
    $('wm-preview').src = PLACEHOLDER_WM;
    $('style-preview').src = PLACEHOLDER_STYLE;
    $('style-preview-auto').classList.add('hidden');
    $('preview-cap-auto').classList.add('hidden');
    renderLogoList(); renderGroups();
    updateCropUI();
    updateAutoColorUI();
    updateRun();
    return;
  }
  const fd = new FormData();
  for (const f of state.wmFiles) fd.append('watermark', f);
  fd.append('split', 'true');
  fd.append('bg', $('wm-bg').value);
  fd.append('tolerance', $('wm-tol').value);
  fd.append('force', $('wm-force').checked ? 'true' : 'false');
  fd.append('trim', $('wm-trim').checked ? 'true' : 'false');
  if (state.crops.some(Boolean)) fd.append('crop', JSON.stringify(state.crops));
  $('wm-notes').textContent = '处理中…';
  try {
    const r = await api('/api/prepare', { method: 'POST', body: fd });
    if (generation !== prepareGeneration) return;
    state.watermarkId = r.id;
    state.logoSet = { id: r.id, logos: r.logos };
    if (state.editingIdx >= r.logos.length) state.editingIdx = 0;
    // 首次上传：建一个含全部 logo 的默认分组；已有分组则清掉失效引用、对齐比例数组
    if (!state.groups.length) {
      state.groups = [defaultGroup(r.logos.map((_, i) => i))];
    } else {
      state.groups.forEach((g) => { g.logos = g.logos.filter((i) => i < r.logos.length); });
      state.groups = state.groups.filter((g) => g.logos.length);
      if (!state.groups.length) state.groups = [defaultGroup(r.logos.map((_, i) => i))];
      state.groups.forEach((g) => { g.ratios = g.logos.map((_, k) => (g.ratios && g.ratios[k]) || 1); });
    }
    $('crop-btn').disabled = false;
    $('wm-preview').src = cropMode && logoSource(state.editingIdx) ? logoSource(state.editingIdx) : r.logos[0].preview;
    $('wm-notes').textContent = r.logos.map((l) => `[${l.name}] ${l.width}×${l.height}${l.monochrome ? ' · 纯黑白' : ' · 含彩色'}${l.hasAlt ? ' · 已生成反色变体' : ''}`).join('\n');
    renderLogoList();
    renderGroups();
    updateCropUI();
    updateAutoColorUI();
    refreshPreview();
    updateRun();
  } catch (e) {
    if (generation !== prepareGeneration) return;
    $('wm-notes').textContent = '✗ ' + e.message;
    state.watermarkId = null;
    state.logoSet = null;
    updateAutoColorUI();
    updateRun();
  }
}
const prepareDebounced = debounce(prepareWatermark, 500);

function defaultGroup(idxs) {
  return {
    logos: idxs.slice(), position: 'se', sizePct: 20, marginPct: 3,
    direction: 'h', gapX: 12, gapY: 12, ratios: idxs.map(() => 1), opacity: 80,
  };
}
const logoOf = (i) => (state.logoSet ? state.logoSet.logos[i] : null);
const logoSource = (i) => { const l = logoOf(i); return l && l.sourcePreview ? l.sourcePreview : null; };

// ---------- 方案（服务端持久化：参数与 logo 文件都存到程序数据目录，换浏览器/清缓存不丢） ----------
let presets = [];         // [{id,name,time,files,data,summary}]，由 /api/presets 拉取
let selectedPresetId = ''; // 当前在下拉/详情里选中的方案 id（仅 UI 状态）

async function loadPresets() {
  try { presets = await api('/api/presets'); } catch { presets = []; }
  if (selectedPresetId && !presets.some((p) => p.id === selectedPresetId)) selectedPresetId = '';
  renderPresetMenu();
  renderPresetDetail();
}

/** 摘要标签 HTML（服务端 presetSummary 产出的 tags） */
function presetTagsHtml(p, limit = 0) {
  const tags = (p.summary && p.summary.tags) || [];
  const shown = limit ? tags.slice(0, limit) : tags;
  return shown.map((t) => `<span class="tag pt-tag pt-tag-${esc(t.k)}">${esc(t.label)}</span>`).join('');
}

function renderPresetMenu() {
  const menu = $('preset-menu');
  const cur = $('preset-current');
  if (!menu) return;
  if (!presets.length) {
    menu.innerHTML = '<div class="pt-empty muted">还没有保存的方案：填名称后点「保存当前」</div>';
  } else {
    menu.innerHTML = presets.map((p) => `
      <button type="button" class="pt-item ${p.id === selectedPresetId ? 'on' : ''}" data-id="${esc(p.id)}" role="option" aria-selected="${p.id === selectedPresetId}">
        <div class="pt-item-head">
          <b class="pt-item-name">${esc(p.name)}</b>
          <span class="pt-item-time">${new Date(p.time).toLocaleString()}</span>
        </div>
        <div class="pt-item-tags">${presetTagsHtml(p)}</div>
        <div class="pt-item-files muted">${p.files.length} 个 logo：${esc(p.files.map((f) => f.name).join('、').slice(0, 60))}${p.files.map((f) => f.name).join('、').length > 60 ? '…' : ''}</div>
      </button>`).join('');
    menu.querySelectorAll('.pt-item').forEach((el) => el.addEventListener('click', () => {
      const id = el.dataset.id;
      selectedPresetId = id;
      closePresetMenu();
      renderPresetMenu();
      renderPresetDetail();
      applyPreset(id);
    }));
  }
  const sel = presets.find((p) => p.id === selectedPresetId);
  if (cur) cur.textContent = sel ? sel.name : '选择已保存方案…';
}

function renderPresetDetail() {
  const box = $('preset-detail');
  if (!box) return;
  const p = presets.find((x) => x.id === selectedPresetId);
  if (!p) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const s = p.summary || {};
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="pd-head">
      <b>${esc(p.name)}</b>
      <span class="muted">${new Date(p.time).toLocaleString()}</span>
    </div>
    <div class="pd-tags">${presetTagsHtml(p)}</div>
    <div class="pd-files muted">logo 文件（${p.files.length}）：${esc(p.files.map((f) => f.name).join('、'))}</div>
    <div class="pd-actions">
      <button class="btn tiny" id="preset-reload">重新加载</button>
      <button class="btn tiny ghost" id="preset-use-name">用此名称覆盖保存</button>
    </div>`;
  const reload = $('preset-reload');
  if (reload) reload.addEventListener('click', () => applyPreset(p.id));
  const useName = $('preset-use-name');
  if (useName) useName.addEventListener('click', () => { $('preset-name').value = p.name; });
}

function openPresetMenu() {
  $('preset-menu').classList.remove('hidden');
  $('preset-toggle').setAttribute('aria-expanded', 'true');
  $('preset-toggle').classList.add('open');
}
function closePresetMenu() {
  const m = $('preset-menu');
  if (m) m.classList.add('hidden');
  const t = $('preset-toggle');
  if (t) { t.setAttribute('aria-expanded', 'false'); t.classList.remove('open'); }
}
function togglePresetMenu() {
  const m = $('preset-menu');
  if (m && m.classList.contains('hidden')) { renderPresetMenu(); openPresetMenu(); } else closePresetMenu();
}

async function savePreset() {
  const hint = $('preset-hint');
  const name = $('preset-name').value.trim();
  if (!name) { hint.textContent = '先填方案名称'; return; }
  const groups = groupsForPayload();
  const frame = frameDef();
  // 只开相机参数、没有 logo 也能存：那套方案里就只有文字水印这一组；纯边框同理
  const hasLogoGroup = groups.some((g) => !g.text);
  if (!groups.length && !frame) { hint.textContent = '当前没有可保存的配置（先配置任一水印样式）'; return; }
  if (hasLogoGroup && (!state.logoSet || !state.wmFiles.length)) {
    hint.textContent = '缺少 logo 原文件，无法保存'; return;
  }
  hint.textContent = '保存中…';
  try {
    const fd = new FormData();
    for (const f of state.wmFiles) fd.append('logos', f);
    fd.append('payload', JSON.stringify({ name, groups: JSON.parse(JSON.stringify(groups)), options: options() }));
    const p = await api('/api/presets', { method: 'POST', body: fd });
    presets = presets.filter((x) => x.id !== p.id); presets.unshift(p);
    selectedPresetId = p.id;
    renderPresetMenu();
    renderPresetDetail();
    hint.textContent = `已保存 ✓ ${p.summary ? p.summary.text : ''}`;
  } catch (e) {
    hint.textContent = '✗ 保存失败：' + e.message;
  }
}

async function delPreset() {
  const id = selectedPresetId || '';
  if (!id) { $('preset-hint').textContent = '先在下拉里选中要删除的方案'; return; }
  const p = presets.find((x) => x.id === id);
  try {
    await api('/api/presets/' + encodeURIComponent(id), { method: 'DELETE' });
    presets = presets.filter((x) => x.id !== id);
    selectedPresetId = '';
    renderPresetMenu();
    renderPresetDetail();
    $('preset-hint').textContent = `已删除${p ? `：${p.name}` : ''}`;
  } catch (e) {
    $('preset-hint').textContent = '✗ ' + e.message;
  }
}

async function applyPreset(id) {
  const hint = $('preset-hint');
  const meta = presets.find((p) => p.id === id);
  if (!meta) return;
  hint.textContent = '恢复中…';
  let files;
  try {
    files = [];
    for (let i = 0; i < meta.files.length; i++) {
      const res = await fetch(`/api/presets/${encodeURIComponent(id)}/file/${i}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `读取第 ${i + 1} 个 logo 失败`);
      files.push(new File([await res.blob()], meta.files[i].name));
    }
  } catch (e) {
    hint.textContent = '✗ ' + e.message;
    return;
  }
  // 纯相机参数方案没有 logo：不走 prepare 流程，直接套用分组与选项
  if (!files.length) {
    onWmFiles([]);
    applyPresetData(meta);
    hint.textContent = `已恢复 ✓ ${meta.summary ? meta.summary.text : ''}`;
    return;
  }
  onWmFiles(files); // 走真实准备流程，prepare 完成后再套用分组与选项
  let tries = 0;
  const timer = setInterval(() => {
    // prepare 失败会把 watermarkId 置回 null，不设上限这里会永远空转
    if (++tries > 40) { clearInterval(timer); hint.textContent = '✗ 恢复超时：logo 准备未完成，请重试'; return; }
    if (!state.watermarkId || !state.logoSet) return;
    clearInterval(timer);
    applyPresetData(meta);
  }, 250);
}

/** 相机参数组判定：enabled 显式 false 才算关（老方案数据里可能没有 enabled，别把它当成没配） */
function isTextGroup(g) {
  return !!(g && g.text && g.text.enabled !== false && Array.isArray(g.text.fields) && g.text.fields.length);
}

/** 把方案里的分组与选项套用到界面（logo 已就绪时调用；无 logo 的纯相机参数方案也走这里） */
function applyPresetData(meta) {
  const hint = $('preset-hint');
  const logoCount = state.logoSet ? state.logoSet.logos.length : 0;
  const restored = JSON.parse(JSON.stringify(meta.data.groups || []));
  // 相机参数那一组没有 logos，会被下面的 logo 过滤丢掉 —— 先摘出来单独还原到 UI
  const textGroup = restored.find((g) => isTextGroup(g)) || null;
  // 标签页按方案内容选：有 logo 就先落在 Logo 页，纯文字方案落在文字页
  const savedOpts = meta.data.options || {};
  const hasFrame = !!(savedOpts.frame && savedOpts.frame.style);
  const hasText = restored.some(isTextGroup);
  const hasLogoGroups = restored.some((g) => !isTextGroup(g));
  if (hasLogoGroups || hasText || hasFrame) {
    // 早期版本支持任意组合，方案里可能两类都有。数据照旧全量回填，但标签页只能停在
    // 一类上（有 logo 就先给 Logo），并在说明行里讲清另一半没在跑，免得以为丢了配置
    const showLogo = hasLogoGroups || !(hasText || hasFrame);
    state.layers = { logo: showLogo, text: !showLogo };
    state.layerNoteExtra = (hasLogoGroups && (hasText || hasFrame))
      ? '　｜　该方案同时含 Logo 水印与文字/画框，现按标签页二选一只应用当前这一类；切到另一页可配置另一半'
      : '';
    localStorage.setItem('imgmark_layers', JSON.stringify(state.layers));
    applyLayers();
  }
  applyExifGroup(textGroup);
  state.groups = restored
    .filter((g) => !isTextGroup(g))
    .map((g) => ({ ...g, logos: (g.logos || []).filter((i) => i < logoCount) }))
    .filter((g) => g.logos.length);
  if (!state.groups.length && logoCount) state.groups = [defaultGroup(state.logoSet.logos.map((_, i) => i))];
  state.groups.forEach((g) => { g.ratios = g.logos.map((_, k) => (g.ratios && g.ratios[k]) || 1); });
  const o = meta.data.options || {};
  if (o.format) $('opt-format').value = o.format;
  if (o.quality) $('opt-quality').value = o.quality;
  if ($('opt-mozjpeg')) $('opt-mozjpeg').checked = !!o.mozjpeg;
  if (o.sizeBase) $('opt-sizebase').value = o.sizeBase;
  if ($('opt-cropratio')) { $('opt-cropratio').value = o.cropRatio || ''; cropHintRefresh(); }
  // 方案里带竖图比例 → 自动勾上「横竖分开设置」并把第二个下拉填好；
  // 老方案（只有 cropRatio）保持不勾，行为与拆分前一致
  if ($('opt-cropsplit')) {
    $('opt-cropsplit').checked = !!o.cropRatioPort;
    $('opt-cropratio-port').value = o.cropRatioPort || '';
    $('cropratio-port-hint').textContent = o.cropRatioPort ? '智能裁剪（保留细节多的一侧）' : '';
    updateCropSplitUI();
  }
  if ($('opt-maxedge')) $('opt-maxedge').value = o.maxLongEdge || '';
  if (o.autoColor && !$('opt-autocolor').disabled) $('opt-autocolor').checked = true;
  applyFrameOpt(o.frame);
  refreshDD(); // 程序改了原生 select，同步刷新自定义下拉的显示文字
  renderLogoList(); renderGroups();
  updateAutoColorUI(); refreshPreview(); updateRun();
  hint.textContent = `已恢复 ✓ ${meta.summary ? meta.summary.text : ''}`;
}

// logo 文件入口（网页 input / 桌面壳原生对话框 / 方案恢复共用）
function onWmFiles(files) {
  state.wmFiles = files;
  state.watermarkId = null;
  state.logoSet = null;
  if (files.length && !state.layers.logo) setLayer('logo'); // 传了 logo 自动切到 Logo 水印页
  const names = files.map((f) => f.name);
  $('wm-name').textContent = files.length
    ? (files.length > 1 ? `${files.length} 个文件：` : '') + (names.join('、').length > 60 ? names.join('、').slice(0, 60) + '…' : names.join('、'))
    : '未选择';
  // 换文件：清空裁剪状态
  state.crops = files.map(() => null);
  state.editingIdx = 0;
  cropMode = false; dragStart = null;
  hideRect();
  renderLogoList();
  renderGroups();
  updateCropUI();
  prepareWatermark();
}

function removeWmFile(index) {
  if (index < 0 || index >= state.wmFiles.length) return;
  state.wmFiles.splice(index, 1);
  state.crops.splice(index, 1);
  state.watermarkId = null;
  if (state.wmFiles.length && state.logoSet) {
    state.logoSet = { ...state.logoSet, id: null, logos: state.logoSet.logos.filter((_, i) => i !== index) };
  } else if (!state.wmFiles.length) {
    state.logoSet = null;
  }

  // 移除 logo 时按新序号重映射每个分组，并保持比例对应原 logo。
  state.groups = state.groups.map((g) => {
    const entries = (g.logos || []).map((logoIndex, k) => ({
      logoIndex,
      ratio: g.ratios && g.ratios[k] || 1,
    })).filter(({ logoIndex }) => logoIndex !== index)
      .map(({ logoIndex, ratio }) => ({ logoIndex: logoIndex > index ? logoIndex - 1 : logoIndex, ratio }));
    return { ...g, logos: entries.map((entry) => entry.logoIndex), ratios: entries.map((entry) => entry.ratio) };
  }).filter((g) => g.logos.length);

  if (state.wmFiles.length && !state.groups.length) {
    state.groups = [defaultGroup(state.wmFiles.map((_, i) => i))];
  }
  if (state.editingIdx === index) state.editingIdx = Math.min(index, Math.max(0, state.wmFiles.length - 1));
  else if (state.editingIdx > index) state.editingIdx -= 1;
  if (!state.wmFiles.length) {
    state.editingIdx = 0;
    cropMode = false;
    dragStart = null;
    hideRect();
  }

  const names = state.wmFiles.map((f) => f.name);
  $('wm-name').textContent = names.length
    ? (names.length > 1 ? `${names.length} 个文件：` : '') + (names.join('、').length > 60 ? names.join('、').slice(0, 60) + '…' : names.join('、'))
    : '未选择';
  renderLogoList();
  renderGroups();
  updateCropUI();
  prepareWatermark();
}

// ---------- logo 列表（点击选中某个 logo 进行框选裁剪） ----------
function renderLogoList() {
  const box = $('logo-list');
  const logos = state.logoSet ? state.logoSet.logos : [];
  if (!logos.length) { box.innerHTML = '<span class="muted">未添加 logo</span>'; return; }
  box.innerHTML = logos.map((l, i) => `
    <div class="logo-item ${i === state.editingIdx ? 'on' : ''}" data-i="${i}" title="${esc(l.name)}（点击选中后可框选裁剪）">
      <img src="${l.preview}" alt="">
      <div class="li-meta"><b>${esc(l.name.length > 14 ? l.name.slice(0, 13) + '…' : l.name)}</b>
        <span>${l.width}×${l.height}${l.monochrome ? ' · 纯黑白' : ' · 含彩色'}${state.crops[i] ? ' · ✂' : ''}</span></div>
      <button type="button" class="li-remove" data-i="${i}" aria-label="移除 ${esc(l.name)}" title="移除此 logo">×</button>
    </div>`).join('');
  box.querySelectorAll('.logo-item').forEach((el) => el.addEventListener('click', () => {
    state.editingIdx = +el.dataset.i;
    renderLogoList();
    if (cropMode) {
      const src = logoSource(state.editingIdx);
      if (src) $('wm-preview').src = src;
      if (state.crops[state.editingIdx]) drawRectPct(state.crops[state.editingIdx]); else hideRect();
    }
    updateCropUI();
  }));
  box.querySelectorAll('.li-remove').forEach((button) => button.addEventListener('click', (e) => {
    e.stopPropagation();
    removeWmFile(+button.dataset.i);
  }));
}

// ---------- 分组（每组：logo 组合 + 九宫格定位 + 大小/间距/比例） ----------
const POS_NAMES = { nw: '左上', n: '上', ne: '右上', w: '左', c: '中', e: '右', sw: '左下', s: '下', se: '右下' };

function renderGroups() {
  updateAutoColorUI(); // 分组变动会改变哪些组能自动换色
  const box = $('groups-box');
  destroyDDWithin(box); // 重建前回收旧的自定义下拉实例，避免注册表累积
  if (!state.groups.length) {
    box.innerHTML = '<div class="muted">还没有分组：点「＋ 添加分组」，每组可放 1 个或多个 logo</div>';
    return;
  }
  const logos = state.logoSet ? state.logoSet.logos : [];
  box.innerHTML = state.groups.map((g, gi) => {
    const multi = g.logos.length > 1;
    // 只剩一个分组时不显示删除：最少保留 1 组，删掉最后一张卡会让整个分组区变空
    const canDel = state.groups.length > 1;
    return `
    <div class="group-card" data-gi="${gi}">
      <div class="row-inline gc-head">
        <b>分组 ${gi + 1}</b>
        <span class="gc-logos">${logos.map((l, li) => `
          <label class="gc-logo ${g.logos.includes(li) ? 'on' : ''}" title="${esc(l.name)}">
            <input type="checkbox" data-li="${li}" ${g.logos.includes(li) ? 'checked' : ''}>
            <img src="${l.preview}" alt=""><span>${li + 1}</span>
          </label>`).join('')}</span>
      </div>
      <div class="row-inline gc-ctrl">
        <div class="field"><label>位置</label>
          <div class="grid9 gc-pos">${Object.entries(POS_NAMES).map(([k, v]) =>
            `<button data-pos="${k}" class="${g.position === k ? 'on' : ''}" title="${v}">${v}</button>`).join('')}</div>
        </div>
        ${multi ? `
        <div class="field"><label>排列</label>
          <select class="gc-dir">
            <option value="h" ${g.direction !== 'v' ? 'selected' : ''}>横排</option>
            <option value="v" ${g.direction === 'v' ? 'selected' : ''}>竖排</option>
          </select></div>` : ''}
        <div class="field"><label>大小 <b class="gc-sv">${esc(g.sizePct)}</b>%</label>
          <input type="range" class="gc-size" min="2" max="90" value="${esc(g.sizePct)}"></div>
        <div class="field"><label>边距 <b class="gc-mv">${esc(g.marginPct)}</b>%</label>
          <input type="range" class="gc-mg" min="0" max="25" value="${esc(g.marginPct)}"></div>
        ${multi ? `
        <div class="field ${g.direction === 'v' ? 'dim' : ''}"><label>水平间距 <b class="gc-gxv">${esc(g.gapX)}</b></label>
          <input type="range" class="gc-gapx" min="0" max="100" value="${esc(g.gapX)}"></div>
        <div class="field ${g.direction === 'h' ? 'dim' : ''}"><label>垂直间距 <b class="gc-gyv">${esc(g.gapY)}</b></label>
          <input type="range" class="gc-gapy" min="0" max="100" value="${esc(g.gapY)}"></div>
        ${g.logos.map((li, k) => `
        <div class="field"><label>logo ${li + 1} ${g.direction === 'v' ? '宽' : '高'}比 <b class="gc-rv" data-k="${k}">${(g.ratios[k] || 1).toFixed(2)}</b></label>
          <input type="range" class="gc-ratio" data-k="${k}" min="0.2" max="3" step="0.05" value="${g.ratios[k] || 1}"></div>`).join('')}` : ''}
        <div class="field"><label>不透明度 <b class="gc-ov">${esc(g.opacity)}</b></label>
          <input type="range" class="gc-op" min="5" max="100" value="${esc(g.opacity)}"></div>
      </div>
      ${canDel ? `<button class="btn tiny gc-del" data-gi="${gi}">✕ 删除分组</button>` : ''}
    </div>`;
  }).join('');
  bindGroupEvents();
}

function bindGroupEvents() {
  const box = $('groups-box');
  box.querySelectorAll('.group-card').forEach((card) => {
    const gi = +card.dataset.gi;
    const g = state.groups[gi];
    // 只剩一个分组时没有删除按钮（见 renderGroups 的 canDel）
    const del = card.querySelector('.gc-del');
    if (del) del.addEventListener('click', () => {
      state.groups.splice(gi, 1);
      renderGroups(); refreshPreview();
    });
    card.querySelectorAll('.gc-logo input').forEach((c) => c.addEventListener('change', () => {
      const li = +c.dataset.li;
      if (c.checked) { if (!g.logos.includes(li)) g.logos.push(li); }
      else g.logos = g.logos.filter((x) => x !== li);
      const old = g.ratios;
      g.ratios = g.logos.map((_, k) => old[k] || 1);
      renderGroups(); refreshPreview();
    }));
    card.querySelectorAll('.gc-pos button').forEach((b) => b.addEventListener('click', () => {
      card.querySelectorAll('.gc-pos button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      g.position = b.dataset.pos;
      refreshPreview();
    }));
    const dir = card.querySelector('.gc-dir');
    if (dir) dir.addEventListener('change', () => { g.direction = dir.value; renderGroups(); refreshPreview(); });
    const bindSlider = (cls, fn) => {
      const el = card.querySelector(cls);
      if (el) el.addEventListener('input', () => { fn(+el.value); refreshPreview(); });
    };
    bindSlider('.gc-size', (v) => { g.sizePct = v; card.querySelector('.gc-sv').textContent = v; });
    bindSlider('.gc-mg', (v) => { g.marginPct = v; card.querySelector('.gc-mv').textContent = v; });
    bindSlider('.gc-gapx', (v) => { g.gapX = v; card.querySelector('.gc-gxv').textContent = v; });
    bindSlider('.gc-gapy', (v) => { g.gapY = v; card.querySelector('.gc-gyv').textContent = v; });
    bindSlider('.gc-op', (v) => { g.opacity = v; card.querySelector('.gc-ov').textContent = v; });
    card.querySelectorAll('.gc-ratio').forEach((el) => el.addEventListener('input', () => {
      const k = +el.dataset.k;
      g.ratios[k] = +el.value;
      const lbl = card.querySelector(`.gc-rv[data-k="${k}"]`);
      if (lbl) lbl.textContent = (+el.value).toFixed(2);
      refreshPreview();
    }));
    // 动态生成的「排列」下拉也走统一的自定义下拉组件
    if (dir) enhanceSelect(dir);
  });
}

function addGroup() {
  if (!state.logoSet || !state.logoSet.logos.length) return;
  state.groups.push(defaultGroup([0]));
  renderGroups();
  refreshPreview();
}

// ---------- 相机参数水印 ----------
// 与水印分组并列，但配置只有一份（同一批照片通常一台相机），
// 勾选后作为「额外的一组」追加到 groups 末尾交给服务端。
const EXIF_DEFAULT_FIELDS = ['camera', 'lens', 'exposure', 'date'];

const exifUI = {
  // 字段元信息由服务端给（/api/exif-fields），避免前后端两份清单失配
  meta: [],
  selected: EXIF_DEFAULT_FIELDS.slice(),
  // 字体清单同理由服务端给（/api/fonts）：它只列本机真装了的字体。
  // 这点很要紧 —— librsvg 找不到字体时不报错，会悄悄回落默认字体，
  // 界面上给一份「全平台通用」的清单等于给出一堆选了没变化的选项
  fonts: [],
  fontDefault: 'sans-serif',
};

/** 当前选中的字体族；清单没加载出来时回落默认族 */
function currentFontFamily() {
  const v = $('exif-font') && $('exif-font').value;
  return v || exifUI.fontDefault;
}

/** 设字体：清单里没有这个名字（方案存了一款本机没装的）就回落默认族 */
function setFontFamily(family) {
  const sel = $('exif-font');
  if (sel && [...sel.options].some((o) => o.value === family)) sel.value = family;
  else if (sel) sel.value = exifUI.fontDefault;
}

async function loadFonts() {
  try {
    const r = await api('/api/fonts');
    exifUI.fonts = Array.isArray(r.fonts) ? r.fonts : [];
    if (typeof r.default === 'string') exifUI.fontDefault = r.default;
  } catch {
    exifUI.fonts = []; // 拿不到就只留默认族，不给一份可能装不上的清单
  }
  const sel = $('exif-font');
  if (!sel) return;
  // 保留当前选中项（切页、恢复方案时不该被重置）
  const keep = sel.value || exifUI.fontDefault;
  sel.innerHTML = '';
  if (!exifUI.fonts.length) {
    const o = document.createElement('option');
    o.value = exifUI.fontDefault; o.textContent = '系统默认';
    sel.appendChild(o);
  } else {
    // 按 kind 分组：中文正文 / 西文 / 等宽 / 通用族
    const GROUPS = [['cjk', '中文'], ['latin', '西文'], ['mono', '等宽'], ['generic', '通用']];
    for (const [kind, title] of GROUPS) {
      const list = exifUI.fonts.filter((f) => f.kind === kind);
      if (!list.length) continue;
      const og = document.createElement('optgroup');
      og.label = title;
      for (const f of list) {
        const o = document.createElement('option');
        o.value = f.family;
        o.textContent = f.note ? `${f.label}（${f.note}）` : f.label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  }
  // 旧方案存的字体这台上没装 → 留在默认族，别把 select 留在一个不存在的选项上
  const has = [...sel.options].some((o) => o.value === keep);
  sel.value = has ? keep : exifUI.fontDefault;
  // 清单是异步到的，若这个 select 已被 enhanceSelect 包过，按钮上的当前项文字要跟着刷
  refreshDD(sel);
}

async function loadExifFields() {
  try {
    const r = await api('/api/exif-fields');
    exifUI.meta = Array.isArray(r.fields) ? r.fields : [];
  } catch {
    // 接口拿不到就退回默认清单，功能不至于不可用
    exifUI.meta = EXIF_DEFAULT_FIELDS.map((k) => ({ key: k, label: k, hint: '' }));
  }
  renderExifFields();
}

function renderExifFields() {
  const box = $('exif-fields');
  if (!box) return;
  box.innerHTML = exifUI.meta.map((f) => `
    <label title="${esc(f.hint || '')}">
      <input type="checkbox" data-ek="${esc(f.key)}" ${exifUI.selected.includes(f.key) ? 'checked' : ''}>
      <span>${esc(f.label)}</span>
      <span class="hint">${esc(f.hint || '')}</span>
    </label>`).join('');
  box.querySelectorAll('input[data-ek]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.dataset.ek;
      const i = exifUI.selected.indexOf(k);
      if (el.checked && i < 0) exifUI.selected.push(k);
      else if (!el.checked && i >= 0) exifUI.selected.splice(i, 1);
      // 至少留一项，否则等于开着这个功能却什么都不输出
      if (!exifUI.selected.length) { el.checked = true; exifUI.selected.push(k); }
      syncExifSample();
      refreshPreview();
    });
  });
}

/** 位置九宫格（与分组卡同款，但作用于文字这一组） */
function renderExifPos() {
  const box = $('exif-pos');
  if (!box) return;
  const cur = exifUI.pos || 'se';
  box.innerHTML = Object.entries(POS_NAMES).map(([k, v]) =>
    `<button type="button" data-epos="${k}" class="${cur === k ? 'on' : ''}" title="${v}">${v}</button>`).join('');
  box.querySelectorAll('button[data-epos]').forEach((b) => {
    b.addEventListener('click', () => {
      exifUI.pos = b.dataset.epos;
      box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      refreshPreview();
    });
  });
}

/** 用本地拼出的示例文案预览这一组会输出什么（真正的文字由服务端按每张图的 EXIF 生成） */
function exifSampleText() {
  const parts = exifUI.selected.map((k) => {
    const m = exifUI.meta.find((x) => x.key === k);
    return m && m.hint ? m.hint : '';
  }).filter(Boolean);
  if (!parts.length) return '—';
  const sep = $('exif-sep') ? $('exif-sep').value : ' · ';
  const pre = $('exif-prefix') ? $('exif-prefix').value : '';
  const suf = $('exif-suffix') ? $('exif-suffix').value : '';
  return `${pre}${parts.join(sep)}${suf}`;
}
function syncExifSample() {
  const el = $('exif-sample');
  if (el) el.textContent = exifSampleText();
}

/** 勾选状态 → 面板显隐；关掉时把这一组从 groups 里摘掉（由 exifGroupDef 决定是否追加） */
function updateExifUI() {
  syncExifSample();
}

/** 文字组定义（读界面配置；不判图层/样式门控，供 exifGroupDef 与缩略图共用） */
function textSpecDef() {
  const fields = exifUI.selected.slice();
  if (!fields.length) return null;
  const color = $('exif-color').value;
  return {
    text: {
      enabled: true,
      fields,
      color,
      fontFamily: currentFontFamily(),
      fontWeight: $('exif-weight').value,
      separator: $('exif-sep').value,
      prefix: $('exif-prefix').value,
      suffix: $('exif-suffix').value,
    },
    position: exifUI.pos || 'se',
    sizePct: +$('exif-size').value,
    marginPct: +$('exif-mg').value,
    opacity: +$('exif-op').value,
    autoColor: $('exif-autocolor').checked,
  };
}

/** 相机参数组的定义：仅「文字 / 画框」页签选中且样式为浮动文字时生效 */
function exifGroupDef() {
  if (!state.layers.text) return null;
  if ($('exif-frame') && $('exif-frame').value) return null; // 容器样式：文字写进画框留白，走 options.frame
  return textSpecDef();
}

/** 组装 payload 的 groups：按当前标签页二选一，logo 分组或相机参数组 */
function groupsForPayload() {
  const list = state.layers.logo ? state.groups.map((g) => ({ ...g })) : [];
  const eg = exifGroupDef();
  if (eg) list.push(eg);
  return list;
}

/** 方案恢复：把存下来的相机参数组回填到 UI（传 null 表示这套方案没开这项） */
function applyExifGroup(g) {
  const on = isTextGroup(g);
  if (!on) {
    // 老方案没有这一项：清成默认值，别把上一次的配置留在界面上
    exifUI.selected = EXIF_DEFAULT_FIELDS.slice();
    exifUI.pos = 'se';
    $('exif-color').value = '#ffffff';
    setFontFamily(exifUI.fontDefault);
    $('exif-weight').value = 'bold';
    $('exif-sep').value = ' · ';
    $('exif-prefix').value = '';
    $('exif-suffix').value = '';
    $('exif-size').value = 30; $('exif-sizev').textContent = '30';
    $('exif-mg').value = 3; $('exif-mgv').textContent = '3';
    $('exif-op').value = 90; $('exif-opv').textContent = '90';
    $('exif-autocolor').checked = false;
  } else {
    const t = g.text;
    exifUI.selected = (Array.isArray(t.fields) ? t.fields : []).slice();
    exifUI.pos = g.position || 'se';
    if (t.color) $('exif-color').value = t.color;
    if (t.fontFamily) setFontFamily(t.fontFamily);
    if (t.fontWeight) $('exif-weight').value = t.fontWeight;
    if (typeof t.separator === 'string') $('exif-sep').value = t.separator;
    $('exif-prefix').value = t.prefix || '';
    $('exif-suffix').value = t.suffix || '';
    const set = (id, lv, v) => { $(id).value = v; $(lv).textContent = v; };
    set('exif-size', 'exif-sizev', g.sizePct ?? 30);
    set('exif-mg', 'exif-mgv', g.marginPct ?? 3);
    set('exif-op', 'exif-opv', g.opacity ?? 90);
    $('exif-autocolor').checked = !!g.autoColor;
  }
  renderExifFields();
  renderExifPos();
  if ($('exif-sep')) refreshDD();
  updateExifUI();
}

/** 方案恢复：把 options.frame 回填到 UI */
function applyFrameOpt(f) {
  const has = !!(f && f.style);
  $('exif-frame').value = has ? f.style : '';
  $('exif-frame-align').value = (f && f.align) || 'left';
  if (f && f.bg) $('exif-frame-bg').value = f.bg;
  $('exif-line1').value = has && Array.isArray(f.lines) ? (f.lines[0] || '') : '';
  $('exif-line2').value = has && Array.isArray(f.lines) ? (f.lines[1] || '') : '';
  // 字体与浮动文字共用一套：画框存的和文字组存的是同一个字段，谁后恢复谁说了算
  if (has && f.fontFamily) setFontFamily(f.fontFamily);
  refreshDD($('exif-frame'));
  refreshDD($('exif-frame-align'));
  updateFrameUI();
}

function bindExifUI() {
  if (!$('exif-color')) return;
  ['exif-sep', 'exif-prefix', 'exif-suffix', 'exif-color', 'exif-weight', 'exif-font'].forEach((id) => {
    $(id).addEventListener('change', () => { syncExifSample(); refreshPreview(); });
    $(id).addEventListener('input', syncExifSample);
  });
  $('exif-autocolor').addEventListener('change', refreshPreview);
  // 滑杆：数字跟手 + 防抖重绘预览
  [['exif-size', 'exif-sizev'], ['exif-mg', 'exif-mgv'], ['exif-op', 'exif-opv']].forEach(([sl, lb]) => {
    $(sl).addEventListener('input', () => { $(lb).textContent = $(sl).value; refreshPreview(); });
  });
  ['exif-frame', 'exif-frame-align'].forEach((id) => {
    $(id).addEventListener('change', () => { updateFrameUI(); refreshPreview(); });
  });
  ['exif-line1', 'exif-line2'].forEach((id) => {
    $(id).addEventListener('change', refreshPreview);
  });
  $('exif-frame-bg').addEventListener('change', refreshPreview);
  renderExifPos();
  updateExifUI();
  updateFrameUI();
}

// ---------- 框选裁剪 ----------
const previewWrap = $('wm-preview-wrap');

function pctFromEvent(e) {
  const imgRect = $('wm-preview').getBoundingClientRect();
  if (!imgRect.width || !imgRect.height) return null;
  return {
    x: Math.max(0, Math.min(100, (e.clientX - imgRect.left) / imgRect.width * 100)),
    y: Math.max(0, Math.min(100, (e.clientY - imgRect.top) / imgRect.height * 100)),
  };
}
function drawRectPct(r) {
  const el = $('crop-rect');
  el.classList.remove('hidden');
  el.style.left = r.x + '%'; el.style.top = r.y + '%';
  el.style.width = r.w + '%'; el.style.height = r.h + '%';
}
function hideRect() { $('crop-rect').classList.add('hidden'); }
function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function updateCropUI() {
  $('crop-btn').classList.toggle('on', cropMode);
  previewWrap.classList.toggle('cropmode', cropMode);
  $('crop-btn').textContent = cropMode ? '✕ 取消裁剪' : '✂ 框选裁剪';
  $('crop-btn').disabled = !state.logoSet;
  const cur = state.crops[state.editingIdx];
  $('crop-reset').disabled = !cur;
  const l = logoOf(state.editingIdx);
  $('crop-status').textContent = cropMode
    ? `在「${l ? l.name : 'logo ' + (state.editingIdx + 1)}」的原图上拖拽框选要保留的区域`
    : cur
      ? `logo ${state.editingIdx + 1} 裁剪：${cur.x.toFixed(0)},${cur.y.toFixed(0)} 起 ${cur.w.toFixed(0)}×${cur.h.toFixed(0)}%（原图 ${l ? [l.sourceWidth, l.sourceHeight].join('×') : ''}）`
      : '';
}

previewWrap.addEventListener('mousedown', (e) => {
  if (!cropMode) return;
  e.preventDefault();
  dragStart = pctFromEvent(e);
  if (dragStart) drawRectPct({ x: dragStart.x, y: dragStart.y, w: 0, h: 0 });
});
window.addEventListener('mousemove', (e) => {
  if (!cropMode || !dragStart) return;
  const p = pctFromEvent(e);
  if (p) drawRectPct(normRect(dragStart, p));
});
window.addEventListener('mouseup', (e) => {
  if (!cropMode || !dragStart) return;
  const p = pctFromEvent(e) || dragStart;
  const r = normRect(dragStart, p);
  dragStart = null;
  if (r.w < 2 || r.h < 2) {
    if (state.crops[state.editingIdx]) drawRectPct(state.crops[state.editingIdx]); else hideRect();
    return; // 太小视为误触
  }
  state.crops[state.editingIdx] = r;
  cropMode = false;
  renderChips();
  updateCropUI();
  prepareWatermark(); // 退出裁剪模式，按新范围重新准备
});

function toggleCropMode() {
  if (!state.logoSet) return;
  cropMode = !cropMode;
  if (cropMode) {
    const src = logoSource(state.editingIdx);
    if (src) $('wm-preview').src = src; // 参考系=当前 logo 的原始画布
    if (state.crops[state.editingIdx]) drawRectPct(state.crops[state.editingIdx]); else hideRect();
  } else {
    if (state.crops[state.editingIdx]) drawRectPct(state.crops[state.editingIdx]); else hideRect();
    prepareWatermark();
  }
  updateCropUI();
}

// ---------- 亮度自适应黑白 ----------
// 按分组判断（与服务端 resolveGroups 一致：组内 logo 都有反色变体才换色）。
// 此前只要有一个彩色 logo 就整体禁用，「黑白文字 logo 一组 + 彩色徽标一组」这种典型用法无法开启
function updateAutoColorUI() {
  const t = $('opt-autocolor');
  const logos = state.logoSet ? state.logoSet.logos : [];
  const groups = state.groups || [];
  const eligible = groups.filter((g) => g.logos.length && g.logos.every((i) => logos[i] && logos[i].hasAlt));
  t.disabled = !eligible.length;
  if (!eligible.length) t.checked = false;
  $('autocolor-hint').textContent = !logos.length ? ''
    : eligible.length === groups.length ? '全部分组为纯黑白 logo：每组按图片落点亮度自动选黑/白标'
    : eligible.length ? `第 ${eligible.map((g) => groups.indexOf(g) + 1).join('、')} 组为纯黑白 logo，可自动换黑/白标；含彩色 logo 的分组保持原色`
    : '没有纯黑白 logo 的分组：把黑白 logo 单独放一组即可启用';
}

// 输出裁剪：勾了「横竖分开设置」就露出竖图那个下拉；不勾则只有横图那个可用，
// 它选的比例两个方向都套用（即默认行为与拆分成两个下拉之前完全一致）
function updateCropSplitUI() {
  const split = $('opt-cropsplit').checked;
  $('cropsplit-extra').classList.toggle('hidden', !split);
  if (!split) {
    // 收起时清掉竖图那个值，避免它留在 payload 里却看不见
    $('opt-cropratio-port').value = '';
    $('cropratio-port-hint').textContent = '';
    refreshDD($('opt-cropratio-port'));
  }
}

// ---------- 样式预览（单张实时：任一分组参数变化都重新合成示例图） ----------
async function doRefreshPreview() {
  refreshFrameThumbs(); // 防抖独立：样式墙跟着当前配置重渲
  // 预览区放的是真图时就地重渲它 —— 改样式看到的仍是自己那张照片，而不是换回示例图
  if (previewOwnMode && previewOwn) { await renderOwn(); return; }
  const groups = groupsForPayload();
  const hasLogoGroup = groups.some((g) => !g.text);
  const frame = frameDef();
  // 三类型任一有内容就预览：logo 组需要水印就绪；纯文字/纯边框不需要 logo
  if ((!groups.length && !frame) || (hasLogoGroup && !state.watermarkId)) return;
  try {
    const r = await api('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watermarkId: state.watermarkId, options: options(), groups: groupsForPayload(), orient: previewOrient }),
    });
    $('style-preview').src = r.preview;
    const auto = !!r.previewAuto;
    if (auto) $('style-preview-auto').src = r.previewAuto; // 此前只切换显隐、从未赋 src，暗图预览显示为破损图标
    $('style-preview-auto').classList.toggle('hidden', !auto);
    $('preview-cap-auto').classList.toggle('hidden', !auto);
    updatePreviewCaps();
  } catch { /* 预览失败不打断 */ }
}
const refreshPreview = debounce(doRefreshPreview, 350);

// 说明文案跟随示例图方向（横图保持原文案）；显示真图时改为「合成结果 + 文件名 + 自动识别的横竖」
function updatePreviewCaps() {
  if (previewOwnMode && previewOwn && previewOwn.file) {
    const o = previewOwn.orient;
    $('preview-cap').textContent = `合成结果 · ${previewOwn.file.name}`
      + (o ? ` · ${previewOwn.w}×${previewOwn.h} ${ORIENT_CN[o]}` : '');
    return;
  }
  const p = previewOrient === 'portrait';
  $('preview-cap').textContent = p ? '样式预览（亮图·竖图示例）' : '样式预览（亮图示例）';
  $('preview-cap-auto').textContent = p ? '暗图·竖图示例（自动换白标）' : '暗图示例（自动换白标）';
}

const ORIENT_CN = { portrait: '竖图', landscape: '横图', square: '方图' };
// 真图方向由图自己决定：读成图的实际像素，横/竖/方各给一个高度（竖图给足，横图与方图维持 280px 的版面）。
// 横/竖 tab 已在进入真图模式时收起 —— 那个切换只对示例图有意义，对真图是噪音
function applyOwnOrient(w, h) {
  const st = previewOwn;
  if (!st || !w || !h) return;
  st.w = w; st.h = h;
  st.orient = h > w ? 'portrait' : w > h ? 'landscape' : 'square';
  const box = document.querySelector('.preview-box');
  box.classList.remove('own-portrait', 'own-landscape', 'own-square');
  box.classList.add(`own-${st.orient}`);
  updatePreviewCaps();
}

// 横/竖示例图切换：sizeBase=long 时两者水印实际像素一致，可直观验证竖幅构图。
// 只在示例图模式下出现（真图模式已把这组 tab 收起）
document.querySelectorAll('#preview-orient .tab').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.orient === previewOrient) return;
  previewOrient = b.dataset.orient;
  document.querySelectorAll('#preview-orient .tab').forEach((x) => x.classList.toggle('on', x === b));
  updatePreviewCaps();
  doRefreshPreview();
}));

// ---------- 用自己的图试样式 + 顺带单张导出 ----------
// 真图与示例图共用这一块预览：服务端 /api/render 与批量是同一条合成管线，
// 所以预览到的画面就是导出的那张 —— 所见即所得，不必先跑一遍批量再打开文件夹确认
let previewOwn = null;       // {file, blob, name, url, gen, orient, w, h}：正在预览的真图
let previewOwnMode = false;  // 预览区当前显示的是不是真图
const oneHint = (s) => { $('one-hint').textContent = s; };

function previewOwnOff() {
  if (previewOwn && previewOwn.url) URL.revokeObjectURL(previewOwn.url);
  previewOwn = null;
  previewOwnMode = false;
  // 回到示例：示例图没有真图那个横/竖自适应，高度与 tab 都还原
  const box = document.querySelector('.preview-box');
  box.classList.remove('own-portrait', 'own-landscape');
  $('preview-orient').classList.remove('hidden');
  $('one-save').classList.add('hidden');
  $('one-clear').classList.add('hidden');
  $('one-save').disabled = true;
  oneHint('');
}

async function renderOwn() {
  const st = previewOwn;
  if (!st || !st.file) return;
  const groups = groupsForPayload();
  if (!groups.length && !frameDef()) { oneHint('先配好水印样式'); return; }
  const gen = ++st.gen; // 连着改样式时只认最后一次响应，旧的直接丢弃
  $('one-save').disabled = true;
  oneHint('合成中…');
  try {
    const fd = new FormData();
    fd.append('file', st.file);
    fd.append('payload', JSON.stringify({ watermarkId: state.watermarkId, groups, options: options() }));
    const r = await fetch('/api/render', { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const blob = await r.blob();
    if (gen !== st.gen || previewOwn !== st) return; // 期间又改了样式，或已经换了图
    if (st.url) URL.revokeObjectURL(st.url);
    st.blob = blob;
    st.name = decodeURIComponent(r.headers.get('X-ImgMark-Name') || 'image_wm.jpg');
    st.url = URL.createObjectURL(blob);
    const im = $('style-preview');
    im.onload = () => applyOwnOrient(im.naturalWidth, im.naturalHeight); // 方向自己认，不问用户
    im.src = st.url;
    if (im.complete && im.naturalWidth) applyOwnOrient(im.naturalWidth, im.naturalHeight); // 缓存命中时不再触发 onload
    // 暗图示例是配给示例图的，对真图没有意义
    $('style-preview-auto').classList.add('hidden');
    $('preview-cap-auto').classList.add('hidden');
    updatePreviewCaps();
    $('one-save').classList.remove('hidden');
    $('one-clear').classList.remove('hidden');
    $('one-save').disabled = false;
    oneHint(r.headers.get('X-ImgMark-Skipped') === '1'
      ? '这张图没有可用的相机参数（EXIF），水印/边框已跳过，画面原样返回'
      : `输出 ${st.name} · ${(blob.size / 1024).toFixed(0)} KB · 导出存为新文件，不动原图`);
  } catch (e) {
    if (gen !== st.gen || previewOwn !== st) return;
    oneHint('✗ ' + e.message);
  }
}

async function saveOwn() {
  const st = previewOwn;
  if (!st || !st.blob) return;
  // 桌面壳问用户存哪；浏览器只能触发下载（落到下载目录）
  if (native && native.saveImage) {
    oneHint('保存中…');
    try {
      const r = await native.saveImage(st.name, await st.blob.arrayBuffer());
      oneHint(r && r.saved ? `已保存：${r.path}` : '已取消保存');
    } catch (e) { oneHint('✗ ' + e.message); }
    return;
  }
  const a = document.createElement('a');
  a.href = st.url;
  a.download = st.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  oneHint(`已下载：${st.name}`);
}

// ---------- 复制成图到剪贴板（分享到微信 / QQ / 小红书等） ----------
// 分享场景默认按「短边 1080」缩放：主流社交平台（微信/QQ/小红书/Instagram）的通行
// 上限都是长边 ~1080~1350，原图 3000×4500 直接粘过去既慢又会被平台再压一遍，
// 白白占剪贴板和上传流量。只缩不放：本来短边就 ≤1080 的原样复制。
const SHARE_SHORT_EDGE = 1080;

// 缩到短边 n。返回 {blob, w, h, scaled}
async function scaleToShortEdge(blob, n) {
  if (!n || n <= 0) return { blob, w: 0, h: 0, scaled: false };
  const bmp = await createImageBitmap(blob);
  const w0 = bmp.width, h0 = bmp.height;
  const short = Math.min(w0, h0);
  if (short <= n) { bmp.close(); return { blob, w: w0, h: h0, scaled: false }; }
  const k = n / short;
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  // 大比例缩小时默认的双线性会产生锯齿；高质量滤波对照片这类连续色调友好得多
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('缩放失败'))), 'image/png'));
  return { blob: out, w, h, scaled: true };
}

// 两条路：桌面壳走主进程（写 Windows 原生剪贴板格式，微信一类才认），
// 浏览器走 navigator.clipboard.write —— 它只接受 PNG，JPEG/WebP 得先转一道。
// 两种都拿不到就退回「下载」，别让右键点了没反应。
async function copyImageToClipboard(blob, name, hint, shortEdge) {
  const say = (s) => { if (hint) hint(s); };
  if (!blob) { say('这张图还没渲染出来'); return; }
  try {
    const sc = await scaleToShortEdge(blob, shortEdge || 0);
    const outBlob = sc.blob;
    const suffix = sc.scaled ? `（短边 ${sc.w < sc.h ? sc.w : sc.h}px）` : '';
    if (native && native.copyImage) {
      const r = await native.copyImage(await outBlob.arrayBuffer(), sc.scaled ? 'share.png' : name);
      if (r && r.copied) { say('已复制' + suffix + '，可直接粘贴到微信 / QQ 等'); return; }
      throw new Error((r && r.error) || '复制失败');
    }
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('浏览器不支持直接写剪贴板');
    // navigator.clipboard 只收 image/png：缩放后必然是 PNG，非缩放时看原格式
    let pngBlob = outBlob;
    if (outBlob.type !== 'image/png') {
      pngBlob = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob((b) => (b ? res(b) : rej(new Error('转 PNG 失败'))), 'image/png');
        };
        img.onerror = () => rej(new Error('图片解码失败'));
        img.src = URL.createObjectURL(outBlob);
      });
    }
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': pngBlob })]);
    say('已复制' + suffix + '，可直接粘贴到微信 / QQ 等');
  } catch (e) {
    // 剪贴板这条路走不通（权限/非安全上下文/格式不支持）时，至少让用户能拿到文件
    say('复制失败：' + (e.message || e) + '，已改为下载');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'image_wm.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}

// ---------- 预览图右键菜单 ----------
// 桌面壳默认不弹 Chromium 菜单，浏览器默认菜单里也只有「复制图像地址」（一个 blob: URL，
// 粘到别处毫无意义），所以自己做一套，选项跟当前显示的是真图还是示例图有关。
let ctxTarget = null;
function closeCtxMenu() {
  const m = $('ctx-menu');
  if (m) m.classList.add('hidden');
  ctxTarget = null;
}
function openCtxMenu(x, y, items) {
  const m = $('ctx-menu');
  m.innerHTML = items.map((it) => (it.sep ? '<div class="ctx-sep"></div>'
    : `<button type="button" class="ctx-item"${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`)).join('');
  m.classList.remove('hidden');
  // 贴着鼠标放；贴到视口边缘时向内收
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  m.querySelectorAll('.ctx-item').forEach((b, i) => {
    if (items[i].disabled) return;
    b.addEventListener('click', () => { const fn = items[i].onClick; closeCtxMenu(); if (fn) fn(); });
  });
}
// 当前预览区显示的这张图：真图模式拿原始 blob，示例模式取 data: URL
function currentPreviewImage() {
  if (previewOwnMode && previewOwn && previewOwn.blob) {
    return { blob: previewOwn.blob, name: previewOwn.name || 'image_wm.jpg', own: true };
  }
  const im = $('style-preview');
  const src = im.getAttribute('src') || '';
  if (!src.startsWith('data:image/')) return null;
  return { dataUrl: src, name: 'imgmark-sample.jpg', own: false };
}
async function blobFromImage(img) {
  if (img.blob) return img.blob;
  const r = await fetch(img.dataUrl);
  return await r.blob();
}
// img 描述 → 剪贴板。取字节这步可能失败（data: URL 解不出图），失败也要有话说，
// 所以统一在这里兜住，别把 Promise 当 Blob 传下去（createObjectURL 会直接抛）
function copyImageDesc(img, hint, shortEdge) {
  return blobFromImage(img)
    .then((blob) => copyImageToClipboard(blob, img.name, hint, shortEdge))
    .catch((e) => { if (hint) hint('✗ ' + (e.message || e)); });
}
// 分享尺寸：默认短边 1080（主流社交平台的通行上限）。工具条上不再放一个常驻下拉 ——
// 那是低频设置，占一行里第五个位置不值当；要换尺寸在右键菜单里直接选「原始尺寸」那条。
// 挂在预览图与大图上：右键复制、左键大图照旧放大
function bindCtxCopy(imgEl, capEl, isLightbox) {
  imgEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const img = isLightbox ? lightboxImage() : currentPreviewImage();
    if (!img) return;
    ctxTarget = img;
    const say = (s) => { if (isLightbox) lightboxSay(s); else oneHint(s); };
    // 两条复制并排给，点哪条就用哪种尺寸 —— 不用再藏一个开关去设置
    openCtxMenu(e.clientX, e.clientY, [
      { label: `复制图片 · 短边 ${SHARE_SHORT_EDGE}（分享）`, onClick: () => copyImageDesc(img, say, SHARE_SHORT_EDGE) },
      { label: '复制图片 · 原始尺寸', onClick: () => copyImageDesc(img, say, 0) },
      { sep: true },
      { label: '在新标签页打开图片', disabled: !img.own, onClick: () => window.open(
        previewOwn && previewOwn.url ? previewOwn.url : '', '_blank') },
    ]);
  });
}
function lightboxImage() {
  const src = $('lightbox-img').getAttribute('src') || '';
  if (!src) return null;
  if (previewOwnMode && previewOwn && src === previewOwn.url) {
    return { blob: previewOwn.blob, name: previewOwn.name || 'image_wm.jpg', own: true };
  }
  if (!src.startsWith('data:image/')) return null;
  return { dataUrl: src, name: 'imgmark-sample.jpg', own: false };
}
function lightboxSay(s) {
  const el = $('lightbox-cap');
  if (!el) return;
  el.textContent = s;
  el.style.color = s.startsWith('已') ? '#8ce99a' : '#ffd8a8';
  clearTimeout(lightboxSay._t);
  lightboxSay._t = setTimeout(() => {
    el.textContent = $('lightbox-copy').dataset.cap || '';
    el.style.color = '';
  }, 2600);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ctx-menu')) closeCtxMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
window.addEventListener('scroll', closeCtxMenu, true);

// ---------- 预览放大（点击亮/暗示例图看原尺寸；点击任意处或 Esc 关闭） ----------
function openLightbox(imgEl, capEl) {
  const src = imgEl.getAttribute('src') || '';
  // 单张导出的成图走 blob: URL，其余预览是 data: URL；占位 SVG 两种都不匹配
  if (!/^(data:image\/(jpeg|png|webp|avif)|blob:)/.test(src)) return;
  $('lightbox-img').src = src;
  $('lightbox-cap').textContent = capEl.textContent;
  $('lightbox-copy').dataset.cap = capEl.textContent;
  // 有真实字节可复制时才给这个角标；示例图虽是 data: URL 也能复制，一并留着
  $('lightbox-copy').classList.remove('hidden');
  $('lightbox').classList.remove('hidden');
}
function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightbox-copy').classList.add('hidden');
  $('lightbox-img').removeAttribute('src');
}
$('style-preview').addEventListener('click', () => openLightbox($('style-preview'), $('preview-cap')));
$('style-preview-auto').addEventListener('click', () => openLightbox($('style-preview-auto'), $('preview-cap-auto')));
// 大图上的「复制图片」角标：点它别触发下面的「点任意处关闭」
$('lightbox-copy').addEventListener('click', (e) => {
  e.stopPropagation();
  const img = lightboxImage();
  if (!img) return;
  copyImageDesc(img, lightboxSay, SHARE_SHORT_EDGE);
});
$('lightbox').addEventListener('click', closeLightbox);
// 预览图与大图都支持右键复制
bindCtxCopy($('style-preview'), $('preview-cap'), false);
bindCtxCopy($('style-preview-auto'), $('preview-cap-auto'), false);
bindCtxCopy($('lightbox-img'), $('lightbox-cap'), true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) closeLightbox();
});

// ---------- 选项（全局：大小基准/输出格式/质量 + 亮度自适应开关；布局参数在各分组里） ----------
function options() {
  return {
    format: $('opt-format').value,
    quality: +$('opt-quality').value,
    mozjpeg: !!($('opt-mozjpeg') && $('opt-mozjpeg').checked),
    sizeBase: $('opt-sizebase') ? $('opt-sizebase').value : 'long',
    autoColor: !$('opt-autocolor').disabled && $('opt-autocolor').checked,
    cropRatio: $('opt-cropratio') ? $('opt-cropratio').value || null : null,
    // 只有勾了「横竖分开设置」才把竖图比例一起发出去；不勾时 cropRatio 两个方向都管
    cropRatioPort: $('opt-cropsplit') && $('opt-cropsplit').checked
      ? ($('opt-cropratio-port').value || null) : null,
    // 输出长边上限：空/0 = 不限（服务端 null = 保持原始尺寸）
    maxLongEdge: $('opt-maxedge') ? Math.max(0, Math.round(+$('opt-maxedge').value) || 0) || null : null,
    frame: frameDef(),
  };
}

// ---------- 边框 / 条幅 ----------
// 与「文字水印」的区别：文字浮在画面上，边框是把画布撑大、参数写进留白。
// 两行都留空时交给服务端用机型/曝光参数自动填（见 /api/preview 的 previewFrame）。
function frameDef() {
  if (!state.layers.text) return null;
  const style = $('exif-frame') ? $('exif-frame').value : '';
  if (!style) return null;
  return {
    style,
    lines: [$('exif-line1').value.trim(), $('exif-line2').value.trim()],
    bg: $('exif-frame-bg').value,
    align: $('exif-frame-align').value,
    fontFamily: currentFontFamily(),
  };
}

function updateFrameUI() {
  const container = !!($('exif-frame') && $('exif-frame').value); // '' = 浮动文字，其余为容器样式
  if ($('float-cfg')) $('float-cfg').classList.toggle('hidden', container);
  if ($('frame-cfg')) $('frame-cfg').classList.toggle('hidden', !container);
  syncFramePresets();
}

// ---- 样式预设缩略图墙（Liit 式交互：每种样式用当前配置真实合成一张小图，点缩略图直接选用） ----
const FRAME_STYLES = [['', '浮动'], ['band', '条幅'], ['frame', '白框'], ['inset', '装裱']];
let frameThumbGen = 0;
const refreshFrameThumbs = debounce(async () => {
  if (!state.layers.text) return;
  const gen = ++frameThumbGen;
  const orient = previewOrient;
  const spec = textSpecDef();
  const frameBase = {
    lines: [$('exif-line1').value.trim(), $('exif-line2').value.trim()],
    bg: $('exif-frame-bg').value,
    align: $('exif-frame-align').value,
    fontFamily: currentFontFamily(),
  };
  const reqs = FRAME_STYLES.map(async ([val]) => {
    const payload = val === ''
      ? { groups: spec ? [spec] : [], options: { format: 'jpeg', quality: 90 }, orient }
      : { options: { format: 'jpeg', quality: 90, frame: { ...frameBase, style: val } }, orient };
    try {
      const r = await api('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return [val, r.preview || null];
    } catch { return [val, null]; }
  });
  const results = await Promise.all(reqs);
  if (gen !== frameThumbGen) return; // 过期响应丢弃
  for (const [val, src] of results) {
    const img = document.querySelector(`.frame-preset[data-style="${val}"] img`);
    if (img && src) img.src = src;
  }
}, 700);

function renderFramePresets() {
  const box = $('frame-presets');
  if (!box || box.dataset.built === '1') return;
  box.dataset.built = '1';
  box.innerHTML = FRAME_STYLES.map(([val, label]) => `
    <button type="button" class="frame-preset" data-style="${val}" title="${label}">
      <img alt="${label}"><span>${label}</span>
    </button>`).join('');
  box.querySelectorAll('.frame-preset').forEach((btn) => btn.addEventListener('click', () => {
    if ($('exif-frame').value === btn.dataset.style) return;
    $('exif-frame').value = btn.dataset.style;
    $('exif-frame').dispatchEvent(new Event('change', { bubbles: true }));
  }));
  syncFramePresets();
}
function syncFramePresets() {
  const cur = $('exif-frame') ? $('exif-frame').value : '';
  document.querySelectorAll('.frame-preset').forEach((btn) => btn.classList.toggle('on', btn.dataset.style === cur));
}
function bindPreviewOn(selector, ev = 'input') {
  document.querySelectorAll(selector).forEach((el) => el.addEventListener(ev, refreshPreview));
}

// 裁剪提示文案：刻意压到 14 字以内（168px 容器一行只放得下 14 字，实测），
// 换行会让 .field 变高。两个裁剪下拉共用同一条文案，各更新自己那一格。
function cropHintRefresh() {
  $('cropratio-hint').textContent = $('opt-cropratio').value ? '智能裁剪（保留细节多的一侧）' : '';
  $('cropratio-port-hint').textContent = $('opt-cropratio-port').value ? '智能裁剪（保留细节多的一侧）' : '';
}

// ---------- fnOS 目录 ----------
async function loadFnosStatus() {
  try {
    const s = await api('/api/fnos/status');
    state.fnosAvailable = s.available;
    if (s.available) {
      $('fnos-uid').readOnly = true; // fnOS 用户身份只认网关头，不接受页面自选 UID
      $('fnos-uid').title = '由 fnOS 网关身份头确定';
      $('fnos-dot').className = 'dot ok';
      $('fnos-text').textContent = `fnOS 开放 API 已连接（${esc(s.appName)}）`;
      // 尝试加载 SDK；在宿主 iframe 内可直接选目录授权
      try {
        const { TrimApp } = await import('/vendor/index.js');
        state.sdk = new TrimApp();
        $('fnos-hint').textContent = state.sdk.isStandaloneWeb
          ? '当前是独立浏览器页面：fnOS 目录访问需要应用网关注入当前用户身份，请从 fnOS 应用入口打开。'
          : '';
      } catch { $('fnos-hint').textContent = '未找到 fnOS SDK（可能不在宿主环境内），只能查询已授权目录。'; }
    } else {
      $('fnos-dot').className = 'dot off';
      $('fnos-text').textContent = 'fnOS 不可用（本地模式）';
      $('fnos-hint').textContent = '当前不是 fnOS 应用环境：请用「本地路径」或「上传图片」。在 fnOS 上安装 ImgMark 后，此页可用飞牛授权目录。';
      $('fnos-pick').disabled = true;
    }
  } catch {
    $('fnos-dot').className = 'dot off';
    $('fnos-text').textContent = 'fnOS 状态未知';
  }
}

async function refreshFolders() {
  if (!state.fnosAvailable) return;
  const uid = +$('fnos-uid').value || 0;
  try {
    const r = await api(`/api/fnos/folders?uid=${uid}`);
    $('fnos-uid').value = String(r.uid);
    const box = $('fnos-folders');
    const items = [
      ...r.shared.map((f) => ({ ...f, tag: '共享' })),
      ...r.user.map((f) => ({ ...f, tag: '个人' })),
    ];
    box.innerHTML = items.length
      ? items.map((f) => `<div class="folder-item" data-path="${esc(f.path)}">
          <span>📁 ${esc(f.semanticPath || f.path)} <span class="muted">${esc(f.path)}</span></span>
          <span class="tag">${f.tag}</span></div>`).join('')
      : '<div class="muted">暂无授权目录：点击「选择并授权目录」授权一个图片文件夹</div>';
    box.querySelectorAll('.folder-item').forEach((el) => el.addEventListener('click', () => browseFnos(el.dataset.path)));
    if (items.length) await browseFnos(items[0].path);
  } catch (e) {
    $('fnos-hint').textContent = '✗ ' + e.message;
  }
}

let sdkBusy = false;
async function pickFnosDirectory() {
  if (!state.sdk || sdkBusy) return;
  sdkBusy = true;
  try {
    // 确定 = 当前用户个人目录；取消 = 管理员共享目录（仅管理员可操作）
    const personal = window.confirm(
      '选择授权类型：\n\n' +
      '【确定】当前用户个人目录 —— 授权给当前登录用户\n' +
      '【取消】共享目录 —— 需要管理员身份，所有人可用'
    );
    const result = personal
      ? await state.sdk.pickUserFile({ directory: true, title: '选择授权目录', okText: '确认授权' })
      : await state.sdk.pickSharedFile({ title: '选择共享授权目录', okText: '确认授权' });
    if (result?.data?.length) {
      await refreshFolders();
    } else if (result && result.code !== 0) {
      $('fnos-hint').textContent = '授权未完成：' + (result.msg || `code=${result.code}`);
    }
  } catch (e) {
    $('fnos-hint').textContent = '授权失败：' + (e?.msg || e?.message || e);
  } finally {
    sdkBusy = false;
  }
}

async function browseFnos(dir) {
  try {
    const r = await api('/api/fnos/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: +$('fnos-uid').value || 0, path: dir }),
    });
    state.fnosPicked = dir;
    $('fnos-picked').textContent = `${dir}（${r.imageCount} 张图片，${r.writable ? '可写' : '只读'}）`;
    $('fnos-crumbs').textContent = r.semanticPath || dir;
    $('fnos-browser').classList.remove('hidden');
    const parentBtn = r.parents && r.parents.length > 1
      ? `<button data-up="${esc(r.parents[r.parents.length - 2])}">⬆ 上一级</button>` : '';
    $('fnos-entries').innerHTML =
      parentBtn +
      r.dirs.map((d) => `<button data-sub="${esc(d.name)}">📁 ${esc(d.name)}</button>`).join('') +
      (r.imageCount ? `<button class="img-count picked-dir" data-pick="${esc(dir)}">✓ 用这个目录（${r.imageCount} 张图）</button>` : '');
    $('fnos-entries').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.up) browseFnos(b.dataset.up);
      else if (b.dataset.sub) browseFnos(dir.replace(/\/+$/, '') + '/' + b.dataset.sub);
      else if (b.dataset.pick) { state.fnosPicked = b.dataset.pick; $('fnos-picked').textContent = b.dataset.pick; updateRun(); }
    }));
    updateRun();
  } catch (e) {
    $('fnos-hint').textContent = '✗ ' + e.message;
  }
}

// ---------- 本地目录 ----------
async function browseLocal(dir) {
  try {
    const r = await api('/api/browse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    state.localPicked = r.path;
    $('local-picked').textContent = `${r.path}（${r.imageCount} 张图片）`;
    $('local-browser').classList.remove('hidden');
    $('local-crumbs').textContent = r.path;
    $('local-entries').innerHTML =
      `<button data-go="${esc(r.parent)}">⬆ 上一级</button>` +
      r.dirs.map((d) => `<button data-go="${esc(r.path.replace(/\/+$/, '') + '/' + d)}">📁 ${esc(d)}</button>`).join('') +
      (r.imageCount ? `<button class="img-count picked-dir" data-pick="1">✓ 用这个目录（${r.imageCount} 张图）</button>` : '');
    $('local-entries').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.go) { browseLocal(b.dataset.go); $('local-path').value = b.dataset.go; }
      else { state.localPicked = r.path; $('local-picked').textContent = `${r.path}（${r.imageCount} 张图片）`; updateRun(); }
    }));
    updateRun();
  } catch (e) {
    $('local-picked').innerHTML = `<span style="color:var(--bad)">✗ ${esc(e.message)}</span>`;
  }
}

// ---------- 运行 ----------
function currentSource() {
  if (state.mode === 'fnos') return state.fnosPicked ? { mode: 'fnos', inputDir: state.fnosPicked, uid: +$('fnos-uid').value || 0 } : null;
  if (state.mode === 'local') return state.localPicked ? { mode: 'local', inputDir: state.localPicked } : null;
  if (native && state.nativePaths.length) return { mode: 'local-files', files: state.nativePaths };
  return state.uploadCount ? { mode: 'upload' } : null;
}
function updateRun() {
  // 当前标签页这一类判定「已配好」，才算样式就绪
  const style = $('exif-frame') ? $('exif-frame').value : '';
  const ready = {
    logo: !!state.watermarkId && state.groups.length > 0,
    text: style === '' ? !!exifGroupDef() : !!frameDef(),
  };
  const active = ['logo', 'text'].filter((k) => state.layers[k]);
  const styleReady = active.length > 0 && active.every((k) => ready[k]);
  const ok = styleReady && !!currentSource();
  $('run').disabled = !ok;
  $('group-add').disabled = !state.logoSet; // 有 logo 才能建分组
  $('watch-create').disabled = !styleReady; // 监听复用当前选中的这一类水印
  const pending = active.find((k) => !ready[k]);
  $('run-hint').textContent = ok ? '准备就绪'
    : !currentSource() ? '先选择图片来源'
    : !active.length ? '先选择一类水印'
    : pending === 'logo' ? (!state.logoSet ? 'Logo 水印：先添加 logo' : 'Logo 水印：等待水印准备…')
    : style === '' ? '文字 / 画框：先勾选要输出的字段'
    : '文字 / 画框：请选择边框样式';
}

// ---------- 文件夹监听 ----------
async function refreshWatchers() {
  try {
    const r = await api('/api/watchers');
    const box = $('watch-list');
    box.innerHTML = r.watchers.length ? r.watchers.map((w) => `
      <div class="watch-item ${w.status}">
        <div class="row-inline" style="gap:8px;justify-content:space-between;margin:0">
          <span>📁 ${esc(w.inputDir)}${w.recursive ? '（含子目录）' : ''}</span>
          <span class="tag">${w.status === 'watching' ? '● 监听中' : w.status === 'paused' ? '⏸ 已暂停' : w.status}</span>
        </div>
        <div class="muted">→ ${esc(w.outputDir)}${w.presetId ? ' · 绑定方案「' + esc((presets.find((p) => p.id === w.presetId) || {}).name || w.presetId.slice(0, 8)) + '」' : ''} · 已处理 ${w.stats.processed} · 跳过 ${w.stats.skipped} · 失败 ${w.stats.failed}${w.lastError ? ' · ' + esc(w.lastError) : ''}${w.note ? ' · ' + esc(w.note) : ''}</div>
        <div class="row-inline" style="gap:6px;margin:0">
          <button class="btn tiny" data-rescan="${w.id}">立即扫描</button>
          <button class="btn tiny ghost" data-del="${w.id}">删除</button>
        </div>
      </div>`).join('') : '<div class="muted">暂无监听：填好监听目录，点「建立监听」</div>';
    // 导航角标同步：运行中的监听数（0 当没监听看，不显示）
    const watching = r.watchers.filter((w) => w.status === 'watching').length;
    const cw = $('cnt-watch');
    if (cw) { cw.textContent = watching; cw.classList.toggle('hidden', !watching); }
    box.querySelectorAll('[data-rescan]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/watchers/${b.dataset.rescan}/rescan`, { method: 'POST' });
      refreshWatchers();
    }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/watchers/${b.dataset.del}`, { method: 'DELETE' });
      refreshWatchers();
    }));
  } catch (e) { $('watch-hint').textContent = '✗ ' + e.message; }
}

async function createWatcher() {
  if ($('watch-create').disabled) return; // 样式未配好（updateRun 里判定）
  const dir = $('watch-dir').value.trim();
  if (!dir) { $('watch-hint').textContent = '填监听目录绝对路径'; return; }
  $('watch-hint').textContent = '建立中…';
  try {
    await api('/api/watchers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputDir: dir, outputDir: $('watch-outdir').value.trim(),
        recursive: $('watch-recursive').checked,
        // 下拉里选中了方案就绑定方案（重启自恢复）；否则按当前选中的这一类水印建立
        presetId: selectedPresetId || undefined,
        watermarkId: state.watermarkId, groups: groupsForPayload(), options: options() }) });
    $('watch-hint').textContent = '监听已建立 ✓ 新图片落盘将自动加水印';
    refreshWatchers();
  } catch (e) { $('watch-hint').textContent = '✗ ' + e.message; }
}

async function run() {
  const src = currentSource();
  const groups = groupsForPayload();
  const frame = frameDef();
  // 纯相机参数 / 纯边框（不传 logo）也能跑，服务端两类都放行
  if (!src || (!groups.length && !frame)) return;
  if (groups.some((g) => !g.text) && !state.watermarkId) return; // 有 logo 组但水印失效
  const overwrite = $('opt-overwrite').checked;
  if (overwrite && !window.confirm('⚠ 将直接覆盖原图片文件（不可恢复），确定继续？')) return;

  const payload = {
    watermarkId: state.watermarkId,
    mode: src.mode,
    inputDir: src.inputDir,
    uid: src.uid,
    options: options(),
    groups,
    skipProcessed: $('opt-skipdone').checked && !$('opt-overwrite').checked,
    recursive: $('opt-recursive').checked && src.mode !== 'local-files',
    overwrite,
    outputDir: overwrite ? null : $('opt-outdir').value.trim() || null,
  };
  if (src.files) payload.files = src.files;
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  if (src.mode === 'upload') {
    for (const f of $('up-files').files) fd.append('files', f);
  }
  $('run').disabled = true;
  $('job-log').textContent = '';
  $('job-summary').textContent = '提交任务…';
  try {
    const { jobId } = await api('/api/process', { method: 'POST', body: fd });
    pollJob(jobId);
  } catch (e) {
    $('job-summary').innerHTML = `<span style="color:var(--bad)">✗ ${esc(e.message)}</span>`;
    $('run').disabled = false;
  }
}

async function pollJob(jobId) {
  try {
    const j = await api(`/api/jobs/${jobId}`);
    // 批量处理页签的角标：任务运行中显示进度，结束/出错就收起（详情都在任务卡里）
    const cj = $('cnt-job');
    if (cj) {
      if (j.status === 'running') { cj.textContent = `${j.done}/${j.total || '…'}`; cj.classList.remove('hidden'); }
      else cj.classList.add('hidden');
    }
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    $('bar').style.width = pct + '%';
    $('job-summary').textContent = j.status === 'running'
      ? `处理中 ${j.done}/${j.total || '…'}（成功 ${j.ok}，失败 ${j.failed}）`
      : j.status === 'done'
        ? `完成：成功 ${j.ok}，失败 ${j.failed}${j.skipped ? `，跳过 ${j.skipped}` : ''}，共 ${j.total + (j.skipped || 0)}`
        : `✗ ${j.error}`;
    const lines = (j.results || []).slice(-200).map((r) =>
      `<div class="${r.ok ? 'done' : 'fail'}">${r.ok ? '✓' : '✗'} ${esc(r.name)}${r.ok ? '' : '  ' + esc(r.error)}</div>`);
    if (j.status === 'done' && j.dirKind !== 'upload' && j.outputDir) {
      lines.push(`<div class="done">输出目录：${esc(j.outputDir)}</div>`);
    }
    if (j.status === 'done' && j.dirKind === 'upload') {
      (j.results || []).forEach((r, i) => { if (r.ok) lines.push(`<div><a href="/api/jobs/${jobId}/file/${i}" style="color:#7dd3fc">⬇ ${esc(r.name)}</a></div>`); });
    }
    $('job-log').innerHTML = lines.join('');
    if (j.status === 'running') setTimeout(() => pollJob(jobId), 700);
    else $('run').disabled = false;
  } catch (e) {
    $('job-summary').textContent = '✗ ' + e.message;
    $('run').disabled = false;
  }
}

// ---------- 初始化 ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('imgmark_theme', t);
  const b = $('btn-theme');
  if (b) b.innerHTML = t === 'dark' ? I.sun : I.moon;
}

function init() {
  applyTheme(document.documentElement.dataset.theme || 'light');
  $('btn-theme').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('btn-home').innerHTML = I.github;
  // 单张导出工具条的图标：index.html 里只留 .pv-ic[data-ic] 占位，图形统一在这里注入
  document.querySelectorAll('.pv-ic[data-ic]').forEach((el) => { el.innerHTML = I[el.dataset.ic] || ''; });
  // 视图导航：点击切换 + 记住上次所在视图
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) { goView(b.dataset.view); window.scrollTo(0, 0); }
  });
  goView(localStorage.getItem('imgmark_view') || 'style');
  // 桌面壳：fnOS 状态无意义，隐藏；页脚换桌面版文案
  if (native) {
    document.querySelector('header .status').classList.add('hidden');
    document.getElementById('page-footer').textContent = '桌面版 · 图片与水印数据均在本机处理 · 关闭窗口即缩到托盘，监听持续运行';
  }

  // 全局滑杆联动（布局滑杆在各分组卡片内自绑定）
  const slider = (bar, label) => { const b = $(bar); if (b) b.addEventListener('input', () => { $(label).textContent = b.value; }); };
  slider('wm-tol', 'tol-v'); slider('opt-quality', 'q-v');

  // 原生 select 统一升级为自定义下拉（保留原生元素做数据源与事件目标）
  ['wm-bg', 'opt-sizebase', 'opt-format', 'opt-cropratio', 'opt-cropratio-port', 'exif-sep', 'exif-weight', 'exif-font', 'exif-frame-align'].forEach((id) => enhanceSelect($(id)));
  renderFramePresets();
  ['wm-tol', 'opt-quality'].forEach((id) => $(id).addEventListener('input', refreshPreview));
  bindPreviewOn('#opt-maxedge', 'input');
  bindPreviewOn('#opt-format', 'change');
  bindPreviewOn('#opt-sizebase', 'change');
  bindPreviewOn('#opt-cropratio', 'change');
  bindPreviewOn('#opt-cropratio-port', 'change');
  $('opt-autocolor').addEventListener('change', refreshPreview);
  $('opt-cropratio').addEventListener('change', cropHintRefresh);
  $('opt-cropratio-port').addEventListener('change', cropHintRefresh);
  // 横竖分开设置：不勾选时只看左边（横图）那个下拉，它的比例两个方向都套用
  $('opt-cropsplit').addEventListener('change', () => {
    updateCropSplitUI();
    refreshPreview();
  });
  $('opt-format').addEventListener('change', () => { $('quality-wrap').style.opacity = ['jpeg', 'webp'].includes($('opt-format').value) ? 1 : .4; refreshPreview(); });
  // 水印类型标签页：两类二选一，状态记住；旧存档的 exif/frame 键迁移为合并后的 text 页
  document.querySelectorAll('#wm-layer-tabs .tab').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.layer;
      if (state.layers[k]) return;
      state.layerNoteExtra = ''; // 手动切换后不再挂着方案混合的那条提醒
      setLayer(k);
    });
  });
  let savedLayers = null;
  try { savedLayers = JSON.parse(localStorage.getItem('imgmark_layers') || '{}'); } catch { /* 损坏则用默认 */ }
  if (savedLayers && typeof savedLayers === 'object') {
    // 旧存档里两层可能同时开着（或 exif/frame 分开存），此时一律按 Logo 页收拢
    const textOn = !!(savedLayers.text ?? savedLayers.exif ?? savedLayers.frame);
    const logoOn = savedLayers.logo !== false;
    state.layers = { logo: logoOn || !textOn, text: !logoOn && textOn };
    localStorage.setItem('imgmark_layers', JSON.stringify(state.layers));
  }
  applyLayers();
  updateRun();
  $('group-add').addEventListener('click', addGroup);
  bindExifUI();
  loadExifFields(); // 字段清单来自服务端，回来后会重绘勾选区
  loadFonts();     // 字体清单来自服务端（只给本机真装了的）
  $('preset-save').addEventListener('click', savePreset);
  $('preset-del').addEventListener('click', delPreset);
  $('preset-toggle').addEventListener('click', (e) => { e.stopPropagation(); togglePresetMenu(); });
  // 点击菜单外部 / Esc 关闭
  document.addEventListener('click', (e) => {
    if (!$('preset-menu') || $('preset-menu').classList.contains('hidden')) return;
    if (!e.target.closest('.preset-picker')) closePresetMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('preset-menu').classList.contains('hidden')) closePresetMenu();
  });
  loadPresets();
  // 预览区换真图：一次合成同时用于「看效果」与「导出」，不额外跑一遍
  $('one-file').addEventListener('change', (e) => {
    const f = (e.target.files || [])[0] || null;
    e.target.value = ''; // 允许重选同一个文件
    previewOwnOff();
    if (!f) { doRefreshPreview(); return; }
    // 横/竖示例 tab 立即收起：真图的方向自己会识别，用不着让用户切
    $('preview-orient').classList.add('hidden');
    previewOwn = { file: f, blob: null, name: '', url: '', gen: 0, orient: null, w: 0, h: 0 };
    previewOwnMode = true;
    renderOwn();
  });
  $('one-clear').addEventListener('click', () => { previewOwnOff(); doRefreshPreview(); });
  $('one-save').addEventListener('click', saveOwn);
  $('watch-create').addEventListener('click', createWatcher);
  $('watch-refresh').addEventListener('click', refreshWatchers);
  if (native) {
    // 桌面壳：原生选目录。监听目录要绝对路径，手打容易错；输出目录既能给绝对路径
    // 也能给子目录名，所以选完填绝对路径（同样被服务端接受）
    $('watch-dir-pick').classList.remove('hidden');
    $('watch-dir-pick').addEventListener('click', async () => {
      const dir = await native.pickFolder('选择要监听的文件夹（新图片落盘后自动加水印）');
      if (dir) $('watch-dir').value = dir;
    });
    $('watch-outdir-pick').classList.remove('hidden');
    $('watch-outdir-pick').addEventListener('click', async () => {
      const dir = await native.pickFolder('选择监听输出的文件夹');
      if (dir) $('watch-outdir').value = dir;
    });
  }
  refreshWatchers();

  $('wm-file').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // 允许移除后再次选择同一个文件
    if (files.length) onWmFiles(files);
  });
  if (native) {
    // 直接用 id 定位按钮：卡片区 DOM 顺序变化会让"取首元素"类选择器拿到错误目标
    $('wm-file-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      const picked = await native.pickWatermark();
      const list = (Array.isArray(picked) ? picked : picked ? [picked] : [])
        .map((p) => new File([Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))], p.name));
      if (list.length) onWmFiles(list);
    });
  }

  ['wm-bg'].forEach((id) => $(id).addEventListener('change', prepareDebounced));
  $('wm-tol').addEventListener('input', prepareDebounced);
  $('wm-force').addEventListener('change', prepareDebounced);
  $('wm-trim').addEventListener('change', prepareDebounced);
  $('crop-btn').addEventListener('click', toggleCropMode);
  $('crop-reset').addEventListener('click', () => {
    state.crops[state.editingIdx] = null;
    hideRect();
    renderLogoList();
    updateCropUI();
    prepareWatermark();
  });

  // 来源 tabs（限定 data-mode，避免误伤预览区的横/竖示例 tab）
  document.querySelectorAll('.tab[data-mode]').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-mode]').forEach((x) => x.classList.remove('on'));
    t.classList.add('on');
    state.mode = t.dataset.mode;
    ['fnos', 'local', 'upload'].forEach((m) => $(`src-${m}`).classList.toggle('hidden', m !== state.mode));
    // 上传的文件是平铺列表，无目录结构可保留
    $('opt-recursive').disabled = state.mode === 'upload';
    updateRun();
  }));
  document.querySelector('.tab[data-mode="local"]').classList.add('on');
  $('src-fnos').classList.add('hidden');
  $('src-local').classList.remove('hidden');
  state.mode = 'local';

  // fnOS
  $('fnos-refresh').addEventListener('click', refreshFolders);
  $('fnos-uid').addEventListener('change', refreshFolders);
  $('fnos-pick').addEventListener('click', pickFnosDirectory);
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    if (ev.data?.type === 'imgmark:auth-result') refreshFolders();
  });

  // 本地
  if (native) $('local-pick').classList.remove('hidden');
  $('local-pick').addEventListener('click', async () => {
    const dir = await native.pickFolder('选择要加水印的图片文件夹');
    if (dir) { $('local-path').value = dir; browseLocal(dir); }
  });
  $('local-browse').addEventListener('click', () => browseLocal($('local-path').value.trim()));
  $('local-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') browseLocal($('local-path').value.trim()); });

  // 上传（桌面壳：原生多选对话框，直接走 local-files 模式处理本地路径，不上传内容）
  if (native) {
    $('up-file-btn').textContent = '选择图片（原生对话框，可多选）';
    $('up-file-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      state.nativePaths = await native.pickImages();
      state.uploadCount = state.nativePaths.length;
      $('up-count').textContent = state.uploadCount;
      updateRun();
    });
  } else {
    $('up-files').addEventListener('change', (e) => { state.uploadCount = e.target.files.length; $('up-count').textContent = state.uploadCount; updateRun(); });
  }

  // 输出
  $('opt-overwrite').addEventListener('change', () => {
    $('outdir-wrap').style.opacity = $('opt-overwrite').checked ? .4 : 1;
    $('opt-outdir').disabled = $('opt-overwrite').checked;
    if (native) $('outdir-pick').disabled = $('opt-overwrite').checked;
  });
  if (native) {
    // 桌面壳：原生选择输出文件夹（绝对路径），并移除 fnOS 页签（壳内无 fnOS 开放 API）
    $('outdir-pick').classList.remove('hidden');
    $('outdir-pick').addEventListener('click', async () => {
      const dir = await native.pickFolder('选择水印输出的文件夹');
      if (dir) $('opt-outdir').value = dir;
    });
    document.querySelector('.tab[data-mode="fnos"]').classList.add('hidden');
  }
  $('run').addEventListener('click', run);
  $('run').disabled = true;

  api('/api/config').then((c) => {
    $('opt-outdir').value = c.outputDirName || '_watermarked';
    $('app-ver').textContent = `v${c.version} · ${native ? '桌面版' : '批量图片水印'}`;
  }).catch(() => {});
  loadFnosStatus();
}

init();
window.__imgmarkState = state; // 调试句柄（module 作用域外部不可见，故显式暴露）
