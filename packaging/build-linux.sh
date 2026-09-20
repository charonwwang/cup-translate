#!/usr/bin/env bash
# 打包 cup-translate 的 Linux 产物，并修正 .deb 的幽灵依赖
#
# 为什么需要这个脚本
# ----------------
# Tauri v1 的 CLI 二进制内**硬编码**会把 `libwebkit2gtk-4.0-37` 写入 .deb 的 Depends，
# 无法通过 tauri.conf.json 去掉（已在 Ubuntu 24.04 实测确认）。
#
# 但实测证明这是**幽灵依赖**：
#   - 二进制的 ELF DT_NEEDED 只有 libwebkit2gtk-4.1.so.0 / libjavascriptcoregtk-4.1.so.0
#   - 全二进制内不含任何对 4.0 的引用（readelf -d 无 4.0）
#   - 4.0 这个名字仅在**编译链接期**（pkg-config + -l 软链）用到，运行期完全不需要
#
# 而 Ubuntu 24.04 起已不提供 libwebkit2gtk-4.0-37，于是 `apt install ./x.deb` 必然失败。
#
# 本脚本在构建后重写 control 文件，去掉该幽灵依赖，
# **让用户不需要额外安装任何兼容包**。
#
# 用法
# ----
#     bash packaging/build-linux.sh              # 构建 deb + appimage 并修正
#     bash packaging/build-linux.sh deb          # 只构建 deb
#
# 详见 docs/BUILD.md §6

set -euo pipefail

BUNDLE="${BUNDLE:-deb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 要从 Depends 中剔除的幽灵依赖（运行期无人需要）
PHANTOM_DEPS=(
  "libwebkit2gtk-4.0-37"
  "libjavascriptcoregtk-4.0-0"
)

echo "== 1/3 构建前端与 Tauri 产物 (bundles: $BUNDLE) =="
pnpm tauri build --bundles "$BUNDLE"

DEB_DIR="$ROOT/src-tauri/target/release/bundle/deb"

# 清理历史品牌的旧产物，避免脚本处理到过期文件
if [ -d "$DEB_DIR" ]; then
  stale=( "$DEB_DIR"/pot_*.deb )
  if [ -e "${stale[0]}" ]; then
    echo "清理旧品牌产物: ${stale[*]##*/}"
    rm -f "$DEB_DIR"/pot_*.deb
  fi
fi

shopt -s nullglob
debs=("$DEB_DIR"/*.deb)
shopt -u nullglob

if [ "${#debs[@]}" -eq 0 ]; then
  echo "错误：未找到 .deb 产物（bundles 是否包含 deb？）" >&2
  exit 1
fi

echo
echo "== 2/3 修正 .deb 幽灵依赖 =="
fixed=0
for deb in "${debs[@]}"; do
  echo "-- 处理 $(basename "$deb")"

  work="$(mktemp -d)"
  dpkg-deb -R "$deb" "$work"

  ctrl="$work/DEBIAN/control"
  before="$(grep '^Depends:' "$ctrl" || true)"

  # 逐项过滤 Depends 中的幽灵依赖
  # 注意：set -e 下必须用 `|| rc=$?` 捕获，否则非 0 退出会直接中止脚本
  rc=0
  python3 - "$ctrl" "${PHANTOM_DEPS[@]}" <<'PY' || rc=$?
import re, sys
path, *phantoms = sys.argv[1:]
lines = open(path, encoding='utf-8').read().splitlines()
out = []
changed = False
for ln in lines:
    if ln.startswith('Depends:'):
        items = [x.strip() for x in ln[len('Depends:'):].split(',') if x.strip()]
        kept = [x for x in items if x not in phantoms]
        # 去重，保持顺序
        seen, uniq = set(), []
        for k in kept:
            if k not in seen:
                seen.add(k); uniq.append(k)
        if kept != items or uniq != items:
            changed = True
        out.append('Depends: ' + ', '.join(uniq))
    else:
        out.append(ln)
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
sys.exit(0 if changed else 3)
PY
  if [ "$rc" -eq 3 ]; then
    echo "   （Depends 干净，无需修改）"
    rm -rf "$work"
    continue
  elif [ "$rc" -ne 0 ]; then
    echo "   错误：control 文件处理失败 (rc=$rc)" >&2
    rm -rf "$work"
    exit 1
  fi

  after="$(grep '^Depends:' "$ctrl" || true)"
  echo "   修改前: $before"
  echo "   修改后: $after"

  # 重新打包（保持原文件名，便于脚本引用）
  dpkg-deb --build --root-owner-group "$work" "$deb" >/dev/null
  rm -rf "$work"
  fixed=$((fixed+1))
done

echo
echo "== 3/3 校验 =="
for deb in "${debs[@]}"; do
  echo "-- $(basename "$deb")"
  echo "   Depends: $(dpkg-deb -f "$deb" Depends)"
  if dpkg-deb -f "$deb" Depends | grep -q 'webkit2gtk-4.0'; then
    echo "   ✗ 仍含幽灵依赖，修正失败"
    exit 1
  else
    echo "   ✓ 幽灵依赖已移除"
  fi
done

echo
echo "模拟安装检查（应无未满足依赖）："
apt-get install -s --no-install-recommends "${debs[0]}" 2>&1 | tail -5

echo
echo "完成。产物："
ls -lh "${debs[@]}"