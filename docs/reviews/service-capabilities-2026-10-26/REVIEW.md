# 四个并行修复提交的代码评审

评审日期：2026-10-26。评审范围为四个独立分支相对 `10f2a6e` 的修改。当前结论：发现四项可复现的 P2 问题，建议修正后再集成；独立分支测试通过，不代表组合版本或桌面安装包已经验收。本轮没有合并分支或修改运行时代码。

## 提交与复核结果

| 分支 | 提交 | 本轮 Node 全量复跑 | 本轮前端构建 | 本轮 Rust 定向复跑 |
| --- | --- | --- | --- | --- |
| codex/fix-plugin-compat | 40ed348e2dc89fea653e2b5f21116c71e2c955c3 | 530 通过 | 通过 | 22 通过 |
| codex/fix-dictionary-display | 24667e361c0474ffa7294dd2a6d5a7d2e30d5ff2 | 526 通过 | 通过 | 无 Rust 修改 |
| codex/fix-anki-collection | 5a5f79832bf54a11d0b1e46780b4ba1e6b7bbb88 | 527 通过 | 通过 | 4 通过，1 项按原标记忽略 |
| codex/fix-qwen-config | cd39e2a51a15f51a675f9b313c08550f8e9fda07 | 537 通过 | 通过 | 无 Rust 修改 |

测试命令为各 worktree 中的 `node --test tests/*.test.mjs` 和 `node node_modules/vite/bin/vite.js build`。插件 Rust 命令为 `cargo test --manifest-path src-tauri/Cargo.toml --locked plugin --no-default-features`；收藏命令为 `cargo test --manifest-path src-tauri/Cargo.toml credentials:: --bin cup-translate --no-default-features --locked`。这些测试共享大量基线用例，不能把四组计数相加称为独立测试数。

## 需要修复的问题

### R1 Lingva 将 HTTP 失败显示为测试成功

优先级：P2。归属：Qwen 分支附带的内置 TTS 配置修复。

位置：`src/services/tts/lingva/Config.jsx:49–50`。

新“测试”按钮仅等待 `tts()` resolve 就执行 `setTested(true)`。实际 Lingva provider 对非 2xx 响应没有抛错，而是返回 `undefined`。因此服务返回 HTTP 503 时仍显示测试成功；HTTP 200 但无有效音频也有相同风险。

本轮把真实 Lingva provider 与真实配置组件 handler 接在一起，注入 `{ok:false,status:503}`，得到 `displayedConnectionSuccess:true`。现有测试只模拟 provider 抛异常，没覆盖其 resolve 无音频的真实行为。

修复建议：provider 对 HTTP 失败和非法或空音频显式失败，配置测试仅在收到有效音频后标记成功。增加 503、200 缺 audio、空 audio 和有效字节数组的测试；继续保留离线保存能力。

### R2 语音配置读取失败时错误信息也被隐藏

优先级：P2。归属：Qwen 分支附带的 Lingva 和系统语音配置。

位置：`src/services/tts/lingva/Config.jsx:62–63`；`src/services/tts/local_tts/Config.jsx:30–31`。

两组件都以 null 初始化配置，读取失败后只设置 error；但整个内容及错误区又被 `config !== null` 包裹。IPC 或配置读取失败后会留下空白配置窗口，没有可见错误和重试入口。

本轮分别让两个组件的 `store.get()` reject，再执行真实组件渲染，结果均为 `false`。这是新的读取实现中的错误分支缺口，与保存失败后的错误显示不同。

修复建议：把加载、读取失败和编辑状态分开渲染，在配置不存在时仍显示读取错误、重试与关闭入口；不要用默认配置自动覆盖读取失败的旧配置。新增 get reject 后可见错误及重试成功的组件测试。

### R3 损坏插件无法通过正常重装修复

优先级：P2。归属：插件分支。

位置：`src-tauri/src/plugin_package.rs:289`。

正常 ID 的目标目录已存在时，安装器先对旧目录运行完整 `metadata()`，检查失败就拒绝新包。即使新包本身正确，只要旧 main.js、图标或 info.json 损坏，重装也无法继续。与此同时 discover 跳过损坏目录，用户无法在应用列表中选择卸载来恢复。

本轮直接编译并调用提交中的实际 Rust 模块，在临时目录执行：正确 fixture 首装成功 → 删除已装 main.js → 原包重装。结果为 `success:false,error:Missing plugin resource`，随后 discover 返回空列表；未操作用户插件目录。

修复建议：不要以旧包全部资源健康作为新包替换的前置条件。安全验证新包和目标路径，并独立处理能读取的旧身份信息；身份无法确认时提供明确、受控的修复或移除路径，保留旧配置与备份。增加缺 main.js、坏图标和损坏 info.json 后恢复的测试。

### R4 非英语词条已有的发音数据随分类修复一起被隐藏

优先级：P2。归属：词典展示分支。

位置：`src/window/Translate/components/TargetArea/index.jsx:1251`，以及同文件按 `isSingleWord` 限制 pronunciationFor 的逻辑。

新分类把中文归为 text，这是避免误报 IPA 所需的变化；但音标或拼音展示仅保留在 word 分支，而 word 又仅允许英语。已有可信发音数据也因此不再显示，包括用户截图里 Google 原本能展示的中文拼音。纯文本 provider 的 pronunciationFor 同样被英语单词条件短路。

本轮复用该分支对真实 TargetArea JSX 的渲染夹具，注入含 `pronunciations:[{symbol:"Xièzài xiàngdǎo"}]` 的中文结果，确认译文保留但发音文本不在渲染树；同一数据在英语 word 分支可显示。

修复建议：将“是否展示已有发音数据”与“是否显示英语单词词典视图及缺 IPA 提示”分开。中文不显示缺 IPA 警告，但仍展示来源明确的已有拼音；不得自行生成拼音或把拼音标为 IPA。覆盖真实 pronunciation 字段和 pronunciationFor 缓存两条路径。

## 合并预检与集成事项

使用 `git merge-tree --write-tree --name-only` 进行预检，未切换或合并任何用户分支：

- 插件 + Anki、插件 + Qwen、词典 + Qwen 的两两组合可以自动合并。
- 词典 + Anki 在 `src/window/Translate/components/TargetArea/index.jsx` 有内容冲突。需要保留词典状态、分类、隐私与朗读改动，同时保留收藏门闩、按钮状态和错误分类。
- 三语 JSON 在上述预检中自动合并，但组合版本仍需检查资源结构和缺失键。
- 尚未生成四分支组合版本，未执行组合版本测试、升级迁移或桌面 GUI 验收。

Anki 分支在本次覆盖范围内未发现新的可确认阻断问题；连接和写入仍需要隔离 profile 的实际验收。该结论不等于对真实 Anki、欧路账号、钥匙串和跨平台行为的验收通过。

建议回修分工：Qwen session 处理 R1、R2；插件 session 处理 R3；词典 session 处理 R4。完成后由主 session 检查追加提交，再在集成分支解决冲突并跑组合回归。真实 Tauri 双入口、音频、隔离 Anki 收卡和平台安装包保持为发布门槛。
