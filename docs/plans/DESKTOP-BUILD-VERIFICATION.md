# 维护分支构建验证（2026-11-12）

[Actions 运行 #43146317015](https://github.com/charonwwang/cup-translate/actions/runs/43146317015) 通过。以 `workflow_dispatch` 指定 `codex/desktop-build-verification`，GitHub 记录的运行提交为 `2bbda49a29ad7324578e00ebfdd4893e957da6f8`。验证工作流的自动推送触发仅限 `master`；本次未触发发布工作流。

| 平台 | 架构 | 构建结果 | Actions artifact |
|---|---|---|---|
| Windows | x64 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858110) | NSIS |
| Windows | x86 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858140) | NSIS |
| Windows | ARM64 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858246) | NSIS |
| Linux | x64 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858083) | DEB / RPM |
| Linux | i686 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858010) | DEB / RPM |
| Linux | ARM64 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858430) | DEB / RPM |
| macOS | x64 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944857795) | .app ZIP |
| macOS | ARM64 | [通过](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858072) | .app ZIP |

八个目标均上传了产物，无失败项。[MSVC 链接回归](https://github.com/charonwwang/cup-translate/actions/runs/43146316467)也在同一提交通过。本机复跑前端 586 项、Qwen Python 8 项、Rust 200 项通过，Rust 6 项按原标记跳过。依赖审计仍是 8 条 Rust 漏洞告警、1 条前端低危告警。

实机结果见 [待做清单](DESKTOP-HARDWARE-ACCEPTANCE.md)。公开版本仍是 v3.0.14；这轮没有打标签、创建 Release 或更新公开清单。
