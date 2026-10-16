# 翻译引擎选型：实测对比报告

> 2026-10-16 更新：本地引擎已修正目标语言标记的位置与模型文件哈希，旧样例输出/占用不能直接代表当前实现。最新实测见 [交互与性能修正记录](performance-and-interaction-2026-10-16.md)。

> 目标：回答「cup-translate 能否做到开箱即用、用户不必申请任何 API key」。
> 方法：**在本机实际运行**候选方案，测量体积、内存、延迟与翻译质量。
> 环境：Ubuntu 24.04 / 12 核 CPU (AVX2+FMA，无 AVX-512) / 15GB RAM / GTX 1650 Ti 4GB / Rust 1.95 / CTranslate2 4.7.1。
>
> ⚠️ **本报告的实测延迟均来自「服务器级 CPU」，不是目标用户的笔记本。**
> 结论方向可用，绝对数值需在真实低端设备上复核。
>
> 日期：2026-09

---

## 0. 一句话结论

**「零配置」和「高质量」不可兼得，但可以分层达成。**

- **本地 OPUS-MT + CTranslate2 int8**：79MB / 158MB 内存 / **实测 100ms** —— 速度与体积可接受，但质量明显低于在线服务（BLEU 53.8 vs 74.1），且**每个语言对要单独一个模型**。
- **免 key 在线（MyMemory）**：质量最好（BLEU 74.1）、零体积，但**配额仅 5000 字符/天**、单请求 500 字符上限、**实测 1/3 请求会卡死 30 秒**，且官方 ToS **明确拒绝**本项目这类应用。

**因此建议**：默认走**在线免 key + 多引擎自动降级**（覆盖大多数场景、零体积），把**本地模型作为「离线/隐私模式」的可选下载项**，而不是默认内置。理由见 §5。

---

## 1. 实测数据总览

### 1.1 本地 OPUS-MT (en→zh) + CTranslate2

模型：`Helsinki-NLP/opus-mt-en-zh`（Apache-2.0），转换到 CT2 int8 后 **79MB**。

| 量化 | 线程 | 平均延迟 | p50 | p95 | 峰值 RSS |
|---|---|---|---|---|---|
| **int8** | 1 | 245.7 ms | 237.4 | 295.9 | **147 MB** |
| **int8** | 2 | 152.9 ms | 151.1 | 189.5 | 153 MB |
| **int8** | **4** | **106.0 ms** | **99.6** | 134.6 | **158 MB** |
| int8 | 8 | 339.8 ms | 316.8 | 444.3 | 158 MB |
| int16 | 4 | 165.7 ms | 157.0 | 207.5 | 398 MB |
| float32 | 4 | 240.1 ms | 233.0 | 300.5 | 426 MB |

**三个关键发现**：
1. **int8 是最优解**：比 float32 快 2.3×，内存少 2.7×。质量损失见 §1.3。
2. **4 线程最优，8 线程反而慢 3.2×**（106ms → 340ms）。线程竞争导致性能崩塌 —— 这是个容易踩的坑，**不能简单设成 `num_cpus`**。
3. 单句延迟 ~100ms 属于"划词即译"可接受范围（人眼感知阈值约 100–200ms）。

### 1.2 翻译质量（人工参考译文，10 句，sacrebleu）

同一测试集、同一参考译文，两种方案对比：

| 方案 | BLEU(zh) | chrF | 平均延迟 | 磁盘 | 内存 |
|---|---|---|---|---|---|
| **本地 OPUS-MT int8** | **53.83** | 52.10 | **100 ms** | 79 MB | 158 MB |
| **MyMemory (免 key)** | **74.09** | 72.09 | **8382 ms** | 0 | 0 |

**MyMemory 质量显著更好**，但注意其延迟数据包含了卡死请求（见 §2.2）；正常响应约 0.8–1.2s。

**本地模型实际译文样例**（可见质量水平）：

| 原文 | 本地 MT | 参考译文 |
|---|---|---|
| Artificial intelligence is transforming the way we work and live. | 人工智能正在改变我们的工作和生活方式 | 人工智能正在改变我们的工作和生活方式。 |
| She carefully documented the intermittent memory leak before filing the bug report. | 她在提交错误报告前仔细记录了间歇性内存泄漏。 | 她在提交错误报告之前仔细记录了间歇性内存泄漏。 |
| The quick brown fox jumps over the lazy dog. | 快速的棕色狐狸跳过懒狗... | 敏捷的棕色狐狸跳过了懒狗。 |
| Hello, world. | 大家好,世界观... | 你好，世界。 |

