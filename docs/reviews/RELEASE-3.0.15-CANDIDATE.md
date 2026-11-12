# v3.0.15 维护候选预检（2026-11-12）

**暂停公开发布：Fedora 44 ARM64 无法安装当前 Linux 构建流程产出的 RPM。**

- 候选源码：`b2fe37d6b42e0e41f455366f27b6b461c0ea5c31`，Tauri 1 维护线，无 Tauri 2 探针代码。相对通过八目标验证的维护分支，只更改版本号和发布说明。
- 候选 [Actions 构建验证](https://github.com/charonwwang/cup-translate/actions/runs/43179916207) 仅上传 artifacts。
- 本机复跑：前端 586 项、Qwen Python 8 项、Rust 200 项通过，6 项 Rust 按原标记跳过。审计仍为 8 条 Rust 漏洞告警和 1 条前端低危告警。
- Apple Silicon DMG：版本 3.0.15，标识 `com.cup-translate.app`；本机 ad-hoc 签名，`hdiutil verify` 通过，SHA-256 `7a8c2e3346f35c9e55e4e5bd41145c5a79911245b88b7da563952780b0555ee8`。未替换日常安装。
- RPM：取 [维护基线 ARM64 构建](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858430) 的 `cup-translate-3.0.14-1.aarch64.rpm`，在干净的 Fedora 44 ARM64 容器中执行 `rpm -qp --requires` 和 `dnf -y install ./cup-translate-3.0.14-1.aarch64.rpm`。仓库索引加载成功，交易被拒绝：`nothing provides libwebkit2gtk-4.0.so.37()(64bit)`。未进入应用启动，不能记作实机通过。候选相对该维护基线没有更改 Linux 构建依赖。
- Linux 官方构建容器实际链接 WebKitGTK 4.0；不能通过删除 RPM 的依赖字段来修复。发布前需让 Linux 二进制使用目标发行版可提供的 WebKitGTK 运行库，然后以候选产物重验依赖、安装和启动。其余实机项仍见 [验收清单](../plans/DESKTOP-HARDWARE-ACCEPTANCE.md)。

未打标签、创建 Release 或更新公开更新清单。
