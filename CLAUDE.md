# CLAUDE.md · cup-translate 协作规范

> 本文件面向 **AI 编码助手 / 新加入的贡献者**，只写「不看就会踩坑」的硬约束。
> 通用项目介绍见 `README.md`，构建细节见 `docs/BUILD.md`，维护路线见 `docs/MAINTENANCE.md`。
>
> 凡本文档中的事实均经实测确认（2025 年，Ubuntu 24.04 / Rust 1.95 / pnpm 12）。

---

## 0. 一句话认清项目

**cup-translate 是已归档项目 [pot-app/pot-desktop](https://github.com/pot-app/pot-desktop) 的社区续版（fork），不是原创项目。**

- 技术栈：**Tauri v1.8 + Rust 后端 + React 18 (JSX) 前端**
- 许可证：**GPL-3.0**（继承上游，**必须保留**）
- 定位：轻量划词翻译，**Linux/Wayland 优先**

---

## 1. 不可违背的约束（违反=返工或法律问题）

### 1.1 许可证与署名
- **必须保持 GPL-3.0**。不得改为 MIT/Apache 等更宽松协议。
- **不得删除任何上游版权头**（`src/`、`src-tauri/src/` 各文件头部）。
- **不得宣称本项目为原创**；对外描述必须说明是 pot-desktop 的 fork。
- **不主张上游商标**（`pot` / `派了个萌`）。对外品牌统一用 `cup-translate`。

### 1.2 不要向上游仓库推送
上游 `pot-app/pot-desktop` 已 `archived`。**所有开发只在 `charonwwang/cup-translate` 进行**，
不要把 conf/commit 推到上游，也不要向上游 `pot-app/pot-docs` 发 webhook（相关 CI 已禁用）。

### 1.3 CI 中的上游身份残留（已禁用，勿误开）
`.github/workflows/package.yml` 中以下 job 使用**上游身份**，已被 `if: false` 禁用：
- `homebrew` — 会推 `pot-app/homebrew-tap`
- `winget` — winget id 为 `Pylogmon.pot`，`fork-user: Pylogmon`
- `trigger-docs-update` — 会 curl 上游 `pot-app/pot-docs`

**除非 cup-translate 有了自己的 tap / winget 标识，否则不要启用。**

---

## 2. 构建：四个必踩的坑（已修复，勿回退）

> 详见 `docs/BUILD.md`。这里只列**结论**，改动相关文件前务必确认不会破坏它们。

| # | 坑 | 现状 | 回退会怎样 |
|---|---|---|---|
| 1 | **wry 必须 ≥ 0.24.12** | `Cargo.lock` 锁定 0.24.12 | 降回 0.24.11 → `E0599` 7 个错误（trait not in scope） |
| 2 | **WebKitGTK 4.0→4.1 兼容层** | pkg-config shim + `.so` 软链（**仅构建期**） | 编译期 `webkit2gtk-4.0 not found`，或链接期 `-lwebkit2gtk-4.0` 找不到 |
| 3 | **pnpm 12 拦截构建脚本** | `pnpm-workspace.yaml` 的 `allowBuilds` | `ERR_PNPM_IGNORED_BUILDS`，vite 构建失败 |
| 4 | **cargo build 缺 `--features custom-protocol`** | 构建命令统一带该 feature（§2.1） | 二进制能启动但**前端永不加载**（webview 空白、无 JS） |

**关键约束**：
- 不要"顺手"把 `wry` 降级或跑 `cargo update` 全量刷新——可能把 wry 拉回有问题的版本。
- `pnpm-workspace.yaml` 的 `allowBuilds` 是 pnpm 12 的**原生格式**，不要改成 `onlyBuiltDependencies`（实测无效）。
- 本地离线翻译（ct2rs/CTranslate2）需要 `cmake` + C++ 工具链（§2 的系统依赖已含）。
- 改动构建相关文件后，跑自检确认没破坏环境：
  ```bash
  bash scripts/check-linux-build-env.sh   # 24 项，应全部通过
  ```

### 2.1 标准构建命令

```bash
pnpm install --frozen-lockfile
pnpm build                                                             # 前端，产物 dist/
cd src-tauri && cargo build --release --features custom-protocol # 产物 target/release/cup-translate
```

> **⚠️ 第四个坑（2026-09-23 实测）：裸 `cargo build --release` 缺 `--features custom-protocol`。**
> 该 feature 只有 `pnpm tauri build` 会自动启用。缺了它，二进制**能启动但前端永不加载**
> （webview 空白、无 JS 执行、日志永远没有 `resolve`），症状与「前端代码坏了」完全一致。
> 跑 GUI 验证必须带 `--features custom-protocol`（详见 `docs/BUILD.md` §5）。
> **且该 feature 在 cargo build 时把 `dist/` 嵌进二进制**：改前端后必须
> **先 `pnpm build` 再 `cargo build --features custom-protocol` 重编**，否则跑的是旧前端
> （日志 `assets/index-<hash>.js` 与 `dist/assets/` 文件名对不上即为此坑）。

### 2.2 打包（.deb / AppImage）

**必须用封装脚本**，它会自动剔除 .deb 的幽灵依赖并清理旧品牌产物：

```bash
bash packaging/build-linux.sh deb        # 推荐
bash packaging/build-linux.sh appimage
```

**⚠️ 不要直接用 `pnpm tauri build --bundles deb`**：Tauri v1 的 CLI 二进制内
**硬编码**会把 `libwebkit2gtk-4.0-37` 写进 `Depends`，而 Ubuntu 24.04 无此包，
**且无法通过 tauri.conf.json 去掉**，导致 .deb 装不上。

但实测证明这是**幽灵依赖**——二进制的 ELF `DT_NEEDED` 只有 4.1，运行期根本不需要它：

```bash
readelf -d src-tauri/target/release/cup-translate | grep NEEDED   # 只有 4.1
```

**因此正确做法是把该依赖剔除，用户零额外安装**（脚本已自动完成）。
注意区分：**构建者**需要 §3.3 的 `.so` 软链，**使用者**不需要任何额外包。

**AppImage 需要 `libfuse2`**（24.04 默认未装）：`sudo apt install libfuse2`。
未装时可用 `--appimage-extract` 解压运行。

### 2.3 已知未验证项（不要当成已完成）

- **RPM 依赖未验证**：`tauri.conf.json` 的 `bundle.rpm.depends` 仍是上游原值
  （含 `libxdo-dev`、`libxcb1` 等 **Debian 风格包名**），在 Fedora/RHEL 上大概率不正确。
  **尚未在 RPM 系发行版上实测过**，修之前请在真实 Fedora 环境验证包名。
- **CI 未验证**：`package.yml` 已收敛为仅 `v*` tag 触发，但**从未打过 tag，因此从未真正跑通**。
- **Windows / macOS 打包未验证**：当前仅在 Ubuntu 24.04 上实测过。

---

## 3. 品牌状态（已完成，附迁移约束）

品牌已从上游 `pot` 迁移到 `cup-translate`：

| 位置 | 当前值 |
|---|---|
| 前端包名 | `cup-translate` (`package.json`) |
| Rust crate 名 | `cup-translate` (`Cargo.toml`) |
| 二进制名 | `cup-translate` |
| app identifier | `com.cup-translate.app` |
| 配置文件路径 | `~/.config/com.cup-translate.app/` |
| .deb 包名 | `cup-translate` |
| 托盘名 / 窗口标题 | `cup-translate` |

**已实现配置自动迁移**（`src-tauri/src/config.rs`）：
启动时若新配置不存在、而旧路径 `~/.config/com.pot-app.desktop/` 存在，
会**递归复制**旧配置到新位置，老用户升级不丢设置。**不要删除这段逻辑。**

> 若将来再改 `identifier`，必须同步更新 `LEGACY_IDENTIFIER` 常量，
> 否则用户配置会静默丢失。

### 3.1 图标（已替换为原创设计）

**全部图标已不含上游 pot 的图形元素**，为 cup-translate 原创设计：
暖橙→焦糖渐变底 + 白色咖啡杯 + 杯身「笔画块 + 字母 A」（表示语言转换）。

| 文件 | 说明 |
|---|---|
| `app-icon.png`（仓库根） | **母版**，1024×1024 RGBA，所有派生图标的唯一来源 |
| `packaging/gen-icon.py` | 用 Pillow 生成母版（含配色常量） |
| `src-tauri/icons/*` | 由 `pnpm tauri icon` 生成（PNG/ICO/ICNS/Appx） |
| `public/icon.png` | 前端 favicon **兼 About 页 logo**（`<img src='icon.png'>`） |

**约束**：
- 改图标**必须改母版** `app-icon.png` 后重新生成，**不要只改派生文件**（会被覆盖）。
- `pnpm tauri icon` **不会**生成 `public/icon.png` 与 `icon_mac.ico`，需手动补齐。
- 完整流程与验证清单见 **`packaging/ICONS.md`**。

### 3.2 仍指向上游的部分

以下 URL 仍指向上游域名，状态分两类（**实测于 2026，证据见 `docs/research/`**）：

| 位置 | 用途 | 状态 |
|---|---|---|
| `src/services/tts/lingva/index.jsx` | Lingva TTS 实例（默认地址已死） | ⚠️ 代码保留**仅供自建**（`requestPath` 可配），默认已换 `local_tts` |
| `src/window/Config/pages/Backup/utils/aliyun.jsx` | 阿里云盘 token 代理 | ⚠️ 依赖上游，暂可用 |
| 各 `services/translate/*/Config.jsx` | 申请 API key 的文档链接 | ⚠️ 仅文档链接 |

**已删除（2026 实测上游全死且无自建入口）**：`src/services/translate/{bing,ecdict,lingva}`——
ECDict（`pot-app.com/api/dict` 404/405）、Lingva 翻译（NXDOMAIN）、Bing 取 token（404）。
如需恢复请以 pot 插件形式自行接入，勿在核心里复活死端点。

**默认引擎策略（开箱即用）**：默认 `translate_service_list` 只含 `yandex` + `google`
（免 API key、上游可用，`google` 支持 `custom_url` 镜像）；TTS 默认 `local_tts`
（本地 espeak-ng / spd-say 合成，零配置、离线）；本地离线翻译 `local_mt` 为**可选插件式**
（默认不启用，模型在设置页按需下载，见 `src-tauri/src/local_mt.rs`）。启动时
`src-tauri/src/config.rs::prune_unconfigured_dead_services()` 会清理**从未配置过**的
`deepl`/`bing`/`lingva`/`ecdict`（翻译）与 `lingva_tts`（TTS）裸实例，让升级用户同样开箱即用；
用户显式创建的 `name@id` 实例、已填配置（如 DeepL 密钥 / 自建地址）的实例一律保留。

`deepl` 代码保留（需 API key，翻译前会跳过未配置实例、不发请求）。
不要把 URL 改成来路不明的第三方镜像；若要自建，需先有对应服务。
依赖上游基础设施仍属已知技术债（见 `docs/MAINTENANCE.md`）。
另：`check_service_available()` 启动时按 `builtin_translate_list`/`builtin_tts_list` 白名单
清理服务列表（见 §4.1 第 5 步）——已删除服务（bing/ecdict/lingva）的**所有**实例
（含 `name@id`）都会被清掉，因为前端已无对应实现、留着必崩服务列表 UI。

### 3.3 更新器（updater）已接自建更新源

`tauri.conf.json` 的 `updater.endpoints` 指向 **cup-translate 自己的** `update.json`，
`pubkey` 为自有 minisign 公钥（key id `DB420303520E0CB5`）。
产物名与仓库地址已在 `updater/*.mjs` 与 CI 中统一为 `cup-translate`。

- 代码层面保留 `tauri::updater`（故 `Cargo.toml` **必须**显式声明 `updater` feature，
  否则 `src-tauri/src/updater.rs` 编译失败：`cannot find updater in tauri`）
- **⚠️ 私钥不在仓库中**，必须存在于 GitHub Secrets（`TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD`）。
  私钥丢失＝更新器永久失效：已安装用户的二进制里烧死了旧公钥，换密钥对无法推送更新。
- **⚠️ 整条链路从未跑通**（仓库从未打过 tag），首次发版前请按
  `docs/MAINTENANCE.md` §7 的清单逐项确认。
- 改 `package.productName` 时**必须同步**改 `updater/*.mjs` 的产物名与
  `.github/workflows/package.yml` 的重命名步骤，否则更新检查会 404。

---

## 4. 代码结构地图

```
src/                       前端 (React 18, JSX)
├── window/                5 个窗口入口
│   ├── Config/            设置界面
│   ├── Translate/         翻译窗口（核心）
│   ├── Recognize/         截图 OCR
│   ├── Screenshot/        截图
│   └── Updater/           更新
├── services/
│   ├── translate/         19 个翻译引擎（每个一个目录 + index.jsx 注册）+ required_config.js 配置检查
│   ├── recognize/         OCR
│   ├── tts/               语音合成
│   └── collection/        生词本
├── utils/                 invoke_plugin.js / store.js 等
└── i18n/locales/          21 个语言 JSON

src-tauri/src/             Rust 后端（17 个模块）
├── main.rs                入口
├── window.rs              窗口管理（划词弹窗定位关键）
├── hotkey.rs              全局快捷键
├── clipboard.rs           剪贴板监听
├── server.rs              本地 HTTP 服务（127.0.0.1:随机端口）
├── config.rs              配置读写
├── tray.rs                系统托盘
└── screenshot.rs / system_ocr.rs / lang_detect.rs / updater.rs / backup.rs / local_mt.rs / tts.rs
```

### 4.1 新增翻译引擎的约定
1. 在 `src/services/translate/<name>/` 建目录，实现 `translate` 导出
2. 在 `src/services/translate/index.jsx` 中 **import + export**（两步都要，缺一不生效）
3. 在 `src/i18n/locales/*.json` 补引擎显示名（**21 个语言文件**，至少补 `en_US` 和 `zh_CN`）
4. 引擎配置项在 `src/window/Config/` 对应页面注册
5. **同步 `src-tauri/src/config.rs` 的 `builtin_translate_list`**（TTS 对应 `builtin_tts_list`）——
   每次启动 `check_service_available()` 都按该白名单校验服务列表，
   **不在名单里的服务会被静默清出 `translate_service_list`**（2026-09-23 实测：`local_mt`
   加了前端忘了加 Rust，用户配置活不过一次重启）。反之，代码已删除的服务要从名单移除，
   让残留配置项被自动清掉。

---

## 5. 代码规范

### 5.1 前端（已被 prettier 强制，`.prettierrc.json`）
- **缩进 4 空格**，**单引号**，**行宽 120**，**分号必需**
- JSX 属性**每行一个**（`singleAttributePerLine: true`）
- 换行符 `lf`
- 文件是 **`.jsx` / `.js`**，**不是 TypeScript**（虽然 devDeps 有 `typescript`，但无 `tsconfig.json`，请勿擅自引入 TS）
  - 唯一例外：`src/services/**/info.ts`（上游既有约定，仅 `info` + `Language` 枚举）

改动后格式化：
```bash
npx prettier --write <files>
```

### 5.2 Rust
- 遵循 `cargo fmt` / `cargo clippy`
- `src-tauri/Cargo.toml` 中 `[package] name = "cup-translate"`，改动会影响二进制名与打包
- `tauri` 依赖的 features **必须包含 `updater`**（源码 `updater.rs` 需要）；删掉会导致 `cannot find updater in tauri`

### 5.3 提交信息
使用**中文**、带类型前缀，例如：
```
fix(linux): 升级 wry 0.24.11 -> 0.24.12，修复 Linux 构建失败
docs: 完善 Linux 构建文档并新增环境自检脚本
ci: 收敛上游发布流水线，避免误用上游身份发布
```
正文说明**根因 + 修复 + 验证方式**（便于后续维护者理解为什么这么改）。

---

## 6. 测试现状（务必知悉）

**本项目目前没有任何自动化测试**：
- 前端无测试框架、无 `test` 脚本
- `src-tauri/src/` 中无 `#[test]`
- `.github/workflows/` 仅 `package.yml`，且**只做打包发版，不跑任何测试**

因此：
- 改动后**必须手工验证**，并在提交信息里写清验证方式
- **不要假装**存在测试命令（如编造 `pnpm test`）；若需验证，用真实可跑的命令：
  ```bash
  pnpm build                                                             # 前端能否构建
  cd src-tauri && cargo build --release --features custom-protocol # 后端能否编译（跑 GUI 必须带 custom-protocol，见 §2.1）
  bash scripts/check-linux-build-env.sh                                  # 构建环境
  ./src-tauri/target/release/cup-translate                               # 能否启动（GUI 常驻，需 Ctrl-C）
  ```
- 引入测试框架是**待办**，不是既成事实

---

## 7. 平台真相（避免做出错误承诺）

| 场景 | 状态 |
|---|---|
| X11 / XWayland 划词（PRIMARY selection） | ✅ 可用 |
| 纯 Wayland 划词 | ⚠️ 受协议安全限制，**不保证**；是 M1/M2 攻坚项 |
| Wayland 全局热键 | ⚠️ 上游遗留问题多，见 issue |

修改划词逻辑前先读 `src-tauri/src/window.rs` 与 `hotkey.rs`，并在**真实 X11/Wayland 会话**下测试。
Xvfb/无头环境下 GUI 行为不可信。

---

## 8. 文档维护约定

改到以下内容时，**同步更新对应文档**（否则视为未完成）：

| 改动 | 需更新 |
|---|---|
| 构建步骤 / 依赖 / 版本坑 | `docs/BUILD.md` |
| 新增环境自检项 | `scripts/check-linux-build-env.sh` |
| 打包方式 | `docs/BUILD.md` §6 + `packaging/` |
| **图标/品牌视觉** | `packaging/ICONS.md` + 本文件 §3.1 |
| 路线/定位变化 | `docs/MAINTENANCE.md` |
| 协作硬约束 | 本文件 `CLAUDE.md` |

---

## 9. 快速上手（AI 助手版）

接到任务后建议顺序：

1. `bash scripts/check-linux-build-env.sh` — 确认环境可用
2. 读相关源码（见 §4 地图），**不要凭猜测改**
3. 改动 → `pnpm build` + `cargo build --release --features custom-protocol` 确认通过
4. 若涉及运行行为 → 实际跑 `./src-tauri/target/release/cup-translate` 验证
5. 按 §5.3 规范提交，按 §8 同步文档

**红线**：不要删版权头、不要改协议、不要启用上游身份 CI、不要声称有测试、不要编造验证结果。