**结论**：技术类长句质量良好（接近参考），**短句与习语明显较差**。这与 OPUS-MT 是 2020 年模型、训练数据偏新闻/文档域相符。

### 1.3 一个必须记录的坑：语言标记

`opus-mt-en-zh` 的共享词表含 **8 个语言标记**（`>>cmn_Hans<<`、`>>cmn_Hant<<`、`>>yue<<` 等），是**多目标模型**。**必须在源序列前置目标语言标记**，否则解码会退化成长度 256 的重复串：

```
不带标记: 全世界,世界好,你好,世界好,世界好,世界好,... (重复 256 token)
带标记:   人工智能正在改变我们的工作和生活方式  ✅
```

**这个坑很难自查**：不会报错，只会输出垃圾。如果将来接入，必须写进代码注释与测试。

### 1.4 解码参数需要按场景调

实测发现 beam 宽度会引入伪影：

| beam | "Hello, world." | "The system will notify you..." |
|---|---|---|
| 1 | 全世界都这么认为 | 部署成功完成后, 系统会通知您 。（无伪影）|
| 4 | 大家好,世界观... | 一旦部署成功完成, 系统将会通知您 。 **@ info**（伪影）|
| 5 | 哈罗,世界... | 一旦部署成功完成, 系统将会通知您 。（无伪影）|

`beam=1` 无伪影但习语差；`beam=4` 有 `@info` 伪影；`beam=5` 较好。**没有单一最优值，需要实测调参 + 后处理清洗**。

---

## 2. 免 key 在线方案实测

### 2.1 MyMemory（唯一存活的免 key 服务）

| 项 | 实测值 |
|---|---|
| 可用性 | ✅ 稳定返回 200 |
| 质量 | BLEU 74.09（10 句人工参考集） |
| 单请求上限 | **500 字符**（501 字符即 `403 QUERY LENGTH LIMIT EXCEEDED`） |
| 匿名配额 | 官方称 5000 字符/天 |
| 语种覆盖 | en↔zh、ja→zh、en→ja、fr→en、en→de、ru→en 均可；**ar→en 会泄漏 XML 标记**（`<g id="1">...</g>`） |

### 2.2 ⚠️ 致命问题：间歇性 30 秒卡死

12 次连续请求的延迟分布：

```
30887 ms ← 卡死
30875 ms ← 卡死
 1114 ms
30888 ms ← 卡死
  971 ms
31334 ms ← 卡死
  913 ms
 1251 ms
  804 ms
30960 ms ← 卡死
  836 ms
 1022 ms

中位数 1183 ms   平均 13488 ms
```

**12 次里 5 次卡死到 30 秒超时。** 对划词翻译这种交互，这是不可接受的 —— 用户会以为程序挂了。必须配超时 + 降级。

### 2.3 官方 ToS 明确拒绝本项目

MyMemory 官方白名单条款原文：

> Personal projects or 'in development' stuff, projects that just use the 'get' endpoint without contributing to MyMemory using the 'set' endpoint, **never qualify**

即：**只用 `get` 不贡献 `set` 的开源项目不符合其使用资格。** 这不是技术问题，是把 MyMemory 当默认引擎的**合规风险**。

### 2.4 其他免 key 渠道：已大面积死亡

| 渠道 | 状态 | 性质 |
|---|---|---|
| Google `translate_a/single?client=gtx` | **本环境无法验证**（TCP 超时） | 🔴 逆向 |
| Bing `edge.microsoft.com/translate/auth` | **404 已死**（实测两次） | 🔴 逆向 |
| `lingva.pot-app.com`（上游硬编码） | **DNS 不存在** | 🔴 逆向 |
| Lingva 公共实例（9 个） | **全部失效** | 🔴 逆向 |
| LibreTranslate 公共实例（6 个） | **全部失效**（403/502） | 🟡 软件活跃≠实例可用 |
| SimplyTranslate | HTTP 200 但**返回空串** | 🔴 逆向 |
| Yandex 免 key | 502 `Invalid parameter: key` **免费档已取消** | 🟢 官方 |

