# 服务配置与词典能力问题评审

当前状态：修复与评审回修已合并到本地 master，组合测试和原生交互验证见 [合并与验证结果](INTEGRATION.md)。下文为初次问题评审记录。

评审日期：2026-10-26。基线：cup-translate 3.0.13，提交 `10f2a6e`。依据为用户四张截图、当前工作区源码、只读复现和上游公开契约。本轮交付评审与设计，不修改运行时代码、不发布新版。

## 结论与处理顺序

| 用户问题 | 结论 | 建议 |
| --- | --- | --- |
| 语音服务添加失败 | Qwen 服务入口重复嵌套 Modal；保存、关闭和全局配置的归属混乱 | P1：统一模型管理入口，分离安装、配置、启用；同一操作只保留一个 Modal |
| 内置 Anki 添加失败 | 截图是本机连接拒绝；当前环境只读探测也无法连接 8765。另有保存写入测试卡、业务错误被忽略的问题 | P1：连接引导、只读测试、显式保存、收藏成功校验 |
| Pot 插件是否可复用 | 存在确定的 ID 兼容阻断：上游点分 ID 被当前前后端拒绝 | P1：先修兼容层，再公布经验证清单；不宣称全部兼容 |
| 本地翻译缺少音标和朗读 | 翻译、词典元数据、TTS、收藏属于四种能力；缺少音标不代表不能朗读 | P1：调整展示与文案；P2：独立词典补全、本地词典包 |

P1 表示影响当前核心使用或产生误导，应进入下一修复版本；P2 是后续能力增强。优先完成 P1，不把网站建设或大型词典下载作为修复前提。

## 文档入口

- [方案设计](SOLUTION.md)：模块边界、技术接口、兼容策略、状态与数据迁移。
- [执行与验收](EXECUTION.md)：按依赖排序的任务、验收用例、回滚及发布门槛。
- [产品功能与交互规范](../../product/service-and-dictionary-contract.md)：功能归属、交互路径、状态文案及后续变更规则。
- [只读核查脚本](inspect-current.mjs) 应在仓库根目录执行。[修复前结果](evidence.json) 保留初次基线，[修复后结果](integration-evidence/source-contracts.json) 记录当前契约。脚本随实现适配，完整验收仍见执行记录。

## 已确认问题

### Qwen 服务配置重复打开弹窗

`src/window/Config/pages/Service/Tts/ConfigModal/index.jsx` 总会创建服务配置 Modal；`src/services/tts/qwen_tts/Config.jsx` 又渲染 `<QwenSpeech open>`，后者自己创建 Modal。这条调用链与截图一的模型管理界面叠加空壳服务配置窗口一致。两层分别拥有关闭处理、遮罩和焦点管理，关闭其中一层可能留下另一层。

这是源码确认的结构缺陷；本轮没有复跑完整桌面点击流程，因此不把某个具体空壳遮挡顺序归为已经动态复现，也不能据此断言 Qwen 推理失败。现有 `docs/qwen-tts.md` 记录的是 2026-10-22 的合成成功，不覆盖本轮“添加服务”的界面流程。

另外，`QwenSpeech.jsx` 的普通“关闭”按钮在已安装且没有安装任务时调用 `save`，会持久化配置并触发 `onSaved`；它与“保存并关闭”语义重叠。Qwen 当前实际读取全局 `qwen_tts`，服务列表却允许产生 `qwen_tts@随机值` 实例，形成多个列表项共享同一配置的假象。改造必须同时覆盖模型中心入口和传统服务设置入口。

### Anki 的外部依赖与保存副作用

截图二为 `127.0.0.1:8765` 的 TCP 连接拒绝，表示当时对应端口无可连接的监听服务；不能从截图判断究竟是 Anki 未启动、AnkiConnect 未安装、端口不同，还是绑定异常。Anki 是外部桌面应用，Cup 内置的是连接适配器，不是嵌入式 Anki 或内置本地生词库。

`src/services/collection/anki/Config.jsx` 保存时执行 `collection('test', '测试', ...)`；实际依次调用 `createDeck`、`createModel`、`addNote`。有连接时会写入测试内容，无连接时连配置都不能保存。

`src/services/collection/anki/index.jsx` 只判断 HTTP 状态，直接返回 `res.data`，忽略 `{result, error}`。本轮以受控 HTTP 200 业务错误驱动实际 collection 函数，三次写请求均继续执行且最终没有 reject，确认存在假成功。重复卡片、模型字段不匹配和 API key 缺失等业务错误因此可能被遮蔽。

