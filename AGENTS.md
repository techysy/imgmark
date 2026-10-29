# ImgMark Agent 操作手册

面向 AI Agent（ZCode / Claude / Codex / OpenCode 等）**直接操作 ImgMark** 的完整说明。
ImgMark = HTTP 服务（默认 `http://127.0.0.1:28110`）+ CLI（`node bin/wm.js`）+ Electron 桌面壳。
本文所有 curl 示例与当前实现逐一核对过，可直接复制执行。

## 0. 启动与健康检查

```bash
# 已有实例则直接用：
curl -s http://127.0.0.1:28110/api/health
# → {"ok":true,"app":"imgmark","dataDir":"..."}

# 没有实例就起一个（Node ≥ 20.9，首次需 npm install）：
cd app/server && npm install && npm start
# 端口占用：PORT=28120 npm start；fnOS 使用平台端口并经 app.sock 网关转发
```

无鉴权，默认只监听 `127.0.0.1`；fnOS 通过 `app.sock` 网关访问。非回环绑定需同时设置 `HOST` 和 `IMGMARK_ALLOW_REMOTE=1`，只用于受信任网络，**不要暴露公网或不可信网络**。

- 上传水印/方案：单文件最多 4 MB，请求体最多 128 MB；图片上传：单文件最多 22 MB、每批最多 10 张、请求体最多 256 MB
- 单张导出：单文件最多 22 MB、请求体最多 64 MB、同时最多 2 路
- 同时最多处理 2 个批量任务；每个任务最多 4 路并发；每位 fnOS 用户最多创建 16 个监听，服务端总数最多 64 个
- 解码上限：目标图最多 50,000,000 像素；水印源最多 40,000,000 像素；PDF/AI 栅格化长边最多 4,000 像素

## 1. 约定

- 所有响应均为 JSON；出错 → 非 2xx + `{"error":"中文原因"}`（HTTP 400/404/500）
- prepare 产物缓存在服务进程内存 + 临时目录：**服务重启后 watermarkId 失效**，需重新 POST `/api/prepare`
- 图片格式：jpg/jpeg/png/webp/bmp/gif/tif/tiff/avif；水印源额外支持 ai（PDF 兼容模式）/ svg
  （BMP 由内置编解码器处理：RLE 压缩 BMP 不支持；`.tif` 在 format=auto 时输出为 `.tiff`）
- 处理默认**不覆盖原图**，输出到输出目录下 `原文件名_wm.原扩展名`（`suffix` 可改）；
  同批/同一监听内输出重名（如 a.jpg、a.png 都强制输出 JPEG）时后者为 `原文件名(2)_wm.扩展名`
- `options.mozjpeg=true`：JPEG 体积小约 10-15%，但编码慢约 5 倍；默认 false（libjpeg-turbo）
- `GET /api/exif-fields`：相机参数水印的可选字段清单（key/label/示例值），前端据此渲染勾选项
- `GET /api/fonts`：本机**确实装了**的字体清单（family/label/kind/note）。librsvg 找不到字体会
  悄悄回落默认字体（不报错、也不画空白），所以服务端逐个渲染一次探针串、按像素指纹与
  「一个不存在的字体名」比对来判定 —— 清单里不会给出装了等于没装的选项。
  `text.fontFamily` 与 `options.frame.fontFamily` 都只认这份清单里的名字，其余回落 `sans-serif`
- 裁剪比例支持方向前缀：`land@5:4` 只对横图生效、`port@4:5` 只对竖图生效，
  不带前缀（`4:5`、`1:1`）两个方向都裁 —— 老方案里存的就是这种，行为与旧版一致
- 裁剪取景 `options.cropAnchor`：`smart`（默认，亮度方差保细节）| `center`（居中取景，
  合照等主体分散的场景用 —— 亮度方差容易偏向一侧把人裁掉）
- 裁剪在**加水印之前**生效：水印（logo / 相机参数文字 / 边框）按裁剪后的最终画面定位，预览与输出一致；
  智能选区在无水印的原图上分析；带裁剪时整条管线只编码一次（旧版「先叠标再裁」已废弃）
- **无水印纯导出**：`groups`/`watermarkId`/`frame` 都不给，只配 `cropRatio` / `maxLongEdge` /
  `format`（非 auto）之一即可跑批量或单张导出（`exportOnly:true` 显式声明也行）；
  三样都没配才是 400（等于原样复制）。用途：批量裁剪 / 缩放 / 转格式，不叠任何水印

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

