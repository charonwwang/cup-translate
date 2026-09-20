# cup-translate · 构建指南（Linux / Ubuntu 24.04 实测）

> 本文档记录 **从零构建 cup-translate 的完整步骤**，以及上游（Tauri v1 + pot-desktop）
> 在新系统上构建时会踩到的**真实坑**与解决方案。
>
> 实测环境：Ubuntu 24.04 (GNOME)，Node 24 / pnpm 12 / Rust 1.95，**2025 年实测全流程通过**。

---

## 0. 结论速览

| 步骤 | 命令 | 状态 |
|---|---|---|
| 系统依赖 | `apt-get install ...`（§2） | ✅ |
| WebKitGTK 4.0 兼容层 | `.pc` shim（§3.2） | ✅ **必需** |
| 链接库兼容软链 | `libwebkit2gtk-4.0.so`（§3.3） | ✅ **必需** |
| wry 版本 | 0.24.12（§5.2） | ✅ **必需** |
| pkg-config `xdo.pc` | shim（§3.2） | ✅ **必需** |
| 前端依赖 | `pnpm install --frozen-lockfile` | ✅ |
| 前端构建 | `pnpm build` | ✅ |
| Rust 构建 | `cargo build --release` | ✅ |
| 产物 | `src-tauri/target/release/pot`（约 60MB） | ✅ |
| 打包 .deb | `pnpm tauri build --bundles deb` | ✅ 36MB |
| 安装 .deb | 需先装兼容包（§6.2） | ✅ 实测可安装启动 |
| 打包 AppImage | `pnpm tauri build --bundles appimage` | ✅ 175MB（运行需 `libfuse2`） |

> ⚠️ **重要**：Ubuntu 24.04 上，**§3 与 §5.2 任一缺失都会导致 Rust 构建失败**。
> 这是上游归档后最常见的构建障碍，下文给出根因与修复。

---

## 1. 前置工具

```bash
node -v      # 需要 >= 18（仓库 .node-version 写 21，实测 Node 24 亦可）
pnpm -v      # 需要 >= 8（pnpm 12 已验证）
rustup show  # 需要 stable，实测 1.95
```

---

## 2. 安装系统依赖（Ubuntu 24.04）

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
  libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev libsoup2.4-dev pkg-config build-essential file libglib2.0-dev
```

> **包名是 `4.1`，不是 `4.0`**。Ubuntu 24.04 **不再提供** `libwebkit2gtk-4.0-dev`
> （`apt-cache policy libwebkit2gtk-4.0-dev` 无候选版本），只有 4.1 系列。
> 而 Tauri v1.8 依赖的 `webkit2gtk-sys 0.18` 在编译期硬性探测 `webkit2gtk-4.0`
> 和 `-lwebkit2gtk-4.0`，于是产生 §3 的两层冲突。

---

## 3. WebKitGTK 4.0 → 4.1 兼容层

### 3.1 问题根源（两层，缺一不可）

| 层次 | 组件期望 | Ubuntu 24.04 实际 |
|---|---|---|
| **编译期**（pkg-config） | `webkit2gtk-4.0` / `javascriptcoregtk-4.0` | ❌ 只有 `-4.1` |
| **链接期**（`-l` flag） | `-lwebkit2gtk-4.0` / `-ljavascriptcoregtk-4.0` | ❌ 只有 `-4.1` |
| **编译期**（libxdo） | `xdo.pc` | ❌ `libxdo-dev` **不含** 该文件 |

只做 pkg-config shim 会在**链接阶段**失败：

```
rust-lld: error: unable to find library -lwebkit2gtk-4.0
rust-lld: error: unable to find library -ljavascriptcoregtk-4.0
collect2: error: ld returned 1 exit status
```

只做软链会在**编译阶段**失败：

```
The system library `webkit2gtk-4.0` required by crate `webkit2gtk-sys` was not found.
```

### 3.2 编译期：pkg-config shim

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

# libxdo-dev 不带 xdo.pc，手动补一个（selection crate 依赖）
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

### 3.3 链接期：4.0 软链指向 4.1 实库

`webkit2gtk-sys` 的 `build.rs`（`system_deps` 生成）会输出
`cargo:rustc-link-lib=webkit2gtk-4.0`，即链接器实际要找 `libwebkit2gtk-4.0.so`。
既然系统只有 4.1，就做同名软链指向 4.1：

```bash
cd /usr/lib/x86_64-linux-gnu

# 用实际存在的 4.1 版本号（ls libwebkit2gtk-4.1.so.0.* 查看）
sudo ln -sf libwebkit2gtk-4.1.so.0.21.10       libwebkit2gtk-4.0.so
sudo ln -sf libjavascriptcoregtk-4.1.so.0.10.14 libjavascriptcoregtk-4.0.so

sudo ldconfig
```

验证：

```bash
# 1) 编译期
for p in webkit2gtk-4.0 javascriptcoregtk-4.0 xdo libsoup-2.4; do
  printf '%-24s ' "$p"; pkg-config --exists "$p" && pkg-config --modversion "$p" || echo MISSING
done

# 2) 链接期
echo 'int main(){return 0;}' > /tmp/t.c
cc /tmp/t.c -o /tmp/t.out -lwebkit2gtk-4.0 && echo "LINK OK"
```

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

`esbuild` 的 postinstall 必须执行（vite 依赖它）。仓库已通过 `pnpm-workspace.yaml` 放行：

```yaml
allowBuilds:
  esbuild: true
  tesseract.js: true