**最重要的判断**：逆向接口的失效是**系统性同时发生**的（Lingva 与 SimplyTranslate 同为 Google 抓取、Bing 同批失效），说明是平台方集体收紧反爬。
→ **"多接几个免费逆向接口互为冗余"的策略不成立**：它们会一起死。

---

## 3. 本地模型的真实成本：每语言对一个模型

OPUS-MT 是**单语言对**模型，这是它最大的架构限制：

| 覆盖目标 | 模型数 | 磁盘 |
|---|---|---|
| 仅 英↔中 | 2 | 0.16 GB |
| 英↔中/日/韩 | 6 | 0.47 GB |
| 英↔中/日/韩/法/德 | 10 | 0.78 GB |
| 英↔8 语种（≈当前应用列出的语种） | 16 | **1.25 GB** |
| 全 30 语种互译 | 870 | **68 GB** |

对比：在线服务 **0 MB**、约 200+ 语种。

**多语言替代方案**（体积换覆盖，但各有问题）：

| 模型 | int8 体积 | 许可 | 可用性 |
|---|---|---|---|
| M2M-100 418M | ~491 MB | **MIT** ✅ | 语种覆盖有限 |
| NLLB-200 distilled-600M | ~623 MB | **cc-by-nc-4.0** ❌ | 非商用，与 GPL-3.0 冲突 |
| Hy-MT2-1.8B（混元，2026-05） | 1133 MB (Q4_K_M) / 462 MB (1.25bit) | Apache-2.0 ✅ | 体积大；官方 GGUF 依赖**未合并**的 llama.cpp PR #22836 |

**关于混元**：任务里问的"混元超小翻译模型"现状是 ——
- 第 1、2 代（`Hunyuan-MT-7B` / `HY-MT1.5-1.8B`）是 **Tencent Community License**，逐字含 "DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA"，**与 GPL-3.0 §7（禁止附加限制）实质冲突**。
- **只有第 3 代 `Hy-MT2`（2026-05-21）是 Apache-2.0**，可用于 GPL-3.0 项目。
- 但最小 1.8B 的**极限三元量化仍要 462MB**，是 OPUS-MT 的 5.8 倍；且官方 GGUF 无法用发行版 llama.cpp 直接跑。

→ **混元不适合作为"轻量划词"的默认本地模型**，可作为进阶选项。

---

## 4. Rust 集成路径（可落地性验证）

必须能在 Tauri 后端跑，不能依赖 Python：

| crate | 版本 | 许可 | 状态 |
|---|---|---|---|
| **`ct2rs`** | **0.10.1**（2026-08-31 更新） | **MIT** ✅ | CTranslate2 的 Rust 绑定，51k downloads |
| `candle-core` | 0.11.0 | MIT/Apache | 通用推理框架 |
| `ort` | 2.0.0-rc.13 | MIT/Apache | ONNX Runtime 绑定 |

**`ct2rs` 直接绑定 OpenNMT/CTranslate2** —— 正是本报告实测的引擎。**结论：本地模型方案在 Rust 侧没有技术障碍。**

许可证链检查（对 GPL-3.0 项目重要）：
- `ct2rs` MIT ✅ / CTranslate2 MIT ✅ / OPUS-MT en-zh Apache-2.0 ✅
- ⚠️ 注意 `opus-mt-zh-en` 是 **CC-BY-4.0**（与 en-zh 不同！），需署名
- ⚠️ NLLB 系的 cc-by-nc **不可用**

---

## 5. 建议方案

### 5.1 结论：默认在线，本地作可选

**不建议**把本地模型作为默认。理由：

| 维度 | 本地 OPUS-MT | 在线免 key |
|---|---|---|
| 磁盘 | 79MB × 语言对数 | 0 |
| 质量 | BLEU 53.8 | BLEU 74.1 |
| 延迟 | 100ms 稳定 | 0.8–1.2s，但**会卡死 30s** |
| 语种 | 每对 80MB | 200+ |
| 隐私/离线 | ✅ 完全本地 | ❌ 需联网 |
| 维护面 | 模型分发 + 调参 + 伪影清洗 | 接口易失效 |

**推荐分层**：

