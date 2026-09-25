# ImgMark 批量图片水印

Node.js 批量图片水印工具：**AI / SVG / PNG / JPG 水印源，白底或黑底自动去底转透明 PNG**，支持九宫格定位 / 平铺 / 透明度 / 旋转 / 缩放，一键批量合成到整个文件夹。文件夹来源支持 **飞牛 fnOS 开放平台文件授权**（最新 `trim.file.*` API）、本地路径、直接上传三种方式；可打包为 fnOS 应用（fpk）。

## 功能

- **水印源格式**：`.ai`（PDF 兼容模式，pdfjs 渲染，可选 Ghostscript 兜底）、`.svg`、`.png`、`.jpg/.jpeg`、`.webp`、`.bmp`、`.gif`、`.tif/.tiff`、`.avif`
- **自动去底**：边缘像素中位数识别底色（白/黑），洪泛填充只清除与边缘连通的背景（保护 logo 内部同色内容），羽化 + 去色染消除白边/黑边；容差可调，也可强制白底/黑底
- **水印裁剪**：① 手动框选——预览图上拖拽画框，只保留选中区域（百分比坐标，AI/SVG 渲染缩放无关）；② 自动去边——按内容包围盒裁掉四周空白（AI 大画板、logo 白边场景）。先裁剪再去底，裁剪区边缘的白底仍会被正常去除
- **多 logo 并排**：水印文件可多选，各 logo 独立去底/去边后水平拼排成一个组合水印（默认等高对齐、间距滑杆 0-100% 可调，0=紧贴排列），后续定位/平铺/批量照常使用；CLI 用 `-w` 重复传参或 `prepare --merge`
- **水印样式**：九宫格定位（nw…se）、大小（占宽 %）、不透明度、边距、平铺 + 间距、旋转、EXIF 自动摆正
- **批量处理**：目录递归、并发池、保持原格式（或强制 PNG/JPEG/WebP）、默认输出到 `<目录>/_watermarked/` 子目录（可选覆盖原图）
- **三种图片来源**：
  - 🐮 **飞牛授权目录**——在 fnOS 应用内通过 `pickUserFile` / `pickSharedFile`（JS SDK）选目录即授权，后端用 `getUserAccessibleFolders` / `getSharedAccessibleFolders` 查询、`checkUserACL` 鉴权、`convertPath` 显示语义化路径
  - 📁 **本地路径**——服务器上任意绝对路径
  - 📤 **上传图片**——浏览器直接上传，处理后逐个下载
- **CLI**：不启服务直接批量处理
- **fnOS 应用打包**：manifest / 生命周期脚本 / api-scope / 设置向导 / 图标 / fnpack 脚本 / GitHub Actions 全套

## 快速开始

### npm 安装（CLI / Web 服务，任何机器）

```bash
npm i -g imgmark          # 全局安装（含 sharp 等原生依赖）
imgmark apply -w logo.png -i ./photos --pos se --recursive   # CLI 批量加水印
imgmark serve             # 启动 Web 界面 http://127.0.0.1:28110
```

程序化调用：`require('imgmark')` 返回 `prepareWatermark` / `composeWatermark` / `mergeWatermarks` / `runBatch`。fnOS 应用打包见下文（fpk 内也走同一套代码）。

### 本地开发运行（Windows / Linux / macOS）

```bash
cd app/server
npm install
npm start          # http://127.0.0.1:28110
```

非 fnOS 环境自动降级：「飞牛授权目录」页签不可用，用「本地路径」或「上传图片」即可。

### Windows 桌面壳（Electron）

`desktop/` 目录提供 Windows 壳（参考 CreditDaddy 模式）：双击即用，自动拉起内嵌服务（28110 被占用自动换端口，已有 imgmark 实例则复用），并通过 preload 桥接**原生文件/文件夹对话框**——比网页版 `<input type=file>` 强：多选图片返回真实路径（本地文件批量不经过上传）、选文件夹、按扩展名过滤水印源。

```bash
cd desktop && npm install && npm run dev    # 开发
npm run dist                                # 打包 → dist/ImgMark-Setup-*.exe / ImgMark-Portable-*.exe
```