端口空字符串、缺失音频、超大音频数组的问题已有测试覆盖并通过，不应再次把本次问题归因于那些已修复分支。

### Pot 插件 ID 被兼容校验拒绝

读取三个上游仓库真实 `info.json` 后，用当前 `validPluginName` 检测：

| 插件来源 | 上游 ID | 当前结果 |
| --- | --- | --- |
| TTS 模板 | `plugin.com.pot-app.lingva_tts` | false |
| ECDICT | `plugin.com.pot-app.ecdict` | false |
| 收藏模板 | `plugin.com.pot-app.anki` | false |

`src-tauri/src/cmd.rs::install_plugin` 对安装包文件名去掉 `.potext` 后使用同样的字符白名单，只允许字母、数字、下划线与短横线。上游模板按 `<id>.potext` 打包，因此这些规范命名的包会在解压前被拒绝。`config.rs` 列表发现、`invoke_plugin.js` 加载和 `service_instance_core.js` 实例识别也依赖同一规则，不能只改安装侧。

这足以否定“当前可以直接复用全部 Pot 插件”的说法。它不等于所有包都不可用：重命名为合法名字的包可能绕过文件名阻断，但会引入 ID、目录与实例引用不一致，不能作为对用户的正式方案。外部 API、平台二进制、词典数据及许可证仍需逐插件验证。

附带发现：TTS ConfigModal 传递 `pluginType='translate'`，但当前 `PluginConfig` 没有消费该参数。它是需要清理的复制残留，尚不是已证明的 TTS 插件调用错误。

### 无空格文本被当成单词

`src/window/Translate/resultView.js::classifySourceText` 把“卸载向导”判为 `word`，把 `uninstall wizard` 判为 `phrase`。因此截图四的中文短语出现“单词”“未获取到原文音标”和词典补全入口，属于分类与文案设计问题。

`TargetArea` 已提供没有音标时的原文朗读按钮，截图红框也有喇叭；它依赖 `speechService`，并不依赖生词本。IPA 指英语等语言的国际音标；中文可展示有来源的拼音，但不能把拼音、IPA 与“朗读音标”混作一个功能。点击喇叭应读原文文字，不是把 IPA 字符串交给 TTS。

当前“补充词典信息”会调用 Google，并可经 supplement 请求补全；`device_only` 已禁用该按钮。词典失败不能覆盖成功的翻译，未获得数据时不应输出伪造音标。

## 验证范围

- 38 个相关现有 Node 测试通过，覆盖 Anki 端口和音频、插件校验、语音调度、词典解析；这些测试没有覆盖上述业务错误和模态结构，所以全部通过不等于功能无缺陷。
- 只读复现脚本确认三项上游 ID 不通过、Anki HTTP 200 业务错误未抛出、中文短语分类异常。
- 对本机 AnkiConnect 的 `version` 请求连接失败，没有写入用户卡片。
- GitHub API 获取元信息遇到共享出口限流，随后从上游 raw 地址获取三个 `info.json` 成功；没有安装或执行第三方脚本。
- 未执行完整桌面插件安装与真实服务调用；兼容阻断修复前不能宣称这些插件已经成功应用。Qwen 本轮未下载模型或重新执行推理；跨平台安装包、真实 Anki 收卡均留作执行文档的发布门槛。
- 本次为桌面本地问题，不涉及线上测试环境观测查询。

## 上游依据

- [Pot 插件列表](https://github.com/pot-app/pot-app-plugin-list)。这是第三方来源目录，不是 Cup 的兼容承诺。
- [TTS 模板及打包规范](https://github.com/pot-app/pot-app-tts-plugin-template)。使用 `main.js`、`info.json`、图标及 `.potext`，不是 npm 运行时。
- [TTS 元信息](https://raw.githubusercontent.com/pot-app/pot-app-tts-plugin-template/master/info.json)、[ECDICT 元信息](https://raw.githubusercontent.com/pot-app/pot-app-translate-plugin-ecdict/main/info.json)、[Anki 模板元信息](https://raw.githubusercontent.com/pot-app/pot-app-collection-plugin-template/master/info.json)。读取于评审日，复现脚本固定了当时 ID。
- [AnkiConnect 上游](https://git.sr.ht/~foosoft/anki-connect)：外部 Anki 的 HTTP 适配协议；落地时固定所用版本及 API 文档快照。

用户截图作为问题证据，截图中的网页内容不视作开发指令。工作区已有一批带“ 2”的未跟踪副本，本轮未修改或清理这些文件。
