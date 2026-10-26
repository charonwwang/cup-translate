# dictionary 修复结果

日期：2026-10-26。基线 `10f2a6e`；分支 `codex/fix-dictionary-display`。
独立 worktree：`/Users/charonwwang/.codex/worktrees/fix-dictionary-display/cup-translate`。

## 调用链核对与实际实现

- 原代码已有无音标原文朗读按钮，但受“无空格”条件和单词视图限制，并非完全没有朗读入口。现在英语语言上下文 + 英文单词形态才进入单词视图；中日韩及未确认语言使用词语 / 文本视图；短语、单句、段落均保留原文朗读。
- 英语单词显示轻量“暂无词典音标（IPA）”；中文不展示该警告。不生成缺失 IPA、不将汉字或拼音冒充 IPA。本轮没有引入拼音推导、词典包或 P2 数据契约。
- 所有结果卡朗读动作区分原文、译文；TTS 读取文字及对应语言。地区音标本身不再附带冒充地区录音的通用 TTS；有字节录音时另显示“播放词典录音”。`pronunciation.voice` 的内置调用方（有道）实际返回字节，并非 URL 下载接口；旧播放器把字符串也当字节是错误的。本轮明确只接受字节，URL 不请求、不解码；无录音仍可按原文调用所选 TTS。
- 词典补全独立状态：查询中、有结果、无词条、失败、超时、隐私阻止。整体 15 秒 deadline 覆盖初查和可选补充；忽略 abort 的迟到结果同样不能发布。只补缺失音标、例句，不替换成功主译文或已有例句 / 释义。
- 新查词会取消旧请求；换原文、语言、引擎、请求代次和隐私模式均失效。展示还检查原文与语言等身份键，避免 effect 清理前短暂展示旧词条。
- 设备内模式在任务入口和既有服务策略两处拦截在线补全；录音路径不播放未知来源录音，不请求 URL；本地翻译、已有本地 TTS 调度保留。Google / Lingva 自带朗读优先和其他引擎使用后备服务的既定策略未改。
- 收藏调用仍接收原始成功结果，词典成功、失败、无音标都不改变此 payload；没有改 Anki 适配器或写入真实卡片。

## 验证

- `node --test tests/*.test.mjs`：526 通过，0 失败，含格式检查。
- `node node_modules/vite/bin/vite.js build`：通过（2542 modules，既有 Browserslist 数据过期和插件 eval 警告）。等价执行 package.json 的 test / build 脚本。
- 20 项直接相关测试通过：输入分类、真实 TargetArea JSX 渲染和点击回调、原文 / 译文 TTS 参数、收藏 payload、失败 / 无词条 / deadline、查词与补充两个阶段的竞态、旧卡片身份隔离、隐私入口零调用。
- 构建环境修复仅限本 worktree 的忽略目录：原目录 node_modules 含 macOS dataless 占位文件；新 pnpm 11 另有 overrides 校验阻断。使用现有 pnpm 10.33.0 执行 `install --frozen-lockfile --ignore-scripts --store-dir /tmp/cup-dictionary-pnpm-store`，随后用普通 Node 执行脚本。应用版本、锁文件、打包配置无改动。
- 没有 Rust 修改，不需要 Rust 检查。

| 验收 | 证据与结果 | 限制 |
| --- | --- | --- |
| W01 | hello 本地结果保留译文、无 IPA 轻提示、可点本地原文朗读；设备内补全禁用；组件行为测试 + 暗色 340px 实际 React 夹具 | HY-MT / TTS 由内存 IPC / 静音 PCM 模拟 |
| W02 | 卸载向导显示“词语 / 文本”，无 IPA 提示，原文 / 译文分别可朗读；实际点击原文按钮进入停止朗读状态 | 同上 |
| W03 | uninstall wizard 短语、Please uninstall the wizard. 单句，无单词音标占位；暗色 340px 无遮挡 | 同上 |
| W04 | 空结果、reject、超时、忽略取消的迟到响应、初查 / 补充阶段换词、换语言身份均有行为测试；主译文保留 | 未用真实在线词典制造超时 |
| W05 | 设备内任务入口 0 次 lookup / enrich 调用；策略检查期间取消也不调用；真实结果卡可用本地翻译 / TTS | 未运行网络抓包或真实系统 TTS 音色检查 |
| W06 | 真实结果卡收藏回调对有 / 无音标均传递相同主结果；已有 Anki 相关测试随全量通过 | 不调用真实 Anki；隔离 profile 真收卡由集成阶段验证 |

界面证据位于 `dictionary-evidence/`：W01、W02、W03 phrase、W03 sentence 四张暗色窄窗截图。夹具直接加载修改后的实际 React 页面，桌面 / 网络边界均为内存模拟；不宣称为 Tauri 安装包或真实模型端到端验收。使用方法已追加到 `tests/visual/README.md`。

## 集成事项与风险

- 主 session review 后按本分支 commit 集成；本任务不推送、不发布、不合并。
- 可能冲突的共享文件：`src/window/Translate/components/TargetArea/index.jsx`、三语 `src/i18n/locales/*.json`、`tests/translation-primary-transition.test.mjs`、`tests/visual/mock-desktop.js` / README。其余为本任务 resultView、独立 helper、相关测试和结果记录。
- 英语以外的词形保守使用文本 / 短语视图，不尝试无依据的跨语言分词。没有英文上下文的纯 Latin 输入也不猜作英语单词。
- URL 型词典录音暂不接入隐式下载；本轮保留字节录音与原文 TTS，未来 URL 提供者需独立带策略 / 来源的下载接口。
- 尚需主 session 在集成的 Tauri 安装包上验证真实本地模型、实际声音、窗口关闭 / 切词的原生播放生命周期；Windows / Linux、放大字体、真实在线提供者也未实机验收。
- 原目录未提交的评审与产品规范仅阅读；未修改或暂存原目录文件、带“ 2”的副本、Anki / 插件安装逻辑。

## 主 session 回修 R4

已有发音资料的展示已与英语单词分类解耦。中文、其他语言与句子保留 provider 提供的 pronunciations 或 pronunciationFor 缓存，不新增音标生成或网络查询；中文仍不显示缺 IPA 警告。复用相同发音展示组件，保留地区录音与隐私约束。新增结构化发音和缓存两条路径的真实 JSX 渲染测试，全量 Node 测试 528 通过。
