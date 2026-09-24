'use strict';
/**
 * ImgMark 前端逻辑。
 * fnOS 宿主环境（桌面 iframe，manifest micro_app=true）：用 @trimjs/web-app 的 pickUserFile/pickSharedFile 选目录即授权；
 * 独立浏览器：授权需经 fnOS 宿主路由，这里给出提示并保留"后端查询已授权目录"能力（此前在宿主内授权过的目录仍可用）。
 */

const $ = (id) => document.getElementById(id);
const native = window.imgmarkDesktop || null; // Electron 桌面壳桥接（纯浏览器环境为 null）
const state = {
  watermarkId: null,
  wmFiles: [],   // 多个 logo → 并排合并成一个组合水印
  mode: 'fnos',
  fnosPicked: null,
  localPicked: null,
  uploadCount: 0,
  nativePaths: [], // 桌面壳：原生对话框选出的图片绝对路径
  sdk: null,
  fnosAvailable: false,
  // 裁剪（每个 logo 各自一份裁剪框，单文件 = 只有一项）
  sourcePreviews: [],
  sourceSizes: [],
  crops: [],
  editingIdx: 0,
};
let cropMode = false, dragStart = null;

// ---------- 工具 ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 水印准备 ----------
async function prepareWatermark() {
  if (!state.wmFiles.length) return;
  const multi = state.wmFiles.length > 1;
  const fd = new FormData();
  for (const f of state.wmFiles) fd.append('watermark', f);
  fd.append('bg', $('wm-bg').value);
  fd.append('tolerance', $('wm-tol').value);
  fd.append('force', $('wm-force').checked ? 'true' : 'false');
  fd.append('trim', $('wm-trim').checked ? 'true' : 'false');
  fd.append('gap', $('wm-gap').value);
  fd.append('equalHeight', $('wm-equal').checked ? 'true' : 'false');
  if (state.crops.some(Boolean)) {
    fd.append('crop', multi
      ? JSON.stringify(state.crops)
      : [state.crops[0].x, state.crops[0].y, state.crops[0].w, state.crops[0].h].map((n) => n.toFixed(2)).join(','));
  }
  $('wm-notes').textContent = '处理中…';
  try {
    const r = await api('/api/prepare', { method: 'POST', body: fd });
    state.watermarkId = r.id;
    state.sourcePreviews = r.sourcePreviews || (r.sourcePreview ? [r.sourcePreview] : []);
    state.sourceSizes = r.sourceSizes || (r.sourceWidth ? [[r.sourceWidth, r.sourceHeight]] : []);
    $('crop-btn').disabled = false;
    const editingSrc = state.sourcePreviews[state.editingIdx];
    $('wm-preview').src = cropMode && editingSrc ? editingSrc : r.preview;
    $('wm-notes').textContent = `${r.width}×${r.height}\n` + (r.notes || []).join('\n');
    renderChips();
    updateCropUI();
    refreshPreview();
    updateRun();
  } catch (e) {
    $('wm-notes').textContent = '✗ ' + e.message;
    state.watermarkId = null;
    updateRun();
  }
}
const prepareDebounced = debounce(prepareWatermark, 500);

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
  const cur = state.crops[state.editingIdx];
  $('crop-reset').disabled = !cur;
  $('crop-status').textContent = cropMode
    ? `在「${(state.wmFiles[state.editingIdx] || {}).name || 'logo ' + (state.editingIdx + 1)}」的原图上拖拽框选要保留的区域`
    : cur
      ? `logo ${state.editingIdx + 1} 裁剪：${cur.x.toFixed(0)},${cur.y.toFixed(0)} 起 ${cur.w.toFixed(0)}×${cur.h.toFixed(0)}%（原图 ${(state.sourceSizes[state.editingIdx] || [0, 0]).join('×')}）`
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
  if (!state.watermarkId) return;
  cropMode = !cropMode;
  if (cropMode) {
    const src = state.sourcePreviews[state.editingIdx];
    if (src) $('wm-preview').src = src; // 参考系=当前 logo 的原始画布
    if (state.crops[state.editingIdx]) drawRectPct(state.crops[state.editingIdx]); else hideRect();
  } else {
    if (state.crops[state.editingIdx]) drawRectPct(state.crops[state.editingIdx]); else hideRect();
    prepareWatermark();
  }
  updateCropUI();
}

// 多 logo：切换当前编辑的 logo（裁剪框各自独立）
function renderChips() {
  const box = $('logo-chips');
  if (state.wmFiles.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = state.wmFiles.map((f, i) => {
    const name = f.name.length > 16 ? f.name.slice(0, 14) + '…' : f.name;
    return `<button class="chip ${i === state.editingIdx ? 'on' : ''}" data-i="${i}" title="${esc(f.name)}">${i + 1}. ${esc(name)}${state.crops[i] ? ' ✂' : ''}</button>`;
  }).join('');
  box.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => selectLogo(+b.dataset.i)));
}
function selectLogo(i) {
  state.editingIdx = i;
  renderChips();
  if (cropMode) {
    const src = state.sourcePreviews[i];
    if (src) $('wm-preview').src = src;
    if (state.crops[i]) drawRectPct(state.crops[i]); else hideRect();
  }
  updateCropUI();
}

