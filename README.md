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
> 第三方插件包含可执行 JavaScript，且可调用本机命令；仅安装信任来源的插件。

---

## 安装

### 下载正式安装包

在 [Releases](https://github.com/charonwwang/cup-translate/releases/latest) 按平台选择：

| 平台 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | `cup-translate_<版本>_mac_arm64.dmg` |
| macOS Intel | `cup-translate_<版本>_mac_x64.dmg` |
| Windows x64 | `cup-translate_<版本>_windows_x64_setup.exe` |
| Windows x86 | `cup-translate_<版本>_windows_x86_setup.exe` |
| Windows ARM64 | `cup-translate_<版本>_windows_arm64_setup.exe` |
| Windows x64/x86（MSI） | `cup-translate_<版本>_windows_<架构>.msi` |
| Linux x64 | `cup-translate_<版本>_linux_x64.deb` 或 `.rpm` |
| Linux ARM64 | `cup-translate_<版本>_linux_arm64.deb` 或 `.rpm` |

macOS 打开 DMG 后将 App 拖入 Applications。当前 macOS 包使用 ad-hoc 签名，尚无 Developer ID 和 Apple 公证，首次打开可能出现系统安全提示。发布说明、对应源码包及校验和均随版本提供；旧更新地址的客户端请手动安装一次新版本。详见 [发布说明](docs/MACOS_RELEASE.md)。

Windows 安装包未做代码签名，SmartScreen 可能提示“未知发布者”；请先核对 Release 中的 `SHA256SUMS`。

Windows 按原生安装向导完成语言、许可、目录、开始菜单及安装步骤；Linux 使用软件中心或包管理器安装。具体操作及卸载方式见 [安装与卸载](docs/INSTALLATION.md)。以上原生 Linux 包名将在下一次发布流程生效，旧版本仍可下载 `.tar.gz` 组合包。

### Linux：构建并安装

也可自行构建安装包：

```bash
# 1) 构建 + 打包（脚本会自动修正 .deb 的幽灵依赖）
bash packaging/build-linux.sh deb        # 也可选 rpm、appimage 或 all

# 2) 安装（APT 自动解析运行时依赖）
sudo apt install ./src-tauri/target/release/bundle/deb/cup-translate_*.deb
```

安装后：

```bash
which cup-translate                          # /usr/bin/cup-translate
cup-translate                                # 启动
```

> AppImage 用户需先 `sudo apt install libfuse2`，或解压运行：
> `./cup-translate_*.AppImage --appimage-extract && ./squashfs-root/AppRun`
> 构建 AppImage 时需安装 `patchelf`；打包脚本会包含 GStreamer 播放插件。

### 源码运行（开发）

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

内部标识已改为 `com.cup-translate.app`；首次启动会迁移旧版配置目录。
对外品牌使用 `cup-translate`，不主张上游商标「pot / 派了个萌」。仍保留
`packaging/cup-translate.metainfo.xml`（原 `com.pot_app.pot.metainfo.xml`）已重写为 cup-translate 品牌标识，
历史 release 条目保留上游 `pot-app/pot-desktop` 出处链接以符合 GPL 署名要求。

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


### 本地模型、连接和术语

在设置 → **模型与连接** 安装 **M2M-100 多语种模型**（单份约 496 MB，CPU 运行，建议 8 GB 以上内存）或 OPUS-MT 中英双向模型、管理 OpenAI-compatible/Ollama 连接和系统语音。原文和目标语言仍在翻译窗口选择；M2M-100 覆盖当前 27 个目标语言选项（不承诺繁体输出、蒙古文传统文字、新挪威语及葡萄牙语地区差异），语言切换不需要重复下载。新安装仍仅默认 Google；旧服务实例和高级参数保留。服务并行比较，顺序决定主结果，不会自动回退云端。
模型列表按场景展示可独立选装的型号与资源/许可信息，管理页支持启用/停用、释放内存、校验修复、卸载、导入本地模型目录及自定义镜像目录地址。当前导入和镜像下载仅支持列表已知型号的固定版本 CTranslate2 模型包，逐文件核对 SHA256；其他架构、压缩包及微调权重不属于通用导入范围。

“仅在设备处理”会阻止在线/外部连接（包括 localhost）和普通插件。系统音色可用性按本机探测，不随安装更改原 TTS 默认配置。未配置朗读时可选择 Google 联网语音、本地系统语音或不朗读。

术语库支持编辑、CSV/JSON 导入预览、命中词偏好与输出校验，不强制替换译文。参见 [实施与验证记录](docs/design/local-models-v1/README.md#11-本次实现与运行记录2026-10-20)、[CSV 示例](docs/design/local-models-v1/examples/glossary-template.csv) 和 [JSON 示例](docs/design/local-models-v1/examples/glossary-template.json)。单词音标来源于词典或适配模型；OPUS 没有内置音标词典，严格离线时不会偷偷联网补充。

本次凭证库迁移覆盖 OpenAI/Ollama 和自定义请求头；系统凭证库不可用时不明文保存。配置导出不包含凭证，新设备需重新绑定；未适配插件不承诺安全迁移。

Piper 本地朗读现可在「模型与连接 → 语音模型」按语言选择、试听、下载和卸载音色。原文与译文分别跟随各自语言，缺少音色会提示；详见 [音色、许可和平台说明](docs/design/local-models-v1/PIPER.md)。

本地模型现可先选系列再选规格或音色：HY-MT1.5 1.8B（推荐 Q4，另有 Q8）一次下载支持多语翻译；Kokoro 82M INT8 一份模型提供七种语言、49 个音色，支持试听、按需下载与卸载。原文和目标语言始终由翻译窗口控制。安装条件、许可和验证边界见 [多语模型说明](docs/design/local-models-v1/MULTILINGUAL.md)。
