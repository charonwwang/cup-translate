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

## 2. 构建：三个必踩的坑（已修复，勿回退）

> 详见 `docs/BUILD.md`。这里只列**结论**，改动相关文件前务必确认不会破坏它们。

| # | 坑 | 现状 | 回退会怎样 |
|---|---|---|---|
| 1 | **wry 必须 ≥ 0.24.12** | `Cargo.lock` 锁定 0.24.12 | 降回 0.24.11 → `E0599` 7 个错误（trait not in scope） |
| 2 | **WebKitGTK 4.0→4.1 兼容层** | pkg-config shim + `.so` 软链 | 编译期 `webkit2gtk-4.0 not found`，或链接期 `-lwebkit2gtk-4.0` 找不到 |
| 3 | **pnpm 12 拦截构建脚本** | `pnpm-workspace.yaml` 的 `allowBuilds` | `ERR_PNPM_IGNORED_BUILDS`，vite 构建失败 |

**关键约束**：
- 不要"顺手"把 `wry` 降级或跑 `cargo update` 全量刷新——可能把 wry 拉回有问题的版本。
- `pnpm-workspace.yaml` 的 `allowBuilds` 是 pnpm 12 的**原生格式**，不要改成 `onlyBuiltDependencies`（实测无效）。
- 改动构建相关文件后，跑自检确认没破坏环境：
  ```bash
  bash scripts/check-linux-build-env.sh   # 20 项，应全部通过
  ```

### 2.1 标准构建命令

```bash
pnpm install --frozen-lockfile
pnpm build                          # 前端，产物 dist/
cd src-tauri && cargo build --release   # 产物 target/release/pot
```

### 2.2 打包（.deb / AppImage）

```bash
pnpm tauri build --bundles deb        # 产物在 src-tauri/target/release/bundle/deb/
pnpm tauri build --bundles appimage
```

**⚠️ .deb 无法直接安装的坑**：Tauri v1 会**硬编码**声明依赖 `libwebkit2gtk-4.0-37`
（Ubuntu 24.04 无此包，且**无法通过 tauri.conf.json 去掉**）。安装前需先装兼容包：

```bash
bash packaging/build-webkit-compat-deb.sh
sudo dpkg -i packaging/out/libwebkit2gtk-4.0-37_*_amd64.deb
sudo apt install ./src-tauri/target/release/bundle/deb/pot_*.deb
```

**AppImage 需要 `libfuse2`**（24.04 默认未装）：`sudo apt install libfuse2`。
未装时可用 `--appimage-extract` 解压运行。

### 2.3 已知未验证项（不要当成已完成）

- **RPM 依赖未验证**：`tauri.conf.json` 的 `bundle.rpm.depends` 仍是上游原值
  （含 `libxdo-dev`、`libxcb1` 等 **Debian 风格包名**），在 Fedora/RHEL 上大概率不正确。
  **尚未在 RPM 系发行版上实测过**，修之前请在真实 Fedora 环境验证包名。
- **CI 未验证**：`package.yml` 已收敛为仅 `v*` tag 触发，但**从未打过 tag，因此从未真正跑通**。
- **Windows / macOS 打包未验证**：当前仅在 Ubuntu 24.04 上实测过。

---

## 3. 品牌迁移状态（重要：当前**未完成**，别被误导）

| 位置 | 当前值 | 目标 |
|---|---|---|
| 前端包名 | `pot` (`package.json`) | cup-translate |
| Rust crate 名 | `pot` (`Cargo.toml`) | cup-translate |
| 二进制名 | `pot` | cup-translate |
| app identifier | `com.pot-app.desktop` | 自有 id |
| 配置文件路径 | `~/.config/com.pot-app.desktop/` | 随 identifier 变更 |
| .deb 包名 | `pot` | cup-translate |
| 托盘名 / 窗口标题 | `pot` | cup-translate |

**改动 identifier 会导致用户配置丢失**（配置路径随 identifier 变化）。
若要做，需**同时**提供配置迁移逻辑，不要只改 JSON。

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
│   ├── translate/         22 个翻译引擎（每个一个目录 + index.jsx 注册）
│   ├── recognize/         OCR
│   ├── tts/               语音合成
│   └── collection/        生词本
├── utils/                 invoke_plugin.js / store.js 等
└── i18n/locales/          21 个语言 JSON

src-tauri/src/             Rust 后端（15 个模块）
├── main.rs                入口
├── window.rs              窗口管理（划词弹窗定位关键）
├── hotkey.rs              全局快捷键
├── clipboard.rs           剪贴板监听
├── server.rs              本地 HTTP 服务（127.0.0.1:随机端口）
├── config.rs              配置读写
├── tray.rs                系统托盘
└── screenshot.rs / system_ocr.rs / lang_detect.rs / updater.rs / backup.rs
```

### 4.1 新增翻译引擎的约定
1. 在 `src/services/translate/<name>/` 建目录，实现 `translate` 导出
2. 在 `src/services/translate/index.jsx` 中 **import + export**（两步都要，缺一不生效）
3. 在 `src/i18n/locales/*.json` 补引擎显示名（**21 个语言文件**，至少补 `en_US` 和 `zh_CN`）
4. 引擎配置项在 `src/window/Config/` 对应页面注册

---

## 5. 代码规范

### 5.1 前端（已被 prettier 强制，`.prettierrc.json`）
- **缩进 4 空格**，**单引号**，**行宽 120**，**分号必需**
- JSX 属性**每行一个**（`singleAttributePerLine: true`）
- 换行符 `lf`
- 文件是 **`.jsx` / `.js`**，**不是 TypeScript**（虽然 devDeps 有 `typescript`，但无 `tsconfig.json`，请勿擅自引入 TS）

改动后格式化：
```bash
npx prettier --write <files>
```

### 5.2 Rust
- 遵循 `cargo fmt` / `cargo clippy`
- `src-tauri/Cargo.toml` 中 `[package] name = "pot"`，改动会影响二进制名与打包

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
  pnpm build                                  # 前端能否构建
  cd src-tauri && cargo build --release       # 后端能否编译
  bash scripts/check-linux-build-env.sh       # 构建环境
  ./src-tauri/target/release/pot              # 能否启动（GUI 常驻，需 Ctrl-C）
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
| 路线/定位变化 | `docs/MAINTENANCE.md` |
| 协作硬约束 | 本文件 `CLAUDE.md` |

---

## 9. 快速上手（AI 助手版）

接到任务后建议顺序：

1. `bash scripts/check-linux-build-env.sh` — 确认环境可用
2. 读相关源码（见 §4 地图），**不要凭猜测改**
3. 改动 → `pnpm build` + `cargo build --release` 确认通过
4. 若涉及运行行为 → 实际跑 `./src-tauri/target/release/pot` 验证
5. 按 §5.3 规范提交，按 §8 同步文档

**红线**：不要删版权头、不要改协议、不要启用上游身份 CI、不要声称有测试、不要编造验证结果。