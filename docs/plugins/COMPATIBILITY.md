# Cup 插件兼容验证清单

测试日期：2026-10-26。Cup：3.0.13，基线 `10f2a6e` + `codex/fix-plugin-compat`（修复 commit 见同分支 RESULT-plugins.md / Git 记录）。平台：macOS 27.0.1 (26A434), arm64。未在 Windows/Linux 实机验收。自动化测试使用临时目录和受控依赖，未操作用户 Anki 数据或真实凭证。

状态按层次记录：“已验证”只适用于该行说明的层次；尚未实测的真实服务或桌面交互一律“未验证”。本表不承诺全部 Pot 插件兼容。Pot 的 official 标记不构成 Cup 背书。

| 样本 | 来源版本 | 安装/发现 | 执行结果与条件 | 真实服务/桌面 |
| --- | --- | --- | --- | --- |
| Cup 确定性四类 fixture | 本分支源码 | 已验证：Rust 真实 ZIP、磁盘安装/发现、升级、失败保留旧版、配置序列化重读、卸载 | 已验证：真实 JS 宿主在注入依赖下调用四类入口；收藏二进制另有真实本地进程测试。无凭证；不访问网络 | 未验证 GUI 配置/重启进程和音频播放；样本非产品服务 |
| `plugin.com.pot-app.lingva_tts` | [8c36bbd908d6](https://github.com/pot-app/pot-app-tts-plugin-template/tree/8c36bbd908d687f7cd02392099c3d9619e839dcd) | 已验证：由原样源码/元信息/图标重新打包的样本 | 已验证：固定源码 + 受控 HTTP 返回音频字节；需可用 Lingva 地址，默认联网。 | 外部 Lingva 与真实音频播放未验证 |
| `plugin.com.pot-app.anki` | [629c23e58121](https://github.com/pot-app/pot-app-collection-plugin-template/tree/629c23e5812197bf4839b79f215eb8be9f74f7e0) | 已验证：由原样源码/元信息/图标重新打包的样本 | 不兼容（该固定源码）：首次 HTTP 前抛出 Body is not defined；源码将 Body 误写为 Boxy。未改第三方源码。 | 真实 Anki 未验证；无写卡 |
| `plugin.com.pot-app.ecdict` | [aceea5798a92](https://github.com/pot-app/pot-app-translate-plugin-ecdict/tree/aceea5798a9269146d55ee3697d85a526630c176) | 已验证：由原样源码/元信息/图标重新打包的样本 | 已验证：固定源码 + 受控 SQL 行返回释义/音标；实际依赖 stardict.db，不调用外部二进制。 | 完整词库包、数据库加载和真实查词未验证；不标兼容 |

上游样本是固定 commit 的原样源码重打包，**不是上游发布页下载的二进制 release 包**；ECDICT 包不包含词库。原文件、许可和逐文件 SHA256 位于 [sources.json](../../tests/fixtures/plugins/upstream/sources.json)。GitHub API 当时限流，commit 经 `git ls-remote` 获取，再从固定 commit 的 raw URL 下载。未执行上游安装脚本。

## 包摘要

以下均为本仓库可重建样本。上游缺少 version 字段，使用固定 Git commit；Cup fixture 使用本分支源码版本。

| 样本包 | SHA256 |
| --- | --- |
| `plugin.cup.fixture.collection.potext` | `0940ad3fa952b7676f3494afc2c024274c9cb69038bb03ac1350aac74e2d2c6f` |
| `plugin.cup.fixture.recognize.potext` | `ebe6583996fcaaf675aec753b1721d97b000fd1dfbe91da7a7d64710dc1a244e` |
| `plugin.cup.fixture.translate.potext` | `5f64e606113987a9cdf9d1262f37dd02a49fe06241a80f37c8f9ceecaeef7f3e` |
| `plugin.cup.fixture.tts.potext` | `9805387ef9186e1c742ebc1b987ca191accda716bcd0c7faa69ac8eaa8849f76` |
| `plugin.com.pot-app.anki.potext` | `8e9a859408809e35904fddff8ca2fcbb42b2cfdf018877a95f183f4ede902e2e` |
| `plugin.com.pot-app.ecdict.potext` | `1636d6dacc4b897c6b5eb5871dfcbfe7b4e4f4a54b1e10d32d8523325d34e8d8` |
| `plugin.com.pot-app.lingva_tts.potext` | `adf84b674bfa72c414d17911de4119b95b83f107aff82c92436ef748fcd74c75` |

## 证据与尚未验收

- `tests/plugin-host.test.mjs`：实际 `invoke_plugin` 函数，四类结果、实例 ID、重新读取的配置、缓存入口设备内策略、上游 Lingva 受控 HTTP、ECDICT 受控 SQL、Anki 明确失败。HTTP/SQL 工具注入只证明宿主接口，不等于真实外部服务通过。
- `src-tauri/src/plugin_package.rs` 的测试：原始 ZIP 落盘、点分 ID、元信息/资源校验、Windows 路径拒绝、symlink/特殊位拒绝、大小及条目限额、坏包不覆盖旧版、完整升级无旧文件残留、事务标记恢复、旧别名保持、逐包结果和真实可执行文件。
- `tests/plugin-uninstall-order.test.mjs`：实际配置生命周期函数，保存与注册单次提交、失败不丢草稿/旧配置、卸载全部实例、最后服务保护、磁盘失败恢复引用、逐包 JS 语法预检。
- 未验证：真实 WebView IPC 点击、系统文件选择器、重启桌面进程、TTS 播放、带平台资源的上游 release 包、真实 Lingva、完整 ECDICT、隔离 Anki profile、Windows/Linux。没有把这些状态提升为“兼容”。

设备内模式不允许运行这些插件，包括离线 fixture 和 ECDICT；它们没有被授予离线可信身份。详见 [权限现实边界](README.md#安全与设备内模式)。
