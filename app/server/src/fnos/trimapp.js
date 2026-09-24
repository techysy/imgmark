'use strict';
/**
 * 飞牛 fnOS 开放平台 后端 API 客户端。
 *
 * 统一入口：POST /api/v1/trimapp（走 Unix Socket /var/run/trim_open_gateway_apiscope.socket）
 * 认证：Authorization: Bearer ${TRIM_API_TOKEN}（系统在拉起 cmd/main 时注入，每次调用现读，不落盘）
 * 请求体：{ reqId, req, appName, data } → 响应 { reqId, code, msg, data }，code=0 成功
 *
 * 已接入：
 *  - trim.file.getUserAccessibleFolders   用户个人授权目录（Scope: trim.file.userAccess）
 *  - trim.file.delUserAccessibleFolder
 *  - trim.file.getSharedAccessibleFolders 管理员共享授权目录（Scope: trim.file.sharedAccess）
 *  - trim.file.delSharedAccessibleFolder
 *  - trim.file.checkUserACL               文件权限检查（Scope: trim.file.userAcl）
 *  - trim.file.convertPath                /vol1/... → 语义化展示路径（Scope: trim.file.path）
 *  - trim.system.getPlatformConfig        系统语言/版本（Scope: trim.system.getPlatformConfig）
 */
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const DEFAULT_SOCKET = '/var/run/trim_open_gateway_apiscope.socket';

class TrimAppClient {
  constructor({ socketPath = process.env.TRIM_OPEN_GATEWAY_SOCKET || DEFAULT_SOCKET, appName = null } = {}) {
    this.socketPath = socketPath;
    this._appName = appName;
  }

  get appName() { return this._appName || process.env.TRIM_APPNAME || 'imgmark'; }
  get token() { return process.env.TRIM_API_TOKEN || ''; }

  /** 是否运行在 fnOS 应用环境（socket 存在 + token 已注入） */
  isAvailable() {
    if (!this.token) return false;
    try { fs.accessSync(this.socketPath); return true; } catch { return false; }
  }

  call(req, data = {}, { timeoutMs = 15000 } = {}) {
    const token = this.token;
    if (!token) return Promise.reject(new Error('TRIM_API_TOKEN 未注入：本接口只能在 fnOS 应用环境内使用'));
    const body = JSON.stringify({
      reqId: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      req,
      appName: this.appName,
      data,
    });
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        path: '/api/v1/trimapp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (e) { return reject(new Error(`trimapp 响应解析失败: ${e.message}`)); }
          if (payload.code !== 0) {
            return reject(Object.assign(new Error(payload.msg || `trimapp ${req} 失败 (code=${payload.code})`), { code: payload.code }));
          }
          resolve(payload.data);
        });
      });
      request.on('timeout', () => request.destroy(new Error(`trimapp ${req} 超时`)));
      request.on('error', reject);
      request.end(body);
    });
  }

  // ---- 具体能力 ----
  getUserAccessibleFolders(uid) {
    return this.call('trim.file.getUserAccessibleFolders', { uid }).then((d) => d.paths || []);
  }
  getSharedAccessibleFolders() {
    return this.call('trim.file.getSharedAccessibleFolders', {}).then((d) => d.paths || []);
  }
  delUserAccessibleFolder(uid, path) {
    return this.call('trim.file.delUserAccessibleFolder', { uid, path });
  }
  delSharedAccessibleFolder(path) {
    return this.call('trim.file.delSharedAccessibleFolder', { path });
  }
  /** @returns {Array<{path,readable,writable,deletable}>} */
  checkUserACL(uid, path) {
    return this.call('trim.file.checkUserACL', { uid, path });
  }
  /** @returns {Array<{path,semanticPath}>} */
  convertPath(paths, language = 'zh-CN') {
    return this.call('trim.file.convertPath', { path: paths, language })
      .then((d) => (d && d.result) || []);
  }
  getPlatformConfig() {
    return this.call('trim.system.getPlatformConfig', {});
  }
}

module.exports = { TrimAppClient, DEFAULT_SOCKET };