1. **默认层：在线多引擎 + 自动降级 + 硬超时**
   - 关键不是"选哪个引擎"，而是**失败时自动切下一个**。逆向接口会集体失效，必须假设"随时有引擎挂掉"。
   - **必须设 3–5 秒硬超时**：MyMemory 实测会挂 30 秒，不设超时 = 用户以为软件死了。
   - 建议探测顺序：用户自配 key（若有）→ 多个免 key 引擎轮询 → 明确报错并提供"去配置"入口。

2. **进阶层：本地离线模式（用户主动下载）**
   - 首次下载 ~80MB/语言对，标注清楚体积。
   - 卖点应为**隐私/离线/无限量**，而**不是**质量。
   - 用 `ct2rs` + int8 + **4 线程**（不要用 num_cpus）。

3. **不要**把 MyMemory 作为唯一默认：配额小（5000 字符/天）、500 字符上限、且 **ToS 明确排除本项目**。

### 5.2 顺带可修的问题（低成本、高收益）

本报告顺带确认了当前代码的几个具体缺陷：

| 位置 | 问题 |
|---|---|
| `src/services/translate/lingva/index.jsx:6` | 硬编码 `lingva.pot-app.com`，**DNS 已不存在** |
| `src/services/translate/bing/index.jsx:4` | `edge.microsoft.com/translate/auth` **返回 404** |
| `src/services/translate/ecdict/index.jsx:4` | 依赖上游 `pot-app.com/api/dict` |
| 默认 `translate_service_list` | 首位是 `deepl`（**需 API key**），用户首次划词即报错 |
| `src/utils/lang_detect.js:314` | 默认走百度非公开接口，而项目**已有**本地 lingua 检测器（`src-tauri/src/lang_detect.rs`）却没默认启用 |

**其中"语言检测默认改 local"是投入产出比最高的一步** —— 代码已存在，零网络、零隐私风险、零配置。

---

## 6. 未验证事项（诚实声明）

1. **绝对延迟数值不可直接外推**：本机是 12 核服务器 CPU，目标用户的低端笔记本会明显更慢。**必须在真实设备复测**。
2. **Google gtx 端点 2026 年是否可用：未验证**（本环境无法直连 Google，TCP 443 全部超时）。
3. **zh→en 方向未实测**：缺 torch（下载失败），`opus-mt-zh-en` 未转 CT2。其 CC-BY-4.0 许可与体积已知，但质量数据缺失。
4. **未测混元 Hy-MT2 实际速度**：仅获得体积与许可事实，未运行推理。
5. **未做真机 GUI 验证**：本报告全部为引擎层基准测试，未验证应用集成后的实际表现。
6. **MyMemory 卡死原因未定位**：仅观测到现象（5/12 次 30s 超时），未查明是其限流、网络还是服务端问题。
7. **GPU 未利用**：本机有 GTX 1650 Ti，但 CTranslate2 的 CUDA 路径未测试（目标用户多数无独显，CPU 路径才是重点）。

---

## 7. 复现方式

```bash
# 依赖
pip3 install ctranslate2 sentencepiece sacrebleu huggingface_hub

# 下载模型（HuggingFace 走镜像）
HF_ENDPOINT=https://hf-mirror.com python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='jiangzhuo9357/opus-mt-en-zh-ct2', local_dir='./ct2-en-zh')"
```

推理示例（注意**语言标记**这个坑）：

```python
import ctranslate2, sentencepiece as spm
M = "./ct2-en-zh"
sp_src = spm.SentencePieceProcessor(model_file=f"{M}/source.spm")
sp_tgt = spm.SentencePieceProcessor(model_file=f"{M}/target.spm")
tr = ctranslate2.Translator(M, device="cpu", compute_type="int8", intra_threads=4)

toks = [">>cmn_Hans<<"] + sp_src.encode("Hello, world.", out_type=str)  # 标记不可省
res = tr.translate_batch([toks], beam_size=5)
print(sp_tgt.decode(res[0].hypotheses[0]))
```

---

## 8. 相关文档

- `docs/research/on-device-mt-models-2026.md` —— 本地模型文档调研（体积/许可/基准，未实测）
- `docs/research/free-translate-backends-2026.md` —— 免 key 服务与开源后端调研
- `CLAUDE.md` §6 —— 本项目零自动化测试，改动需手工验证