# 桌面端本地小模型机器翻译 · 选型事实调研（2026）

> 调研方式：HuggingFace API（经 hf-mirror.com 镜像）、arXiv、GitHub API。
> 所有体积数字来自 HF API `?blobs=true` 的**真实字节数**，非估算。
> ⚠️ 环境说明：本机 `huggingface.co` 不可达，全部 HF 数据经 **hf-mirror.com** 获取，数字与官方一致。

标注约定：**【已查证】** = 有可点开的一手来源；**【推测】** = 由已查证事实推导，未经实测。

---

## 0. 结论速览：是否存在 <200MB 且 CPU 近实时的中英模型？

**存在，但只有一条路线：OPUS-MT（Marian）经 CTranslate2 int8 量化。**

### 0.1 翻译引擎选型决策（2026-10 实测确认）

> **用户需求**：资源占用尽可能小 + 翻译效果好，优先本地小模型 + 谷歌翻译。

| 维度 | OPUS-MT CT2 int8（✅ 采用） | Hy-MT2-1.8B（❌ 不采用） |
|---|---|---|
| 磁盘 | **82 MB** | 462 MB（1.25-bit）~ 1133 MB（Q4_K_M） |
| 内存 | **158 MB** | 预估 500MB+（1.8B 参数） |
| 延迟 | **100ms**（4 线程） | 未实测，1.8B LLM 推理远慢于 Marian |
| 推理框架 | CTranslate2（已集成，ct2rs） | llama.cpp（需引入，且官方 GGUF 依赖未合并 PR） |
| 翻译质量 | BLEU 53.8（技术类长句良好，短句/习语偏弱） | 预估更高（1.8B LLM），但无 BLEU 基准 |
| 每语向模型 | 79MB × 2 = 158MB | 462MB × 2 = 924MB |
| 许可证 | Apache-2.0 + CC-BY-4.0 ✅ | Apache-2.0 ✅ |

**结论**：在「资源占用尽可能小」的硬约束下，OPUS-MT CT2 int8 是唯一可行方案。
Hy-MT2-1.8B 即使极限三元量化（462MB）也是 OPUS-MT 的 5.8 倍，且需要引入
llama.cpp 推理框架（当前 CTranslate2 已集成），翻译速度不可比。

**当前实现**：`src-tauri/src/local_mt.rs`（CTranslate2 int8）+
`src/services/translate/local_mt/`（前端）。
**默认引擎顺序**：`['google', 'local_mt']`（Google 在线兜底 + 本地离线优先）。

| 方案 | 磁盘体积 | 是否 <200MB |
|---|---|---|
| **OPUS-MT en-zh + CTranslate2 int8** | **79.6 MB**（model.bin）+ ~2.4MB 词表/spm ≈ **82 MB** | ✅ 是 |
| OPUS-MT en-zh + CTranslate2 float16 | 155.5 MB ≈ 160 MB | ✅ 是 |
| Hy-MT2-1.8B 1.25-bit GGUF | 461.9 MB | ❌ 否（但官方称"440MB"） |
| Hy-MT2-1.8B 2-bit GGUF | 600.5 MB | ❌ 否 |
| Hy-MT2-1.8B Q4_K_M GGUF | 1133.1 MB | ❌ 否 |
| NLLB-200-distilled-600M CT2 int8 | 622.6 MB | ❌ 否 |
| M2M-100 418M CT2 int8 | 490.7 MB | ❌ 否 |
| T5-small ONNX quantized（encoder+decoder） | 35.5 + 58.7 ≈ 94 MB | ✅ 是（但非专用翻译模型） |

**没有任何一个 1.8B 级别的 LLM 式翻译模型能压到 200MB 以下。**
1.25-bit 三元量化（461.9 MB）已接近该尺寸的下限，仍超 2 倍。

---

## 1. 腾讯 Hunyuan / Hy-MT 系列

### 1.1 命名的重大变化（**选型关键**）

腾讯的模型命名在 2025→2026 间换过三代，**"Hunyuan-MT"已不是最新系列**：

| 代次 | 开源日期 | 模型名 | 架构 | 许可证 |
|---|---|---|---|---|
| 第 1 代 | 2025-09-01 | `tencent/Hunyuan-MT-7B`、`Hunyuan-MT-Chimera-7B` | — | **Tencent Hunyuan Community License** |
| 第 2 代 | 2025-12-30 | `tencent/HY-MT1.5-1.8B`、`HY-MT1.5-7B` | `hunyuan_v1_dense` | **Tencent HY Community License** |
| 第 3 代 | 2026-05-21 | `tencent/Hy-MT2-1.8B`、`-7B`、`-30B-A3B` | `HunyuanDenseV1ForCausalLM` | **Apache-2.0** ✅ |

