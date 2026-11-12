# cup-translate · 维护路线与产品定位

> 本文档是 **cup-translate（pot-desktop 社区续版）** 的长期维护路线。
> 目标读者：维护者、贡献者和对方向有疑问的人。

当前服务功能的演进请结合 [服务与词典交互规范](product/service-and-dictionary-contract.md) 和 [2026-10-26 问题评审与修复计划](reviews/service-capabilities-2026-10-26/README.md) 阅读。本文保留了较早阶段的默认功能与平台定位，涉及当前行为时需先核对实现和已验收记录。

---

## 1. 项目一页简介

| 项 | 内容 |
|---|---|
| 名字 | **cup-translate**（☕）|
| 动机 | 原项目 pot-app/pot-desktop 已归档、停止维护 |
| 许可证 | **GNU GPL-3.0**（保留上游）|
| 目标平台 | Windows / macOS / Linux（**优先 Linux + Wayland**）|
| 核心卖点 | 「鼠标选中一段文本 → 立即弹窗翻译」的**轻快、无感**体验 |

## 2. 产品定位（差异化）

### 一句话
> **把「划词翻译」这一件事做到 95 分——不挤占资源、不走弯路，只做最顺手的那条「翻译一条龙」。**

### 与上游(pot)的差异
| 维度 | 上游 pot | cup-translate |
|---|---|---|
| 范围 | 全能（翻译+OCR+TTS+生词本全要）| **聚焦划词闭环**；OCR/TTS 默认关，按需开 |
| Linux/Wayland | 支持但"尽力" | **一等公民**，专攻纯 Wayland |
| 维护 | 《已归档》 | 社区活跃续更 |
| 产品姿态 | "多而全" | **"少而精"** |

## 3. 目标用户
1. 读英文论文/外文资料的**研究者、学生**
2. 在终端/编译器里看英文报错与注释的**开发者**
3. 深度使用 **Wayland 桌面**（GNOME/KDE/Hyprland）的原生用户
4. 反感臃肿工具、偏爱「免安装、低内存、即开即用」的极简派

## 4. 非目标（明确不做，防膨胀）
- 不做复杂云账号 / 会员系统
- 不做捆绑式 OCR/TTS 默认开启
- 不做"我全都要"的菜单堆叠；保持默认只有划词+剪贴板

## 5. 核心体验设计原则
1. **划词即译、无感演出**：弹窗自动出现/自动消失，不抢键盘焦点
2. **跨应用统一**：浏览器、终端、编辑器、PDF 一套覆盖
3. **Wayland 第一**：任何解决不了的先记录为 issue 优先排期
4. **默认轻量**：默认关 OCR/TTS/生词本，需要时再开

## 6. Roadmap

### 阶段 M0（本月内，已起步）
- [x] 从已归档上游（pot-desktop）fork 续版仓库
- [x] 品牌改名 cup-translate，README/CONTRIBUTING 完善
- [x] **构建链路验证（Ubuntu 24.04 上 pnpm + cargo build 全流程通过）**
  - 详见 `docs/BUILD.md`，环境自检脚本 `scripts/check-linux-build-env.sh`
  - 关键修复：WebKitGTK 4.0→4.1 兼容层（pkg-config shim + 链接软链）、wry 升级 0.24.12
- [x] 收敛上游 CI：仅在 `v*` tag 触发；禁用上游身份的 homebrew/winget 发布
- [x] **打包链路打通**：`.deb`（36MB）+ `.AppImage`（175MB）均可生成
  - 实测在 Ubuntu 24.04 上可安装并启动（需配套 webkit 兼容包，见 `packaging/`）
- [x] GitHub Actions CI / Release 初版（本仓库自有，含构建验证）
  - `v3.0.13`、`v3.0.14` 已由 Release desktop 发布矩阵成功构建并公开；所有构建工作流均已移除无法在当前 x64 runner 链接的 ARMv7 目标
- [x] 仓库公开（https://github.com/charonwwang/cup-translate）

### 阶段 M1（近期）
- [ ] 修复上游遗留的高频 issue（尤其 Linux 划词、Wayland 热键）
- [ ] WebKit2GTK 2.42 Nvidia 崩溃规避
- [x] 发布 alpha 打包（.deb / AppImage for Linux）；后续正式版已覆盖 Linux x64/ARM64 DEB/RPM
- [x] **品牌迁移完成**：二进制名 / 包名 / app id / 桌面项统一为 `cup-translate`
  - identifier: `com.pot-app.desktop` → `com.cup-translate.app`
  - 已实现旧配置**自动迁移**，老用户升级不丢设置（`config.rs`）
- [x] **图标替换完成**：全部图标改为 cup-translate 原创设计
  - 母版 `app-icon.png` + 生成脚本 `packaging/gen-icon.py`，说明见 `packaging/ICONS.md`
  - 覆盖 PNG/ICO/ICNS/Appx 全平台，含托盘图标与前端 favicon
  - 顺带修复：`/icon.png` favicon 长期 404（上游遗留，仓库无 `public/`）
