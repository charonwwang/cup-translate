# cup-translate · 构建指南（Linux / Ubuntu 24.04 实测）

> 本文档记录 **从零构建 cup-translate 的完整步骤**，以及上游（Tauri v1 + pot-desktop）
> 在新系统上构建时会踩到的**真实坑**与解决方案。
>
> 实测环境：Ubuntu 24.04 (GNOME)，Node 22+ / pnpm 9+ / Rust stable；2026 年已验证 Linux x86_64 的 `.deb`、`.rpm`、AppImage 构建，AppImage 已隔离启动。Windows/macOS 尚待各自 CI 运行验证。
>
> **平台范围**：本文 §2/§3 的 pkg-config 开发包与 `.so` 软链是 **Linux 专有**的
> WebKitGTK 兼容层，macOS/Windows 上没有对应物。macOS 构建见 §6.6。
>
> **环境自检**：`bash scripts/check-linux-build-env.sh`。该脚本会检测平台——
> 在 Linux 上检查全部 24 项；在 macOS/Windows 上**跳过**上述 Linux 专项检查
> （跳过项不计入失败），只检查跨平台项（基础工具、wry 版本、pnpm 放行、
> 品牌与上游隔离），并在结尾说明「本平台的构建环境未被本脚本检查」。
> 因此**不要**把非 Linux 平台上的跳过项当成环境损坏。

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
| 打包 AppImage | `bash packaging/build-linux.sh appimage` | ✅ 180MB（包含 GStreamer 插件；运行需 `libfuse2`） |

> ⚠️ **重要**：Ubuntu 24.04 上，**§3 与 §5.2 任一缺失都会导致 Rust 构建失败**。
> 这是上游归档后最常见的构建障碍，下文给出根因与修复。

---

## 1. 前置工具

```bash
node -v      # 推荐 Node 22（仓库 .node-version）；本机 Node 24 亦已验证
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
  libssl-dev libsoup2.4-dev pkg-config build-essential cmake file libglib2.0-dev
```

> **包名是 `4.1`，不是 `4.0`**。Ubuntu 24.04 **不再提供** `libwebkit2gtk-4.0-dev`
> （`apt-cache policy libwebkit2gtk-4.0-dev` 无候选版本），只有 4.1 系列。
> 而 Tauri v1.8 依赖的 `webkit2gtk-sys 0.18` 在编译期硬性探测 `webkit2gtk-4.0`
> 和 `-lwebkit2gtk-4.0`，于是产生 §3 的两层冲突。

> **`cmake` 是本地离线翻译（ct2rs / CTranslate2）的构建依赖**：ct2rs 的 build.rs
> 用 cmake + cxx 静态编译内嵌的 CTranslate2 源码。首次构建约 5–15 分钟
> （可设 `CMAKE_PARALLEL=-j <N>` 并行），之后增量构建不受影响。

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

