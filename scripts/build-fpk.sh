#!/usr/bin/env bash
# ImgMark fpk 打包脚本 —— 需在目标架构的 Linux 环境（NAS 本机 / WSL / CI）运行，
# 因为 sharp / @napi-rs/canvas 是平台相关二进制，node_modules 必须在 Linux 上安装。
#
# 用法：./scripts/build-fpk.sh [x86|arm]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
ARCH="${1:-x86}"
FNPACK_VERSION=1.2.1
FNPACK_URL="https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-linux-amd64"
[ "$ARCH" = "arm" ] && FNPACK_URL="https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-linux-arm64"

VERSION=$(tr -d ' \n' < VERSION)
sed -i "s/^platform.*/platform              = ${ARCH}/" manifest
sed -i "s/^version.*/version               = ${VERSION}/" manifest

echo "==> 安装依赖（Linux ${ARCH}，二进制随平台解析）"
cd app/server
rm -f package-lock.json
npm install --omit=dev --no-audit --no-fund
cd "$ROOT"

echo "==> 下载 fnpack ${FNPACK_VERSION}"
[ -f fnpack ] || curl -fsSL "$FNPACK_URL" -o fnpack
chmod +x fnpack

echo "==> 清理 symlink（fnpack 不支持）"
find . -type l -not -path './node_modules/*' -delete 2>/dev/null || true

echo "==> 打包"
./fnpack build -d .
FPK="imgmark-${VERSION}-${ARCH}.fpk"
mv imgmark.fpk "$FPK" 2>/dev/null || mv $(ls *.fpk | head -1) "$FPK"
echo "==> 完成：$ROOT/$FPK"
echo "    应用中心「手动安装」：把 fpk 放到扫描目录（如 /vol1/1000/fnOS App/fpk/imgmark/）"
