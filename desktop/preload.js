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
});