- [x] **开箱即用改造**：翻译「零配置可用」，默认引擎收敛为 `yandex` + `google`
  - 修复全新安装界面默认为英文的 bug（`tray.rs` 抢在前端前写入 `app_language=en`，毒化 zh_cn 默认值）
  - 语种检测默认 `baidu` → `local`（lingua 本地检测，零网络、零隐私风险）；存量用户设置不动
  - 启动时清理从未配置过的 `deepl`/`bing`/`lingva`/`ecdict` 裸实例（升级用户同样开箱即用，`config.rs`）
  - 翻译失败**自动展开**错误卡片并截断显示（此前失败被静默折叠，6 个默认引擎 4 个失效用户也看不见）
  - 启动失败 / 配置初始化失败时渲染**兜底错误面板**（含日志路径提示，不再白屏）
  - 未配置的引擎翻译时**直接跳过**（不发请求，卡片显示「未配置，已跳过」）
  - 实测报告：`docs/research/translation-engine-benchmark-2026.md`、`docs/research/gui-integration-test-2026.md`
- [x] **本地离线翻译模式（可选插件式）**：CTranslate2（`ct2rs`）+ OPUS-MT en↔zh CT2 int8
  - 每方向 79MB / 158MB 内存 / 106ms@4 线程 / BLEU 53.8，仅中英互译；zh→en 模型 CC-BY-4.0，UI 已标注署名
  - 默认**不启用**，在 设置 → 翻译服务 → 本地离线翻译 中按需下载模型（huggingface.co 失败自动换 hf-mirror.com）
  - 实现：`src-tauri/src/local_mt.rs`（`local_mt_*` 命令）+ `src/services/translate/local_mt/`；调研见 `docs/research/on-device-mt-models-2026.md`
- [x] **死服务清理 + 本地 TTS**：翻译侧 `bing`/`ecdict`/`lingva` 代码删除（上游全死且无自建入口）
  - TTS 默认 `lingva_tts` → `local_tts`（espeak-ng / espeak / spd-say 本地合成：离线、零配置、GPL-3.0 兼容）
  - `lingva_tts` 代码保留仅供自建实例（`requestPath` 可配）；高质量本地 TTS（Piper + sherpa-onnx，Apache-2.0）为后续升级项
- [x] 引入最小测试：前端/打包规则与 Rust 单元测试已覆盖主要回归点；跨平台安装与真实划词仍需持续做集成验证
- [x] 自建更新源 —— 清单、签名、公开下载、CI 发布，以及 3.0.13 → 3.0.14 的真实应用内升级均已完成验收，证据见 §7
- [ ] 脱离上游基础设施依赖：ECDICT / Lingva / Bing token **已删除**，TTS **已本地化**；
      仍剩阿里云盘备份授权代理（依赖上游，本轮未验证其可用性）待替换；本地/WebDAV/阿里云备份已统一使用新应用配置目录，恢复后会自动重启以应用设置

### 阶段 M2（中期）
- [ ] 专注"划词→弹窗"响应优化（内存/耗时）
- [ ] Wayland 划词跟随鼠标的健壮方案
- [ ] 精简模块：可选功能默认关闭 + 可裁剪构建

### 阶段 M3（长期，相对远）
- [ ] 极简界面 / 无障碍改进
- [ ] 本地词典（ECDICT 离线）深度整合
- [ ] 多语言原生 SDK、插件生态逐步开放

## 7. 更新器（updater）启用状态

更新器发布链路已在 `v3.0.13`、`v3.0.14` 实际跑通：tag 触发流水线，产物、
更新清单、签名、公开下载，以及 macOS 应用内从 3.0.13 升级到 3.0.14 均已完成验收。

### 已完成（代码侧）

| 项 | 位置 | 说明 |
|---|---|---|
| 更新源 | `src-tauri/tauri.conf.json` → `updater.endpoints` | 指向 `releases/latest/download/update.json`（最新正式版附带的清单；评审时返回 3.0.14） |
| 验签公钥 | `src-tauri/tauri.conf.json` → `updater.pubkey` | 自有 minisign 公钥（key id `DB420303520E0CB5`） |
| 固定版 WebView2 安装包 | `src-tauri/webview.{x64,x86,arm64}.json` | 不再覆盖更新端点，继承主通道（`latest/download/update.json`，同一公钥）；见下文「固定运行时渠道」 |
| 清单生成 | `updater/updater.mjs`、`updater-for-fix-runtime.mjs` | 已改为 `charonwwang/cup-translate` + `cup-translate_*` 产物名 |
| 产物重命名 | `.github/workflows/package.yml` | macOS / Windows 的 `Rename-Item` 源名已从 `pot_` 改为 `cup-translate_`（原先会因找不到文件而失败） |

同时**删除了** `linux-i686 / linux-aarch64 / linux-armv7` 三个平台条目：
上游原版将这三项错误地指向 macOS 产物，会导致用户下载到无法安装的包。
CI 也只为 x86_64 构建 AppImage，且 Tauri 更新器在 Linux 上仅支持 AppImage 自替换。

### 首次发版已完成；后续发版仍需确认