> **⚠️ 同一个坑的第二面（2026-09-23 实测）：`custom-protocol` 在 cargo build 时把 `dist/`
> 整个嵌进二进制**。先 `cargo build` 后 `pnpm build` 的话，运行的仍是**旧前端**
> （实测二进制里是 `index-ZZ7ZGZre.js`，而 `dist/` 已是 `index-qjMwQcBN.js`），
> 且**没有任何报错**。改前端后必须**先 `pnpm build` 再 `cargo build --features custom-protocol`
> 重编**，顺序不能反。日志里的 `assets/index-<hash>.js` 与 `dist/assets/` 下的文件名对不上，
> 就说明二进制嵌的是旧产物。

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
bash packaging/build-linux.sh rpm        # 只构建 rpm
bash packaging/build-linux.sh appimage   # AppImage（需 patchelf）
bash packaging/build-linux.sh all        # 三种格式
```

该脚本在构建 `.deb` 后会**自动修正其 WebKit 运行时依赖**（见 §6.2），
构建 AppImage 时会打包 GStreamer 插件。它不会删除历史产物。若直接用 `pnpm tauri build --bundles deb`，
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

### 6.4 实测结论（Ubuntu 24.04, 2026）

| 项目 | 结果 |
|---|---|
| `.deb` | ✅ 生成约 34MB；依赖已规范化 |
| `.rpm` | ✅ 生成约 38MB；尚未在 RPM 系统上安装验证 |
| AppImage | ✅ 生成约 180MB，内含 GStreamer 插件；已在隔离 X11 中启动 |

### 6.5 尚未验证的部分

为避免误导，以下内容**未在本项目实测过**，不要当作已完成：

| 项目 | 状态 |
|---|---|
| RPM 系（Fedora/RHEL）安装与依赖 | ❌ 已打包，但尚未在 Fedora/RHEL 上安装验证 |
| CI 流水线 | ❌ 已收敛为仅 `v*` tag 触发，但从未打 tag，**从未真正运行过** |
| Windows 构建与打包 | ❌ 仅在 Ubuntu 24.04 上验证过 |
| macOS 构建与打包 | ✅ **2026-10 在 Apple Silicon Mac mini (M6, macOS 27) 实测**：见 §6.6 |
| 自动化测试 | ✅ 已加入前端资源、截图几何与 Rust 边界测试；跨系统 GUI 验收仍需补齐 |


---

## 6.6 macOS（Apple Silicon）构建实测（2026-10, M6 Mac mini / macOS 27）

### 6.6.1 前置工具（与 Linux 不同）

```bash
brew install cmake     # ct2rs/sentencepiece 的 build.rs 需要 cmake，缺失报 `is 'cmake' not installed?`
rustup default stable  # 仅装 rustup 不装工具链时报 missing manifest，需要 `rustup default stable`
```

macOS 自带 Xcode Command Line Tools（clang/make），无 WebKitGTK 兼容层问题；`ct2rs`
仍会静态编译内嵌 CTranslate2 源码，首次构建较慢（实测增量构建约 1 分钟）。

### 6.6.2 标准命令

```bash
pnpm install --frozen-lockfile
pnpm build
cd src-tauri && cargo build --release --features custom-protocol   # 产物约 55MB arm64
pnpm tauri build -b dmg                                             # 或 pnpm tauri build -b app
```

- `.app` 打包正常：`src-tauri/target/release/bundle/macos/cup-translate.app`，
  `Contents/Resources/resources/ocr-{aarch64,x86_64}-apple-darwin`（macOS OCR helper）正确入包，
  与 `system_ocr.rs::resolve_resource("resources/ocr-<arch>-apple-darwin")` 路径一致。
- `.dmg` 打包在 Finder 装饰步骤需要向 Finder 发 AppleScript：在无 GUI 会话/无
  「自动化-控制 Finder」授权的机器上会报 `Finder 遇到一个错误：AppleEvent 已超时 (-1712)`
  并退出（**非编译问题**，直接 `open cup-translate.app` 即可运行；`tauri.conf.json`
  已写死 `bundle.dmg` 的窗口/图标布局，CI 上的 macOS runner 可正常产出 `.dmg`）。

### 6.6.3 macOS 上踩到的坑（已修复）

| # | 坑 | 现状 | 回退会怎样 |
|---|---|---|---|
| 1 | `cmake` 缺失导致 ct2rs 构建失败 | 已装 cmake 并写入 §6.6.1 | `sentencepiece-sys` build.rs panic |
| 2 | `bundle.dmg` 未写布局 → dmg 装饰布局随主机默认值漂移 | `tauri.conf.json` 显式声明 app/Applications 位置与窗口尺寸 | dmg 窗口布局不可复现 |
| 3 | macOS bundle 资源必须在 `resources/` 目录 | `tauri.macos.conf.json` 用 `resources/*`，已加回归测试 | system_ocr 找不到 helper 二进制 |

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

### macOS 本地开发包

使用 `pnpm package:macos:local` 构建 `.app` 并执行本地 ad-hoc 签名校验。
脚本仅清理生成包中的 FinderInfo/ResourceFork 元数据，不清除隔离等安全属性。
单独运行 `pnpm tauri build --bundles app` 后，也可运行 `bash packaging/sign-macos-local.sh`。
本地签名不等同于 Developer ID 签名/公证，系统授权在重编译后的持续性仍需验证。

### macOS DMG 与公开更新发布

运行 `pnpm package:macos:dmg` 可生成本机架构的 DMG。标准“拖入 Applications”布局由 `dmgbuild` 写入 `.DS_Store`，背景图为 `packaging/dmg-background.png`；本地未安装 `dmgbuild` 时会回退到普通布局。安装方式：

```bash
python3 -m venv .venv-dmg
.venv-dmg/bin/pip install dmgbuild
DMGBUILD=.venv-dmg/bin/dmgbuild pnpm package:macos:dmg
```

双架构 GitHub Release、更新签名校验、公开下载仓库及 Apple 证书配置见 [MACOS_RELEASE.md](MACOS_RELEASE.md)。无 Apple Developer 账号时使用 ad-hoc 签名；这不等同于 Developer ID 或 Apple 公证。


### 2026-10-21 · 3.0.12 全平台发布构建

统一入口为 `.github/workflows/release-desktop.yml`，版本取稳定 `v*` 标签，发布前同步 package.json、Cargo.toml、Cargo.lock 和 Tauri 配置。macOS 两个架构、Windows 三个架构、Linux x64/ARM64 全部成功后才发布安装包及签名更新清单。

Piper/eSpeak 构建需要 CMake、C/C++ 和 libclang；Linux 容器显式安装 clang/libclang-dev，Node 依构建宿主选择 x64/ARM64。Linux ARM64 发布使用 `ubuntu-24.04-arm` 原生宿主，避免构建词典时尝试在 x64 执行 ARM64 的 eSpeak 工具。Windows 设置 `ESPEAK_STATIC_CRT=1`，与仓库 MSVC 静态 CRT 保持一致。macOS 及 Windows x64、原生 Linux 宿主在打包后运行 Rust 回归；跨架构 Windows 包不在 x64 宿主执行。

macOS 使用 ad-hoc 签名和经过校验的 Tauri 更新签名，Developer ID/公证仍需独立证书配置。Linux ARM64 当前没有自动更新条目，使用 deb/rpm 安装包升级。CI 构建成功不等同于其他平台已完成真实桌面划词、截图或全部模型的人工验收。


eSpeak NG 默认 POSIX 数据目录缓冲只有 160 字节。显式 `--target` 的干净 CI 构建会在 `compiledata.c` 拼接音素源文件名时截断路径；`.cargo/config.toml` 通过上游支持的 `N_PATH_HOME=4096` 编译宏同时扩大宿主工具与内嵌音素引擎的目录容量。自定义 `CFLAGS` 时请保留此宏。


3.0.12 新增的 llama.cpp C++ bridge 使用 `std::filesystem`，Intel Mac 不能继续采用 Tauri 隐含的 macOS 10.13 编译下限。`bundle.macOS.minimumSystemVersion` 与发布 job 的 `MACOSX_DEPLOYMENT_TARGET` 同设为 `10.15`，覆盖应用编译和独立 Rust 测试；Apple Silicon 本身至少 macOS 11，Piper 的单独 ONNX Runtime 仍要求 macOS 14+。Kokoro 内嵌 universal 运行库的 Intel 最低版本由 Mach-O 检查确认为 10.15（ONNX）/10.14（sherpa），应用统一取更高下限。


Windows x64 的最后链接还需要 llama.cpp 与 CTranslate2 共用静态 CRT。`llama-cpp-sys-2` 的 `LLAMA_STATIC_CRT` 默认关闭，即使 Rust 已启用 `+crt-static`，其 CMake 产物仍可能使用 `/MD` 并触发 `LNK2038`/`LNK2005`。仓库 `.cargo/config.toml` 为全部本地及 CI 命令同时设置 `LLAMA_STATIC_CRT=1`、`ESPEAK_STATIC_CRT=1`，与 CTranslate2、sentencepiece 和 Rust 保持 `/MT` 一致；保留两个模型系列，不用禁用后端规避链接问题。


仅 `LLAMA_STATIC_CRT=1` 还不足以覆盖 llama.cpp 的 `CMP0091=NEW`：cmake-rs 仅向编译器传 `/MT`，现代 Visual Studio 生成器仍可能用默认目标属性 `/MD` 覆盖。另设 `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`，由 llama-cpp-sys 的 CMAKE_ 环境转发写入所有目标。发布流程增加 Windows C++ 链接预检：一个候选 CMake 库与强制静态 CRT 的参考可执行文件实际编译、链接并执行；预检失败时不启动七个平台的大型构建。该属性及默认行为见 [CMake 官方文档](https://cmake.org/cmake/help/latest/variable/CMAKE_MSVC_RUNTIME_LIBRARY.html)。
