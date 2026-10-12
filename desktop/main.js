'use strict';
/**
 * ImgMark Windows 桌面壳（Electron，参考 CreditDaddy 模式）
 * - 主进程内直接 require ImgMark 的 Express 服务（同 Node 栈），端口占用自动 +1，
 *   仅复用使用同一用户数据目录的 ImgMark 实例
 * - preload 暴露 window.imgmarkDesktop：原生文件/文件夹对话框（比 <input type=file> 强：
 *   多选文件返回真实路径、选文件夹、按扩展名过滤水印源），路径交给后端 local-files 模式批量处理
 */
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage, clipboard, ClipboardItem } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const BASE_PORT = Number(process.env.IMGMARK_PORT || 28110);
let win = null;
let boundPort = BASE_PORT;
let tray = null;
let isQuitting = false;
let watcherCount = 0; // -1 = 尚未获取
let dataDir = null;   // 内嵌服务的数据目录，托盘菜单里要显示/打开

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

function probeImgmark(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(health.app === 'imgmark' && typeof health.dataDir === 'string' ? health : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function startServer() {
  dataDir = path.resolve(app.getPath('userData'));
  const normalizeDataDir = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const expectedDataDir = normalizeDataDir(dataDir);
  const usesExpectedDataDir = (health) => health && normalizeDataDir(health.dataDir) === expectedDataDir;

  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (usesExpectedDataDir(await probeImgmark(p))) { boundPort = p; return 'reused'; }
  }
  // 服务代码打包在 resources/imgmark/server（开发时用仓库 app/server）
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'imgmark', 'server')
    : path.join(__dirname, '..', 'app', 'server');
  process.env.IMGMARK_DATA_DIR = dataDir; // 必须在 require 前设置
  const { start } = require(path.join(serverRoot, 'src', 'server.js'));
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    const health = await probeImgmark(p);
    if (usesExpectedDataDir(health)) { boundPort = p; return 'reused-mid'; }
    if (health) continue; // 端口上虽有 ImgMark，但属于另一份数据目录，不能复用
    // 只绑回环地址：桌面版无鉴权，绑 0.0.0.0 等于把本机文件浏览/改写接口暴露给整个局域网
    try { await start({ port: p, host: '127.0.0.1' }); boundPort = p; return 'started'; }
    catch { /* 端口被其它程序占用，换下一个 */ }
  }
  throw new Error('28110 起连续 20 个端口均不可用');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 620,
    title: 'ImgMark 批量图片水印', icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true, backgroundColor: '#f4f6f9',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL(`http://127.0.0.1:${boundPort}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 关闭窗口 = 缩到托盘（监听服务继续运行）；真正退出走托盘菜单「退出」
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      refreshTray();
    }
  });
  win.on('closed', () => { win = null; });
}

function showMain() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  refreshTray(); // 菜单第一项在「打开 ImgMark」/「显示主窗口」之间变，跟着窗口状态走
}

// ---- 托盘 ----
// 菜单按桌面壳常见的样子铺开：打开窗口 / 浏览器访问 → 运行状态 → 数据目录 → 开机自启 → 退出。
// 监听常驻后台（关窗口只是收进托盘），所以「去哪儿看状态」得托盘自己说清楚。
function buildTrayMenu() {
  const portLabel = boundPort ? `服务运行中 · 127.0.0.1:${boundPort}` : '服务未就绪';
  const watchLabel = watcherCount < 0 ? '文件夹监听：获取状态中…'
    : watcherCount === 0 ? '文件夹监听：无运行中的监听'
    : `文件夹监听：${watcherCount} 个运行中`;
  const winLabel = win && !win.isDestroyed() && win.isVisible() ? '显示主窗口' : '打开 ImgMark';
  return Menu.buildFromTemplate([
    { label: winLabel, click: showMain },
    { label: '在浏览器中打开', enabled: !!boundPort, click: () => shell.openExternal(`http://127.0.0.1:${boundPort}/`) },
    { type: 'separator' },
    { label: portLabel, enabled: false },
    { label: watchLabel, enabled: false },
    { type: 'separator' },
    { label: '打开数据目录', enabled: !!dataDir, click: () => { if (dataDir) shell.openPath(dataDir); } },
    // 内嵌服务与壳同生共死，所以这里是「重启 ImgMark」而不是「重启服务」
    { label: '重启 ImgMark', click: () => { isQuitting = true; app.relaunch(); app.quit(); } },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => setAutoLaunch(item.checked),
    },
    { type: 'separator' },
    { label: `关于 ImgMark ${app.getVersion()}`, click: showAbout },
    { type: 'separator' },
    { label: '退出 ImgMark', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

// 开机自启走 Electron 内置的登录项（注册表 Run 键），只装 Windows 版就用 exePath
function setAutoLaunch(enable) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enable, path: process.execPath, args: [] });
  } catch {
    dialog.showErrorBox('开机自启设置失败', '无法修改开机启动项，可在「设置 → 应用 → 启动」中手动开启 ImgMark。');
  }
  refreshTray();
}

function showAbout() {
  const watchText = watcherCount < 0 ? '状态获取中'
    : watcherCount === 0 ? '无运行中的监听' : `${watcherCount} 个监听运行中`;
  dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: '关于 ImgMark',
    message: `ImgMark ${app.getVersion()}`,
    detail: [
      `批量图片水印 · 相机参数文字 · 文件夹监听`,
      `服务地址：http://127.0.0.1:${boundPort}/`,
      `数据目录：${dataDir || '未知'}`,
      `监听：${watchText}`,
    ].join('\n'),
    buttons: ['好'],
  });
}

