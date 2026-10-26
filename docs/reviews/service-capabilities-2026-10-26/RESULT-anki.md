# anki：内置收藏与导出修复结果

日期：2026-10-26（Asia/Shanghai）。基线：`10f2a6e`。分支：`codex/fix-anki-collection`。
Worktree：`/Users/charonwwang/.codex/worktrees/fix-anki-collection/cup-translate`。

## 范围与调用链核对

按用户补充排查整个收藏模块。当前内置服务只有 Anki、欧路词典，均已修复并用受控接口验证；插件兼容、词典补全、本地复习系统不在此任务。

- 原评审对 Anki 保存写测试卡、忽略业务 error 的判断准确。
- 扩展排查发现欧路保存也调用 `collection('test', ...)`，会创建生词本、写入测试词；现一并移除。
- 原 `useConfig(..., {sync:false})` 仍会在首次打开时写默认配置，强制保存走防抖且不返回持久化结果。内置收藏编辑器改用独立草稿控制器，不修改共享 hook；仅点击保存才持久化，保存配置与服务列表在一次现有原子磁盘提交中完成，失败回滚暂存内存，保留草稿。
- “添加服务”选择框原先没有在打开配置时关闭，现关闭选择框后打开配置，避免叠层。内置编辑器的关闭、取消、Esc/遮罩关闭遇到未保存编辑时，在同一弹窗内提供放弃/继续编辑；保存期间阻止关闭。
- 欧路原 `id` 参数仍属官方兼容参数，并非确定失效。本次改为推荐的 `category_id`；保留兼容的 `words` 格式，避免用新 `items.star` 意外重置既有星级。沿用英语词条导出语义，不宣称保存译文、词典音频或全语种本地生词库。

## 实现

1. Anki 可注入传输适配器统一验证 HTTP、JSON 信封、非空业务 error、动作对应 result、v6 能力和 deadline。真实 Tauri 传输先读取文本，再解析 JSON，使非 JSON 响应可被准确分类为协议错误。
2. 配置页说明 Anki 桌面版、AnkiConnect、重启和默认本机端口；显示默认牌组/模板。测试仅请求 `version`；欧路测试仅 GET 生词本列表。保存完全不调用远端，不要求 Anki 在线或欧路 Token 已可用，显示未确认连接或本次连接通过。
3. 修改草稿立即使测试结果失效；测试代次防止迟到响应覆盖新草稿，关闭后忽略响应。保存期间禁用编辑/重复保存，写盘失败不假报成功。
4. 真正收藏时才探测牌组、模型；已有模型校验六个必需字段，缺少模型才创建并再次校验，缺少牌组才创建。任何失败停止后续动作，不覆盖用户模板；只有正的安全整数 note ID 才成功。
5. 重复、授权、字段、协议、连接错误分别本地化；addNote 超时、丢响应、异常 HTTP 或非法结果显示“结果未确认，先检查 Anki”，无自动重发。外部错误正文和卡片内容不进入默认日志/Toast，防止服务回显密钥。
6. 原文、译文、释义和音标中的 HTML 特殊字符转义，换行转 `<br>`；无音频正常导出，URL 不冒充音频字节；500KB 大数组继续分块编码。仅输出两个模板音频字段，单项最多 10MiB，使用安全唯一文件名防止路径注入和覆盖其他卡片音频。
7. 欧路校验生词本列表、创建结果和写入确认（官方 HTTP 201 + JSON message），使用字符串 ID 保留大整数精度，区分授权/限流/协议/结果未知。缺失生词本只在实际收藏时创建；未确认写入不重试。
8. 收藏按钮具有请求中状态和同步防重入门闩；新增中、英、繁中资源，页签名称改为“收藏与导出”，Anki 名称改为“Anki 连接”。其他语言沿用既有英文回退。
9. Anki API key、欧路 Token 复用现有系统凭证库、`secretRefs`、启动迁移及导出脱敏机制。输入为密码框，保存后不在普通配置存放明文；重新打开只显示凭证已保存占位，可替换/清除。不读取真实凭证、不进行真实账户 API 调用。

## 验证

锁文件、版本号、依赖声明及打包配置均未更改。

- `npx --yes pnpm@9.15.9 test`：**527/527 通过**，含全仓格式检查。
- `npx --yes pnpm@9.15.9 build`：**通过**（Vite 5.4.10）。
- `cargo test --manifest-path src-tauri/Cargo.toml credentials:: --bin cup-translate --no-default-features --locked`：**4 通过、0 失败、1 忽略**；忽略项为原有明确要求系统钥匙串写入的集成测试。编译通过，含新增凭证封装、幂等性、失败和备份脱敏用例。
- `rustfmt --edition 2021 --check src-tauri/src/credentials.rs`：通过。
- `git diff --check`：通过。