### 相机参数文字水印（group 的另一种形态）

把 `text` 给上，这一组就不叠 logo，改叠**该图自己的 EXIF** 文字（相机/镜头/曝光/日期）。
`text` 组不需要 logo 集，所以 `watermarkId` 可以整个不给 —— 即「只加相机参数、不加水印图」。

```json
[{
  "text": {
    "enabled": true,
    "fields": ["camera", "lens", "exposure", "date"],  // 见 GET /api/exif-fields
    "color": "#ffffff",       // #rrggbb
    "fontFamily": "Microsoft YaHei",  // 可选，见 GET /api/fonts；未装则回落 sans-serif
    "fontWeight": "bold",     // bold | normal
    "separator": " · ",       // 默认 " · "
    "prefix": "shot on ",     // 可选，≤40 字
    "suffix": ""              // 可选，≤40 字
  },
  "position": "se", "sizePct": 30, "marginPct": 3, "opacity": 90,
  "autoColor": true           // 按落点明暗自动换黑/白字
}]
```

- 字段可选：`camera`（机身）`lens`（镜头）`exposure`（焦距光圈快门 ISO）`date` `datetime`
  `brand` `model` `software`；顺序即拼接顺序，取不到的字段**静默跳过**不留空占位
- **没有 EXIF 的照片会自动跳过这一组**：原图字节不动（不重编码，不掉画质），不是画一行空白
- `date` 与 `datetime` 同时勾选时只输出 `datetime`（避免同一时间出现两遍）
- 文字渲染依赖系统字体；服务启动时会自检并在日志里警告（字体缺失时 libvips 不报错、只画空白）
- `fontFamily`：`text` 组与 `options.frame` 共用同一个字段（画框把字写进留白时也是它）。
  名字不在 `GET /api/fonts` 的清单里就回落 `sans-serif`；**没装的字体不会画空白**，
  librsvg 会回落默认字体，看起来只是「选了没变化」
- **边框 / 条幅**（`options.frame`）：把参数写进**新撑出来的留白**，而不是浮在画面上 ——
  这是它与上面「文字组」的本质区别（文字是 composite 到图上，边框是先改画布尺寸）。
  因此边框必须在合成前生效：它会撑大画布，随后 logo / 文字水印的位置全部按「照片那块矩形」换算，
  不会落进留白里。三种版式：
  ```json
  "frame": { "style": "band|frame|inset",   // 下方条幅 / 四周白框 / 装裱细线框
             "lines": ["主行", "副行"],        // 留空 → 用该图 EXIF 自动填（机型 / 曝光）
             "bg": "#ffffff", "color": "#111111", "subColor": "#8a93a0",
             "align": "left|center",
             "padPct": 0.045, "bottomPct": 0.10 }   // 可选，覆盖预设比例（相对短边）
  ```
  留白比例跟着**短边**走，所以横竖构图的观感一致。`options.frame` 存在**全局 options** 里
  （不在某个 group 上），且**套边框不改变输出格式**（format=auto 的 JPEG 仍是 JPEG）。
  没有 EXIF 且两行都留空时整张跳过边框（不留一条空白），显式给了字则照加；
- 引擎可独立使用：`node -e "require('./src/core/exiftext').formatCameraText(exif, {fields:['camera']})"`

- `options.sizeBase`：`long`（默认，同一相机横/竖构图水印实际像素大小一致）| `short` | `width`
- `options.maxLongEdge`：输出长边上限（像素）。超过的图在**裁剪后**等比缩小（只缩不放，
  水印随画面一起缩），EXIF/ICC 保留；留空/0 保持原始尺寸。没超限的图原样返回，不重编码
- `options.autoColor`：组内 logo 全部为纯黑白墨时，按每张图水印落点亮度**整组**自动换黑标/白标；
  文字组没有备用变体，改为按同套字段换个墨色再渲一遍
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
- **绑定方案**：请求带 `presetId` 时，分组与选项整套装自该方案，logo 原文件从数据目录现场重新准备 ——
  服务重启后监听**自动恢复**（方案落盘在 DATA_DIR/presets），不再转 `paused`；
  不传 `presetId` 的旧形式（watermarkId/groups）行为不变
- 服务重启：监听配置持久化自动恢复；仅 watermarkId 形式的旧监听因水印映射在内存里失效转 `paused`，需重新 prepare 后重建
- 不支持 `overwrite`（监听永远输出新文件）

