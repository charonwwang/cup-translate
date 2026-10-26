# 服务修复合并与验证结果

完成日期：2026-10-26（Asia/Shanghai）。四个修复分支和评审回修已合并到本地工作主分支 `master`；最终运行时代码提交为 `a8439879c26cdf6c6ab13e4e604631a82d7c6d96`，本文与证据在后续文档提交中保存。最初合并验证阶段没有推送、发布或替换用户已安装应用；随后按用户要求完成本机替换，见文末记录。

## 修复与合并记录

| 内容 | 提交或合并 | 结果 |
| --- | --- | --- |
| Qwen 原修复及 R1 R2 回修 | `cd39e2a`、`2911cc4` → `67c3035` | 单层弹窗、显式保存和启用、单例迁移、真实失败判定、读取错误恢复 |
| 插件原修复及 R3 回修 | `40ed348`、`02bdddf` → `2d20cff` | 点分 ID、包验证及回滚、损坏安装可重装并保留旧目录 |
| Anki 与欧路收藏 | `5a5f798` → `ef8041f` | 只读测试、离线保存、凭证保护和写入确认 |
| 词典展示及 R4 回修 | `24667e3`、`2767e16` → `90490c0` | 跨语言分类、发音数据保留、请求竞态及隐私控制 |
| 集成补充 | `a843987` | 插件选择器先关闭再打开配置，增加回归测试与拼音视觉夹具 |

四个分支的最终提交均通过 `git merge-base --is-ancestor <branch> master` 检查。`TargetArea` 的冲突已同时保留 `createDictionarySupplement` 和 `createCollectionGate`；对应 JSX 测试环境也注入真实收藏门闩，避免孤立分支的测试替身在组合版本中失效。三语资源完成合并，未修改版本号、锁文件或打包配置。

## 评审问题关闭记录

- R1：Lingva 非 2xx、缺失、空或非法音频必须失败；重新测试会清除旧成功状态。测试直接运行真实 provider 与真实组件 handler。
- R2：Lingva 和系统语音配置在读取失败时独立显示错误、重试与关闭。重试或换实例后旧响应不覆盖新值，不用默认值覆盖无法读取的配置。
- R3：旧资源健康与旧身份核对分离。规范 ID 的损坏目录允许正确包恢复；旧目录成为 previous 备份。已知身份不同仍拒绝，历史别名身份不可读则明确提示恢复 manifest 或移除旧包。
- R4：已有 pronunciation 字段和 provider pronunciationFor 缓存跨展示模式保留，中文仍不出现缺 IPA 提示。没有新增音标生成或隐式网络查询。

## 自动化与构建

环境：macOS ARM64，Node 24.21.0，Rust 1.99.0。最后一次前端测试与生产构建针对 `a843987`。Rust 与 Python 验证包含已合并回修代码，之后只增加插件选择器的一行关闭处理、前端测试及视觉夹具。

| 检查 | 结果 |
| --- | --- |
| 所有受 Git 管理的 Node 测试 | 577 通过，0 失败 |
| Vite 生产构建 | 通过，3.81 秒 |
| Rust 全量 `--no-default-features --locked` | 195 通过，0 失败，6 项按原标记忽略 |
| Qwen Python runtime 测试 | 4 通过 |
| 原生开发构建 | 通过，使用独立 bundle identifier，未启用 updater feature |
| `git diff --check` | 通过 |

受 Git 管理的前端测试可从仓库根目录复跑：

```sh
git ls-files -z 'tests/*.test.mjs' | xargs -0 node --test
node node_modules/vite/bin/vite.js build
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
python3 tests/test_qwen_runtime.py
```

原目录中已有的未跟踪“ 2”副本保持原样，没有把旧测试副本作为当前版本测试执行。Rust 使用插件 worktree 的 target 缓存构建本工作目录源码，不依赖它的旧源码。六个忽略项分别为系统钥匙串写入，以及需要外部固定模型目录的 HY-MT、Kokoro、M2M-100、OPUS-MT 和 Piper 实测。

原 node_modules 含按需下载占位文件，测试启动时挂起；已保留为忽略目录 `node_modules.pre-integration.local`，并用 pnpm 9.15.9、现有锁文件执行 `install --frozen-lockfile --ignore-scripts` 重建当前依赖。没有提交依赖产物或修改锁文件。