CI 推 `v*` tag 时自动产出 **Windows**（`ImgMark-Setup-*.exe` 安装版 / `ImgMark-Portable-*.exe` 便携版）与 **macOS**（`ImgMark-mac-arm64-*.dmg` Apple Silicon / `ImgMark-mac-x64-*.dmg` Intel）桌面安装包并附到 Release。macOS 包未做代码签名：首次打开需**右键 → 打开**，或执行 `xattr -cr /Applications/ImgMark.app`。前端检测到 `window.imgmarkDesktop` 后自动启用：水印文件选择走原生对话框、「上传图片」变为本地文件路径直处理、「本地路径」页签出现「选择文件夹」按钮；纯浏览器环境自动降级为原有行为。

### 打包为 fnOS 应用（fpk）

要求系统 ≥ **1.2.0401**、应用中心版本 ≥ **1.34.0**（`trim.file.*` 开放能力要求）。

```bash
# 在 NAS 本机或任意 Linux（x86）上：
./scripts/build-fpk.sh x86
# 产物：imgmark-<版本>-x86.fpk → 应用中心「手动安装」
# CI 推 v* tag 会自动产出三个变体：
#   imgmark-<版本>-x86-window.fpk      桌面窗口入口（推荐，新版 fnOS，全功能）
#   imgmark-<版本>-x86-fullscreen.fpk  全屏/新标签页入口（全功能）
#   imgmark-<版本>-x86-compat.fpk      兼容旧版应用中心（不含 micro_app/api-scope；
#                                      飞牛授权目录标签不可用，用本地路径/上传）
```

安装要点（照搬 deepseek-harness-fnos 已验证的模式）：