```

若仍被拦，执行一次 `pnpm approve-builds --all`。

---

## 5. Rust / Tauri

```bash
cd src-tauri
cargo build --release       # 首次约 900 个 crate，耗时较长
```

产物：`src-tauri/target/release/pot`

### 5.1 开发模式 / 打包

```bash
pnpm tauri dev
pnpm tauri build
```

### 5.2 ⚠️ wry 必须为 0.24.12（关键）

**症状**：编译 `wry` 时报 7 个 `E0599`：

```
error[E0599]: no method named `set_enable_webgl` found for struct `webkit2gtk::Settings`
  help: trait `SettingsExt` which provides `set_enable_webgl` is implemented but not in scope;
        perhaps you want to import it: use webkit2gtk::SettingsExt;
```

**原因**：`wry 0.24.11` 的 `src/webview/webkitgtk/mod.rs` 用
`use webkit2gtk::{traits::*, ...}` 导入 trait，但在 `webkit2gtk 0.18.2` 中
这个 glob 无法把 `SettingsExt` 等带入作用域。上游在 **0.24.12** 改为从 crate 根
显式导入（`SettingsExt, WebViewExt, URIRequestExt, ...`），问题即消失。

**修复**（本仓库已提交，`Cargo.lock` 已锁定 0.24.12）：

```bash
cd src-tauri
cargo update -p wry --precise 0.24.12
```

> `tauri-runtime-wry 0.14.10` 依赖 `wry ^0.24`，因此 0.24.12 是**语义兼容**升级。

### 5.3 验证构建产物

```bash
file target/release/pot            # ELF 64-bit LSB pie executable
ldd  target/release/pot | grep -i "not found"   # 应无输出
./target/release/pot               # 应打印 "============== Start App =============="
```

---

## 6. 打包与安装（.deb / AppImage）

### 6.1 打包

```bash
pnpm tauri build --bundles deb        # src-tauri/target/release/bundle/deb/
pnpm tauri build --bundles appimage   # src-tauri/target/release/bundle/appimage/
pnpm tauri build                      # 全部（targets: "all"）
```

### 6.2 ⚠️ .deb 在 Ubuntu 24.04 上**无法直接安装**

Tauri v1 打包时**硬编码**加入依赖 `libwebkit2gtk-4.0-37`。该包在 24.04 不存在，
因此直接安装会失败：

```
$ sudo apt install ./pot_3.0.7_amd64.deb
下列软件包有未满足的依赖关系：
 pot : 依赖: libwebkit2gtk-4.0-37 但无法安装它
```

**实测确认**：即使已在 `tauri.conf.json` 的 `bundle.deb.depends` 中显式列出正确依赖，
Tauri v1 仍会**追加**该默认依赖，无法通过配置去掉（24.04 实测）。

**解决方案**：构建并安装一个"空壳兼容包"，它只做两件事——
声明 `Provides: libwebkit2gtk-4.0-37`，并放入指向 4.1 实库的 `4.0` 名字软链。

```bash
# 1) 生成兼容包（脚本会自动探测系统 4.1 库的实际版本号）
bash packaging/build-webkit-compat-deb.sh

# 2) 安装兼容包（满足依赖声明）
sudo dpkg -i packaging/out/libwebkit2gtk-4.0-37_*_amd64.deb

# 3) 现在可以正常安装
sudo apt install ./src-tauri/target/release/bundle/deb/pot_*.deb
```

安装后：

```bash
which pot                                   # /usr/bin/pot
ls /usr/share/applications/pot.desktop      # 桌面项已就绪
pot                                         # 启动
```

### 6.3 AppImage 需要 libfuse2

24.04 默认未装 `libfuse2`，直接运行会报：

```
dlopen(): error loading libfuse.so.2
AppImages require FUSE to run.
```

两种办法：

```bash
# 办法一：装 FUSE
sudo apt install libfuse2
./pot_3.0.7_amd64.AppImage

# 办法二：不装 FUSE，解压运行
./pot_3.0.7_amd64.AppImage --appimage-extract
./squashfs-root/AppRun
```

### 6.4 实测结论（Ubuntu 24.04, 2025）

| 项目 | 结果 |
|---|---|
| `pnpm tauri build --bundles deb` | ✅ 生成 36MB `.deb` |
| `dpkg -i` 兼容包 + `apt install` 主包 | ✅ 安装成功 |
| 安装后 `pot` 启动 | ✅ 正常（加载配置、创建窗口、托盘、本地 HTTP 服务） |
| `pnpm tauri build --bundles appimage` | ✅ 生成 175MB `.AppImage`（需 `libfuse2` 运行） |

---

## 7. 常见问题速查

| 现象 | 原因 | 解决 |
|---|---|---|
| `system library webkit2gtk-4.0 was not found` | 24.04 无 4.0 开发包 | §3.2 |
| `rust-lld: unable to find library -lwebkit2gtk-4.0` | 缺 4.0 软链 | §3.3 |
| `xdo.pc not found` / `selection` 构建失败 | `libxdo-dev` 不含 `.pc` | §3.2 |
| `E0599 no method named set_enable_webgl` | wry 0.24.11 的 traits 导入失效 | §5.2 |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 12 拦截脚本 | §4.1 |
| `libsoup-2.4` 缺失 | 未装 dev 包 | `apt install libsoup2.4-dev` |
| `apt install` 报 `libwebkit2gtk-4.0-37` 无法安装 | Tauri v1 硬编码依赖 | §6.2 |
| AppImage 报 `libfuse.so.2` 加载失败 | 未装 FUSE | §6.3 |
| cargo 拉取超时 / 404 | 镜像索引问题 | 附录 A |

---

## 附录 A：国内镜像配置

`~/.cargo/config.toml`（**建议用 sparse 协议**，git 协议索引偶发 404）：

```toml
[source.crates-io]
replace-with = 'ustc'

[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"

[net]
retry = 3
```

---

> 本文档随构建链路变化同步更新。遇到新坑请直接补进 §6。☕