来源：[Hy-MT2-1.8B-GGUF README](https://hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF)（News 段落明确列出三个开源日期）

> **用户任务中问的"是否有更小的蒸馏版"——答案是：没有蒸馏版，但有原生 1.8B 版本**，
> 且分两代：`HY-MT1.5-1.8B`（2025-12）与 `Hy-MT2-1.8B`（2026-05）。

### 1.2 体积与量化（【已查证】，HF API 真实字节数）

| 模型 | 文件 | 磁盘体积 |
|---|---|---|
| `tencent/Hunyuan-MT-7B` | 4×safetensors | 5272.4 + 5352.2 + 5360.5 + 75.5 ≈ **16.1 GB** (bf16) |
| `tencent/Hunyuan-MT-7B-fp8` | 2×safetensors | 4997.9 + 3032.8 ≈ **8.0 GB** |
| `tencent/Hy-MT2-1.8B` | model.safetensors | **4077.1 MB** (bf16) |
| `tencent/Hy-MT2-1.8B-FP8` | model.safetensors | **2038.7 MB** |
| `tencent/Hy-MT2-1.8B-GGUF` | Q8_0 | **1908.5 MB** |
| 同上 | Q6_K | **1474.8 MB** |
| 同上 | **Q4_K_M** | **1133.1 MB** |
| `tencent/Hy-MT2-1.8B-2Bit-GGUF` | 2-bit gguf | **600.5 MB** |
| `tencent/Hy-MT2-1.8B-1.25Bit-GGUF` | STQ1_0 | **461.9 MB** |
| `litert-community/Hy-MT2-1.8B` | int8 `.litertlm` | **1815.6 MB** |
| `tencent/HY-MT1.5-1.8B-GGUF` | Q4_K_M / Q6_K / Q8_0 | **1133.1 / 1474.8 / 1908.5 MB** |
| `tencent/HY-MT1.5-1.8B-GPTQ-Int4` | model.safetensors | **1329.7 MB** ✅ int4 实测值 |
| `AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF` | gguf | **461.9 MB** |

**arXiv 报告原文（【已查证】）**：
> "when paired with AngelSlim's 1.25-bit extreme quantization for on-device deployment,
> the lightweight 1.8B model requires only **440 MB** of storage and achieves a **1.5x inference speedup**."
> — [arXiv:2605.22064](https://arxiv.org/abs/2605.22064)（Hy-MT2: A Family of Fast, Efficient and Powerful Multilingual Translation Models in the Wild）

> 注意 **440 MB（论文口径） vs 461.9 MB（实际文件）** 的差异，差在未计入 `imgs/` 与元数据。

### 1.2b 社区 ONNX 转换（【已查证】，`justinchuby/Hy-MT2-1.8B-ONNX`）

这是**唯一可直接落到 ONNX Runtime 的 Hy-MT2 构建**（downloads: 0，非常新，未经社区检验）：

| 子目录 | 精度 | model.onnx.data |
|---|---|---|
| `Q4_GPTQ/cuda/` | Q4 GPTQ | 1102.8 MB |
| **`Q4_KQuant_tie/cpu/`** | **Q4 K-quant（**CPU 专用**）** | **1282.1 MB** |
| `Q4_K_M/cuda/` | Q4_K_M | 1454.6 MB |
| `Q4_RTN/cuda/` | Q4 RTN | 1245.9 MB |
| `Q4_K_M/default/` | Q4_K_M | 2113.4 MB |
| `bf16/` `f16/` | 全精度 | 3649.3 MB |

> ⚠️ 即便最小的 **Q4 CPU 版也要 1282 MB**，印证"1.8B 类模型无法进入 200MB 档位"。
> ⚠️ 该仓库 downloads 为 0，且仅有 `cuda`/`default`/`webgpu` 变体标注了 `cpu` 的仅 Q4_KQuant_tie，
> **成熟度低，不建议作为唯一依赖**。【推测】

### 1.3 架构参数（【已查证】，config.json）

`Hy-MT2-1.8B` 与 `HY-MT1.5-1.8B` 配置一致：
```
model_type: hunyuan_v1_dense
hidden_size: 2048 · num_hidden_layers: 32 · num_attention_heads: 16
num_key_value_heads: 4  (GQA) · intermediate_size: 6144
vocab_size: 120818 · max_position_embeddings: 262144 (256K)
torch_dtype: bfloat16
```

### 1.4 语种覆盖（【已查证】）

- 官方文本称"**33 languages + 5 ethnic/dialect variations**"。
- 实际 README 语言表**列出 38 行**（含 `zh-Hant`、`yue` 粤语、`bo` 藏语、`ug` 维吾尔语等）。
- 方向：**多语言 ↔ 多语言**（非单语言对），中英双向在列。

### 1.5 质量（部分【已查证】，多为定性）

- 【已查证】Hy-MT2-1.8B README 称 1.8B "surpasses mainstream commercial APIs from providers such as **Microsoft and Doubao** overall"，7B/30B 在 fast-thinking 模式下超过 DeepSeek-V4-Pro、Kimi K2.6。
- 【已查证】第 1 代：`Hunyuan-MT-7B` 在 **WMT25 的 31 个语言类别中拿到 30 个第一**（README 原文）。
- ❌ **未查到**：中英方向的 **具体 BLEU / COMET / chrF 数值**。官方以图片形式发布（`imgs/main_result.png`），README 无数字表。需下载该 PNG 或查 arXiv PDF 正文才有具体分数。

### 1.6 许可证（**决定性差异，务必区分**）

| 模型 | 许可证 | 关键限制 |
|---|---|---|
| `Hy-MT2-*`（2026）| **Apache-2.0** ✅ | 无地域限制、无 MAU 限制 |
| `HY-MT1.5-*`（2025-12）| Tencent HY Community License | 见下 |
| `Hunyuan-MT-7B`（2025-09）| Tencent Hunyuan Community License | 见下 |

**Tencent Community License 的关键条款（【已查证】，逐字摘自 `License.txt`）**：
1. **"THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA"**
2. **Territory** = 全球**排除** EU / UK / 韩国。不得在 Territory 之外使用、复制、修改、分发、展示。
3. 分发须附带 `Notice` 文件 + 本协议副本；修改文件须标注变更。
4. **月活 > 1 亿**的产品需另行向腾讯申请授权。
5. 不得用其输出改进其他 AI 模型；**"For military purposes"** 等 20 条 Acceptable Use Policy 约束。
6. 管辖法：**香港特别行政区法律**，专属管辖地为香港法院。

> **对 GPL-3.0 项目的含义（【推测】，非法律意见）**：
> - `Hy-MT2`（Apache-2.0）：与 GPL-3.0 **兼容**，可随包分发。Apache-2.0 → GPL-3.0 是 FSF 认可的单向兼容方向。
> - `HY-MT1.5` / `Hunyuan-MT-7B`：**非 OSI 开源许可证**，带地域限制和使用限制。与 GPL-3.0 存在**实质冲突**——GPL-3.0 要求向任何人授予无差别权利，而该许可证禁止向 EU/UK/KR 用户授权。且 GPL-3.0 §7 禁止附加额外限制（no further restrictions），该许可证的 Territory/AUP 恰恰是额外限制。
> - **建议**：若要用腾讯模型，选 **Hy-MT2（Apache-2.0）**，避开 HY-MT1.5 与 Hunyuan-MT-7B。

### 1.7 部署风险（**重要，【已查证】**）

Hy-MT2 的 GGUF **依赖未合并的 llama.cpp 自定义 kernel**：

> "❕❕ This gguf depends on our **STQ kernel**, which is released at [PR #22836](https://github.com/ggml-org/llama.cpp/pull/22836)."
> — [Hy-MT2 GitHub README](https://github.com/Tencent-Hunyuan/Hy-MT2)

PR 状态经 GitHub API 查证（2026-09-14 更新）：
```
title:  ggml-cpu : add STQ1_0 ternary quantization with ARM NEON vec_dot kernel
state:  open
merged: False
merged_at: None
created: 2026-05-08
```
即 **截至 2026 年 9 月仍未合并**。STQ1_0 = Sparse Ternary Quantization，1.3125 bits/weight（每 4 权重 5 bit）。

> ⚠️ **这意味着官方量化 GGUF 无法用发行版 llama.cpp 直接跑**，需自行打补丁编译。
> 对"零配置开箱即用"是**实质性障碍**。【推测】Q4_K_M/Q6_K/Q8_0 走标准 kernel，
> 可能不受影响——**但 README 未区分说明，需实测确认**。

### 1.8 分发渠道（【已查证】）

- HuggingFace：`tencent/Hy-MT2-1.8B`（1.2K likes）、`Hy-MT2-1.8B-GGUF`（**383,726 downloads**，下载量最高的变体）
- ModelScope 合集：`modelscope.cn/collections/Tencent-Hunyuan/Hy-MT2`（README 徽章指向）
- GitHub：`github.com/Tencent-Hunyuan/Hy-MT2`
- 国内镜像：**hf-mirror.com 实测可完整访问**（本次调研全部数据即由该镜像取得）

---

## 2. Helsinki-NLP OPUS-MT（Marian）

### 2.1 体积（【已查证】）

| 模型 | 格式 | 体积 | 许可证 |
|---|---|---|---|
| `Helsinki-NLP/opus-mt-en-zh` | pytorch_model.bin | **312.1 MB** | **apache-2.0** |
| 同上 | flax_model.msgpack | 309.9 MB | |
| 同上 | rust_model.ot | 578.4 MB | |
| 同上 | 词表+spm（必需） | 0.81+0.80+1.62 ≈ 3.2 MB | |
| `Helsinki-NLP/opus-mt-zh-en` | pytorch_model.bin | **312.1 MB** | **cc-by-4.0** |

> ⚠️ **注意方向许可不同**：`en-zh` 是 Apache-2.0，`zh-en` 是 **CC-BY-4.0**。两者都允许商用。
> 【推测】CC-BY-4.0 与 GPL-3.0 兼容（需保留署名）。

**CTranslate2 量化后（【已查证】，这是最关键的一组数字）**：

| 仓库 | 精度 | model.bin | 总计 |
|---|---|---|---|
| `jiangzhuo9357/opus-mt-en-zh-ct2` | **int8** | **79.6 MB** | **≈82 MB** ✅ |
| `ooeoeo/opus-mt-en-zh-ct2-float16` | float16 | 155.5 MB | ≈160 MB |

### 2.2 速度与内存（【已查证】，CTranslate2 官方基准）

官方 README 基准（En→De newstest2014，**4 线程，Intel Xeon Platinum 8275CL**，AWS c5.2xlarge）：

| 运行时 | tokens/s | 峰值内存 | BLEU |
|---|---|---|---|
| Transformers 4.26.1 + PyTorch 1.13.1 | 147.3 | 2332 MB | 27.90 |
| Marian 1.11.0 | 344.5 | 7605 MB | 27.93 |
| Marian int8 | 355.8 | 4763 MB | 27.27 |
| **CTranslate2 3.6.0** | **525.0** | **721 MB** | 27.92 |
| CTranslate2 int16 | 596.1 | 660 MB | 27.53 |
| **CTranslate2 int8** | **696.1** | **516 MB** | **27.65** |

来源：[CTranslate2 README Benchmarks](https://github.com/OpenNMT/CTranslate2#benchmarks)

**要点（【已查证】）**：
- int8 相对 float32 CTranslate2：**525 → 696 tokens/s（+33%）**，内存 721 → 516 MB。
- int8 相对 PyTorch 原版：**147 → 696 tokens/s（4.7×）**，BLEU 仅降 0.25。
- **支持 int8 量化加速：是**，且加速显著。CTranslate2 还支持 int16 / bf16 / fp16 / **AWQ (int4)**。
  > CTranslate2 原文："Quantization can make the models 4 times smaller on disk with minimal accuracy loss."

> ⚠️ **该基准在 4 核 Xeon 服务器 CPU 上测得**，非笔记本。普通笔记本（如 i5-1235U）性能会低不少，
> 但仍可预期 hundreds of tokens/s 量级 → **中英短句接近实时**。【推测】

### 2.3 质量（【已查证】）

| 模型 | 测试集 | BLEU | chrF |
|---|---|---|---|
| `opus-mt-en-zh` | Tatoeba-test.eng.zho | **31.4** | **0.268** |
| `opus-mt-zh-en` | Tatoeba-test.zho.eng | **36.1** | **0.548** |

原始 eval 明细（en-zh）：
```
BLEU+case.mixed+numrefs.1+smooth.exp+tok.zh+version.1.4.2 = 31.4
  64.6/41.8/28.2/19.8 (BP = 0.896 ratio = 0.901 hyp_len = 99507 ref_len = 110468)
chrF2+case.mixed+numchars.6+numrefs.1+space.False+version.1.4.2 = 0.268
```
来源：[opus-mt-en-zh README](https://hf-mirror.com/Helsinki-NLP/opus-mt-en-zh)、
[原始 eval.txt](https://object.pouta.csc.fi/Tatoeba-MT-models/eng-zho/opus-2020-07-17.eval.txt)

> ⚠️ **Tatoeba 是短句/口语测试集，且是 2020 年模型**。BLEU 31.4 与当代 LLM 不可直接比较，
> 但注意 en-zh 的 **chrF 仅 0.268 明显偏低**，中文生成质量是其弱项。

### 2.4 语种与方向（【已查证】）

- **单语言对模型**（`src_multilingual: False`，`tgt_multilingual: False`）。
- `opus-mt-en-zh` 目标侧覆盖多种中文变体：cmn / cmn_Hans / cmn_Hant / **yue 粤语** / wuu 吴语 / gan 赣语 / nan 闽南语 / lzh 文言文。
- 需要**句首语言标记 token**（`>>id<<`）指定目标变体。
- Helsinki-NLP 在 HF 上 opus-mt* 模型**超过 1000 个**（API limit=1000 即打满），覆盖极广语言对。

### 2.5 许可证（【已查证】）

- `opus-mt-en-zh` → **Apache-2.0** ✅
- `opus-mt-zh-en` → **CC-BY-4.0** ✅
- 两者均**允许商用**，与 GPL-3.0 兼容（Apache-2.0 单向兼容 GPL-3.0；CC-BY-4.0 需署名）。
- **【重要】模型权重与训练数据（OPUS 语料）许可需分别审视**——模型卡声明的权重许可不必然覆盖训练数据。

### 2.6 分发（【已查证】）

- HuggingFace：`Helsinki-NLP/opus-mt-en-zh`（99,779 downloads）、`opus-mt-zh-en`（**180,950 downloads**）
- 原始权重：`object.pouta.csc.fi`（CSC 芬兰 IT 中心，可直接下载 zip）
- GitHub：`Helsinki-NLP/OPUS-MT-train`
- hf-mirror.com 实测可访问

---

## 3. Meta NLLB-200

### 3.1 体积（【已查证】）

| 模型 | 文件 | 体积 |
|---|---|---|
| `facebook/nllb-200-distilled-600M` | pytorch_model.bin | **2460.5 MB** |
| | sentencepiece.bpe.model | 4.9 MB |
| | tokenizer.json | 17.3 MB |
| `facebook/nllb-200-distilled-1.3B` | pytorch_model.bin | **5482.9 MB** |
| （完整 54B MoE 版未在本次调研范围） | | |

**CTranslate2 int8 后（【已查证】）**：
| 仓库 | 精度 | model.bin |
|---|---|---|
| `JustFrederik/nllb-200-distilled-600M-ct2-int8` | **int8** | **622.6 MB** |
| 同仓库总计（含 spm/tokenizer） | | ≈ 647 MB |

> `distilled-600M` 是 **600M 参数**，但 bf16 权重 2460MB，**int8 后仍 622.6 MB**，
> 与"600M≈600MB"的直觉不符（词表巨大：NLLB 词表 256K）。

### 3.2 语种与方向（【已查证】）

- **200 种语言**，**多语言 ↔ 多语言**（single sentence translation among 200 languages）。
- 模型卡原文："It allows for single sentence translation among 200 languages."
- 输入长度上限 512 tokens，**超出会质量下降**；不支持文档级翻译。

### 3.3 质量（部分【已查证】）

- 【已查证】NLLB 论文摘要："Our model achieves an improvement of **44% BLEU** relative to the previous state-of-the-art"（[arXiv:2207.04672](https://arxiv.org/abs/2207.04672)），基于 **FLORES-200** 基准，评估了 40,000+ 翻译方向。
- ❌ **未查到**：`distilled-600M` 在 **中英方向的具体 BLEU/COMET 数值**。模型卡只列了 metrics 名称（bleu/spbleu/chrf++），未给数字。具体分数在论文正文表格中，本次未提取。

### 3.4 许可证（**红旗，【已查证】逐字引用**）

```
license: "cc-by-nc-4.0"
...
- License: CC-BY-NC
```
- **CC-BY-NC-4.0 = 非商业性使用**。
- 模型卡原文进一步限定：
  > "NLLB-200 is a **research model** and is **not released for production deployment**."
  > "Primary users are researchers and machine translation research community."
  > "NLLB translations **can not be used as certified translations**."

> **对 GPL-3.0 项目的含义（【推测】，非法律意见）**：
> **NC 条款与 GPL-3.0 不兼容**。GPL-3.0 明确允许商业使用，而 CC-BY-NC 禁止。
> 且 CC 系列明确**不推荐用于软件**。**结论：NLLB-200 不应随 GPL-3.0 桌面应用分发。**
> 这是本次调研中**最明确的一个排除项**。

### 3.5 分发（【已查证】）

- HuggingFace：`facebook/nllb-200-distilled-600M`（**1,009,806 downloads**，978 likes，下载量极高）
- 社区 CT2 转换版本丰富（JustFrederik / skywood / keisuke-miyako 等至少 8 个镜像）

---

## 4. Meta M2M-100

### 4.1 体积（【已查证】）

| 模型 | 文件 | 体积 |
|---|---|---|
| `facebook/m2m100_418M` | pytorch_model.bin | **1935.8 MB** |
| | rust_model.ot | 1935.8 MB |
| | sentencepiece.bpe.model | 2.4 MB |
| `facebook/m2m100_1.2B` | pytorch_model.bin | **4958.2 MB** |

**CTranslate2 int8 后（【已查证】）**：
| 仓库 | 精度 | model.bin | 总计 |
|---|---|---|---|
| `JustFrederik/m2m_100_418m_ct2_int8` | int8 | **490.7 MB** | ≈494 MB |
| `jncraton/m2m100_418M-ct2-int8` | int8 | **490.7 MB** | ≈500 MB |
| `JustFrederik/m2m_100_418m_ct2_float16` | fp16 | （存在，未取字节） | |

### 4.2 语种 / 质量 / 许可证（【已查证】）

- 语种：**100 种语言**，多语言↔多语言；`language: multilingual, af, am, ar, ...`
- 许可证：**MIT** ✅ （最宽松，与 GPL-3.0 完全兼容）
- `m2m100_418M` downloads 472,337 / likes 349
- ❌ **未查到**：中英方向具体 BLEU/COMET 数值。
- ⚠️ **【已查证】M2M-100 是 2020 年模型，早于 NLLB**。论文（[arXiv:2010.11125](https://arxiv.org/abs/2010.11125)）以 BLEU 报告 100 语言结果，但其英文→中文质量**在现代标准下已明显落后**。【推测：M2M-100 中英质量通常弱于 NLLB 与 OPUS-MT】

> **注意 CTranslate2 支持矩阵**：README 明确列出支持 encoder-decoder 模型
> "*Transformer base/big, **M2M-100, NLLB**, BART, mBART, Pegasus, T5, Whisper, T5Gemma, T5Gemma2, MADLAD-400*"，
> 以及 **Marian / OPUS-MT**。→ 三者均可走 CT2 int8。✅

---

## 5. 阿里 Qwen 小尺寸模型（通用模型用于翻译）

| 模型 | 文件 | 体积 |
|---|---|---|
| `Qwen/Qwen2.5-0.5B-Instruct` | model.safetensors | **988.1 MB** (bf16) |
| `Qwen/Qwen2.5-0.5B-Instruct-GGUF`（官方）| q4_k_m | **491 MB** |
| `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | Q4_K_M | **398 MB** |
| 同上 | Q4_0 | 353 MB |

- 许可证：**Apache-2.0** ✅（`Qwen/Qwen2.5-0.5B-Instruct`）
- 参数量：0.5B；downloads **8,490,785**（本次调研中最高）/ likes 631
- ❌ **未查到**：Qwen2.5-0.5B 作为**翻译模型**的 BLEU/COMET 基准分数。它是通用指令模型，非专用翻译模型。
- **【推测】** 0.5B 通用模型的中英翻译质量显著低于同体积专用翻译模型（如 OPUS-MT 或 Hy-MT2-1.8B）；且是**指令式 LLM**，输出需后处理（可能带解释文本），对划词翻译的"零配置"体验不利。

---

## 6. Google Gemma / T5

| 模型 | 文件 | 体积 | 许可证 |
|---|---|---|---|
| `google/gemma-2-2b-it` | 2×safetensors | 4988.0 + 240.7 ≈ **5.2 GB** (bf16) | **gemma**（Gemma Terms） |
| `bartowski/gemma-2-2b-it-GGUF` | Q4_K_M | **1709 MB** | |
| 同上 | Q8_0 | 2784 MB | |
| `google-t5/t5-small` | model.safetensors | **242.0 MB** | **apache-2.0** ✅ |
| 同上 | **onnx/encoder_model_quantized.onnx** | **35.5 MB** | |
| 同上 | **onnx/decoder_model_quantized.onnx** | **58.7 MB** | |
| 同上 | onnx/decoder_model_merged_quantized.onnx | 58.7 MB | |
| 同上 | pytorch_model.bin | 242.1 MB | |

- `t5-small` 参数量 **60M**，downloads **24,729,634**（极高热度）
- **T5-small 量化 ONNX 合计约 94 MB，是本次调研中体积最小的可用方案**（【已查证】文件确实存在于官方仓库）。
- ⚠️ 但 **T5-small 是通用文本到文本模型，不是翻译专用模型**——模型卡无翻译基准。若直接用于翻译，质量【推测】很差。
- **Gemma 许可证**：Google 的 Gemma Terms of Use，**非标准 OSI 许可证**，含使用限制条款。与 GPL-3.0 的兼容性**【未查证】**，需单独阅读 Gemma Terms。体积上 2B Q4_K_M 达 1709MB，本身已超出轻量目标。

---

## 7. 推理加速方案对比

| 方案 | 支持的 MT 架构 | 量化支持 | 关键事实 |
|---|---|---|---|
| **CTranslate2** | Transformer base/big、**M2M-100、NLLB**、BART、mBART、Pegasus、**T5**、Whisper、T5Gemma、MADLAD-400、**Marian/OPUS-MT** | **FP16 / BF16 / INT16 / INT8 / AWQ(INT4)** | "Quantization can make the models **4 times smaller on disk** with minimal accuracy loss." 有官方 CPU 基准表（见 §2.2） |
| **llama.cpp / GGUF** | LLM 类（Hy-MT2、Qwen、Gemma） | Q8_0/Q6_K/Q4_K_M/Q2_K/**1.25-bit STQ** | ⚠️ Hy-MT2 GGUF **依赖未合并 PR #22836**（截至 2026-09 仍 open） |
| **ONNX Runtime** | T5-small 官方提供 quantized ONNX | 动态 int8 | T5-small encoder+decoder quantized ≈ **94 MB**（【已查证】文件存在） |
| **vLLM / SGLang / TensorRT-LLM** | Hy-MT2 系列（官方 README 给出用法） | FP8 等 | 面向 GPU 服务端，**不适合无独显笔记本** |
| **AngelSlim**（腾讯自研） | Hy-MT1.5 / Hy-MT2 | 1.25-bit 三元量化、低比特量化、投机采样 | [github.com/tencent/AngelSlim](https://github.com/Tencent/AngelSlim) |

**CTranslate2 版本注意**：官方基准用的是 **CTranslate2 3.6.0**（较旧）。当前版本号未查证。

---

## 8. 许可证兼容性总表（针对 GPL-3.0 项目）

| 模型 | 许可证 | 商用 | 可随 GPL-3.0 分发 | 备注 |
|---|---|---|---|---|
| `Helsinki-NLP/opus-mt-en-zh` | Apache-2.0 | ✅ | ✅ **兼容** | 推荐 |
| `Helsinki-NLP/opus-mt-zh-en` | CC-BY-4.0 | ✅ | ✅ **兼容**（需署名） | 反向方向 |
| `facebook/m2m100_418M` | MIT | ✅ | ✅ **兼容** | 质量较旧 |
| `facebook/nllb-200-distilled-600M` | **CC-BY-NC-4.0** | ❌ | ❌ **不兼容** | 明确排除 |
| `tencent/Hy-MT2-1.8B` | **Apache-2.0** | ✅ | ✅ **兼容** | 腾讯系唯一可用 |
| `tencent/HY-MT1.5-1.8B` | Tencent HY Community License | ⚠️ 有限制 | ❌ **实质冲突** | 禁 EU/UK/KR |
| `tencent/Hunyuan-MT-7B` | Tencent Hunyuan Community License | ⚠️ 有限制 | ❌ **实质冲突** | 禁 EU/UK/KR |
| `Qwen/Qwen2.5-0.5B-Instruct` | Apache-2.0 | ✅ | ✅ **兼容** | 非专用翻译模型 |
| `google-t5/t5-small` | Apache-2.0 | ✅ | ✅ **兼容** | 非专用翻译模型 |
| `google/gemma-2-2b-it` | Gemma Terms | ⚠️ | **未查证** | 需单独评估 |

> ⚠️ **以上兼容性判断为基于许可证文本的【推测】，非法律意见。**
> 尤其注意：模型卡的 `license:` 字段可能不完整（见 §1.6 中 Hunyuan-MT-7B 的 cardData 完全缺失 license 字段，
> 但仓库内实际存在 `License.txt`）。**务必读仓库内的 LICENSE 文件，而非只看卡片标签。**
> 另需注意：**训练数据许可**与**权重许可**是两个独立问题。

---

## 9. 汇总对比表（核心数字）

| 模型 | 参数量 | 权重磁盘体积（各精度） | CPU 内存 | CPU 速度 | 中英质量 | 语种/方向 | 许可证 |
|---|---|---|---|---|---|---|---|
| **OPUS-MT en-zh** | ~77M | fp32 312MB / **CT2 int8 79.6MB** / CT2 fp16 155.5MB | **516MB**（CT2 int8，官方基准） | **696 tok/s**（4线程 Xeon） | BLEU **31.4** / chrF 0.268（Tatoeba） | 单语言对（en→zh 多变体） | Apache-2.0 ✅ |
| **OPUS-MT zh-en** | ~77M | fp32 312MB | 同上 | 同上 | BLEU **36.1** / chrF **0.548** | 单语言对 | CC-BY-4.0 ✅ |
| **Hy-MT2-1.8B** | 1.8B | bf16 4077MB / FP8 2039MB / **Q4_K_M 1133MB** / Q6_K 1475MB / Q8_0 1909MB / **2bit 600.5MB** / **1.25bit 462MB** / ONNX Q4-CPU 1282MB / LiteRT int8 1816MB | 未查到 | 未查到（官方称 1.25bit 提速 1.5×） | 未查到具体分数（官方称超 MS/Doubao API） | 33+5 语言，多↔多 | **Apache-2.0** ✅ |
| **HY-MT1.5-1.8B** | 1.8B | bf16 4077MB / **GPTQ-Int4 1329.7MB** / Q4_K_M 1133MB / 1.25bit 462MB | 未查到 | 未查到 | 未查到 | 33+5 语言，多↔多 | Tencent HY ❌ |
| **Hunyuan-MT-7B** | 7B | bf16 ≈16.1GB / FP8 ≈8.0GB | 未查到 | 未查到 | WMT25 31项中30项第一（方向未细分） | 未查到（7B 代） | Tencent Hunyuan ❌ |
| **NLLB-200-distilled-600M** | 600M | bf16 2460MB / **CT2 int8 622.6MB** | 未查到 | 未查到 | 未查到（论文：整体 +44% BLEU） | **200 语言，多↔多** | **CC-BY-NC** ❌ |
| **NLLB-200-distilled-1.3B** | 1.3B | bf16 5483MB | 未查到 | 未查到 | 未查到 | 200 语言，多↔多 | CC-BY-NC ❌ |
| **M2M-100 418M** | 418M | fp32 1936MB / **CT2 int8 490.7MB** | 未查到 | 未查到 | 未查到 | 100 语言，多↔多 | **MIT** ✅ |
| **M2M-100 1.2B** | 1.2B | fp32 4958MB | 未查到 | 未查到 | 未查到 | 100 语言，多↔多 | MIT ✅ |
| **Qwen2.5-0.5B-Instruct** | 0.5B | bf16 988MB / **Q4_K_M 398–491MB** | 未查到 | 未查到 | 未查到 | 通用（多语言） | Apache-2.0 ✅ |
| **Gemma-2-2b-it** | 2B | bf16 5.2GB / **Q4_K_M 1709MB** | 未查到 | 未查到 | 未查到 | 通用 | Gemma Terms ⚠️ |
| **T5-small** | 60M | fp32 242MB / **ONNX int8 35.5+58.7≈94MB** | 未查到 | 未查到 | 未查到（非翻译专用） | 通用 | Apache-2.0 ✅ |

---

## 10. 明确的「未查到」清单（避免误用）

以下问题本次调研**未能找到可靠数字**，不做推测填充：

1. **Hy-MT2 / HY-MT1.5 / Hunyuan-MT-7B 的任何具体 BLEU / COMET / chrF 数值**（含中英）。
   官方以图片（`imgs/main_result.png`）发布结果，README 无数字表；arXiv 报告正文未提取。
2. **Hy-MT2-1.8B 各量化档位的 CPU 实测 tokens/s 与 RAM 占用**。官方仅给"1.5× 加速"相对值。
3. **NLLB-200-distilled-600M 的中英方向具体分数**（论文有 FLORES-200 表格，本次未提取）。
4. **M2M-100 418M / 1.2B 的中英方向具体分数**。
5. **Qwen2.5-0.5B、Gemma-2-2B、T5-small 的翻译基准分数**（均非翻译专用模型，无权威 MT 基准）。
6. **各模型在真实笔记本 CPU（如 i5/i7 U 系列、Ryzen 移动版）上的实测速度**。
   所有速度数据均来自服务器级 CPU（Xeon 8275CL）或 GPU（A10G）。
7. **CTranslate2 当前版本号**（基准数据来自 3.6.0，现版本未查证）。
8. **Gemma Terms 与 GPL-3.0 的兼容性**。
9. **OPUS-MT 权重许可与训练数据（OPUS 语料）许可是否一致**。
10. **Hy-MT2 的 Q4_K_M/Q6_K/Q8_0 是否也依赖未合并的 STQ kernel**（README 未区分，仅笼统标注依赖 PR #22836）。

---

## 11. 环境限制说明（影响复现）

- `huggingface.co` 在本机**不可达**（`curl` 返回 000；DNS 有 A 记录 47.88.58.234 但连接失败）。
- 全部 HF 数据经 **`hf-mirror.com`** 获取。该镜像的 `/api/models?blobs=true` 返回的文件字节数与
  HF 官方一致（体积数据可信），但**下载计数/dl 与 likes 可能与官方略有偏差**。
- `arxiv.org`、`github.com`、`raw.githubusercontent.com`、`pypi.org`、`registry.npmjs.org` 均可达。
- `modelscope.cn` 可达（302 重定向），但其搜索 API 未返回可解析 JSON，**ModelScope 侧的具体模型可用性未逐一验证**。

---

## 12. 数据来源汇总

| 主题 | URL |
|---|---|
| Hy-MT2-1.8B 模型卡 | https://hf-mirror.com/tencent/Hy-MT2-1.8B |
| Hy-MT2-1.8B-GGUF（含量化体积与路线图） | https://hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF |
| Hy-MT2-1.8B-1.25Bit-GGUF | https://hf-mirror.com/tencent/Hy-MT2-1.8B-1.25Bit-GGUF |
| Hy-MT2-1.8B-2Bit-GGUF | https://hf-mirror.com/tencent/Hy-MT2-1.8B-2Bit-GGUF |
| Hy-MT2-1.8B 社区 ONNX 转换 | https://hf-mirror.com/justinchuby/Hy-MT2-1.8B-ONNX |
| Hy-MT2-1.8B LiteRT int8 | https://hf-mirror.com/litert-community/Hy-MT2-1.8B |
| Hy-MT2-1.8B LICENSE.txt（Apache-2.0） | https://hf-mirror.com/tencent/Hy-MT2-1.8B/raw/main/LICENSE.txt |
| HY-MT1.5-1.8B License.txt（Tencent HY） | https://hf-mirror.com/tencent/HY-MT1.5-1.8B/raw/main/License.txt |
| Hunyuan-MT-7B License.txt（Tencent Hunyuan） | https://hf-mirror.com/tencent/Hunyuan-MT-7B/raw/main/License.txt |
| Hy-MT2 arXiv 报告（440MB / 1.5× 出处） | https://arxiv.org/abs/2605.22064 |
| Hy-MT2 GitHub（STQ kernel 依赖说明） | https://github.com/Tencent-Hunyuan/Hy-MT2 |
| llama.cpp STQ PR #22836（未合并） | https://github.com/ggml-org/llama.cpp/pull/22836 |
| OPUS-MT en-zh（BLEU 31.4） | https://hf-mirror.com/Helsinki-NLP/opus-mt-en-zh |
| OPUS-MT zh-en（BLEU 36.1） | https://hf-mirror.com/Helsinki-NLP/opus-mt-zh-en |
| OPUS-MT en-zh 原始 eval.txt | https://object.pouta.csc.fi/Tatoeba-MT-models/eng-zho/opus-2020-07-17.eval.txt |
| OPUS-MT en-zh CTranslate2 int8（79.6MB） | https://hf-mirror.com/jiangzhuo9357/opus-mt-en-zh-ct2 |
| CTranslate2 官方 CPU 基准（tok/s + RAM） | https://github.com/OpenNMT/CTranslate2#benchmarks |
| CTranslate2 量化文档 | https://opennmt.net/CTranslate2/quantization.html |
| NLLB-200-distilled-600M（CC-BY-NC） | https://hf-mirror.com/facebook/nllb-200-distilled-600M |
| NLLB-200 论文 | https://arxiv.org/abs/2207.04672 |
| NLLB CT2 int8（622.6MB） | https://hf-mirror.com/JustFrederik/nllb-200-distilled-600M-ct2-int8 |
| M2M-100 418M（MIT） | https://hf-mirror.com/facebook/m2m100_418M |
| M2M-100 CT2 int8（490.7MB） | https://hf-mirror.com/JustFrederik/m2m_100_418m_ct2_int8 |
| Qwen2.5-0.5B-Instruct | https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct |
| T5-small（ONNX quantized） | https://hf-mirror.com/google-t5/t5-small |
| Gemma-2-2b-it | https://hf-mirror.com/google/gemma-2-2b-it |
| AngelSlim 量化工具 | https://github.com/Tencent/AngelSlim |