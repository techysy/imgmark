'use strict';
const express = require('express');
const path = require('path');

/**
 * fnOS 开放能力路由（仅在 fnOS 应用环境内可用；否则返回 501 + 说明）。
 * 目录访问不做 HTTP 代理下载/上传——授权后应用用户具备 ACL，直接读写真实路径。
 */
function createFnosRouter({ client, listImages }) {
  const router = express.Router();

  const requireFnos = (req, res, next) => {
    if (!client.isAvailable()) {
      return res.status(501).json({
        error: 'fnOS_OPEN_API_UNAVAILABLE',
        message: '当前不是 fnOS 应用运行环境（缺少 TRIM_API_TOKEN 或网关 socket），飞牛授权目录功能不可用。请用"本地路径"或"上传图片"模式。',
      });
    }
    next();
  };

  // 状态路由放行：前端据此判断是否运行在 fnOS 应用环境
  router.get('/status', async (req, res) => {
    const available = client.isAvailable();
    const out = { available, appName: client.appName, socketPath: client.socketPath };
    if (available) {
      try { out.platform = await client.getPlatformConfig(); } catch { /* 忽略 */ }
    }
    res.json(out);
  });

  router.use(requireFnos);

  const semantic = async (paths, language) => {
    if (!paths.length) return [];
    try { return await client.convertPath(paths, language || 'zh-CN'); }
    catch { return []; }
  };

  // 授权目录列表（用户个人 + 管理员共享），附语义化展示路径
  router.get('/folders', async (req, res) => {
    try {
      const uid = Number(req.query.uid || 0);
      if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'uid 无效' });
      const language = req.query.lang || 'zh-CN';
      const [user, shared] = await Promise.all([
        client.getUserAccessibleFolders(uid).catch(() => []),
        client.getSharedAccessibleFolders().catch(() => []),
      ]);
      const [userSem, sharedSem] = await Promise.all([semantic(user, language), semantic(shared, language)]);
      const decorate = (paths, sems) => paths.map((p) => ({
        path: p,
        semanticPath: (sems.find((s) => s.path === p) || {}).semanticPath || p,
      }));
      res.json({ uid, user: decorate(user, userSem), shared: decorate(shared, sharedSem) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 列目录：只允许已授权根目录及其子路径；返回前用当前 uid 检查 ACL
  router.post('/list', async (req, res) => {
    try {
      const { uid, path: dir, lang } = req.body || {};
      if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'uid 无效' });
      if (typeof dir !== 'string' || !dir.startsWith('/')) return res.status(400).json({ error: '路径无效' });

      const [user, shared] = await Promise.all([
        client.getUserAccessibleFolders(uid).catch(() => []),
        client.getSharedAccessibleFolders().catch(() => []),
      ]);
      const roots = [...new Set([...user, ...shared])];
      const inside = roots.find((r) => dir === r || dir.startsWith(r.replace(/\/+$/, '') + '/'));
      if (!inside) return res.status(403).json({ error: '目录未授权', roots });

      const acl = await client.checkUserACL(uid, dir);
      const entry = Array.isArray(acl) ? acl[0] : acl;
      if (!entry || !entry.readable) return res.status(403).json({ error: '当前用户对该目录没有读权限' });

      const dirents = await require('fs').promises.readdir(dir, { withFileTypes: true });
      const dirs = [], files = [];
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        if (d.isDirectory()) dirs.push({ name: d.name });
        else {
          const ext = path.extname(d.name).toLowerCase();
          if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'].includes(ext)) {
            files.push({ name: d.name, ext });
          }
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      const [sem] = await semantic([dir], lang);
      res.json({
        path: dir,
        semanticPath: (sem || {}).semanticPath || dir,
        writable: !!(entry && entry.writable),
        parents: roots.filter((r) => dir.startsWith(r.replace(/\/+$/, '') + '/')) .map((r) => r),
        dirs: dirs.slice(0, 500),
        imageCount: files.length,
        images: files.slice(0, 200).map((f) => f.name),
        truncated: dirs.length > 500 || files.length > 200,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 删除授权目录（用户个人 / 管理员共享）
  router.post('/delete-authorization', async (req, res) => {
    try {
      const { uid, path: dir, shared } = req.body || {};
      if (shared) {
        await client.delSharedAccessibleFolder(dir);
      } else {
        if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'uid 无效' });
        await client.delUserAccessibleFolder(uid, dir);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFnosRouter };
