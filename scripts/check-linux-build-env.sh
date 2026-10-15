#!/usr/bin/env bash
# cup-translate 构建前置环境自检
#
# 用途：在 Ubuntu 24.04 上构建前，快速确认 §3/§5.2 的兼容层是否就绪。
# 用法：bash scripts/check-linux-build-env.sh
#
# 平台：§2/§3 检查的是 **Linux 专有**的 WebKitGTK 兼容层（见 CLAUDE.md §2 坑 2），
#   在 macOS/Windows 上没有对应物。因此非 Linux 平台会自动跳过这两节，
#   其余各节（基础工具 / wry 版本 / pnpm 放行 / 品牌与上游隔离）在所有平台照常检查。
#   不要把 §2/§3 的缺失当成「环境坏了」——它们只在 Linux 上有意义。
#
# 详见 docs/BUILD.md

set -uo pipefail

pass=0
fail=0
skip=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
skipped() { printf '  \033[90m-\033[0m %s\n' "$1"; skip=$((skip+1)); }

host_os=$(uname -s 2>/dev/null || echo unknown)
is_linux=0
[ "$host_os" = "Linux" ] && is_linux=1

echo "== 0. 平台 =="
if [ "$is_linux" -eq 1 ]; then
  ok "$host_os" "（Linux：§2/§3 的 WebKitGTK 兼容层检查适用）"
else
  warn "$host_os" "（非 Linux：§2/§3 的 Linux 专项检查将跳过）"
fi

echo
echo "== 1. 基础工具 =="
# pkg-config 只服务于 Linux 的 WebKitGTK shim（docs/BUILD.md §3.2），
# macOS/Windows 上构建并不需要它，因此不在这些平台上判为失败。
tools="cargo rustc node pnpm cc cmake"
[ "$is_linux" -eq 1 ] && tools="cargo rustc node pnpm pkg-config cc cmake"
for c in $tools; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "$c: $($c --version 2>&1 | head -1)"
  else
    bad "$c 未安装"
  fi
done
if [ "$is_linux" -eq 0 ]; then
  if command -v pkg-config >/dev/null 2>&1; then
    ok "pkg-config: $(pkg-config --version 2>&1 | head -1)（本平台非必需）"
  else
    skipped "非 Linux 平台，pkg-config 非必需（仅供 WebKitGTK shim）"
  fi
fi

echo
echo "== 2. pkg-config 开发包（§2/§3.2，仅 Linux）=="
if [ "$is_linux" -eq 1 ]; then
  for p in webkit2gtk-4.0 javascriptcoregtk-4.0 javascriptcoregtk-4.1 \
           libsoup-3.0 libsoup-2.4 gtk+-3.0 glib-2.0 x11 xdo; do
    if pkg-config --exists "$p" 2>/dev/null; then
      ok "$p $(pkg-config --modversion "$p")"
    else
      bad "$p 缺失（见 docs/BUILD.md §3.2）"
    fi
  done
else
  skipped "非 Linux 平台，跳过 9 项 pkg-config 检查（这些包仅 Linux 提供）"
fi

echo
echo "== 3. 链接库（§3.3，仅 Linux）=="
if [ "$is_linux" -eq 1 ]; then
  probe_link() {
    # $1 = 库名（不含 -l）
    if cc -x c -o /tmp/_ct_link_probe - -l"$1" 2>/dev/null <<<'int main(void){return 0;}'; then
      ok "-l$1 可链接"
    else
      bad "-l$1 无法链接（见 docs/BUILD.md §3.3）"
    fi
  }
  probe_link webkit2gtk-4.0
  probe_link javascriptcoregtk-4.0
  probe_link xdo
  rm -f /tmp/_ct_link_probe
else
  skipped "非 Linux 平台，跳过 3 项链接检查（WebKitGTK/xdo 仅 Linux 提供）"
fi