## 5. 任务 C：单图预览

```bash
curl -s -X POST http://127.0.0.1:28110/api/preview \
  -H "Content-Type: application/json" \
  -d '{"watermarkId":"<id>","orient":"portrait","options":{"autoColor":true,"sizeBase":"long"},"groups":[{"logos":[0],"position":"se","sizePct":30}]}'
# → {"preview":"data:image/jpeg;base64,...","previewAuto":"..."}（autoColor 命中时附暗底预览）
# orient 可选 landscape|portrait（默认 landscape），仅影响示例图方向；预览保持示例图原生分辨率（长边 960），前端点击可放大
```

## 6. 任务 D：单张导出（一张图 → 立即回传成图）

批量之外的单次用法：`/api/process` 那一套解析与合成原样复用，只是不建任务、不落盘，
响应直接就是成图字节（`Content-Disposition` 已带 `原名_wm.扩展名`，`curl -OJ` 即可存盘）。
适合「调完样式先拿一张真图确认效果」——注意文字组/边框用的是**这张图自己的 EXIF**。

```bash
curl -s -OJ -X POST http://127.0.0.1:28110/api/render \
  -F 'file=@/abs/one.jpg' \
  -F 'payload={"watermarkId":"<logoSetId>","groups":[{"logos":[0],"position":"se","sizePct":25}],"options":{"format":"auto","cropRatio":"16:9","maxLongEdge":1600}}'
# → 图片字节；响应头 X-ImgMark-Name: one_wm.jpg（URL 编码，fetch 用 decodeURIComponent 取）
#   X-ImgMark-Skipped: 1 表示这张图没画上任何东西（如没有 EXIF 的照片只要边框）→ 画面原样返回
```

- 表单字段：图片 `file`（单个，≤22 MB）、配置 `payload`（JSON，同 `/api/process` 的 `watermarkId`/`groups`/`options`）
- 只走分组管线（`groups` + `options.frame`）；**不支持**单/合并水印的老路径（`watermarkId` 单独给会报 400）
- 既没有分组也没有边框 → 400；引用了不存在/已失效的 logo 集 → 404
- 出错仍是 JSON（`{"error":"中文原因"}`）——只有成功时才是图片字节，用 `-f`/`-OJ` 才能把错误存成文件

## 7. 任务 E：文案生成（发布页签）

```bash
# 模型服务配置（OpenAI 兼容；密钥只写不回读，也可用环境变量 IMGMARK_LLM_BASE_URL / IMGMARK_LLM_API_KEY）
curl -s -X PUT http://127.0.0.1:28110/api/copy/config \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"http://127.0.0.1:20127/v1","apiKey":"sk-...","model":"mimo/mimo-v2.6-flash"}'

curl -s http://127.0.0.1:28110/api/copy/models     # 视觉模型清单（只列 vision 能力）
curl -s http://127.0.0.1:28110/api/copy/platforms  # 平台与默认文案规则

# 历史截图参考（可选；存储于数据目录，最多 3 张参与生成）
curl -s -X POST http://127.0.0.1:28110/api/copy/refs -F "file=@ref.png" -F "name=过往截图"

# 生成：待发布图片（可多张组图，image 字段重复传，最多 9 张）+ 平台 + 一句话场景
curl -s -X POST http://127.0.0.1:28110/api/copy/generate \
  -F "image=@one.jpg" -F "image=@two.jpg" \
  -F 'payload={"platform":"instagram","scene":"PNS 在成都 CPI 开快闪店，我去打卡拍照","model":"mimo/mimo-v2.6-flash","refIds":["<refId>"]}'
# → {"platform","model","imageCount","titles":[...],"body":"...","hashtags":[...],"mentions":[...]}
```

- `platform` 取值见 `GET /api/copy/platforms`（`instagram` / `xiaohongshu`）；`refIds` 可省略
- 只产出文字供人工复制，**不代发**；`mentions` 只会原样输出场景描述里明确写过的 @ 账号

## 8. 任务 F：选图打分（JPG 无损内嵌评星 / 非 JPG 写入 XMP sidecar）

给文件夹里的图片评 1-5 星并打问题标记（曝光过度/曝光不足/虚焦/快门过慢）：
- **JPG / JPEG 文件直接无损内嵌写入文件头部 XMP**（0 画质损耗，毫秒级注入），Windows 资源管理器、Lightroom、Bridge 原生直接显示“分级”星级，无需产生任何 .xmp 碎文件；
- **非 JPG 格式（如 RAW）**自动写入每张图旁的**同名 `.xmp` sidecar**；
- LR 的旗标不落 XMP：1 星自动附「淘汰」关键词。
评星以人工在 UI 里确认为准。

