# cup-translate · 构建指南（Linux / Ubuntu 24.04 实测）

> 本文档记录 **从零构建 cup-translate 的完整步骤**，以及上游（Tauri v1 + pot-desktop）
> 在新系统上构建时会踩到的**真实坑**与解决方案。
>
> 实测环境：Ubuntu 24.04 (GNOME, X11)，Node 24 / pnpm 12 / Rust 1.95，2025 年实测通过。

---

## 0. 结论速览

| 步骤 | 命令 | 状态 |
|---|---|---|
| 系统依赖 | `apt-get install ...`（见 §2） | ✅ |
| pkg-config 兼容层 | 3 个 `.pc` shim（见 §3） | ✅ 必需 |
| 前端依赖 | `pnpm install --frozen-lockfile` | ✅ |
| 前端构建 | `pnpm build` | ✅ |
| Rust 构建 | `cargo build --release` | ✅ |
| 产物 | `src-tauri/target/release/pot` | ✅ |

> ⚠️ **关键**：在 Ubuntu 24.04 上，**不装 §3 的 pkg-config shim 则 Rust 构建必定失败**。
> 原因见下文——这是上游归档后最常见、也最劝退的构建障碍。

---

## 1. 前置工具

```bash
# Node（仓库 .node-version 写的是 21；实测 Node 24 亦可）
node -v      # 需要 >= 18
pnpm -v      # 需要 >= 8（pnpm 12 已验证）

# Rust
rustup show  # 需要 stable，实测 1.95
```

> 若使用国内镜像加速（可选）：
> - cargo 源：`~/.cargo/config.toml` 里 `replace-with = 'ustc'`（见附录 A）
> - npm 源：`npm_config_registry=https://registry.npmmirror.com`

---

## 2. 安装系统依赖（Ubuntu 24.04）

Tauri v1 在 Linux 上需要 WebKitGTK / GTK / libsoup 等开发包：

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
  libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev libsoup2.4-dev pkg-config build-essential file libglib2.0-dev
```

> **注意包名是 `4.1`，不是 `4.0`**。Ubuntu 24.04 已经**不再提供** `libwebkit2gtk-4.0-dev`
> （`apt-cache policy libwebkit2gtk-4.0-dev` 查不到候选版本），只有 4.1 系列。
> 但 Tauri v1.8 依赖的 `webkit2gtk-sys 0.18` 在编译期**硬性探测 `webkit2gtk-4.0`**，
> 于是产生 §3 的冲突。

自检：

```bash
for p in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0 glib-2.0 x11 openssl; do
  printf '%-24s ' "$p"; pkg-config --exists "$p" && pkg-config --modversion "$p" || echo MISSING
done
```

---

## 3. pkg-config 兼容 shim（**必需**）

### 3.1 问题根源

| 组件 | 期望的 pkg-config 名 | Ubuntu 24.04 实际 |
|---|---|---|
| `webkit2gtk-sys 0.18` | `webkit2gtk-4.0` | ❌ 只有 `webkit2gtk-4.1` |
| `javascriptcoregtk` | `javascriptcoregtk-4.0` | ❌ 只有 `-4.1` |
| `selection` / `libxdo` | `xdo.pc` | ❌ `libxdo-dev` **不含** `xdo.pc` |

`webkit2gtk-sys/build.rs` 由 `system_deps` 生成，探测失败即 `process::exit(1)`——
报错通常是：

```
The system library `webkit2gtk-4.0` required by crate `webkit2gtk-sys` was not found.
```

### 3.2 解决：提供 4.0 名字、指向 4.1 实库

在系统 pkg-config 搜索路径（`/usr/local/lib/x86_64-linux-gnu/pkgconfig`）放三个 `.pc`：

```bash
sudo mkdir -p /usr/local/lib/x86_64-linux-gnu/pkgconfig
cd /usr/local/lib/x86_64-linux-gnu/pkgconfig

