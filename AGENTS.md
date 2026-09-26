# ImgMark Agent 操作手册

面向 AI Agent（ZCode / Claude / Codex / OpenCode 等）**直接操作 ImgMark** 的完整说明。
ImgMark = HTTP 服务（默认 `http://127.0.0.1:28110`）+ CLI（`node bin/wm.js`）+ Electron 桌面壳。
本文所有 curl 示例与当前实现逐一核对过，可直接复制执行。

## 0. 启动与健康检查

```bash
# 已有实例则直接用：
curl -s http://127.0.0.1:28110/api/health
# → {"ok":true,"app":"imgmark","dataDir":"..."}

# 没有实例就起一个（Node ≥ 18，首次需 npm install）：
cd app/server && npm install && npm start
# 端口占用：PORT=28120 npm start；fnOS 环境 HOST/PORT 由平台注入
```

无鉴权，仅限本机/局域网使用，**不要暴露公网**。

## 1. 约定

- 所有响应均为 JSON；出错 → 非 2xx + `{"error":"中文原因"}`（HTTP 400/404/500）
- prepare 产物缓存在服务进程内存 + 临时目录：**服务重启后 watermarkId 失效**，需重新 POST `/api/prepare`
- 图片格式：jpg/jpeg/png/webp/bmp/gif/tif/tiff/avif；水印源额外支持 ai（PDF 兼容模式）/ svg
  （BMP 由内置编解码器处理：RLE 压缩 BMP 不支持；`.tif` 在 format=auto 时输出为 `.tiff`）
- 处理默认**不覆盖原图**，输出到输出目录下 `原文件名_wm.原扩展名`（`suffix` 可改）；
  同批/同一监听内输出重名（如 a.jpg、a.png 都强制输出 JPEG）时后者为 `原文件名(2)_wm.扩展名`
- `options.mozjpeg=true`：JPEG 体积小约 10-15%，但编码慢约 5 倍；默认 false（libjpeg-turbo）

## 2. 任务 A：给文件夹批量加水印（最常用）

### A1 准备水印（服务重启后执行一次）

```bash
# 分组模式：每个 logo 独立去底，返回 logos[]（供 groups 用序号引用）
curl -s -X POST http://127.0.0.1:28110/api/prepare \
  -F "watermark=@/path/logo.png" -F "split=true" -F "trim=true"
# → {"id":"<logoSetId>","logos":[{"key","name","width","height","monochrome","inkDark","hasAlt",...}]}
#    monochrome=true 表示纯黑白墨（可参与亮度自适应黑白），hasAlt=true 表示已生成反色变体
```

合并模式（多 logo 并排成**一个**水印，传统行为）：去掉 `split=true`、`watermark=@` 可重复传；
响应为 `{id, width, height, preview,...}`，process 时不带 `groups` 即可。

### A2 提交批量任务

```bash
curl -s -X POST http://127.0.0.1:28110/api/process \
  -F 'payload={"watermarkId":"<logoSetId>","mode":"local","inputDir":"/abs/photos","outputDir":"/abs/photos/_wm","options":{"autoColor":true,"sizeBase":"long","format":"auto","quality":90},"groups":[{"logos":[0],"position":"se","sizePct":25,"marginPct":3}],"skipProcessed":true}'
# → {"jobId":"..."}
```

### A3 轮询任务

```bash
curl -s http://127.0.0.1:28110/api/jobs/<jobId>
# status: running | done | error
# running: total/done/ok/failed（进度逐文件实时更新，700ms 轮询一次足够）
# done:    另有 skipped（跳过的已处理文件数）与 results[]（逐文件 input/output/ok/error）
# 上传模式（mode=upload）可用 GET /api/jobs/:id/file/:idx 逐个下载结果
```

## 3. groups 字段（分组布局）

```json
[{
  "logos": [0, 1],        // prepare 返回的 logos 序号，同一 logo 可进多组
  "position": "se",       // nw|n|ne|w|c|e|sw|s|se（九宫格）
  "sizePct": 25,          // 组合宽 = 大小基准边 × %
  "marginPct": 3,         // 距图片边缘（短边 × %）
  "direction": "h",       // 组内排列 h=横排 v=竖排（单 logo 时可省）
  "gapX": 12, "gapY": 12, // 组内水平/垂直间距（基准 100px 的 %，横排用 gapX、竖排用 gapY）
  "ratios": [1, 0.8],     // 组内逐 logo 相对大小（单 logo 可省）
  "opacity": 80
}]
```