环境说明：系统 pnpm 12 对当前仓库 `package.json` 中既有 overrides 配置报 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`；复用原目录依赖时原生模块读取另曾卡住。最终在本 worktree 以 pnpm 9.15.9、现有锁文件执行 `install --frozen-lockfile --ignore-scripts`，安装后正常测试和构建。未修改原目录依赖或提交依赖安装产物；未改锁文件。Rust 未执行全功能发行打包，仅执行上述针对性编译/测试。

### A01—A10 对应证据

| 编号 | 自动化结果 | 真实应用状态 |
| --- | --- | --- |
| A01 | 草稿控制器离线保存，远端调用为 0；配置与列表提交、失败回滚均通过 | 桌面重启后复读配置待验 |
| A02 | 连接异常、只读 deadline、简短错误分类与保留草稿通过 | Anki 未启动的桌面提示、布局待验 |
| A03 | 受控 HTTP 200 + error 拒绝；创建模型失败后停止；无假成功 | 实际插件业务错误待验 |
| A04 | HTTP 失败、非 JSON、信封缺字段、错误类型、版本不足均拒绝 | 真实不同 AnkiConnect 版本待验 |
| A05 | 受控 HTTP 请求记录证明仅 `version`，无写动作；欧路仅 GET | 隔离 profile 前后笔记/模型/牌组计数待验 |
| A06 | 首次创建、第二次复用，字段查询与合法 note ID 校验通过 | 实际生成卡片与 note ID 回查待验 |
| A07 | 重复、字段、授权分别分类；已有字段不符时没有写请求 | 隔离 profile 真实异常待验 |
| A08 | 受控 HTTP 延迟响应，addNote 只发一次，结果未知；欧路写入同样不重发 | 服务端先写入再断开响应待验 |
| A09 | 构造实际 note payload 验证转义、换行、无音频、500KB 音频、安全文件名 | 实际 Anki 卡片渲染/音频播放待验 |
| A10 | 改端口/密钥后迟到成功或失败均无法修改新草稿状态，关闭后忽略响应 | 桌面输入、Esc/焦点/遮罩待验 |

受控测试使用 Node 本地 HTTP 服务和应用实际 `createCollectionTransport`、Anki/Eudic 客户端及收藏编排；无真实 Token、无 AnkiConnect 默认端口写入。草稿、失败回滚和按钮门闩通过运行实际控制器验证；没有把源码字符串检查或模拟接口通过称为桌面端到端验收。既有音频源码提取测试已替换为直接执行真实 note 构造逻辑。

## 契约来源

读取日期 2026-10-26；实现保持 AnkiConnect legacy API v6。

- AnkiConnect [API_LEGACY.md](https://git.sr.ht/~foosoft/anki-connect/blob/master/API_LEGACY.md)，获取内容 SHA256 `dc6f3fb6be20c215440c68c4221cdddb4c11f931022668310ddbdbe6048f37c1`。本次使用 `version`、`deckNames`、`modelNames`、`modelFieldNames`、`createDeck`、`createModel`、`addNote`，其结果校验固定在客户端与 HTTP fixtures 中。
- 欧路[开发指南](https://my.eudic.net/OpenAPI/Doc_Index)、[生词本 API 原始文档](https://my.eudic.net/doc/api_study.md)，后者获取内容 SHA256 `fb705498c82f0aac04063d5862801e53ea7d9d5cec4bb9fa3b63891ce28a2b19`。其官方页面通过 JS 载入 Markdown，不能把页面初始空壳误判为无契约。

## 待集成与实机验收

- 未找到或创建隔离 Anki profile，未操作日常 Anki 卡片；没有可用隔离欧路测试账户，因此未真实收卡/写入欧路。主 session 需在隔离 profile 完成 A05—A09（含建资源次数、实际内容/媒体、重复和写入未知恢复），只清理带测试标识的测试数据。
- 待 macOS 桌面完整交互：添加两个内置服务、保存/重开/重启、关闭草稿、存储失败、列表同步、800×600 与暗色布局、键盘和焦点。Windows/Linux 同等流程未实测，系统钥匙串不可用时的恢复也需各平台确认。
- 后续可增加结果未知时按稳定标识查询；本次采用明确人工检查后重试，不自动重发。
- 系统凭证迁移失败会保留旧磁盘配置，仍沿用现有安全迁移约定；用户必须恢复系统凭证库后重新保存。普通导出继续脱敏。此安全路径有纯逻辑测试，未执行真实钥匙串写入集成测试。

可能冲突的共享文件：`src/utils/credentials.js`、`src-tauri/src/credentials.rs`（仅扩展服务 schema 和单测）、`src/i18n/locales/{en_US,zh_CN,zh_TW}.json`（收藏相关子树/页签）、`src/window/Translate/components/TargetArea/index.jsx`（收藏处理和按钮）、`src/window/Config/pages/Service/Collection/{ConfigModal,SelectModal}/index.jsx`。其余改动在 `src/services/collection/` 和对应测试内。主 session 集成时保留其他任务对这些共享文件的独立修改。

原工作区的评审文档、共享产品规范和所有“ 2”副本均未改动。本分支未推送、发布或合并其他分支。
