# v3.0.15 维护候选预检（2026-11-12）

**基线安装阻塞已复现；修订候选正在验证。**

- 候选源码：`b2fe37d6b42e0e41f455366f27b6b461c0ea5c31`，Tauri 1 维护线，无 Tauri 2 探针代码。相对通过八目标验证的维护分支，只更改版本号和发布说明。
- 候选 [Actions 构建验证](https://github.com/charonwwang/cup-translate/actions/runs/43179916207) 仅上传 artifacts。
- 本机复跑：前端 586 项、Qwen Python 8 项、Rust 200 项通过，6 项 Rust 按原标记跳过。审计仍为 8 条 Rust 漏洞告警和 1 条前端低危告警。
- Apple Silicon DMG：版本 3.0.15，标识 `com.cup-translate.app`；本机 ad-hoc 签名，`hdiutil verify` 通过，SHA-256 `7a8c2e3346f35c9e55e4e5bd41145c5a79911245b88b7da563952780b0555ee8`。未替换日常安装。
- RPM：取 [维护基线 ARM64 构建](https://github.com/charonwwang/cup-translate/actions/runs/43146317015/job/130944858430) 的 `cup-translate-3.0.14-1.aarch64.rpm`，在干净的 Fedora 44 ARM64 容器中执行 `rpm -qp --requires` 和 `dnf -y install ./cup-translate-3.0.14-1.aarch64.rpm`。仓库索引加载成功，交易被拒绝：`nothing provides libwebkit2gtk-4.0.so.37()(64bit)`。未进入应用启动，不能记作实机通过。候选相对该维护基线没有更改 Linux 构建依赖。
- Linux 官方构建容器实际链接 WebKitGTK 4.0；不能通过删除 RPM 的依赖字段来修复。发布前需让 Linux 二进制使用目标发行版可提供的 WebKitGTK 运行库，然后以候选产物重验依赖、安装和启动。其余实机项仍见 [验收清单](../plans/DESKTOP-HARDWARE-ACCEPTANCE.md)。

未打标签、创建 Release 或更新公开更新清单。

## WebKitGTK 修订候选

- Linux 构建容器以临时链接和 pkg-config 别名将 Tauri 1 的编译依赖解析为真实 4.1 库。成品 ELF 必须依赖 4.1，且不能直接依赖旧 WebKitGTK、JavaScriptCore 或 libsoup 2.4。
- DEB 和 RPM 的声明与实际 ELF 依赖保持一致。RPM 保留 Tauri 的二进制、资源与桌面文件；重建后比对每个文件的路径、权限、大小和 SHA-256。
- [Fedora 44 当前候选复跑](https://github.com/charonwwang/cup-translate/actions/runs/43194096696)运行 ARM64 / x64 的 DNF 安装及 Xvfb 下的设置窗口启动。脚本使用独立普通用户和无网络运行容器，不覆盖物理设备、纯 Wayland 或应用内升级验收。
- [首次专项](https://github.com/charonwwang/cup-translate/actions/runs/43190105016)在 ARM64 证实 ELF 已链接 WebKitGTK 4.1，但仍直接链接 libsoup 2.4；ABI 检查拦截，未进入 Fedora 启动验证。修订提交 `8c94928` 为 Wry 的 Linux 请求头路径回移 libsoup 3 适配，macOS/Windows 继续使用上游实现。
- [第二轮专项](https://github.com/charonwwang/cup-translate/actions/runs/43193092490)两个架构因 Wry `URIRequestExt` 导入缺失而在编译阶段退出；`3cbf274` 恢复 URI 方法所需的导入，保留 libsoup 3 请求头适配。
- [第三轮专项](https://github.com/charonwwang/cup-translate/actions/runs/43194096696)两个架构通过 ELF 检查，但实际 Tauri RPM 的 `rpm2cpio` 输出有效归档后返回 1。修订 `d7014e3` 改为校验 RPM 摘要，再由 libarchive 解包。[第四轮专项](https://github.com/charonwwang/cup-translate/actions/runs/43350035654)验证两架构。
- 2026-11-13 本地 Fedora 44 ARM64 容器：从完整 Tauri 候选 RPM 重打包后，DNF 成功安装 `cup-translate-3.0.15-1.aarch64`；`ldd` 解析到 `libwebkit2gtk-4.1.so.0`，普通用户在无网络 Xvfb 环境启动并显示设置窗口。
- [第四轮](https://github.com/charonwwang/cup-translate/actions/runs/43350035654)使用新发布的 Rust 1.100，其 Cargo 构建脚本目录变化使 eSpeak 字典嵌入失败。Linux 容器和桌面候选及发布工作流固定到验证过的 Rust 1.99.1。
- 最终专项在 `bbffb4d` 通过：[Fedora 44 x64](https://github.com/charonwwang/cup-translate/actions/runs/43351543727/job/131643721362)、[Fedora 44 ARM64](https://github.com/charonwwang/cup-translate/actions/runs/43351543727/job/131643721535) 均安装成功并显示设置窗口。随后触发同提交的[完整八目标构建](https://github.com/charonwwang/cup-translate/actions/runs/43353935261)。
