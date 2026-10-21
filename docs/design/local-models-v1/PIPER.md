# Piper 本地朗读

2026-10-21：按用户追加要求接入，扩展原 v2 只提供系统语音的范围。

在「模型与连接 → 语音模型 → 添加本地语音模型」选择音色，可搜索、试听、下载、设为该语言默认音色及卸载。主页保留系统语音、Google 和 Piper 三种显式选择；新用户的既有默认设置不变。翻译窗口的朗读菜单也可选 Piper。

- 原文朗读使用原文语言，译文朗读使用目标语言；回译使用原文语言。每种语言独立选默认音色，例如英文 Alba、中文华燕。没有显式默认时，在已安装的同语言音色中优先匹配地区。
- 缺少该语言的音色、选定音色被移除或推理失败会提示检查设置，不改用另一语言或云端。不支持日、韩等未列出的 Piper 语言；它们仍可显式选择系统语音或 Google。普通话音色不能充当粤语音色。
- 未安装时「试听样例 · 联网」只下载、缓存上游固定 MP3，无用户文本；安装后试听与正文朗读使用同一个本地推理引擎，不访问网络。可在仅设备模式下使用本地 Piper。
- 每个音色单独下载 ONNX、JSON 配置及模型卡。固定仓库提交和每个文件的大小、SHA256；显示实际字节进度。完整校验并实际合成 WAV 自检后，才原子移动到就绪目录。一次安装一个音色，不下载整个列表。
- 下载可取消。重试复用完整且校验通过的文件；未完成文件从头下载，不宣称支持 Range 续传。应用关闭后，下次重新下载该型号也可复用已完整下载的文件；不自动联网继续。
- 卸载需确认，清理该音色、暂存文件、试听缓存和对应默认选择，保留其他音色、翻译模型、历史与配置。可以再次下载。合成期间拒绝卸载；下载先取消并结束。关闭管理弹窗不会取消已开始的下载。
- CPU 本地推理，无需 Python、Homebrew 或外部 Piper 程序。运行时固定 `piper-rs 0.2.0`、`espeak-rs 0.2.0`、`ort 2.0.0-rc.12`；eSpeak NG 静态链接；ONNX Runtime 1.24.2 的官方动态库从固定 SHA256 的官方 PyPI 分发包提取并嵌入应用，首次使用解包到应用缓存后加载（不安装或运行 Python），隔离与翻译引擎的 Protobuf 符号，编译后的 eSpeak 语言字典嵌入程序，首次在应用缓存中展开。每次合成后释放模型。每次最多 3000 字，不保存用户音频。

## 型号与许可

所有文件锁定 `rhasspy/piper-voices` 提交 `5041a7a49ae5b3a0f30e6837769eb03fdbb231bd`。完整清单（体积、SHA256、模型卡原文）在 `src-tauri/resources/piper-catalog.json`。每个音色约 63.2 MB，Paola 约 63.5 MB；质量均为 medium，并非虚构的低/高音质套餐。

| 语言 | 音色 | 上游模型卡中的数据集许可 |
| --- | --- | --- |
| 普通话 zh-CN | 华燕 Huayan | Unknown（上游未注明，界面明确提示） |
| 英语 en-US | Lessac | 上游 Lessac 数据集许可链接，见模型卡 |
| 英语 en-GB | Alba | CC BY 4.0 |
| 法语 fr-FR | Siwis | CC BY 4.0 |
| 德语 de-DE | Thorsten | 见该音色模型卡 |
| 西班牙语 es-ES | DaveFX | 见该音色模型卡 |
| 葡萄牙语 pt-BR | Faber | 见该音色模型卡 |
| 意大利语 it-IT | Paola | 见该音色模型卡 |
| 俄语 ru-RU | Irina | 见该音色模型卡 |

