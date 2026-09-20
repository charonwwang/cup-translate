# ☕ cup-translate

> **社区维护的轻量划词翻译工具 / Community-maintained lightweight selection-translate tool**

> **重要声明 / Important notice**
>
> 本项目为 **`pot-app/pot-desktop` 的社区续版（社区 fork）**。
> 原项目 **pot-app/pot-desktop**（[官方仓库](https://github.com/pot-app/pot-desktop)）已 **归档（archived）并停止开发**，
> 本仓库从其上 fork 而来，作为 **后续独立维护的版本**，继续演进。
>
> This is a **community continuation fork** of the now-archived
> **pot-app/pot-desktop** (GPL-3.0). The original maintainer has stopped
> development; this repository picks up maintenance going forward.

---

## 定位 / Positioning

**一句话：把「鼠标选中一段文本 → 弹出翻译」这一件事做到极致、轻快、无感。**

与「全能型」原厂（翻译+OCR+TTS+生词本全都要）不同，cup-translate 聚焦并打磨
**「划词翻译」这一核心闭环**，并在 **Linux / Wayland** 上作为一等公民做到最好，
其余能力（OCR / TTS / 生词本）作为**默认关闭、按需开启**的可选能力保留，避免臃肿。

### 核心理念

- **选中即译**：不打断阅读、不抢焦点、弹窗无感自动出现 & 自动消失。
- **跨应用**：浏览器、终端、编辑器、PDF 阅读器……一套覆盖，不限单应用。
- **Wayland 优先**：专门攻坚纯 Wayland（GNOME/KDE/Hyprland）下的划词与热键。
- **轻量**：默认只保留划词翻译 + 剪贴板监听两条「主打」链路。

---

## 功能（来自上游，保留并继续演进）

- 跨平台：Windows / macOS / Linux（含 Wayland）
- 划词翻译 · 输入翻译 · 剪贴板监听翻译
- 多翻译引擎并行（内置 30+，可插件扩展）
- 截图 OCR / 截图翻译（Linux 默认离线 Tesseract）
- 语音合成 TTS、生词本导出（Anki / 欧路 / 有道 / 扇贝）
- 本机 HTTP 服务（外部程序可通过 `curl` 调用）

> 关于 Wayland 的已知限制与规避方案，见上游原文档（`UPSTREAM_README.md`）。
> 划词、OCR、热键在纯 Wayland 的处理是本仓库重点维护方向。

---

## 安装

### 方式一：包管理器（推荐，需先构建）

目前**尚未发布预编译产物**，需自行构建：

```bash
# 1) 构建
pnpm install --frozen-lockfile && pnpm build
pnpm tauri build --bundles deb        # 或 appimage

# 2) Ubuntu 24.04 需先装 WebKitGTK 兼容包（否则依赖报错）
bash packaging/build-webkit-compat-deb.sh
sudo dpkg -i packaging/out/libwebkit2gtk-4.0-37_*_amd64.deb

# 3) 安装
sudo apt install ./src-tauri/target/release/bundle/deb/pot_*.deb
```

> AppImage 用户需先 `sudo apt install libfuse2`，或解压运行：
> `./pot_*.AppImage --appimage-extract && ./squashfs-root/AppRun`

### 方式二：源码运行（开发）

> 📖 **Ubuntu 24.04 / Linux 用户请先看 [`docs/BUILD.md`](docs/BUILD.md)。**
> 新版系统上 WebKitGTK 4.0 已被 4.1 取代，直接构建会失败；该文档给出实测通过的
> 完整修复步骤。可先运行环境自检：
>
> ```bash
> bash scripts/check-linux-build-env.sh
> ```

### 依赖
- Node.js + pnpm（前端）
- Rust toolchain（Tauri 后端）
- Linux: WebKit2GTK、GTK-3；Windows: WebView2；macOS: 系统 WebKit

```bash
# 1. 安装前端依赖（pnpm 12 需放行 esbuild，仓库已配置）
pnpm install --frozen-lockfile

# 2. 开发模式运行（自动拉起 Tauri）
pnpm tauri dev

# 3. 构建发行版
pnpm tauri build
```

---

## 品牌迁移说明

为保留原有运行机制，内部标识（app id、窗口 title）仍沿用上游 `org.pot_app.pot`；
对外品牌使用 `cup-translate`，不主张上游商标「pot / 派了个萌」。若后续想彻底去除
pot 品牌痕迹，可替换以下位置（暂不作为默认改动）：

| 文件 | 内容 |
|---|---|
| `com.pot_app.pot.metainfo.xml` | 应用元数据名 |
| `src-tauri/tauri.conf.json` | 窗口 title / app id |
| `src-tauri/Cargo.toml` | package 名 |

---

## 许可证与免责

- 本仓库遵循 **GNU GPL v3.0**（见 `LICENSE`）。
- 上游代码版权归原项目作者（`Pylogmon` 等），fork 后保留全部版权头。
- 与上游 `pot-app/pot-desktop` 无任何关联或背书；商标归原作者，本仓库
  `cup-translate` 名字，不主张该商标。
- 使用请遵守 GPL-3.0 及商标规范。

---

## 文档导航

- 上游原始说明（历史保留）：`UPSTREAM_README.md`、`README_EN.md`、`README_KR.md`
- 维护路线与定位：`docs/MAINTENANCE.md`
- **Linux 构建指南（含 Ubuntu 24.04 兼容修复）：`docs/BUILD.md`**
- **协作硬约束（AI 助手/新贡献者必读）：`CLAUDE.md`**
- 贡献指南：`CONTRIBUTING.md`