1. **配置 GitHub Secrets**（Settings → Secrets and variables → Actions）：
   - `TAURI_PRIVATE_KEY` = `~/.tauri/cup-translate.key` 的全部内容
   - `TAURI_KEY_PASSWORD` = 生成密钥时设置的密码
2. **备份私钥到仓库之外的安全位置**。私钥丢失＝**更新器永久失效**：
   已安装用户的二进制里烧死了旧公钥，换新密钥对将无法推送更新，只能让用户手动重装。
3. **打 tag 触发流水线**（`v*` 形式，如 `v3.1.0`），并确认：
   - 各平台 job 产出的 `.sig` 与安装包一并上传到了 release
   - `publish-desktop.mjs`（`release-desktop.yml` 的 publish 步骤）已把 `update.json` 上传到版本 release（如 `v3.0.14`），
     把更新载荷上传到 `updater-vX` 预发布；随后 `releases/latest/download/update.json` 返回新版本、六个平台条目齐全
   - tag 名（可能带 `v`）与产物名中的版本号（不带 `v`）差异已被 `updater.mjs` 的 `assetVersion` 处理
4. **实测一次升级**：装旧版 → 启动 → 确认能检测到新版、下载、验签通过、安装成功。
   2026-11-04 已在 macOS Apple Silicon 完成 3.0.13 → 3.0.14 实测；配置未变、194 条历史保留，
   证据见 [`RELEASE-3.0.14.md`](reviews/service-capabilities-2026-10-26/RELEASE-3.0.14.md) 与
   [`upgrade-3.0.13-to-3.0.14.json`](reviews/service-capabilities-2026-10-26/integration-evidence/upgrade-3.0.13-to-3.0.14.json)。

### 固定运行时渠道（2026-11-11 已退役）

- 评审事实（2026-11-10 实测）：`releases/download/updater/update-fix-runtime.json` 与 `update.json` 均 404；
  `updater` 标签不存在；近 60 个 release 中没有任何 `*_fix_webview2_runtime-setup*` 附件。该渠道**从未对外提供过更新**。
- 处理（2026-11-11）：
  - `src-tauri/webview.{x64,x86,arm64}.json` 删除 `tauri.updater` 覆盖段。固定运行时安装包现在继承主通道
    （`releases/latest/download/update.json`，与主程序同一公钥）。
  - `updater/updater-for-fix-runtime.mjs` 与 `package.json` 的 `updater:fixRuntime` 已删除；
    `package.yml` 的 release-update 作业不再生成或上传 `update-fix-runtime.json`。
  - `package.yml` 的 `build-for-windows-fix-runtime` 作业仍构建固定运行时安装包（附件名不变），仅不再发布专用清单。
  - `tests/packaging.test.mjs` 已改为守护新的契约（webview 配置不得覆盖更新端点；退役文件不得再被引用）。
- 注意：固定运行时安装包的自动更新现在使用**标准**安装包清单，用户更新后会换成标准 NSIS 安装，不再保留内置运行时。
  若要恢复按固定运行时分发更新，需先在 release 流程中生成对应附件与清单。
- 在决定之前，**不要**把 `webview.*.json` 的端点改成其它第三方地址（§3.2 红线）。

### 注意

- `updater.mjs` 中的产物名依赖 `tauri.conf.json` 的 `package.productName`（当前 `cup-translate`）。
  **改 productName 必须同步改这两个 mjs 和 CI 里的重命名步骤。**
- 清单生成按当前触发的 tag 读取 release；签名缺失或为空时脚本直接失败，
  不会上传无法通过验签的更新清单。

## 8. 权限与分工
- **维护者（现状负责人）**：审 PR、合并、规划、发版
- **贡献者**：按 CONTRIBUTING 提 PR/Issue
- 初期单人可速跑，达到握手需至少 2 名活跃维护者再正式化

## 9. 风险
| 风险 | 缓解 |
|---|---|
| Wayland 上游协议限制（划词）| 预留 XWayland + curl 外部调用兜底 |
| 上游版权/商标使用 | 保留 GPL、改掉 pot 名称、不主张原商标 |
| 单人维护精力 | 控制默认功能边界，减少维护面 |
| 前端依赖告警 | `pnpm audit --prod --registry https://registry.npmjs.org` 现仅剩 1 条 low（`deepmerge`，上游无修补版本，属于 NextUI 构建期依赖）；high/moderate 已通过升级 React Router、覆盖 `source-map-js`/`glob`/`minimatch`/`lodash.omit`/`postcss-selector-parser` 清除。仍需随 NextUI 升级持续复查。 |
| Rust 依赖告警 | `zip` 已从 2.2.0 升级到 9.3.0，`tar` 已升级到 0.4.46；完整 lockfile 已知 23 条告警（定向升级已把 35 条降到 23 条），其中 15 条锁文件专属已按授权登记在仓库根 `.cargo/audit.toml`（复审 2027-02-11），`cargo audit` 当前报告 8 条进入发布产物的告警，需 Tauri 2.x 迁移消除。分类与理由见 [依赖审计基线](reviews/dependency-audit-2026-11-04.md)。不能把“已建立基线”理解为“已清零”。 |

---

> 意见/讨论：在项目 Issue 区发起「维护方向」讨论。☕
