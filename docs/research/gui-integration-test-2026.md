# GUI 集成验证与翻译实测报告

> 本报告补充 `translation-engine-benchmark-2026.md`（引擎层基准），聚焦**真实运行的应用**。
> 方法：在真实 X11 桌面（1920x1080，display `:1`）上运行 Release 二进制，通过 HTTP 接口驱动，
> 用 `import` 截图 + `tesseract` OCR 读取界面，从应用日志与 `history.db` 取证。
>
> ⚠️ 与引擎层报告不同，**本报告的结论全部来自实际跑起来的应用**。

---

## 0. 三个最重要的结论

1. **集成链路本身是通的** —— 划词 → 弹窗 → 翻译 → 渲染，全流程正常。这不是一个有架构问题的项目。
2. **但默认引擎组合 6 个里 4 个失效**（实测 80% 失败率），且**失败是静默的**：用户只看到成功的那个，不知道其余都坏了。
3. **发现并 100% 复现一个真实回归 bug**：全新安装时界面语言是**英文**，而非 commit `f252133` 声称的简体中文。

---

## 1. 端到端集成验证：通过 ✅

### 1.1 测试方法

```bash
DISPLAY=:1 ./src-tauri/target/release/cup-translate    # 启动
curl -X POST -d "Hello, world. This is an integration test of cup-translate." \
     http://127.0.0.1:60828/                            # 模拟划词
import -window <wid> shot.png && tesseract shot.png -l chi_sim+eng
```

### 1.2 结果

| 环节 | 结果 |
|---|---|
| 应用启动 | ✅ 窗口创建，托盘常驻，无崩溃 |
| 本地 HTTP 服务 | ✅ `127.0.0.1:60828` 正常监听，路由响应 200 |
| 翻译窗口弹出 | ✅ 350x420，位置正确 |
| 源文本渲染 | ✅ 完整显示 |
| 语言栏 | ✅ `自动检测 → 简体中文` |
| 译文渲染 | ✅ **"你好，世界！. 这是cup-translate的集成测试。"** |
| 历史记录 | ✅ `history.db` 写入 |

**截图 OCR 实录**（翻译窗口）：

```
Hello, world. This is an integration test of cup-translate
自动检测   =   简体中文
回 DeepL              Y
   必应翻译            3
   Lingva             x
   Yandex             x
你好，世界！. 这是cup-translate的集成测试。
```

**结论：核心功能（划词→翻译→显示）工作正常。** 集成层没有阻塞性问题。

---

## 2. 默认引擎实测：6 个里 4 个失效 ⚠️

同一次翻译请求触发的**全部引擎调用**（取自应用日志，非推测）：

| 引擎 | 结果 | 原因 |
|---|---|---|
| `deepl` | ❌ reject | `Http Request Error` —— **需要 API key，但实例配置是空的 `{}`** |
| `bing` | ❌ reject | `Get Token Failed` —— `edge.microsoft.com/translate/auth` 返回 404 |
| `lingva` | ❌ reject | **DNS 无法解析** —— `lingva.pot-app.com` 域名已不存在 |
| `yandex` | ✅ **resolve** | `你好，世界！. 这是cup-translate的集成测试。` |
| `ecdict` | ❌ reject | `Http Request Error` —— 上游 `pot-app.com/api/dict` 不可用 |
| `google` | — | 本环境网络不可达，未能验证 |

**实测失败率：4/5 被调用的引擎失败（80%）。**

### 2.1 最严重的问题：失败是静默的

代码逻辑（`TargetArea/index.jsx:177-180`）：失败时 `setHide(true)` 保持**卡片折叠**，
只有成功的引擎会展开显示译文。

**用户看到的是**：一个干净的结果列表，其中 Yandex 正常显示中文译文。
**用户看不到的是**：其余 4 个引擎全部报错。

→ 用户**无从得知**自己 2/3 的翻译服务已经失效，也就不会去修。
这比"直接报错"更糟——它掩盖了问题。

### 2.2 这解释了用户自己的历史记录

用户真实 `history.db` 里**仅有 1 条记录**，且用的是 `yandex`：

```
[09-21 23:16:31] yandex  en->zh_cn
原文: '—AE: 18 RRA — BH) RAB...'   ← OCR 乱码输入
译文: '-AE：18RRA-BH）RAB。...'
```