下载按钮要求确认已阅读所选音色的模型卡与许可说明，不把 Unknown 改写为开放许可。项目 GPL-3.0；eSpeak NG 的 GPL-3.0 与 ONNX Runtime 的 MIT 许可仍须随分发保留，Rust 包装器为 MIT。上游代码与说明：

- https://github.com/thewh1teagle/piper-rs
- https://github.com/espeak-ng/espeak-ng
- https://github.com/microsoft/onnxruntime
- https://huggingface.co/rhasspy/piper-voices

## 配置和平台

新增 `speech_policy: "piper"` 以及 `piper_voices: { "en": "en_GB-alba-medium", "zh": "zh_CN-huayan-medium" }`。它们属于可迁移偏好，不含秘密；模型文件和语音字典不加入配置导出。旧 `local_tts` 仍表示系统语音，不把现有系统配置迁移成 Piper。不创建 API Key，不更改翻译服务顺序。

模型位于应用配置目录 `models/piper/<voice-id>`，下载暂存在同目录 `.voice-id-staging`；公共试听缓存位于应用缓存目录 `piper-previews`。删除音色不删除其他文件夹。

运行时面向 macOS 14+ ARM64、Linux ARM64/x86_64、Windows x86_64；Intel macOS、Windows ARM64、32 位及其他未提供固定运行库的平台禁用并说明原因。构建需要 Rust >= 1.88、C/C++、CMake/libclang 及 eSpeak NG 构建工具；首次构建通过 Cargo 获取固定版本运行时，运行时无需开发工具。当前只在 macOS ARM64 实机验证；Windows/Linux 未作实机验证，不能视为验收通过。

构建同时编译固定 eSpeak NG 1.52.0 普通话扩展词典，避免依赖默认的小词典导致中文发音覆盖不全。原始词典与来源说明随仓库提供，二进制内嵌完整编译结果。

## 本次验证证据（macOS ARM64）

- 前端测试 499 项通过；Rust 默认测试 177 项通过、4 项真实环境测试默认忽略；前端生产构建与 macOS 调试应用打包通过。
- 独立 `com.cup-translate.piper-review` 应用实际执行：未安装音色的公开样例试听；中文下载取消与重试；中文华燕、英文 Alba 分别下载全部固定文件、校验、合成自检到就绪；本地试听；逐语言默认设置；只卸载中文且保留英文，再用预备的完整暂存文件恢复并自检。测试未删除用户真实配置或模型。
- 真实原生集成测试输出：华燕、Alba 均生成 22050 Hz PCM WAV，样例约 2.2 秒，单次推理约 48–56 ms（不含加载、校验和音频播放，不代表所有设备）。扩展普通话词典完整性测试通过，无“小词典缺失”告警。
- 初版静态 ONNX Runtime 曾与 SentencePiece 的 Protobuf 冲突；已改为固定版本动态库，并验证同一进程先 Piper 合成、后 SentencePiece 初始化和编码。M2M-100 的 en→fr、en→ja、ja→zh、fr→de 真实翻译全部回归通过。

复现原生真实测试（模型根目录必须已有上述已校验音色；不会下载其他音色）：

```sh
CUP_PIPER_MODEL_DIR=/absolute/path/to/models/piper \
CUP_M2M_MODEL_DIR=/absolute/path/to/m2m100 \
cargo test --manifest-path src-tauri/Cargo.toml \
  real_piper_voices_produce_wave_without_external_runtime -- --ignored --nocapture
```

其余 7 个音色的固定文件及原始模型卡已核验，尚未在本机逐个下载试听；安装时每个音色必须执行实际合成自检。Windows/Linux 未实机验证；不对未列出的 TTS 架构提供兼容声明。

最终桌面包还验证了同一翻译窗口中英文原文与中文译文分别调用 Piper 朗读，页脚显示 Piper；既有 Google 翻译保持正常。语言或朗读方式变化会停止旧播放，迟到的音频不会重新开始播放。运行时显式关闭 ONNX Runtime 遥测。