只读核查脚本也已适配新的 Anki 客户端与带语言的分类接口；[修复后契约输出](integration-evidence/source-contracts.json) 显示点分 ID 通过、业务错误在 version 阶段停止、中文归为 text、关闭不再调用保存。原始 evidence.json 继续保留修复前基线。

## 原生桌面验证

验证应用使用独立标识 `com.cup-translate.validation-20261026`，配置目录为 `~/Library/Application Support/com.cup-translate.validation-20261026`，只写入新建的测试配置与自有 fixture。程序使用本轮合并源码的原生 Rust 后端和 Vite 前端。它是本地开发构建，不是已签名发行安装包。

| 操作 | 实际结果 |
| --- | --- |
| 服务设置 → 语音合成 → 添加 Qwen | 一个模型管理弹窗，无空壳服务配置叠层；关闭返回服务列表并恢复触发按钮焦点 |
| 模型中心 → 语音模型 → 添加 Qwen | 同一个管理器，未叠加语音系列选择器 |
| Qwen 改 1.7B 草稿 → Esc → 放弃 | 显示放弃提示；退出后配置未写规格，speech_policy 保持 local，没有启动下载 |
| Anki 未连接时保存 | 显示“已保存，尚未确认连接”；取消返回后服务列表出现 Anki；磁盘有且仅有一个新实例 |
| 系统文件选择器安装点分 ID 插件 | 自有 `plugin.cup.fixture.translate.potext` 经 WebView 预检、真实 IPC、Rust 安装与目录发现成功 |
| 配置插件实例 | prefix=integration 保存到独立配置；配置关闭后返回服务列表，没有选择器叠层 |
| 模拟插件入口缺失再原包重装 | 只将测试目录的 main.js 改名为可恢复备份；真实界面重装成功，main.js 恢复、previous 目录保留、实例 prefix 保持 integration |

桌面验证期间保持设备内隐私模式；未执行第三方插件、未操作真实 Anki 卡片或欧路账号、未读取真实服务凭证。验证完成后已退出测试应用并停止临时开发服务器；测试配置和临时应用保留以便复查，不影响日常安装。

原生证据：[Qwen 单层弹窗](integration-evidence/native-qwen-single-modal.png)、[Anki 离线保存](integration-evidence/native-anki-offline-saved.png)、[插件重装成功](integration-evidence/native-plugin-reinstalled.png)。

## 中文拼音的界面验证

使用合并后的实际 React 结果页，注入 Google 兼容响应，通过现有 pronunciationFor 缓存提供 `Xièzài xiàngdǎo`。在 340px 暗色布局中，中文显示“词语 / 文本”、已有拼音和译文，不显示缺 IPA 提示；原文与译文朗读入口分别存在。此项是隔离响应夹具，不是实时 Google 调用。

证据：[340px 暗色拼音结果卡](integration-evidence/fixture-chinese-pinyin-dark-340.png)。

## 仍需独立环境验收的范围

本轮修复、分支合并、组合自动化和上述原生交互验证已完成。以下外部能力不在本次通过声明中：已签名发行安装包升级、Windows/Linux 实机、完整 ECDICT 数据包、真实在线 Lingva、隔离 Anki profile 收卡、欧路测试账号写入、Qwen 大模型重新下载及真实推理。缺少对应环境与资源时不将其标记为已验证，也不将 Pot 插件目录整体标为兼容。

## 本机已安装应用替换

2026-10-26 按用户要求，将源码 `7e039ed` 构建为 ARM64 optimized release 应用，内嵌生产前端资源，不依赖 Vite。安装到 `/Applications/cup-translate.app`，应用标识保持 `com.cup-translate.app`，版本号保持 3.0.13，Info.plist 额外记录 CupTranslateSourceCommit。已通过本地签名完整性校验并实际启动，设置页使用 `tauri://localhost/service`，停留在语音服务页供用户实测。没有推送或公开发布。

旧应用和配置的私有备份保存在 `~/Library/Application Support/cup-translate-local-backups/20261026-161030-7e039ed/`。旧应用通过移动完整 bundle 保留，配置在替换前另存快照，现有模型目录保持原位。`installation.json` 记录新旧可执行文件摘要和替换结果；本机截图只保存在该备份目录，不随仓库公开。

## 用户实测后的配置与语音回修

步骤样式缺失、试听等待、内存及磁盘语义、配置弹窗一致性的后续修复与真实模型证据见 [模型配置交互与 Qwen 试听回修](UX-AND-RUNTIME-FOLLOWUP.md)。该记录在上述初次替换之后执行，包含本机真实推理验证。