默认列表首位的 `deepl` 没能工作，最终是 `yandex` 兜住的 —— 与本次实测完全一致。

---

## 3. 发现真实回归 Bug：全新安装界面是英文 🐛

### 3.1 现象

| 项 | 值 |
|---|---|
| 代码与文档声称 | 默认 `zh_cn`（commit `f252133`："新用户首次启动时 app_language 初值由 'en' 改为 'zh_cn'"）|
| **全新安装实测** | **`app_language: "en"`** |
| 复现次数 | **3/3 次，100% 稳定** |

### 3.2 根因

`src-tauri/src/tray.rs:21-28`：

```rust
language = match get("app_language") {
    Some(v) => v.as_str().unwrap().to_string(),
    None => {
        set("app_language", "en");   // ← 写死英文
        "en".to_string()
    }
};
```

**托盘在 Rust 侧、前端加载之前初始化**，此时配置项尚不存在，于是写入 `"en"`。
随后前端 `useConfig('app_language', 'zh_cn')` 读取时发现该键**已存在**，
其默认值 `'zh_cn'` **不再生效**（`useConfig` 的初值仅在配置项缺失时使用）。

commit `f252133` 只改了 `src/App.jsx` 与 `General/index.jsx` 两个前端文件，
**遗漏了 `src-tauri/src/tray.rs`**。

### 3.3 验证：A/B 对照实验

同一个二进制，仅改配置值，界面语言随之切换：

| `app_language` | 侧边栏 OCR 结果 |
|---|---|
| `"en"` | `General` / `Translate` / `Recognize` / `Hotkey` / `Service` / `History` / `Backup` |
| `"zh_cn"` | `常规设置` / `翻译设置` / `文字识别` / `服务设置` / `历史记录` / `备份设置` |

→ **i18n 系统本身完全正常**，问题纯粹是首启时写入了错误默认值。

### 3.4 影响面

- 影响**所有全新安装的中文用户**（目标用户主体）；
- 副作用范围有限：一旦用户在设置里改过语言，之后不再被覆盖（实测确认：已存在的值不会被改写）；
- 但"开箱即用"的第一印象被破坏 —— 界面语言是用户最先看到的东西。

### 3.5 修复方向

`tray.rs` 的默认值应与 i18n 默认保持一致（`zh_cn`），或改为不写死、交由前端决定。
**注意**：同一函数内 `set("translate_auto_copy", "disable")`、`set("clipboard_monitor", false)` 等
其他默认值也在此处写入，修改前应确认它们与前端默认一致（避免同类问题）。

---

## 4. 对"开箱即用"的综合判断

结合引擎层报告（BLEU / 延迟）与本次 GUI 实测：

| 维度 | 现状 | 判断 |
|---|---|---|
| 集成链路 | 划词→弹窗→翻译→渲染全通 | ✅ 无架构问题 |
| 默认引擎可用性 | **6 个里 4 个失效** | ❌ 最严重 |
| 失败可见性 | **静默折叠**，用户无感知 | ❌ 掩盖问题 |
| 首启界面语言 | **英文**（应为中文） | ❌ 真实 bug |
| 语言检测 | 默认走百度非公开接口 | ⚠️ 建议改 `local` |
| 免 key 兜底 | 本环境仅 `yandex` 生效 | ⚠️ 依赖单一 |

**核心判断**：这个项目的问题**不是集成架构，而是默认配置年久失修**。
上游几个免费接口在这几年陆续失效，而默认列表从未更新，导致"装完即用"实际退化。
**修默认配置的性价比，远高于引入本地模型。**

优先级建议：
1. **修 `app_language` 默认值**（1 行，影响所有新用户的第一印象）
2. **清理默认引擎列表**：移除需 key 的 `deepl`、已死的 `lingva`/`ecdict`
3. **让失败可见**：失败的引擎不应静默折叠，至少给个标记
4. 语言检测默认改 `local`（代码已存在）

---

## 5. 未验证事项