echo
echo "== 4. wry 版本（§5.2，必须 >= 0.24.12）=="
if [ -f src-tauri/Cargo.lock ]; then
  wry_ver=$(awk '/^name = "wry"$/{getline; gsub(/[",]/,""); print $3}' src-tauri/Cargo.lock | head -1)
  if [ -z "$wry_ver" ]; then
    warn "未在 Cargo.lock 中找到 wry"
  elif [ "$(printf '%s\n0.24.12\n' "$wry_ver" | sort -V | head -1)" = "0.24.12" ]; then
    ok "wry $wry_ver"
  else
    bad "wry $wry_ver 过旧，请执行：cargo update -p wry --precise 0.24.12"
  fi
else
  warn "未找到 src-tauri/Cargo.lock（请在仓库根目录运行本脚本）"
fi

echo
echo "== 5. 前端构建脚本放行（§4.1）=="
if [ -f pnpm-workspace.yaml ] && grep -q "esbuild" pnpm-workspace.yaml 2>/dev/null; then
  ok "pnpm-workspace.yaml 已放行 esbuild"
else
  bad "pnpm 12 会拦截 esbuild 构建脚本（见 docs/BUILD.md §4.1）"
fi

echo
echo "== 6. 品牌与上游隔离（CLAUDE.md §1/§3）=="
if [ -f src-tauri/tauri.conf.json ]; then
  ident=$(python3 -c "
import json
try: print(json.load(open('src-tauri/tauri.conf.json'))['tauri']['bundle']['identifier'])
except Exception: print('')
" 2>/dev/null)
  case "$ident" in
    com.pot-app.*) bad "identifier 仍是上游的 $ident（会造成品牌混淆与配置串用）" ;;
    "")            warn "无法读取 identifier" ;;
    *)             ok "identifier: $ident" ;;
  esac

  # 更新器不得指向上游发布源
  if grep -q "pot-app.com\|pot-app/pot-desktop" src-tauri/tauri.conf.json 2>/dev/null; then
    bad "tauri.conf.json 仍引用上游更新源（可能覆盖安装他人签名产物）"
  else
    ok "updater 未指向上游发布源"
  fi
else
  warn "未找到 src-tauri/tauri.conf.json"
fi

# 禁用中的上游身份 CI 不应被误开
if [ -f .github/workflows/package.yml ]; then
  if grep -qE 'if: false' .github/workflows/package.yml 2>/dev/null; then
    ok "上游身份发布 job 处于禁用状态"
  else
    warn "package.yml 中未见 disabled 的上游身份 job，请确认 homebrew/winget 已禁用"
  fi
fi

echo
echo "----------------------------------------"
if [ "$fail" -eq 0 ]; then
  if [ "$is_linux" -eq 1 ]; then
    printf '\033[32m全部 %d 项通过，可以开始构建：\033[0m\n' "$pass"
  else
    printf '\033[32m%d 项通过，%d 项跳过（Linux 专项）。\033[0m\n' "$pass" "$skip"
    printf '\033[33m注意：本脚本在 %s 上只覆盖了跨平台项；%s 的构建环境未被本脚本检查。\033[0m\n' \
      "$host_os" "$host_os"
  fi
  echo "  pnpm install --frozen-lockfile && pnpm build"
  if [ "$is_linux" -eq 1 ]; then
    echo "  bash packaging/build-linux.sh deb        # 打包（含幽灵依赖修正）"
  else
    echo "  cd src-tauri && cargo build --release --features custom-protocol"
    echo "  # 需要 Linux 打包时请在 Linux 机器上执行（见 docs/BUILD.md §6）"
  fi
  exit 0
else
  printf '\033[31m%d 项通过，%d 项失败。\033[0m 请对照 docs/BUILD.md 修复。\n' "$pass" "$fail"
  if [ "$is_linux" -eq 0 ]; then
    printf '\033[33m（已跳过 %d 项 Linux 专项检查；上面失败的都是跨平台项）\033[0m\n' "$skip"
  fi
  exit 1
fi