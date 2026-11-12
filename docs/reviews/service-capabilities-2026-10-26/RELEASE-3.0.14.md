# v3.0.14 发布评审

日期：2026-10-26（Asia/Shanghai）。推送前放行检查与远程正式发布均已完成，发布产物对应源提交 `3fb8e7e9713112b1759eecc7796ebfe3a1b7118c`，标签保持不变。

## 评审结论

未发现阻塞此次发布的新问题。四个原修复分支及其回修均已合入 master；后续原生实测暴露的样式、模型生命周期和 Qwen 内容错误也已纳入。本次版本提升为 3.0.14，不替换已公开的 3.0.13 标签或附件。

- Qwen：Mac 使用 CPU 兼容路径，旧 MPS 登记无需重新下载模型即可迁移；单词确定性生成、异常预算拒绝、请求摘要与语言/音色绑定、缓存隔离、旧播放失效均已核对。真实中英文音频经过本地转写，并获用户实听确认。详见 [内容级回修](SPEECH-CONTENT-FOLLOWUP.md)。
- 收藏：Anki 连接测试保持只读，写入校验、未确认写入和重复提交分开处理；欧路及 Anki 凭证沿用系统凭证库路径。没有把外部账号写入测试标为已完成。
- 插件：规范化 ID 和路径、资源验证、压缩包体积限制、安装回滚、损坏包恢复和多实例卸载已复查。保留上游测试源码及许可证；不声明所有 Pot 插件均兼容。
- 字典与界面：已有拼音/音标保留、原文/译文朗读、可选补充失败不影响主结果、设备内模式，以及服务页直接进入模型弹窗的样式已验证。
- 发布：package、Cargo manifest/lock、Tauri 版本统一；公开更新端点与内置验签公钥保持不变。签名私钥仅使用现有 CI secrets，未读取或复制到源码。

## 本地检查

| 项目 | 结果 |
| --- | --- |
| 受 Git 管理的 Node 测试 | 584 通过 |
| Qwen Python 回归 | 8 通过 |
| Rust 全量无默认 features | 199 通过、6 按原标记忽略 |
| Vite 生产构建 | 通过 |
| diff 空白检查 | 通过 |

Python 回归加入 Release desktop 的 preflight，使语音设备选择、内容绑定及缓存回归在公开构建前执行。原生与账号/完整模型的验收边界沿用 INTEGRATION.md 及各模块结果记录；本次跨平台安装包由远程正式发布矩阵构建，不把构建成功等同于各系统上的人工安装验收。

本地 Git 元数据中的无效空格副本引用影响 fetch，已原样移出 .git 留作本机备份；正常分支、标签和用户未跟踪的文件副本未删除。远程 master 与本地主分支确认可以快进，不进行强制推送。

## 远程发布与下载复核

- master 已快进推送，`v3.0.14` 已发布为 Latest：[正式发布](https://github.com/charonwwang/cup-translate/releases/tag/v3.0.14)。
- [Release desktop 流水线](https://github.com/charonwwang/cup-translate/actions/runs/40302632061) 全部成功：preflight、Windows 运行库检查、macOS ARM64/x64、Windows x64/x86/ARM64、Linux x64/ARM64，以及最终 publish。
- 主发布 16 个附件，独立 updater 发布 12 个文件；28 个下载地址均以不含认证头的请求验证返回 200。GitHub 元数据读取使用已有登录，规避共享网络的匿名 API 配额限制；下载验证本身不依赖登录。
- latest/update.json 的版本为 3.0.14，六个更新平台条目正确；清单 SHA-256 与 SHA256SUMS 相同，公开附件摘要与 GitHub 上传摘要逐项一致。
- 独立下载 macOS ARM64 CI 产物，以客户端内置公钥再次验证更新签名，通过；压缩包内 CFBundleShortVersionString 为 3.0.14，应用标识保持 com.cup-translate.app。
- 没有替换已公开的旧版本附件，没有修改更新验签公钥。此次不把每个平台人工安装或真实外部收藏账号写入标记为已完成；macOS 应用内升级另行完成验收，见下节。

单独的 [Verify Windows and Linux builds](https://github.com/charonwwang/cup-translate/actions/runs/40302597939) 在六个目标成功，ARMv7 仍因既有扩展构建问题失败；上一版也存在同目标失败。本次正式发布矩阵不含 ARMv7，该失败不影响上述七个已成功的发布目标。后续已从 Verify 工作流移除 ARMv7 目标，并加入“工作流不得重新包含 ARMv7”的配置回归测试。

机器证据：[发布验证记录](integration-evidence/release-3.0.14.json)。

## 应用内升级验收（2026-11-04）

使用公开发布的 3.0.13 macOS ARM64 DMG 安装旧版，通过应用启动检查进入更新窗口，完成 3.0.14 的下载、Tauri 内置公钥验签、替换和重启。3.0.13 DMG 为 77,564,846 字节，SHA-256 与 release 的 `SHA256SUMS` 一致：`d22f717adac36996377484d952eb0df0f4e1465a6c757b181019d8cf0db17190`。

| 验收点 | 证据 |
| --- | --- |
| 旧版为 3.0.13 | `CFBundleShortVersionString=3.0.13`；启动日志记录配置路径 |
| 检测到 3.0.14 | `[2026-11-04][10:54:54][INFO][cup_translate::updater] New version available` |
| 更新窗口展示 3.0.14 | [检测截图](integration-evidence/upgrade-3.0.13-detected-3.0.14.png) |
| 用户确认后下载安装 | [确认截图](integration-evidence/upgrade-3.0.13-confirm.png)；未验签通过不会进入安装 |
| 安装后重启 | `[2026-11-04][11:14:11][INFO][cup_translate] ============== Start App ==============` |
| 安装结果为 3.0.14 | `CFBundleShortVersionString=3.0.14`；主程序 SHA-256 `1a4b727c...d3006` 与原 3.0.14 应用一致 |
| 配置未丢失 | 升级前后配置 SHA-256 均为 `6f909763...e25f`，规范化 JSON diff 为空 |
| 历史未丢失 | `history.db` 的 `history` 表升级前后均为 194 行 |
| 单实例运行（**待复验**） | 11:14:11 的重启日志中同一启动块出现两份 `Start App`；第二个进程注册了全局快捷键，随后 `Server start failed: Address already in use`，说明它到达了热键注册阶段，单实例守卫没有在此时拦下它。CUA 在替换期间重连被认为是触发条件之一，但未证实；手动重启后 11:14:48 仅一套启动记录，并只有 1 个进程监听 `127.0.0.1:60828`。**在复现前不能定为产品缺陷，也不能视为通过** |

完整机器记录见 [升级证据 JSON](integration-evidence/upgrade-3.0.13-to-3.0.14.json) 和 [脱敏应用日志](integration-evidence/upgrade-3.0.14-app.redacted.txt)（仅将本机用户名路径替换为 `<user>`；原始 `.log` 按 `.gitignore` 不入库）。原 3.0.14 应用、配置和历史在测试前已备份到仓库外；未删除用户数据。
