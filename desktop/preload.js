'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** 桌面壳桥接：原生文件/文件夹对话框（纯浏览器环境无此对象，前端自动降级） */
contextBridge.exposeInMainWorld('imgmarkDesktop', {
  isDesktop: true,
  pickImages: () => ipcRenderer.invoke('pick-images'),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  pickWatermark: () => ipcRenderer.invoke('pick-watermark'),
  // 单张导出存盘：name 是服务端给好的建议文件名，data 是图片字节（ArrayBuffer）
  saveImage: (name, data) => ipcRenderer.invoke('save-image', { name, data }),
  // 复制图片到系统剪贴板（分享到微信/QQ/社交平台）。data 是原始图片字节。
  // 走主进程而不是页面里的 navigator.clipboard：桌面版要的是 Windows 原生
  // 剪贴板格式（DIB 等），浏览器那条路只能塞 PNG，好些程序还不认
  copyImage: (data, name) => ipcRenderer.invoke('copy-image', { data, name }),
});