- `manifest` 声明 `install_dep_apps = nodejs_v24`（Node 运行时）、`micro_app = true`（启用 JS SDK 必需）
- `config/resource` 声明 `api-scope`：`trim.file.userAccess` / `trim.file.sharedAccess` / `trim.file.userAcl` / `trim.file.path` / `trim.system.getPlatformConfig`
- 服务端口 28110（`TRIM_SERVICE_PORT` 可覆盖），数据目录 `TRIM_PKGVAR`
- 访问：桌面图标（iframe 直连 `127.0.0.1:28110`）或 `http://<NAS_IP>:28110`
- node_modules 是平台相关二进制，**必须在 Linux 上安装**后再打包（脚本已处理；ARM 用 `./scripts/build-fpk.sh arm`）
- GitHub Actions：`.github/workflows/build-fpk.yml`——推送 `v*` tag（如 `v0.2.2`）自动打 x86 fpk 并发布到 [Releases](https://github.com/techysy/imgmark/releases)，也可 workflow_dispatch 手动触发；ARM 包需在 aarch64 环境跑 `scripts/build-fpk.sh arm`

### 在 fnOS 里使用飞牛授权目录

1. 打开应用 → 「图片来源」→「飞牛授权目录」
2. 点「**＋ 选择并授权目录**」：
   - **个人目录**（所有用户可用）：调 `pickUserFile({directory:true})`，用户选中即完成 ACL 授权
   - **共享目录**（仅管理员）：调 `pickSharedFile`，授权给整个应用
3. 授权列表由后端 `trim.file.getUserAccessibleFolders(uid)` / `getSharedAccessibleFolders()` 查询，路径用 `trim.file.convertPath` 转成语义化展示（如 `存储空间1/admin 的文件/photo`）
4. 浏览选择图片目录（后端先 `trim.file.checkUserACL(uid, path)` 校验读写权限）→ 开始处理
5. 结果写入该目录下的 `_watermarked` 子目录（应用用户经授权具备 ACL，直接读写真实路径，无需上传下载）

> 独立浏览器（非 fnOS 桌面 iframe）打开时，授权弹窗需要 fnOS 宿主路由，请在 fnOS 桌面内完成授权；此前授权过的目录在独立浏览器里仍可查看和使用。
> 用户 UID 默认 1000（fnOS 首个用户），可在页面上修改；后端所有 `trim.file.*` 查询均按该 uid 执行。

## CLI 用法

```bash
cd app/server

# 多个 logo 并排合并成一个透明 PNG
node bin/wm.js prepare brand.png partner.ai --merge -o combined.png --gap 10

# 批量加水印（水印源自动先转透明 PNG；-w 可重复 = 多 logo 并排）
node bin/wm.js apply -w brand.png -w partner.png -i /vol1/1000/photos \
  --pos se --size 20 --opacity 80 --margin 3 --recursive \
  --format auto --quality 90 -o /vol1/1000/photos/_watermarked

# 常用参数
#   --pos nw|n|ne|w|c|e|sw|s|se   位置（默认 se）
#   --tile --tile-gap 10          平铺 + 间距%
#   --rotate 30                   水印旋转角度
#   --crop "55,55,40,40"          裁剪水印源：x,y 起 w×h（百分比，先裁剪再去底）
#                                 多 logo 用分号逐个指定，空段=不裁："55,55,40,40;;30,30,70,70"
#   --trim                        自动裁掉水印源边缘空白
#   --overwrite                   覆盖原图（危险；此时强制保持原格式）
#   --bg auto|white|black --tolerance N --force   去底参数
#   --concurrency 3 --suffix _wm
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/prepare` | multipart `watermark`（可多个，并排合并）+ `bg/tolerance/force/maxSize/trim/crop("x,y,w,h"百分比，仅单文件)/gap/equalHeight` → 透明 PNG（返回 id、预览 dataURL、`logoCount`、单文件时附 `sourcePreview`/`sourceWidth`/`sourceHeight`/`cropApplied`） |
| POST | `/api/preview` | `{watermarkId, options}` → 内置示例图的合成预览 |
| POST | `/api/process` | multipart：`payload`(JSON) + 可选 `files[]`；`mode=local/fnos/upload` → `{jobId}` |
| GET | `/api/jobs/:id` | 任务进度与逐文件结果 |
| GET | `/api/jobs/:id/file/:idx` | 上传模式的单文件下载 |
| POST | `/api/browse` | 本地模式目录浏览 |
| GET | `/api/fnos/status` | fnOS 开放 API 可用性 + 平台配置 |
| GET | `/api/fnos/folders?uid=` | 已授权目录（个人+共享，含语义化路径） |
| POST | `/api/fnos/list` | `{uid, path}`：ACL 校验后列目录（图片计数） |
| POST | `/api/fnos/delete-authorization` | 删除授权目录 |

`options` 字段：`position, sizePct, opacity, marginPct, offsetX, offsetY, rotate, tile, tileGapPct, format(auto|png|jpeg|webp), quality`

## 架构

```
watermark-app/
├── manifest / VERSION / ICON.PNG / ICON_256.PNG   ← fpk 清单与图标
├── app/
│   ├── ui/config + images/                        ← fnOS 桌面入口（iframe :28110）
│   └── server/                                    ← Node 应用（唯一 package.json）
│       ├── bin/wm.js                              ← CLI
│       └── src/
│           ├── server.js                          ← Express + multer + 任务/水印状态
│           ├── core/transparency.js               ← 底色识别/洪泛去底/羽化去色染
│           ├── core/watermark.js                  ← prepareWatermark / composeWatermark
│           ├── core/batch.js                      ← 目录扫描 + 并发池 + 进度
│           ├── formats/ai.js                      ← .ai → PNG（pdfjs-dist + @napi-rs/canvas，gs 兜底）
│           ├── fnos/trimapp.js                    ← 开放平台后端 API 客户端（Unix Socket）
│           ├── fnos/routes.js                     ← /api/fnos/*
│           └── public/                            ← 单页前端（app.js/css + callback.html）
├── cmd/                                           ← main / install / upgrade / uninstall / config 回调
├── config/resource（api-scope）/ privilege
├── wizard/config                                  ← fnOS 应用设置页表单
└── scripts/                                       ← make-icons / smoke-test / build-fpk
```

**fnOS 后端 API 调用约定**（`src/fnos/trimapp.js` 已封装）：`POST /api/v1/trimapp` over Unix Socket `/var/run/trim_open_gateway_apiscope.socket`，`Authorization: Bearer ${TRIM_API_TOKEN}`（系统注入 `cmd/main` 环境，每次现读不落盘），请求体 `{reqId, req, appName, data}` → `{code, msg, data}`。

## 已知限制

- Web 界面无鉴权，属局域网工具，请勿直接暴露公网（如需远程建议走 FN Connect 域名 + fnOS 侧访问控制）
- `.ai` 依赖「创建 PDF 兼容文件」导出；纯 PostScript 旧版 AI 需系统安装 Ghostscript（`gs`/`gswin64c`）
- 目录授权为单选（fnOS 平台限制）；文件授权结果不进目录列表，仅目录授权可被后端查询
- 独立浏览器打开时无法发起新授权（需 fnOS 宿主环境），但已授权目录可正常使用
- 服务重启后已上传的水印需重新选择（水印 PNG 缓存在临时目录，进程内持有映射）

## 测试

```bash
node scripts/smoke-test.js    # fixtures 生成 → 去底/合成/批量/CLI/HTTP 全链路 11 项断言
```

## License

MIT