// ---------- 样式预览 ----------
const refreshPreview = debounce(async () => {
  if (!state.watermarkId) return;
  try {
    const r = await api('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watermarkId: state.watermarkId, options: options() }),
    });
    $('style-preview').src = r.preview;
  } catch { /* 预览失败不打断 */ }
}, 400);

// ---------- 选项 ----------
function options() {
  return {
    position: document.querySelector('#pos-grid button.on')?.dataset.pos || 'se',
    sizePct: +$('opt-size').value,
    opacity: +$('opt-opacity').value,
    marginPct: +$('opt-margin').value,
    rotate: +$('opt-rotate').value,
    tile: $('opt-tile').checked,
    tileGapPct: +$('opt-tile-gap').value,
    format: $('opt-format').value,
    quality: +$('opt-quality').value,
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
  const ok = !!state.watermarkId && !!currentSource();
  $('run').disabled = !ok;
  $('run-hint').textContent = ok ? '准备就绪' : '先选水印文件和图片来源';
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
        ? `完成：成功 ${j.ok}，失败 ${j.failed}，共 ${j.total}`
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
function init() {
  // 九宫格
  const posNames = { nw: '左上', n: '上', ne: '右上', w: '左', c: '中', e: '右', sw: '左下', s: '下', se: '右下' };
  $('pos-grid').innerHTML = Object.entries(posNames)
    .map(([k, v]) => `<button data-pos="${k}" ${k === 'se' ? 'class="on"' : ''} title="${v}">${v}</button>`).join('');
  $('pos-grid').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $('pos-grid').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    refreshPreview();
  }));

  // 滑杆数值联动
  const slider = (bar, label) => $(bar).addEventListener('input', () => { $(label).textContent = $(bar).value; });
  slider('wm-tol', 'tol-v'); slider('opt-size', 'size-v'); slider('opt-opacity', 'op-v');
  slider('opt-margin', 'mg-v'); slider('opt-quality', 'q-v'); slider('wm-gap', 'gap-v');
  ['wm-tol', 'opt-size', 'opt-opacity', 'opt-margin', 'opt-quality', 'opt-rotate', 'opt-tile-gap'].forEach((id) => $(id).addEventListener('input', refreshPreview));
  $('wm-gap').addEventListener('input', prepareDebounced);
  bindPreviewOn('#opt-format', 'change');
  $('opt-tile').addEventListener('change', () => { $('tile-gap-wrap').classList.toggle('hidden', !$('opt-tile').checked); refreshPreview(); });
  $('opt-format').addEventListener('change', () => { $('quality-wrap').style.opacity = ['jpeg', 'webp'].includes($('opt-format').value) ? 1 : .4; refreshPreview(); });

  // 水印文件（可多选 → 并排合并，每个 logo 可独立裁剪；桌面壳用原生对话框）
  const onWmFiles = (files) => {
    state.wmFiles = files;
    const names = files.map((f) => f.name);
    $('wm-name').textContent = files.length
      ? (files.length > 1 ? `${files.length} 个文件：` : '') + (names.join('、').length > 60 ? names.join('、').slice(0, 60) + '…' : names.join('、'))
      : '未选择';
    // 换文件：清空裁剪状态
    state.crops = files.map(() => null);
    state.sourcePreviews = [];
    state.sourceSizes = [];
    state.editingIdx = 0;
    cropMode = false; dragStart = null;
    hideRect();
    $('arrange-row').classList.toggle('hidden', files.length < 2);
    renderChips();
    updateCropUI();
    prepareWatermark();
  };
  $('wm-file').addEventListener('change', (e) => onWmFiles(Array.from(e.target.files || [])));
  if (native) {
    document.querySelector('label[for="wm-file"], .file-btn').closest('.row').querySelector('.file-btn')
      .addEventListener('click', async (e) => {
        e.preventDefault();
        const picked = await native.pickWatermark();
        if (picked) {
          const bytes = Uint8Array.from(atob(picked.base64), (c) => c.charCodeAt(0));
          onWmFiles([new File([bytes], picked.name)]);
        }
      });
  }
  ['wm-bg'].forEach((id) => $(id).addEventListener('change', prepareDebounced));
  $('wm-tol').addEventListener('input', prepareDebounced);
  $('wm-force').addEventListener('change', prepareDebounced);
  $('wm-trim').addEventListener('change', prepareDebounced);
  ['wm-gap', 'wm-equal'].forEach((id) => $(id).addEventListener('change', prepareDebounced));
  $('crop-btn').addEventListener('click', toggleCropMode);
  $('crop-reset').addEventListener('click', () => {
    state.crops[state.editingIdx] = null;
    hideRect();
    renderChips();
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
  });
  $('run').addEventListener('click', run);
  $('run').disabled = true;

  api('/api/config').then((c) => { $('opt-outdir').value = c.outputDirName || '_watermarked'; }).catch(() => {});
  loadFnosStatus();
}

init();
window.__imgmarkState = state; // 调试句柄（module 作用域外部不可见，故显式暴露）
