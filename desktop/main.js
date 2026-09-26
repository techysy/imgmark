'use strict';
/**
 * ImgMark Windows 桌面壳（Electron，参考 CreditDaddy 模式）
 * - 主进程内直接 require ImgMark 的 Express 服务（同 Node 栈），端口占用自动 +1，
 *   28110 已有 imgmark 实例则直接复用
 * - preload 暴露 window.imgmarkDesktop：原生文件/文件夹对话框（比 <input type=file> 强：
 *   多选文件返回真实路径、选文件夹、按扩展名过滤水印源），路径交给后端 local-files 模式批量处理
 */
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const BASE_PORT = Number(process.env.IMGMARK_PORT || 28110);
let win = null;
let boundPort = BASE_PORT;
let tray = null;
let isQuitting = false;
let watcherCount = 0; // -1 = 尚未获取

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

function probeImgmark(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'imgmark'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await probeImgmark(p)) { boundPort = p; return 'reused'; }
  }
  // 服务代码打包在 resources/imgmark/server（开发时用仓库 app/server）
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'imgmark', 'server')
    : path.join(__dirname, '..', 'app', 'server');
  process.env.IMGMARK_DATA_DIR = app.getPath('userData'); // 必须在 require 前设置
  const { start } = require(path.join(serverRoot, 'src', 'server.js'));
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await probeImgmark(p)) { boundPort = p; return 'reused-mid'; }
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
    }
  });
  win.on('closed', () => { win = null; });
}

function showMain() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

// ---- 托盘 ----
function buildTrayMenu() {
  const watchLabel = watcherCount < 0 ? '文件夹监听：获取状态中…'
    : watcherCount === 0 ? '文件夹监听：无运行中的监听'
    : `文件夹监听：${watcherCount} 个运行中`;
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMain },
    { type: 'separator' },
    { label: watchLabel, enabled: false },
    { type: 'separator' },
    { label: '退出 ImgMark', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`ImgMark 批量图片水印（${watcherCount > 0 ? `${watcherCount} 个监听运行中` : '无监听'}）`);
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
  pollWatchers();
  setInterval(pollWatchers, 30000);
}

// ---- 原生对话框（强化文件/文件夹选择能力）----
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'];
const WM_EXTS = ['ai', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'];

ipcMain.handle('pick-images', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要加水印的图片（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: IMAGE_EXTS }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择图片文件夹', properties: ['openDirectory'] });
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