```bash
curl -s -X POST http://127.0.0.1:28110/api/cull -H "Content-Type: application/json" \
  -d '{"inputDir":"/abs/photos","writeXmp":true}'
# → {"jobId":"..."}；用 GET /api/jobs/<jobId> 轮询（job.kind='cull'）
# done 后 results[] 逐文件 {name,input,rating,flags[],xmp}

# 手动改一张图的星级 / 追加关键词（JPG 直接无损内嵌更新，非 JPG 写 sidecar）
curl -s -X POST http://127.0.0.1:28110/api/cull/set -H "Content-Type: application/json" \
  -d '{"file":"/abs/photos/IMG_001.jpg","rating":4,"labels":["备选"]}'

# 手动快速打星（UI「快速打星」网格用的两个接口）
curl -s "http://127.0.0.1:28110/api/cull/list?dir=/abs/photos&recursive=1"  # 16路并发快速扫头部128KB列图+星级
curl -s -o t.jpg "http://127.0.0.1:28110/api/cull/thumb?file=/abs/photos/IMG_001.jpg&size=big"
# thumb：420px 网格缩略图（size=big → 1600px 全屏预览），按 路径+尺寸+mtime+大小 磁盘缓存（原图被替换自动失效）
```

- `writeXmp:false` 只回传结果不落盘；`recursive:true` 含子目录
- 已存在元数据或 sidecar 时**安全合并**：星级替换、用户关键词并集；本工具词表的旧标记先剥再并，不破坏原有属性；
  JPG 内嵌成功会删掉同名 sidecar（其内容已并入内嵌 XMP，不丢）；0 星 = 未分级（xmp:Rating="0"）
- `rating:0` 同样可写（取消打星）；`labels` 只增不删（本工具词表词随星级走）
- UI：选图页快速打星（缩略图网格 + 全屏预览，点缩略图进全屏，← → 切换、1-5 打星、0 取消）；
  自动预评分入口已从 UI 移除，仅保留 API / CLI 形式
- CLI：`node bin/wm.js cull -i <目录> [--recursive] [--no-xmp]`

## 9. CLI 等价命令

```bash
cd app/server
node bin/wm.js prepare logo.png --trim -o wm.png            # 生成透明水印 PNG
node bin/wm.js prepare a.png b.ai --merge --gap 10 -o combined.png   # 多 logo 并排合并
node bin/wm.js apply -w combined.png -i /abs/photos --pos se --size 25 \
  --format auto --quality 90 -o /abs/photos/_wm --recursive
```

CLI 暂不支持分组布局 / 监听 / 数据库去重 / 输出裁剪 cropRatio / 输出缩放 maxLongEdge（这些走 HTTP API；
CLI 的 `--crop` 是水印源裁剪，别混淆；选图打分另见第 8 节 `wm.js cull`）。

## 10. 其他模式

- `mode=upload`：multipart 附 `files[]`（与 payload 同表单），结果用 `GET /api/jobs/:id/file/:idx` 逐个下载
- `mode=fnos`：飞牛 NAS 内使用，UID 由应用网关注入 `x-trim-userid`（请求 payload/query 的 UID 不可信），输入和输出路径都必须位于当前用户可读/可写的授权目录（开放平台 `trim.file.*`），桌面壳内隐藏该页签
- `mode=local-files`：桌面壳原生对话框的显式文件列表

## 11. Agent 注意事项

- **默认不要用 `overwrite`**：它会直接改写原图片文件（不可恢复）；勾选后强制保持原格式
- `skipProcessed`：配合本地数据库跳过已输出文件（ overwrite 时无效）；「已输出」= 数据库身份命中且输出仍在，或输出文件已存在
- 水印源去底（白底/黑底转透明）在 prepare 阶段完成，`tolerance/bg/force` 可调；透明 PNG 源自动跳过去底
- `.ai` 水印源依赖 PDF 兼容导出，纯 PostScript 旧 AI 需系统 Ghostscript
- 大小基准 `sizeBase=long` 下，组合水印宽度 = 长边 × sizePct%：横/竖构图实际水印大小一致
- 日志：服务 stdout；任务级错误在 job.error / job.results[].error
