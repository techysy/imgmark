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
};
let cropMode = false, dragStart = null;

// ---------- 图标（Lucide 风格线性图标，与 CreditDaddy 同款，currentColor） ----------
const svg = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const I = {
  github: svg('<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
};

// 空状态占位图（与 index.html 中的初始 src 保持一致）
const PLACEHOLDER_WM = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='190' height='150'%3E%3Ctext x='95' y='70' text-anchor='middle' font-family='sans-serif' font-size='12' fill='%239aa0a6'%3E添加 logo 后预览%3C/text%3E%3Ctext x='95' y='92' text-anchor='middle' font-family='sans-serif' font-size='11' fill='%23b9bec5'%3E支持 AI / SVG / PNG / JPG%3C/text%3E%3C/svg%3E";
const PLACEHOLDER_STYLE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='420' height='280'%3E%3Crect x='0' y='0' width='420' height='280' fill='%23dde3ea'/%3E%3Ccircle cx='90' cy='70' r='42' fill='%23ffffff' opacity='.35'/%3E%3Crect x='280' y='180' width='110' height='66' fill='%233d4f63' opacity='.3' rx='8'/%3E%3Ctext x='210' y='145' text-anchor='middle' font-family='sans-serif' font-size='13' fill='%237a8494'%3E添加 logo 并配置分组后预览%3C/text%3E%3C/svg%3E";

// ---------- 工具 ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 水印准备（split：每个 logo 独立去底；布局在 ② 分组里配置） ----------
async function prepareWatermark() {
  state.watermarkId = null;
  state.logoSet = null;
  if (!state.wmFiles.length) {
    $('wm-preview').src = PLACEHOLDER_WM;
    $('style-preview').src = PLACEHOLDER_STYLE;
    $('style-preview-auto').classList.add('hidden');
    $('preview-cap-auto').classList.add('hidden');
    renderLogoList(); renderGroups();
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

// ---------- 方案（保存/恢复：分组+选项存 localStorage，logo 文件存 IndexedDB） ----------
const PRESET_KEY = 'imgmark_presets';
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('imgmark-presets', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(key, files) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(files, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction('files', 'readonly').objectStore('files').get(key);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
function getPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch { return []; } }

function renderPresetSelect() {
  const sel = $('preset-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">选择已保存方案…</option>' +
    getPresets().map((p) => `<option value="${esc(p.name)}">${esc(p.name)}（${new Date(p.time).toLocaleString()}）</option>`).join('');
}

async function savePreset() {
  const hint = $('preset-hint');
  const name = $('preset-name').value.trim();
  if (!name) { hint.textContent = '先填方案名称'; return; }
  if (!state.logoSet || !state.groups.length) { hint.textContent = '当前没有可保存的配置（先加 logo 和分组）'; return; }
  const list = getPresets().filter((p) => p.name !== name);
  list.push({ name, time: Date.now(), data: {
    groups: JSON.parse(JSON.stringify(state.groups)),
    options: options(),
  }});
  localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  await idbPut(name, state.wmFiles);
  renderPresetSelect();
  $('preset-select').value = name;
  hint.textContent = '已保存 ✓（含 logo 文件与全部分组参数）';
}

async function delPreset() {
  const name = $('preset-select').value;
  if (!name) { $('preset-hint').textContent = '先在左侧选择要删除的方案'; return; }
  localStorage.setItem(PRESET_KEY, JSON.stringify(getPresets().filter((p) => p.name !== name)));
  await idbDel(name);
  renderPresetSelect();
  $('preset-hint').textContent = '已删除';
}

async function applyPreset(name) {
  const hint = $('preset-hint');
  const meta = getPresets().find((p) => p.name === name);
  if (!meta) return;
  const files = await idbGet(name);
  if (!files.length) { hint.textContent = '方案缺少 logo 文件（可能被浏览器清理）'; return; }
  hint.textContent = '恢复中…';
  onWmFiles(files); // 走真实准备流程，prepare 完成后再套用分组与选项
  const timer = setInterval(() => {
    if (!state.watermarkId || !state.logoSet) return;
    clearInterval(timer);
    state.groups = JSON.parse(JSON.stringify(meta.data.groups))
      .map((g) => ({ ...g, logos: (g.logos || []).filter((i) => i < state.logoSet.logos.length) }))
      .filter((g) => g.logos.length);
    if (!state.groups.length) state.groups = [defaultGroup(state.logoSet.logos.map((_, i) => i))];
    state.groups.forEach((g) => { g.ratios = g.logos.map((_, k) => (g.ratios && g.ratios[k]) || 1); });
    const o = meta.data.options || {};
    if (o.format) $('opt-format').value = o.format;
    if (o.quality) $('opt-quality').value = o.quality;
    if (o.sizeBase) $('opt-sizebase').value = o.sizeBase;
    if (o.autoColor && !$('opt-autocolor').disabled) $('opt-autocolor').checked = true;
    renderLogoList(); renderGroups();
    updateAutoColorUI(); refreshPreview(); updateRun();
    hint.textContent = '已恢复 ✓';
  }, 250);
}

// logo 文件入口（网页 input / 桌面壳原生对话框 / 方案恢复共用）
function onWmFiles(files) {
  state.wmFiles = files;
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
}

// ---------- 分组（每组：logo 组合 + 九宫格定位 + 大小/间距/比例） ----------
const POS_NAMES = { nw: '左上', n: '上', ne: '右上', w: '左', c: '中', e: '右', sw: '左下', s: '下', se: '右下' };

function renderGroups() {
  const box = $('groups-box');
  if (!state.groups.length) {
    box.innerHTML = '<div class="muted">还没有分组：点「＋ 添加分组」，每组可放 1 个或多个 logo</div>';
    return;
  }
  const logos = state.logoSet ? state.logoSet.logos : [];
  box.innerHTML = state.groups.map((g, gi) => {
    const multi = g.logos.length > 1;
    return `
    <div class="group-card" data-gi="${gi}">
      <div class="row-inline gc-head">
        <b>分组 ${gi + 1}</b>
        <span class="gc-logos">${logos.map((l, li) => `
          <label class="gc-logo ${g.logos.includes(li) ? 'on' : ''}" title="${esc(l.name)}">
            <input type="checkbox" data-li="${li}" ${g.logos.includes(li) ? 'checked' : ''}>
            <img src="${l.preview}" alt=""><span>${li + 1}</span>
          </label>`).join('')}</span>
        <button class="btn tiny gc-del" data-gi="${gi}">✕ 删除分组</button>
      </div>
      <div class="row-inline wrap gc-ctrl">
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
        <div class="field"><label>大小 <b class="gc-sv">${g.sizePct}</b>%</label>
          <input type="range" class="gc-size" min="2" max="90" value="${g.sizePct}"></div>
        <div class="field"><label>边距 <b class="gc-mv">${g.marginPct}</b>%</label>
          <input type="range" class="gc-mg" min="0" max="25" value="${g.marginPct}"></div>
        ${multi ? `
        <div class="field ${g.direction === 'v' ? 'dim' : ''}"><label>水平间距 <b class="gc-gxv">${g.gapX}</b></label>
          <input type="range" class="gc-gapx" min="0" max="100" value="${g.gapX}"></div>
        <div class="field ${g.direction === 'h' ? 'dim' : ''}"><label>垂直间距 <b class="gc-gyv">${g.gapY}</b></label>
          <input type="range" class="gc-gapy" min="0" max="100" value="${g.gapY}"></div>
        ${g.logos.map((li, k) => `
        <div class="field"><label>logo ${li + 1} ${g.direction === 'v' ? '宽' : '高'}比 <b class="gc-rv" data-k="${k}">${(g.ratios[k] || 1).toFixed(2)}</b></label>
          <input type="range" class="gc-ratio" data-k="${k}" min="0.2" max="3" step="0.05" value="${g.ratios[k] || 1}"></div>`).join('')}` : ''}
        <div class="field"><label>不透明度 <b class="gc-ov">${g.opacity}</b></label>
          <input type="range" class="gc-op" min="5" max="100" value="${g.opacity}"></div>
      </div>
    </div>`;
  }).join('');
  bindGroupEvents();
}

function bindGroupEvents() {
  const box = $('groups-box');
  box.querySelectorAll('.group-card').forEach((card) => {
    const gi = +card.dataset.gi;
    const g = state.groups[gi];
    card.querySelector('.gc-del').addEventListener('click', () => {
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
  });
}

function addGroup() {
  if (!state.logoSet || !state.logoSet.logos.length) return;
  state.groups.push(defaultGroup([0]));
  renderGroups();
  refreshPreview();
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
function updateAutoColorUI() {
  const t = $('opt-autocolor');
  const logos = state.logoSet ? state.logoSet.logos : [];
  const allMono = logos.length > 0 && logos.every((l) => l.monochrome);
  t.disabled = !allMono;
  if (!allMono) t.checked = false;
  $('autocolor-hint').textContent = allMono
    ? '全部 logo 为纯黑白：每组按图片落点亮度自动选黑/白标'
    : '存在彩色 logo：彩色所在分组不参与自动换色（不影响正常使用）';
}

// ---------- 样式预览（单张实时：任一分组参数变化都重新合成示例图） ----------
const refreshPreview = debounce(async () => {
  if (!state.watermarkId || !state.groups.length) return;
  try {
    const r = await api('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watermarkId: state.watermarkId, options: options(), groups: state.groups }),
    });
    $('style-preview').src = r.preview;
    const auto = !!r.previewAuto;
    $('style-preview-auto').classList.toggle('hidden', !auto);
    $('preview-cap-auto').classList.toggle('hidden', !auto);
  } catch { /* 预览失败不打断 */ }
}, 350);

// ---------- 选项（全局：大小基准/输出格式/质量 + 亮度自适应开关；布局参数在各分组里） ----------
function options() {
  return {
    format: $('opt-format').value,
    quality: +$('opt-quality').value,
    sizeBase: $('opt-sizebase') ? $('opt-sizebase').value : 'long',
    autoColor: !$('opt-autocolor').disabled && $('opt-autocolor').checked,
  };
}
function bindPreviewOn(selector, ev = 'input') {
  document.querySelectorAll(selector).forEach((el) => el.addEventListener(ev, refreshPreview));
}

// ---------- fnOS 目录 ----------
async function loadFnosStatus() {
  try {
    const s = await api('/api/fnos/status');
    state.fnosAvailable = s.available;
    if (s.available) {
      $('fnos-dot').className = 'dot ok';
      $('fnos-text').textContent = `fnOS 开放 API 已连接（${esc(s.appName)}）`;
      // 尝试加载 SDK；在宿主 iframe 内可直接选目录授权
      try {
        const { TrimApp } = await import('/vendor/index.js');
        state.sdk = new TrimApp();
        $('fnos-hint').textContent = state.sdk.isStandaloneWeb
          ? '当前是独立浏览器页面：目录授权需在 fnOS 桌面内打开本应用完成；此前授权过的目录仍会显示在下面。'
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
  const ok = !!state.watermarkId && !!state.groups.length && !!currentSource();
  $('run').disabled = !ok;
  $('group-add').disabled = !state.logoSet; // 有 logo 才能建分组
  $('watch-create').disabled = !state.watermarkId; // 监听复用当前 logo/分组
  $('run-hint').textContent = ok ? '准备就绪' : '先选水印文件和图片来源';
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
        <div class="muted">→ ${esc(w.outputDir)} · 已处理 ${w.stats.processed} · 跳过 ${w.stats.skipped} · 失败 ${w.stats.failed}${w.lastError ? ' · ' + esc(w.lastError) : ''}${w.note ? ' · ' + esc(w.note) : ''}</div>
        <div class="row-inline" style="gap:6px;margin:0">
          <button class="btn tiny" data-rescan="${w.id}">立即扫描</button>
          <button class="btn tiny ghost" data-del="${w.id}">删除</button>
        </div>
      </div>`).join('') : '<div class="muted">暂无监听：选好 logo 与分组后，填监听目录点「建立监听」</div>';
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
  if (!state.watermarkId) return;
  const dir = $('watch-dir').value.trim();
  if (!dir) { $('watch-hint').textContent = '填监听目录绝对路径'; return; }
  $('watch-hint').textContent = '建立中…';
  try {
    await api('/api/watchers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputDir: dir, outputDir: $('watch-outdir').value.trim(),
        recursive: $('watch-recursive').checked,
        watermarkId: state.watermarkId, groups: state.groups, options: options() }) });
    $('watch-hint').textContent = '监听已建立 ✓ 新图片落盘将自动加水印';
    refreshWatchers();
  } catch (e) { $('watch-hint').textContent = '✗ ' + e.message; }
}

async function run() {
  const src = currentSource();
  if (!src || !state.watermarkId) return;
  const overwrite = $('opt-overwrite').checked;
  if (overwrite && !window.confirm('⚠ 将直接覆盖原图片文件（不可恢复），确定继续？')) return;

  const payload = {
    watermarkId: state.watermarkId,
    mode: src.mode,
    inputDir: src.inputDir,
    uid: src.uid,
    options: options(),
    groups: state.groups,
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
  // 桌面壳：fnOS 状态无意义，隐藏；页脚换桌面版文案
  if (native) {
    document.querySelector('header .status').classList.add('hidden');
    document.getElementById('page-footer').textContent = '桌面版 · 图片与水印数据均在本机处理 · 关闭窗口即缩到托盘，监听持续运行';
  }

  // 全局滑杆联动（布局滑杆在各分组卡片内自绑定）
  const slider = (bar, label) => { const b = $(bar); if (b) b.addEventListener('input', () => { $(label).textContent = b.value; }); };
  slider('wm-tol', 'tol-v'); slider('opt-quality', 'q-v');
  ['wm-tol', 'opt-quality'].forEach((id) => $(id).addEventListener('input', refreshPreview));
  bindPreviewOn('#opt-format', 'change');
  bindPreviewOn('#opt-sizebase', 'change');
  $('opt-autocolor').addEventListener('change', refreshPreview);
  $('opt-format').addEventListener('change', () => { $('quality-wrap').style.opacity = ['jpeg', 'webp'].includes($('opt-format').value) ? 1 : .4; refreshPreview(); });
  $('group-add').addEventListener('click', addGroup);
  $('preset-save').addEventListener('click', savePreset);
  $('preset-del').addEventListener('click', delPreset);
  $('preset-select').addEventListener('change', (e) => { if (e.target.value) applyPreset(e.target.value); });
  renderPresetSelect();
  $('watch-create').addEventListener('click', createWatcher);
  $('watch-refresh').addEventListener('click', refreshWatchers);
  refreshWatchers();

  $('wm-file').addEventListener('change', (e) => onWmFiles(Array.from(e.target.files || [])));
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

  // 来源 tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
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
    const dir = await native.pickFolder();
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
      const dir = await native.pickFolder();
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