function refreshTray() {
  if (!tray) return;
  const tip = `ImgMark 批量图片水印 · ${watcherCount > 0 ? `${watcherCount} 个监听运行中` : '无监听'} · 双击打开`;
  tray.setToolTip(tip);
  tray.setContextMenu(buildTrayMenu());
}

function pollWatchers() {
  const req = http.get({ host: '127.0.0.1', port: boundPort, path: '/api/watchers', timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const list = JSON.parse(body).watchers || [];
        const n = list.filter((w) => w.status === 'watching').length;
        if (n !== watcherCount) { watcherCount = n; refreshTray(); }
      } catch { /* 非 imgmark 实例占用端口等情况，忽略 */ }
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
}

function createTray() {
  // 32px 专用托盘图标；缺失时退回 512px 应用图标（Electron 自动缩放）
  let icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('ImgMark 批量图片水印');
  tray.setContextMenu(buildTrayMenu());
  // 设了 contextMenu 之后，Windows 上托盘的单击/双击默认行为（弹菜单）不会再来，
  // 双击也就没人处理了 —— 这里自己接：双击显示主窗口，单击也显示（更符合直觉）
  tray.on('double-click', showMain);
  tray.on('click', showMain);
  pollWatchers();
  setInterval(pollWatchers, 30000);
}

// ---- 原生对话框（强化文件/文件夹选择能力）----
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'];
const WM_EXTS = ['ai', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'];

ipcMain.handle('pick-images', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要加水印的图片（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: IMAGE_EXTS }],
  });
  return r.canceled ? [] : r.filePaths;
});

// title 由调用方给：同一个对话框要服务「选图片来源」「选输出目录」「选监听目录」等
// 多种场景，写死一个标题会让用户对着「选择图片文件夹」去选输出目录
ipcMain.handle('pick-folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: typeof title === 'string' && title.trim() ? title : '选择文件夹',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-watermark', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择水印文件（可多选，并排合并）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '水印文件', extensions: WM_EXTS }, { name: '所有文件', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p), base64: fs.readFileSync(p).toString('base64') }));
});

// 单张导出存盘：浏览器里只能靠 <a download> 落到下载目录，桌面壳直接问用户存哪
// 复制成图到系统剪贴板，供分享到微信/QQ/小红书等。
// 用主进程 clipboard.writeImage 而非渲染进程的 navigator.clipboard：后者在 Electron 里
// 只能写 text 与（Chromium 允许的）image/png，微信一类程序读的是 Windows 原生 DIB 格式
ipcMain.handle('copy-image', async (_e, payload) => {
  try {
    const buf = Buffer.from(payload.data);
    if (!buf.length) return { copied: false, error: '图片数据为空' };
    // Electron 44 的主进程 clipboard 只剩异步 web API（write/read/writeText…），
    // writeImage/readImage 已经没有了 —— 必须走 clipboard.write(ClipboardItem)。
    // 系统剪贴板认的格式由它自己往 Windows 侧翻译（DIB 等），我们只管给出标准图片格式。
    let out = buf;
    if (!/\.png$/i.test(String(payload.name || ''))) {
      // 只保证 PNG 一条路：JPEG/WebP 直接塞 ClipboardItem 未必被目标程序接受，
      // 统一转成无损 PNG 再放。sharp 从内嵌服务借，延迟 require ——
      // 启动时加载它要上百毫秒，而复制是偶发操作，不该让每次开 ImgMark 都为此等一下
      const serverRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'imgmark', 'server')
        : path.join(__dirname, '..', 'app', 'server');
      out = await require(path.join(serverRoot, 'node_modules', 'sharp'))(buf).png().toBuffer();
    }
    await clipboard.write([new ClipboardItem({ 'image/png': out })]);
    return { copied: true };
  } catch (e) {
    return { copied: false, error: String(e.message || e) };
  }
});

ipcMain.handle('save-image', async (_e, payload) => {
  const name = typeof (payload && payload.name) === 'string' && payload.name.trim() ? payload.name : 'image_wm.jpg';
  const ext = path.extname(name).slice(1).toLowerCase();
  const r = await dialog.showSaveDialog(win, {
    title: '导出图片',
    defaultPath: name,
    filters: ext === 'png' ? [{ name: 'PNG 图片', extensions: ['png'] }]
      : ext === 'webp' ? [{ name: 'WebP 图片', extensions: ['webp'] }]
      : [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }],
  });
  if (r.canceled || !r.filePath) return { saved: false };
  await fs.promises.writeFile(r.filePath, Buffer.from(payload.data));
  return { saved: true, path: r.filePath };
});

app.whenReady().then(async () => {
  app.setAppUserModelId('cn.techysy.imgmark');
  try { await startServer(); } catch (e) {
    dialog.showErrorBox('ImgMark 启动失败', String(e.message || e));
    app.quit();
    return;
  }
  createWindow();
  createTray();
  app.on('activate', () => showMain());
});

app.on('before-quit', () => { isQuitting = true; });

app.on('second-instance', () => showMain());
app.on('window-all-closed', () => app.quit());