sudo tee webkit2gtk-4.0.pc >/dev/null <<'EOF'
prefix=/usr
exec_prefix=${prefix}
libdir=/usr/lib/x86_64-linux-gnu
includedir=${prefix}/include
Name: WebKitGTK
Description: Web content engine for GTK (4.0 compat shim -> 4.1)
Version: 2.52.6
Requires: glib-2.0 gtk+-3.0 libsoup-3.0 javascriptcoregtk-4.1
Libs: -L${libdir} -lwebkit2gtk-4.1
Cflags: -I${includedir}/webkitgtk-4.1
EOF

sudo tee javascriptcoregtk-4.0.pc >/dev/null <<'EOF'
prefix=/usr
exec_prefix=${prefix}
libdir=/usr/lib/x86_64-linux-gnu
includedir=${prefix}/include
Name: JavaScriptCoreGTK+
Description: JavaScriptCore engine (4.0 compat shim -> 4.1)
Version: 2.52.6
Requires: glib-2.0 gobject-2.0
Libs: -L${libdir} -ljavascriptcoregtk-4.1
Cflags: -I${includedir}/webkitgtk-4.1
EOF

# libxdo-dev 不带 xdo.pc，手动补一个
sudo tee xdo.pc >/dev/null <<'EOF'
prefix=/usr
exec_prefix=${prefix}
libdir=/usr/lib/x86_64-linux-gnu
includedir=${prefix}/include
Name: xdo
Description: libxdo bindings (compat shim for missing upstream xdo.pc)
Version: 3.20160805.1
Requires: x11
Libs: -L${libdir} -lxdo
Cflags: -I${includedir}
EOF
```

验证：

```bash
for p in webkit2gtk-4.0 javascriptcoregtk-4.0 xdo libsoup-2.4; do
  printf '%-24s ' "$p"; pkg-config --exists "$p" && pkg-config --modversion "$p" || echo MISSING
done
```

> 若 `webkit2gtk-4.0` 能打印版本号，即可继续。

---

## 4. 前端

```bash
cd cup-translate
pnpm install --frozen-lockfile
pnpm build          # 产物在 dist/
```

### 4.1 pnpm 12 的 build script 拦截

pnpm 12+ **默认禁止依赖执行 postinstall**，直接报：

```
ERR_PNPM_IGNORED_BUILDS
  Ignored build scripts: esbuild@0.21.5, tesseract.js@5.1.1
```

`esbuild` 的 postinstall 必须执行（vite 依赖它），否则 `pnpm build` 失败。仓库已通过
`pnpm-workspace.yaml` 声明放行：

```yaml
allowBuilds:
  esbuild: true
  tesseract.js: true
```

若仍被拦，执行一次：

```bash
pnpm approve-builds --all
```

---

## 5. Rust / Tauri

```bash
cd src-tauri
cargo build --release
```

首次编译较久（~900 个 crate）。产物：

```
src-tauri/target/release/pot
```

> 二进制名仍是上游的 `pot`（见 `src-tauri/Cargo.toml` 的 `[package] name`），
> 品牌改名工作在 Roadmap M1 处理。

### 5.1 开发模式

```bash
pnpm tauri dev
```

### 5.2 打包

```bash
pnpm tauri build
```

---

## 6. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `system library webkit2gtk-4.0 was not found` | 24.04 无 4.0 开发包 | §3 shim |
| `xdo.pc not found` / `selection` 构建失败 | `libxdo-dev` 不含 `.pc` | §3 的 `xdo.pc` |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 12 拦截脚本 | §4.1 |
| `libsoup-2.4` 缺失 | 未装 dev 包 | `apt install libsoup2.4-dev` |
| cargo 拉取超时 | 网络 | 配 USTC 镜像（附录 A） |

---

## 附录 A：国内镜像配置

`~/.cargo/config.toml`：

```toml
[source.crates-io]
replace-with = 'ustc'

[source.ustc]
registry = "https://mirrors.ustc.edu.cn/crates.io-index"

[net]
retry = 3
```

npm 已在环境变量层面指向 `registry.npmmirror.com`。

---

> 本文档随构建链路变化同步更新。遇到新坑请直接补进 §6。☕