- `options.sizeBase`：`long`（默认，同一相机横/竖构图水印实际像素大小一致）| `short` | `width`
- `options.autoColor`：组内 logo 全部为纯黑白墨时，按每张图水印落点亮度**整组**自动换黑标/白标
- 校验：`logos` 序号越界 → 500；分组数 1..8、每组 logo 数 1..8
- 组内布局语义：先用 ratios/gapX/gapY 在内部拼出组合（ratio=1 → 高(h排)/宽(v排) 100px 基准），
  再整体缩放到 sizePct —— 所以改 ratios 改变的是组内相对大小与组合高宽比，组合总宽恒等于 sizePct

## 4. 任务 B：文件夹监听（新图落盘自动加水印）

```bash
curl -s -X POST http://127.0.0.1:28110/api/watchers \
  -H "Content-Type: application/json" \
  -d '{"inputDir":"/abs/inbox","outputDir":"/abs/inbox/_watched","watermarkId":"<logoSetId>","groups":[{"logos":[0],"position":"se","sizePct":25,"marginPct":3}],"options":{"autoColor":true}}'
```

- `options` 与 process 端点同构（format/quality/sizeBase/autoColor 等全部生效）
- 触发：fs.watch 事件 + 周期扫描（30s）双保险；新图片写入稳定 2s 后处理；`recursive:true` 时子目录同样扫描
- **去重**：本地数据库（路径+mtime+size 身份命中且输出仍在）或非覆盖模式下输出文件已存在 → 跳过；
  输出目录内的文件永不处理（防回环）
- `GET /api/watchers` → 列表（status: watching/paused + stats{processed,skipped,failed} + lastError）
- `POST /api/watchers/:id/rescan` 立即全量扫描；`DELETE /api/watchers/:id` 删除
- 服务重启：监听配置持久化自动恢复；水印映射在内存里失效 → 监听转 `paused`，需重新 prepare 后重建
- 不支持 `overwrite`（监听永远输出新文件）

## 5. 任务 C：单图预览

```bash
curl -s -X POST http://127.0.0.1:28110/api/preview \
  -H "Content-Type: application/json" \
  -d '{"watermarkId":"<id>","orient":"portrait","options":{"autoColor":true,"sizeBase":"long"},"groups":[{"logos":[0],"position":"se","sizePct":30}]}'
# → {"preview":"data:image/jpeg;base64,...","previewAuto":"..."}（autoColor 命中时附暗底预览）
# orient 可选 landscape|portrait（默认 landscape），仅影响示例图方向；预览保持示例图原生分辨率（长边 960），前端点击可放大
```

## 6. CLI 等价命令

```bash
cd app/server
node bin/wm.js prepare logo.png --trim -o wm.png            # 生成透明水印 PNG
node bin/wm.js prepare a.png b.ai --merge --gap 10 -o combined.png   # 多 logo 并排合并
node bin/wm.js apply -w combined.png -i /abs/photos --pos se --size 25 \
  --format auto --quality 90 -o /abs/photos/_wm --recursive
```

CLI 暂不支持分组布局 / 监听 / 数据库去重（这三项走 HTTP API）。

## 7. 其他模式

- `mode=upload`：multipart 附 `files[]`（与 payload 同表单），结果用 `GET /api/jobs/:id/file/:idx` 逐个下载
- `mode=fnos`：飞牛 NAS 内使用，需 `uid` + 已授权目录（开放平台 `trim.file.*`），桌面壳内隐藏该页签
- `mode=local-files`：桌面壳原生对话框的显式文件列表

## 8. Agent 注意事项

- **默认不要用 `overwrite`**：它会直接改写原图片文件（不可恢复）；勾选后强制保持原格式
- `skipProcessed`：配合本地数据库跳过已输出文件（ overwrite 时无效）；「已输出」= 数据库身份命中且输出仍在，或输出文件已存在
- 水印源去底（白底/黑底转透明）在 prepare 阶段完成，`tolerance/bg/force` 可调；透明 PNG 源自动跳过去底
- `.ai` 水印源依赖 PDF 兼容导出，纯 PostScript 旧 AI 需系统 Ghostscript
- 大小基准 `sizeBase=long` 下，组合水印宽度 = 长边 × sizePct%：横/竖构图实际水印大小一致
- 日志：服务 stdout；任务级错误在 job.error / job.results[].error
