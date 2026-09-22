# 免 API key 公开翻译服务与开源翻译后端 · 事实调研（2026）

> 调研方式：`curl` 实测 + 官方文档抓取 + GitHub API。
> 标注约定：**[实测]** = 本次调研亲自发起请求得到的响应；**[文档]** = 官方文档原文；**[推测]** = 无直接证据的推断。
> 实测环境：容器网络（**无法直连 Google**，见 §1.1 —— 这是本次调研最大的环境限制）。
> 实测时间：2026 年（GitHub API 返回 `updated_at` 2026-09-21）。

---

## 0. 结论速览

| 方案 | 是否免 key | 2026 实测状态 | 官方/逆向 | 稳定性 |
|---|---|---|---|---|
| Google `translate_a/single` | 免 key | **无法验证**（本环境网络不通） | 逆向非官方 | 低，且需处理网络可达性 |
| Bing `edge.microsoft.com/translate/auth` | — | **404 确认失效 [实测]** | 逆向非官方 | **已死** |
| MyMemory | 免 key | **可用 [实测]**，500 字符/请求、5000 字符/天 | **官方** | 中高（官方但配额极小） |
| Yandex `translate.yandex.net` | **需 key** | 无 key 报 `Invalid parameter: key` **[实测]** | 官方 | 免费档已取消 |
| LibreTranslate 公共实例 | 免 key | **实测全部失效/被墙 [实测]** | 官方但实例非官方 | 公共实例不可用 |
| Lingva 公共实例 | 免 key | **实测全部失效 [实测]**；上游仓库 2023 年后停更 | 逆向非官方 | **已近死亡** |
| SimplyTranslate | 免 key | 服务在线但返回空译文 **[实测]** | 逆向非官方 | 低 |
| 自建 LibreTranslate | 自建 | **活跃维护**（v1.9.6 / 2026-05-26）**[实测]** | 官方 | 高（但资源开销大） |
| LLM 直连（SiliconFlow 免费模型） | **需注册 key** | 有免费模型档 **[文档]** | 官方 | 中（需实名） |

**核心判断**：2026 年「完全不需用户申请 key」的公开翻译服务已**大面积塌陷**。唯一实测可用的免 key 服务是 MyMemory，但其 500 字符/请求 + 5000 字符/天 的配额对划词翻译**勉强够用但极易触顶**。

---

## 1. 免 key 公开翻译 API / 非官方接口

### 1.1 Google 非官方端点 `translate.googleapis.com/translate_a/single?client=gtx`

**⚠️ 本次未能直接验证 —— 环境限制**

**[实测]** DNS 可解析，但 TCP 连接全部超时：

| 主机 | DNS | TCP 443 |
|---|---|---|
| `translate.googleapis.com` | ✅ 解析到 108.177.98.95 | ❌ 超时 |
| `translate.google.com` | — | ❌ 超时 |
| `clients5.google.com` | — | ❌ 超时 |
| `translate.google.cn` | — | ✅ 连通，但 `/translate_a/single` 返回 **404** |

- `translate.google.cn` 虽 TCP 连通，但该路径返回 **HTTP 404**（Google 中国区服务已于 2022 年停止，域名仅剩跳转/错误页）**[实测]**。
- 因此**无法给出 2026 年 gtx 端点可用性的第一手结论**。业界普遍仍在用它，但属于**逆向非官方接口**，Google 从未承诺支持。
- **风险（推测，但证据充分）**：该端点无官方 SLA、无公开配额文档；Google 长期通过 IP 封禁/验证码方式反制。桌面应用以固定 User-Agent 高频调用极易被限流。**建议不要作为唯一依赖。**

