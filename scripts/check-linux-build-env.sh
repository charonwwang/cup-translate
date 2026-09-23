#!/usr/bin/env bash
# cup-translate 构建前置环境自检
#
# 用途：在 Ubuntu 24.04 上构建前，快速确认 §3/§5.2 的兼容层是否就绪。
# 用法：bash scripts/check-linux-build-env.sh
#
# 详见 docs/BUILD.md

set -uo pipefail

pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "== 1. 基础工具 =="
for c in cargo rustc node pnpm pkg-config cc cmake; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "$c: $($c --version 2>&1 | head -1)"
  else
    bad "$c 未安装"
  fi
done

echo
echo "== 2. pkg-config 开发包（§2/§3.2）=="
for p in webkit2gtk-4.0 javascriptcoregtk-4.0 javascriptcoregtk-4.1 \
         libsoup-3.0 libsoup-2.4 gtk+-3.0 glib-2.0 x11 xdo; do
  if pkg-config --exists "$p" 2>/dev/null; then
    ok "$p $(pkg-config --modversion "$p")"
  else
    bad "$p 缺失（见 docs/BUILD.md §3.2）"
  fi
done

echo
echo "== 3. 链接库（§3.3）=="
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
  printf '\033[32m全部 %d 项通过，可以开始构建：\033[0m\n' "$pass"
  echo "  pnpm install --frozen-lockfile && pnpm build"
  echo "  bash packaging/build-linux.sh deb        # 打包（含幽灵依赖修正）"
  exit 0
else
  printf '\033[31m%d 项通过，%d 项失败。\033[0m 请对照 docs/BUILD.md 修复。\n' "$pass" "$fail"
  exit 1
fi