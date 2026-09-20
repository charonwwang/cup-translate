#!/usr/bin/env bash
# 构建 libwebkit2gtk-4.0-37 兼容包（Ubuntu 24.04+）
#
# 背景
# ----
# Ubuntu 24.04 起不再提供 WebKitGTK 4.0（只有 4.1）。
# 但 Tauri v1 打包出的 .deb 会硬编码声明依赖 `libwebkit2gtk-4.0-37`，
# 导致 `apt install ./pot_*.deb` 直接失败：
#
#     pot : 依赖: libwebkit2gtk-4.0-37 但无法安装它
#
# Tauri v1 无法通过 tauri.conf.json 去掉该默认依赖（实测：显式 depends
# 仍会被追加），因此提供一个"满足依赖声明 + 提供 4.0 名字软链"的空壳兼容包。
#
# 该包只做两件事：
#   1. 声明 Provides: libwebkit2gtk-4.0-37，让 apt 认为依赖已满足
#   2. 放入 libwebkit2gtk-4.0.so / libjavascriptcoregtk-4.0.so 软链，
#      指向系统实际存在的 4.1 共享库
#
# 用法
# ----
#     bash packaging/build-webkit-compat-deb.sh
#     sudo dpkg -i packaging/out/libwebkit2gtk-4.0-37_*_amd64.deb
#
# 详见 docs/BUILD.md §7

set -euo pipefail

LIBDIR="/usr/lib/x86_64-linux-gnu"
OUT="$(cd "$(dirname "$0")" && pwd)/out"

echo "== 探测已安装的 WebKitGTK 4.1 共享库版本 =="
webkit_real="$(basename "$(readlink -f "$LIBDIR/libwebkit2gtk-4.1.so.0")")"
jsc_real="$(basename "$(readlink -f "$LIBDIR/libjavascriptcoregtk-4.1.so.0")")"

if [ -z "$webkit_real" ] || [ ! -e "$LIBDIR/$webkit_real" ]; then
  echo "错误：未找到 libwebkit2gtk-4.1.so.0，请先安装 libwebkit2gtk-4.1-0" >&2
  exit 1
fi
if [ -z "$jsc_real" ] || [ ! -e "$LIBDIR/$jsc_real" ]; then
  echo "错误：未找到 libjavascriptcoregtk-4.1.so.0" >&2
  exit 1
fi
echo "  libwebkit2gtk      -> $webkit_real"
echo "  libjavascriptcore  -> $jsc_real"

# 取 4.1 包的实际版本号，让兼容包版本与系统一致，便于 apt 比较
ver="$(dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || echo '0')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/DEBIAN" "$work$LIBDIR"

cat > "$work/DEBIAN/control" <<EOF
Package: libwebkit2gtk-4.0-37
Version: ${ver}+cup1
Section: libs
Priority: optional
Architecture: amd64
Provides: libwebkit2gtk-4.0-37
Depends: libwebkit2gtk-4.1-0, libjavascriptcoregtk-4.1-0
Maintainer: cup-translate <charonwwang@users.noreply.github.com>
Description: WebKitGTK 4.0 ABI compatibility layer for Ubuntu 24.04+ (cup-translate)
 Ubuntu 24.04 and later no longer ship WebKitGTK 4.0, but Tauri v1
 application packages still declare a dependency on libwebkit2gtk-4.0-37.
 This compatibility package satisfies that dependency and installs
 libwebkit2gtk-4.0.so / libjavascriptcoregtk-4.0.so symlinks pointing at
 the installed 4.1 libraries. It contains no code of its own.
EOF

ln -sf "$webkit_real" "$work$LIBDIR/libwebkit2gtk-4.0.so"
ln -sf "$jsc_real"    "$work$LIBDIR/libjavascriptcoregtk-4.0.so"

mkdir -p "$OUT"
deb="$OUT/libwebkit2gtk-4.0-37_${ver}+cup1_amd64.deb"
dpkg-deb --build --root-owner-group "$work" "$deb" >/dev/null

echo
echo "== 已生成 =="
echo "  $deb"
echo
echo "安装： sudo dpkg -i '$deb'"