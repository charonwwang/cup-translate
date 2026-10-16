# 朗读与回译交互修复（2026-10-16）

- 原本本地 TTS 仅检测 espeak / speech-dispatcher，macOS 因此报 Linux 引擎缺失。macOS 现在使用系统 `/usr/bin/say`，选择已安装的对应语言音色，后台合成为 WAV；临时文件读完或失败后删除。不会自动切换网络服务。
- Google 朗读已有独立实现。翻译引擎和语音服务分别配置；在设置的服务/语音合成中选择 Google TTS，并将其排到第一位。网络服务可用性受连接和端点限制，本轮没有验证 Google 在线合成。
- 原文与译文朗读采用统一单播放控制器：加载、播放、停止；AudioContext 在点击时恢复；取消期间返回的旧音频不会再播放。内容变化及卸载清理播放。旧的词典音标音频仍保留原有播放入口。
- 回译与原译文分别保存，首次调用反向翻译，之后切换复用结果；方向使用译文语言到实际检测的原文语言。回译失败保留译文，新查询使旧回译失效。按钮提示、图标、选中状态和复制文案同步变化，朗读语言跟随当前视图。
- 前端 396 项测试通过，Rust 153 项通过、1 项模型基准忽略。新增覆盖等待语音时取消、跨按钮互斥、失败复位，macOS 实际生成 WAV 并验证 RIFF/WAVE 标识。
- 实际 React 界面夹具验证朗读/停止、回译/返回译文，截图位于 docs/design/ui-review-v3/screenshots/。可用 `/tests/visual/index.html?view=translate&scenario=multi&speech=1` 重现，使用静音 PCM，不连接真实服务。

限制：WAV 合成测试验证音频文件格式，不等同于人工听感验收。Linux speech-dispatcher 仍是自行播报，不能由 Web Audio 停止。
