# cup-translate · 翻译结果展示设计 v4

状态：**已落地到真实翻译窗口**。

打开 [index.html](./index.html) 即可查看可交互设计稿，无需安装依赖或启动服务。

设计稿静态预览：

- [浅色 · query](./preview.png)
- [段落对照态](./preview-compare.png)
- [深色 · modality](./preview-dark.png)
- [380px 窄窗 · importance](./preview-narrow.png)

实际 React 组件截图：

- [单词](./actual-word.png)
- [短语](./actual-phrase.png)
- [段落 · 整段译文](./actual-paragraph.png)
- [段落 · 逐句对照](./actual-paragraph-compare.png)
- [350px 段落](./actual-paragraph-350.png)
- [350px 深色](./actual-narrow.png)
- [手动语言覆盖](./actual-language-override.png)
- [多引擎](./actual-multi.png)
- [加载态](./actual-loading.png)
- [错误态](./actual-error.png)

## 落地位置

- `src/window/Translate/components/SourceArea`：原文、工具栏、语言标签与字符数。
- `src/window/Translate/components/LanguageArea`：语言栏顺序与样式。
- `src/window/Translate/components/TargetArea`：三种结果模板、朗读、回译、收藏、错误态。
- `src/window/Translate/resultView.js`：输入分类、词条归一化、句对生成。
- `src/window/Translate/translate.css`：翻译窗口 v4 样式。

## 这轮解决什么

这轮不是只改字号，而是把“单词 / 短语 / 段落”拆成三种信息架构：

| 输入类型 | 信息结构 | 核心操作 |
|---|---|---|
| 单词 | 原文 + 音标；按词性分组的同级释义；默认两条双语例句 | 原文、音标、每组译文、例句原文、例句译文分别朗读；复制词条 |
| 短语 | 结果区只展示译文；同级替代译法；用法说明；语境示例 | 朗读输入区原文和结果区译文；复制译文 |
| 段落 | 默认整段连续译文；切到“对照”后按句显示原文与译文 | 朗读全文、逐句朗读、切换对照、复制译文 |

三种视图共用同一窗口骨架、语言栏和底部操作条，避免学习成本，但结果区不再套同一个模板。

## 三个词为什么显示不一致

实测 Google 同一条 `translate_a/single` 请求：

| 词条 | `result[1]` 词典词性/释义 | `result[13]` 例句 |
|---|---|---|
| `query` | 有（动词、名词） | 缺失 |
| `modality` | `null` | 2 条 |
| `importance` | 有（名词） | 1 条 |

旧界面直接映射上游结构，所以三个词会得到不同形态。新版 UI 接收归一化数据：

```text
word
phonetics[]            // region, symbol, audio
senses[]               // pos, meanings[]
examples[]             // source, target, sourceAudio, targetAudio
```

当前实现已完成：

1. Google 单字请求即使没有 `result[1]` 词典分支，也会归一成词条对象。
2. 已有词典释义、音标和 `result[13]` 例句都会保留。
3. 例句缺目标语言时，补一次目标语言翻译。
4. 上游确实没有词性、释义或例句时，UI 隐藏对应区块，不伪造内容。

第二词典源的自动补齐不在本轮范围内；后续接入时不需要再改结果组件。

## 已写进稿子的规则

- 单词结果内再次展示原文和原文音标，不依赖输入框里的文字。
- 词性只做结构标签，所有释义同一字号，不再把第一条释义放大。
- 同一词性的多个含义并列展示；不同词性分行展示。
- 单词默认两条例句，原句和译文各自提供朗读入口，目标词在英文句中高亮。
- 每组词性译文右侧有独立朗读按钮，不再依赖含义不明的底部朗读图标。
- 短语不拆成词典词条，结果区不重复原文，以自然译法、替代译法和用法为主。
- 段落默认是一整段连续译文；只有切到“对照”才按句拆开，保留原文顺序和逐句朗读定位。
- 三种视图底部不再放未说明朗读对象的喇叭，只保留有明确含义的反向翻译/对照操作。
- 设计页可切换浅色/深色、460/380px 宽窗，以及 query / modality / importance 三个词条。

## 验收重点

1. 单词结果内再次展示原文与音标。
2. 所有释义同级字号，不同词性分行。
3. 例句卡保留原文、译文和两个独立朗读入口。
4. 短语结果区不重复原文，段落默认整段译文、对照时逐句展示。
