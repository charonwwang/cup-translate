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
| 产物 | `src-tauri/target/release/cup-translate`（约 60MB） | ✅ |
| 打包 .deb | `bash packaging/build-linux.sh deb` | ✅ 32MB |
| 安装 .deb | 用 `packaging/build-linux.sh` 后**零额外依赖**（§6.2） | ✅ 实测可安装启动 |
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
cargo build --release --features custom-protocol    # 首次约 900 个 crate，耗时较长
```

产物：`src-tauri/target/release/cup-translate`

> **⚠️ `--features custom-protocol` 不能省（2026-09-23 实测踩坑，耗时数小时）**
> `Cargo.toml` 的 `[features] custom-protocol = ["tauri/custom-protocol"]` 只有
> `pnpm tauri build` / `pnpm tauri dev` 会按需启用，裸 `cargo build --release` **不会**。
> 缺该 feature 的二进制：Rust 侧一切正常（托盘 / 本地 HTTP / 日志都好），但 webview 加载的
> 是 `devPath`（开发服务器，未运行）——**前端永不执行**：界面空白、`appWindow.show()` 无人调用
> （窗口连 X toplevel 都不显示）、useConfig 默认值不落盘、日志里永远没有 `resolve/reject`。
> 编译期**无任何报错**，症状与「前端代码坏了」完全一致，极难定位。
> 快速自检：启动后触发一次翻译，`grep resolve ~/.config/com.cup-translate.app/logs/cup-translate.log`
> 有输出，才算二进制真正可用。对照数据：缺 feature 时 0 条 JS 日志、配置仅 Rust 写入的十余个键；
> 带 feature 时 `[yandex]resolve:...` 正常出现、前端默认值全部落盘。

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
file target/release/cup-translate       # ELF 64-bit LSB pie executable
ldd  target/release/cup-translate | grep -i "not found"   # 应无输出
./target/release/cup-translate          # 应打印 "============== Start App =============="
```

---

## 6. 打包与安装（.deb / AppImage）

### 6.1 打包（**请用封装脚本**）

```bash
bash packaging/build-linux.sh deb        # 只构建 deb（推荐）
bash packaging/build-linux.sh            # 默认 deb
bash packaging/build-linux.sh appimage   # AppImage
```

该脚本在 `pnpm tauri build` 之后会**自动修掉 .deb 的幽灵依赖**（见 §6.2），
并清理历史品牌的旧产物。若直接用 `pnpm tauri build --bundles deb`，
产出的 .deb 在 Ubuntu 24.04 上**装不上**。

### 6.2 为什么需要封装脚本：`libwebkit2gtk-4.0-37` 是幽灵依赖

Tauri v1 的 CLI 二进制内**硬编码**会把 `libwebkit2gtk-4.0-37` 写入 .deb 的 `Depends`，
**无法通过 `tauri.conf.json` 去掉**（实测：显式列正确依赖后仍被追加）。
而 Ubuntu 24.04 起不再提供该包，于是：

```
$ sudo apt install ./cup-translate_3.0.7_amd64.deb
下列软件包有未满足的依赖关系：
 cup-translate : 依赖: libwebkit2gtk-4.0-37 但无法安装它
```

**但这是"幽灵依赖"——运行期根本不需要它**。实测证据：

```bash
# 二进制的 DT_NEEDED 只有 4.1，没有任何 4.0 引用
$ readelf -d src-tauri/target/release/cup-translate | grep -iE 'NEEDED.*(webkit|javascript)'
 (NEEDED)  Shared library: [libjavascriptcoregtk-4.1.so.0]
 (NEEDED)  Shared library: [libwebkit2gtk-4.1.so.0]
```

4.0 这个名字只在**编译链接期**用到（§3 的 `.pc` shim 与 `-l` 软链），
运行期完全走 4.1。

**因此正确做法是把该依赖从 .deb 中剔除**（`packaging/build-linux.sh` 已自动完成），
而不是让用户额外装一个兼容包。修正后：

```bash
$ sudo apt install ./src-tauri/target/release/bundle/deb/cup-translate_*.deb   # 零额外依赖
$ which cup-translate
/usr/bin/cup-translate
```

> ⚠️ 注意区分：**构建者**仍需要 §3 的 `.so` 软链（链接期），
> 但**使用者**不需要装任何额外包。

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
./cup-translate_3.0.7_amd64.AppImage

# 办法二：不装 FUSE，解压运行
./cup-translate_3.0.7_amd64.AppImage --appimage-extract
./squashfs-root/AppRun
```

### 6.4 实测结论（Ubuntu 24.04, 2025）

| 项目 | 结果 |
|---|---|
| `pnpm tauri build --bundles deb` | ✅ 生成 36MB `.deb` |
| `apt install` 主包（幽灵依赖已剔除） | ✅ 安装成功，无需额外包 |
| 安装后 `pot` 启动 | ✅ 正常（加载配置、创建窗口、托盘、本地 HTTP 服务） |
| `pnpm tauri build --bundles appimage` | ✅ 生成 175MB `.AppImage`（需 `libfuse2` 运行） |

### 6.5 尚未验证的部分

为避免误导，以下内容**未在本项目实测过**，不要当作已完成：

| 项目 | 状态 |
|---|---|
| RPM 系（Fedora/RHEL）打包与依赖 | ❌ `bundle.rpm.depends` 仍是上游原值（Debian 风格包名），多半不正确 |
| CI 流水线 | ❌ 已收敛为仅 `v*` tag 触发，但从未打 tag，**从未真正运行过** |
| Windows / macOS 构建与打包 | ❌ 仅在 Ubuntu 24.04 上验证过 |
| 自动化测试 | ❌ 项目当前**零测试**（见 `CLAUDE.md` §6） |

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