> 来源：实测 + [Google 中国区停止服务报道](https://www.google.com/)（未查到 2026 年官方状态页）

### 1.2 Microsoft/Bing Edge 令牌接口 —— **已确认失效** ✅ 高置信度

**[实测]** 直接请求，两次均返回 404：

```
GET https://edge.microsoft.com/translate/auth        -> HTTP 404
GET https://edge.microsoft.com/translate/auth/       -> HTTP 404
```

- **证实了上游项目遇到的 404 问题**，该令牌端点当前不可用。
- `edge.microsoft.com` 域名本身仍然存活（DNS 解析到 `ax-0002.ax-msedge.net`），说明是**该路径被移除**，而非整个域下线 **[实测]**。
- 替代路径探测：`api-edge.cognitive.microsofttranslator.com/translate` 返回 **405 Method Not Allowed**（说明端点存在，但需 POST + `Ocp-Apim-Subscription-Key` 或有效 Bearer token）**[实测]**。
- **[推测]** 未查到微软官方公告说明废弃原因；`api-edge.*` 属 Edge 浏览器内部使用的非公开接口，无官方文档、无 SLA，**同样属于随时可能失效的逆向接口**。
- **[未查到]** 是否存在 2026 年仍可用的免 key 替代令牌端点。

> 来源：实测请求

### 1.3 MyMemory `api.mymemory.translated.net` —— **官方 API，实测可用** ✅

**[实测]** 端到端成功：

```
GET https://api.mymemory.translated.net/get?q=hello%20world&langpair=en|zh-CN
-> 200 {"responseData":{"translatedText":"你好世界","match":1},
        "quotaFinished":false,"responseStatus":200,...}
```

**配额（官方文档原文）[文档]**：

| 档位 | 额度 | 条件 |
|---|---|---|
| 匿名免费 | **5000 字符/天** | 无需任何 key |
| 提供有效 email（`de` 参数） | **50000 字符/天** | 仅需填邮箱，**仍无需 key** |
| CAT 工具白名单 | 150000 字符/天 | 需申请，明确排除个人项目 |
| RapidAPI 付费 | 更高 | 付费 |

> 原文："Free, anonymous usage is limited to 5000 chars/day. Provide a valid email ('de' parameter) ... and enjoy 50000 chars/day."

**其他实测约束**：

- **单请求上限 500 字符**：600 字符请求返回 `403 QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS` **[实测]**
  - 注意：官方 spec 写 "Max 500 **bytes**"，实测中文/多字节会更快触顶 **[文档+实测]**
- `de=email` 参数实测被接受，返回 200 **[实测]**（但未验证额度是否真的提升到 50k —— 需长期观测）
- **白名单明确拒绝本项目这类应用**：原文 "Personal projects or 'in development' stuff, projects that just use the 'get' endpoint without contributing to MyMemory using the 'set' endpoint, **never qualify** for the whitelisting." **[文档]**

**质量口碑 [文档+实测]**：
- 返回体含 `matches` 数组，每条带 `quality`（如 74）、`match`（0-1 匹配度）、`created-by`（如 `MateCat`）
- 实测 `hello world` 命中的是 **2014/2018 年的人工翻译记忆库条目**，`usage-count: 2` —— 说明**优先返回翻译记忆（TM）而非机器翻译**，短句质量好，长句/新词大概率回退到 MT 且质量未知
- 语种覆盖：官方称使用 ISO/RFC3066 语言名。**[未查到]** 明确的语种覆盖清单；TM 库为众包贡献，**长尾语种覆盖不可保证 [推测]**

> 来源：[API spec](https://mymemory.translated.net/doc/spec.php)、[Usage Limits](https://mymemory.translated.net/doc/usagelimits.php)、实测

### 1.4 Yandex 免费端点 —— **免费档已取消** ✅

**[实测]** 无 key 请求：

```
POST https://translate.yandex.net/api/v1.5/tr.json/translate
     -d "text=hello&lang=en-zh&format=plain"
-> {"code":502,"message":"Invalid parameter: key"}
```

- 端点存活（HTTP 400/502 而非 404），但**明确要求 API key**，不再有免 key 免费档 **[实测]**。
- **[未查到]** 2026 年 Yandex 免费额度的确切政策（Yandex Cloud 曾提供试用额度，但需注册+绑卡）。

> 来源：实测请求

### 1.5 其他免 key 翻译 API

#### LibreTranslate 公共实例 —— **实测全部不可用** ✅ 高置信度

**[实测]** 逐个 POST `/translate`：

| 实例 | 结果 |
|---|---|
| `libretranslate.com` | **403**（Cloudflare 拦截，要求 API key） |
| `translate.terraprint.co` | **502** Bad Gateway |
| `lt.vern.cc` | **无响应**（且返回了 terraprint 的 502 缓存） |
| `libretranslate.de` | **301** 跳转（已被 Cloudflare 接管） |
| `translate.fedilab.app` | **403** Forbidden（administrative rules） |
| `trans.zillyhuhn.com` | **403** Forbidden |

**结论：曾经流行的 LibreTranslate 公共实例在 2026 年已基本全部失效或被强制要求 API key。** 这一发现对选型至关重要 —— **不能把公共 LibreTranslate 实例当作免 key 方案**。

> 来源：实测请求

#### SimplyTranslate —— **服务在线但功能失效** ✅

**[实测]**：

```
GET https://simplytranslate.org/api/translate/?engine=google&from=en&to=zh&text=hello
-> 200 {"source_language":"en","definitions":null,"translations":null,
        "translated_text":"","pronunciation":""}
```

- HTTP 200 但 **`translated_text` 为空字符串** —— **接口活着但翻译不出结果** **[实测]**。
- 推测原因：其后端依赖 Google 抓取，被限流/封禁后静默返回空 **[推测]**。
- 其他实例 (`translate.simplytranslate.org`、`simplytranslate.pussthecat.org`) **完全无响应** **[实测]**。

> 来源：实测请求

---

## 2. 自托管 / 可自建的开源翻译后端

### 2.1 LibreTranslate —— **推荐，维护活跃** ✅

**[实测]** GitHub API 数据（截至 2026-09-21）：

| 指标 | 值 |
|---|---|
| 仓库 | `LibreTranslate/LibreTranslate` |
| Stars | **16,695** |
| Open issues | 126 |
| 最后 push | **2026-09-03** |
| 许可证 | **AGPL-3.0** ⚠️ |
| Archived | False |

**最近发版 [实测]**：

| 版本 | 日期 |
|---|---|
| v1.9.6 | 2026-05-26 |
| v1.9.5 | 2026-03-03 |
| v1.9.4 | 2026-02-24 |
| v1.9.3 | 2026-02-21 |

→ **发版节奏健康（2026 年内多次发版），项目明确活跃，未废弃。**

**技术事实 [文档]**：
- 翻译引擎为 **Argos Translate**（`argosopentech/argos-translate`），纯离线、不依赖 Google/Azure 等专有服务
- 官方描述："entirely self-hosted. Unlike other APIs, it doesn't rely on proprietary software such as Google or Azure"
- 引擎项目 Argos：Stars 6,490，最后 push **2026-08-08**，MIT 许可 **[实测]**

**⚠️ 许可证风险 [实测]**：LibreTranslate 为 **AGPL-3.0**。cup-translate 是 **GPL-3.0** 桌面应用，若以**独立进程**形式调用自建 LibreTranslate 实例（网络调用），通常不构成衍生作品；但若**链接/打包**其代码则需谨慎评估。**建议选型时由法律/维护者确认。**

**[未查到]** LibreTranslate 官方 README 中**没有**给出明确的模型体积与内存占用数字。社区常见说法是「按语种对下载模型，每对约几十 MB 到上百 MB，全量需数 GB 磁盘 + 数 GB 内存」——**本次未能在官方来源验证，标注为 [推测]，选型时须实测**。

> 来源：[LibreTranslate GitHub](https://github.com/LibreTranslate/LibreTranslate)、[Argos Translate](https://github.com/argosopentech/argos-translate)、GitHub API 实测

### 2.2 Lingva Translate —— **已实质停更 + 公共实例全灭** ✅ 高置信度

**[实测]** GitHub API 数据：

| 指标 | 值 |
|---|---|
| 仓库 | `thedaviddelta/lingva-translate` |
| Stars | 1,846 |
| Open issues | 46 |
| 最后 push（API `pushed_at`） | **2023-08-01** |
| **最后一次 commit** | **2023-01-13** |
| Releases | **无任何 release** |
| 许可证 | AGPL-3.0 |

→ **实际代码提交停在 2023 年 1 月，已超过 3 年无功能更新。** `pushed_at` 2023-08 亦仅为分支推送。

**公共实例实测（逐个请求 `/api/v1/en/zh/hello`）[实测]**：

| 实例 | 结果 |
|---|---|
| `lingva.pot-app.com`（上游硬编码） | **DNS 解析失败（NXDOMAIN）** ❌ |
| `lingva.ml` | **403** Cloudflare "Just a moment..." 挑战 |
| `lingva.lunar.icu` | **连接失败**（返回 Cloudflare 挑战页） |
| `translate.plausibility.cloud` | **500** `{"error":"An error occurred while retrieving the translation"}` |
| `lingva.garudalinux.org` | **连接失败** |
| `lingva.thedaviddelta.com` | **503** `DEPLOYMENT_PAUSED` ⚠️ 作者自己的实例已暂停 |
| `lingva.zzls.xyz` | **301** 跳转 |
| `translate.dr460nf1r3.org` | **DNS 失败** |
| `lingva.jamesflare.com` | **DNS 失败** |

**结论：Lingva 生态在 2026 年已基本死亡 —— 作者自己的官方实例都是 `DEPLOYMENT_PAUSED`，其余实例要么 DNS 消失、要么被 Cloudflare 拦截、要么后端报错。** 这直接印证了上游 cup-translate 的 `lingva.pot-app.com` 失效问题，且**不是个案**。

> 来源：GitHub API 实测、逐实例 HTTP 实测

### 2.3 其他现代替代品

- **Argos Translate**（`argosopentech/argos-translate`）：LibreTranslate 的底层引擎，可作为 Rust 应用外挂的本地翻译进程。Stars 6,490，最后 push 2026-08-08，MIT 许可 **[实测]**。Python 实现，嵌入 Rust 桌面应用需处理 Python 运行时/打包体积 **[推测]**。
- **[未查到]** 2026 年有其它同等知名度、活跃维护的「免 key 公共翻译 API」项目。
- **[未查到]** 专门面向桌面端嵌入的 Rust 原生离线翻译库（如基于 CTranslate2/OPUS-MT 的 Rust binding）的权威现状 —— 本次未检索到可靠来源。

---

## 3. LLM 直连翻译方案

> ⚠️ **前提变更**：LLM 方案**都需要用户注册并申请 API key**，与「装完就能翻译、无需申请任何 key」的产品目标**直接冲突**。以下列出仅为选型完整性。

### 3.1 DeepSeek

**[文档]** 官方定价页（2026）显示两种模型与实际价格：

| 模型 | 输入（缓存命中） | 输入（缓存未命中） | 输出 |
|---|---|---|---|
| `deepseek-flash` (V4.1-Flash) | 错峰 $0.003 / 高峰 $0.006 | 错峰 $0.15 / 高峰 $0.3 | 错峰 $0.6 / 高峰 $1.2 |
| `deepseek-v4-pro` | 错峰 $0.022 / 高峰 $0.044 | 错峰 $0.66 / 高峰 $1.32 | 错峰 $1.98 / 高峰 $3.96 |

（单位：每 1M tokens；错峰价为高峰价的一半，高峰时段为 UTC 周一至周五 01:00-04:00 与 06:00-10:00）

- **并发限制**：`deepseek-flash` 2500，`deepseek-v4-pro` 500，账户级 **[文档]**
- **⚠️ 关于「免费额度」**：定价页提到 "granted balance"（赠送余额）优先于充值余额扣费，**但该页面未说明新用户注册是否赠送、赠送多少** **[文档]**。**[未查到]** 2026 年 DeepSeek 新用户免费额度的确切政策。

> 来源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit)

### 3.2 硅基流动 SiliconFlow —— **有明确的免费模型档** ✅

**[文档]** Rate Limits 页面原文关键点：

- **"实名认证后使用全部的免费模型"** —— 免费模型存在，但**需实名认证**
- **"免费模型调用免费"**，账单中此类模型费用为 **0**
- **免费模型的 Rate Limits 是固定值**（不随用量级别提升）
- 平台按**月消费金额**划分 L0–L5 用量级别，**新用户注册后初始级别为 L0**
- 超限返回 **HTTP 429**

| 用量级别 | 门槛（人民币） |
|---|---|
| L0（新用户默认） | < ¥50 |
| L1 | ¥50 – ¥200 |
| L2 | ¥200 – ¥2000 |
| L3 | ¥2000 – ¥5000 |
| L4 | ¥5000 – ¥10000 |
| L5 | > ¥10000 |

- 免费模型列表**未在文档中枚举**，需在「模型广场」查询 **[文档]**
- 兼容 OpenAI SDK（`base_url=https://api.siliconflow.cn/v1`）**[文档]**

> 结论：SiliconFlow 是本次调研中**唯一明确记录「有免费模型、调用费用为 0」**的商业 API，但**门槛为「注册 + 实名认证」**，非零门槛。

> 来源：[SiliconFlow Rate Limits](https://docs.siliconflow.cn/cn/userguide/faqs/rate-limit-and-upgradation)、[快速上手](https://docs.siliconflow.cn/cn/userguide/quickstart)

### 3.3 智谱 Zhipu / BigModel

**[文档]** 模型概览列出 2026 年主力模型：

| 模型 | 上下文 | 最大输出 | 备注 |
|---|---|---|---|
| GLM-5.3 | 1M | 128K | 旗舰 |
| **GLM-5.3-Flash** | 1M | 128K | **原生多模态**，320B 总参 / **18B 激活** |
| GLM-5.3-FlashX | 1M | 128K | 速度 200 tokens/s |
| GLM-5.2 | 1M | 128K | |
| GLM-OCR / GLM-ASR-2512 / GLM-TTS 等 | — | — | 全模态 |

- ‼️ **重要观察**：文档称 GLM-5.3-Flash 为 **"普惠的全球前沿模型"**，并将 **GLM-5.3-Flash 全量上线 GLM Coding Plan（额度翻 3 倍）** **[文档]**。
- **⚠️ [未查到]**：定价页结构过于复杂（含模型推理/搜索/知识库/微调/私有实例多档），本次抓取**未能提取到 GLM-5.3-Flash 是否免费的具体价格数字**。历史版本 GLM-4-Flash 曾长期免费，但**不能据此推断 GLM-5.3-Flash 仍免费**。**选型前必须查最新定价页。**

> 来源：[智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[GLM-5.3-Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)、[API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing)

### 3.4 「注册即送免费额度」选项评估

| 供应商 | 免费模型/额度 | 是否需实名 | 对「零门槛」目标 |
|---|---|---|---|
| SiliconFlow | ✅ 明确有免费模型（费用 0） | **需实名认证** | ❌ 有门槛 |
| DeepSeek | ⚠️ 提及赠送余额，政策未明 | 需注册充值 | ❌ 有门槛 |
| 智谱 | ⚠️ Flash 系列传统上免费，**未查实** | 需注册 | ❌ 有门槛 |

**结论：不存在「普通用户零门槛、无需注册、无需 key」的 LLM 方案。** LLM 路线必然与产品目标冲突。

---

## 4. 失效风险对比：官方支持 vs 逆向非官方

| 方案 | 性质 | 依据 | 失效风险 |
|---|---|---|---|
| **Google `translate_a/single` (gtx)** | 🔴 **逆向非官方** | 无官方文档/SLA，Google 未公开支持 | **高** — 随时可能加验证码/IP 封禁 |
| **Bing `edge.microsoft.com/translate/auth`** | 🔴 **逆向非官方** | Edge 浏览器内部接口 | **已失效**（404 实测） |
| **Lingva Translate** | 🔴 **逆向非官方**（Google 前端） | 上游 2023 停更；官方实例 `DEPLOYMENT_PAUSED` | **已基本死亡** |
| **SimplyTranslate** | 🔴 **逆向非官方**（Google 抓取） | 实测返回空译文 | **高** — 已实质故障 |
| **MyMemory** | 🟢 **官方 API** | 有正式 spec、usage limits、ToS 页面 | **低**（但配额极小：5000 字符/天匿名） |
| **Yandex** | 🟢 官方 | 需 key，免费档已取消 | 不适用于本项目 |
| **LibreTranslate 公共实例** | 🟡 官方软件 + **非官方托管** | 软件活跃，但公共实例实测全灭/收费 | **公共实例不可依赖** |
| **自建 LibreTranslate** | 🟢 **官方开源** | AGPL-3.0，2026 年活跃发版 | **低**（受自身维护能力约束） |
| **LLM API（SiliconFlow 等）** | 🟢 官方 | 有正式文档与计费 | 低，但**需用户 key，违背产品目标** |

### 关键风险洞察

1. **逆向接口的失效是「同时发生」的** —— Lingva（Google 前端）与 SimplyTranslate 同为 Google 抓取，2026 年同时塌陷；Bing Edge 令牌也同时失效。**说明这不是偶然，而是平台方系统性收紧反爬。**
2. **「公共实例」比「公开 API」更脆弱** —— LibreTranslate 软件本身健康（2026 年多次发版），但其公共实例 100% 失效。**软件活跃 ≠ 公共实例可用。**
3. **唯一实测可用的免 key 官方服务是 MyMemory**，但：
   - 500 字符/请求上限（划词场景通常够用）
   - **5000 字符/天（匿名）** = 约 10-25 次划词翻译就会触顶
   - 官方**明确拒绝**为个人项目/纯 get 调用方提供白名单提额
   - 填 `de=email` 可到 50000 字符/天（约 100-250 次/天），**但仍需用户提供邮箱，且邮箱会被记录**

---

## 5. 本次调研的局限（务必知悉）

| 局限 | 影响 |
|---|---|
| **环境无法直连 Google** | **未能验证 gtx 端点 2026 年是否真的可用**；这条最关键的结论仍属未知 |
| `web_search` 工具不可用（缺 API key） | 无法通过搜索引擎发现新方案，只能靠已知目标 + 官方文档 |
| LibreTranslate 模型体积/内存 | **未在官方来源找到数字**，社区说法未经验证 |
| 智谱 GLM-5.3-Flash 价格 | 定价页结构复杂，**未能提取具体数字** |
| DeepSeek 新用户赠送额度 | 官方页面**未说明**赠送政策 |
| 白名单/长期配额 | 未做长达一整天的额度消耗观测，`de` 参数提额**未经端到端验证** |

**建议后续在真实用户网络环境下复测**：① Google gtx 端点可用性与触限阈值；② MyMemory 50k/天档位的实际生效情况；③ 自建 LibreTranslate 的实际内存占用。

---

## 附：一手实测命令与响应（便于复现）

```bash
# MyMemory —— 可用
curl "https://api.mymemory.translated.net/get?q=hello%20world&langpair=en|zh-CN"
# -> 200 {"responseData":{"translatedText":"你好世界","match":1},"quotaFinished":false,...}

# MyMemory 500 字符上限
curl "https://api.mymemory.translated.net/get?q=$(python3 -c "print('a'*600)")&langpair=en|es"
# -> {"responseStatus":"403","responseDetails":"QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS"}

# Bing Edge 令牌 —— 已失效
curl -o /dev/null -w "%{http_code}\n" https://edge.microsoft.com/translate/auth
# -> 404

# Yandex —— 需 key
curl -X POST https://translate.yandex.net/api/v1.5/tr.json/translate -d "text=hello&lang=en-zh"
# -> {"code":502,"message":"Invalid parameter: key"}

# LibreTranslate 公共实例 —— 全部失效
curl -X POST https://libretranslate.com/translate -H "Content-Type: application/json" \
     -d '{"q":"hello","source":"en","target":"zh"}'
# -> 403 (Cloudflare)

# SimplyTranslate —— 200 但空译文
curl "https://simplytranslate.org/api/translate/?engine=google&from=en&to=zh&text=hello"
# -> {"translated_text":"", ...}

# lingva.pot-app.com —— DNS 不存在
getent hosts lingva.pot-app.com   # -> 无输出
```