1. **`google` 引擎未验证**：本环境网络无法直连 Google。
2. **纯 Wayland 划词未验证**：本次为 X11 会话。
3. **托盘菜单语言未逐项 OCR**：仅验证了主窗口；托盘菜单受同一 `app_language` 影响，推断一致但未逐字确认。
4. **未测试 OCR / TTS / 生词本**：本次聚焦翻译主链路。
5. **未在低端设备复测延迟**：引擎层报告的延迟来自服务器级 CPU。
6. **`app_language` 修复未实施**：本报告只做诊断与复现，未改动代码。

---

## 6. 复现方式

```bash
# 启动（需真实 X 显示；Xvfb 下 GUI 行为不可信，见 CLAUDE.md §7）
DISPLAY=:1 ./src-tauri/target/release/cup-translate

# 触发翻译
curl -X POST -d "Hello, world." http://127.0.0.1:60828/

# 截图 + OCR 取证
import -window <wid> /tmp/shot.png
tesseract /tmp/shot.png stdout -l chi_sim+eng --psm 6

# 查看各引擎真实结果
grep -a "resolve\|reject" ~/.config/com.cup-translate.app/logs/cup-translate.log | tail

# 复现 app_language bug
rm -rf ~/.config/com.cup-translate.app && ./cup-translate &
sleep 15 && python3 -c "import json;print(json.load(open('$HOME/.config/com.cup-translate.app/config.json'))['app_language'])"
# 输出 'en' —— 应为 'zh_cn'
```

---

## 7. 验证补记（2026-09-23）：修复实施后的真实 GUI 复测 ✅

> 修复已实施（`tray.rs` / `lang_detect.js` / `main.rs` / `config.rs` / `TargetArea/index.jsx` 等，
> 见 commit「feat: 开箱即用改造」）。以下为修复后在 **真实 X11 桌面**上的实测结果。

| # | 测试项 | 方法 | 结果 |
|---|---|---|---|
| A | 全新安装默认中文 | `rm -rf ~/.config/com.cup-translate.app` → 启动 → 读 config + 截图 OCR | ✅ `app_language='zh_cn'`（旧 bug 同法复现为 `'en'`）；设置窗口全中文：常规设置/翻译设置/服务设置/历史记录/备份设置 |
| B | 开箱即用翻译 | `curl -X POST -d "This is a test of cup-translate." http://127.0.0.1:60828/` | ✅ `[yandex]resolve:这是杯-翻译的测试。`；窗口显示「自动检测 → 简体中文」+ Yandex / 谷歌翻译两张卡片；历史落库；默认列表自动写为 `['yandex','google']` |
| C | 失败可见 + 截断 | 配置 `['yandex','deepl@t1']` + 空 deepl 配置后再触发 | ✅ DeepL 卡片**自动展开**（旧版静默折叠）显示 3 行截断错误 `Http Request Error / Http Status: 429 / "code":479...`，完整错误进日志 |
| D | 升级迁移 | 用用户真实 60 键配置的**只读副本**启动 | ✅ `['deepl','bing','lingva','yandex','google','ecdict']` → `['yandex','google']`；其余设置（`Ctrl+Shift+Z` 等）完好；`translate_detect_engine` 保持用户自选值不被迁移 |

证据图：`docs/research/evidence/out-of-box-config-zh.png`、`out-of-box-translate.png`、`error-visible.png`。

### 排查补记：两个「隐形」坑（后续维护者必读）

1. **裸 `cargo build --release` 缺 `--features custom-protocol`** → 二进制前端永不加载
   （详见 `docs/BUILD.md` §5）。本次症状与「前端代码坏了」完全一致，靠「旧安装包 vs 新构建」
   A/B 对照 + 三轮二分（前端 stash / Rust stash / 原始源码重建）才定位。快速自检见 BUILD.md。
2. **webkit2gtk 2.52.x 在无合成器的 Xvfb 上抓窗口内容全黑**（渲染绕过 X 帧缓冲，
   `WEBKIT_DISABLE_COMPOSITING_MODE=1`、`WEBKIT_DISABLE_DMABUF_RENDERER=1` 均无效）。
   可行做法：在有合成器的真实桌面上 `import -window root` 后按窗口坐标裁剪，
   并用 `xdotool windowraise <wid>` 置顶（否则被全屏窗口遮挡）；取证前把
   `translate_close_on_blur` 设为 `false`，防止窗口在截图间隙自动关闭。