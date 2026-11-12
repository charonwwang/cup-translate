# Tauri 2 启动探针

这是迁移阶段 A 的独立工程。它保留产品名和应用标识 `com.cup-translate.app`，使用内嵌页面和独立 WebView 临时目录。探针不会启动 Cup 的 HTTP 服务、读取日常设置/历史、注册热键或检查更新。其二进制名为 `cup-tauri2-smoke`，不要用于替换已安装的 Cup。

在有桌面会话的机器，从仓库根目录执行：

```sh
cargo build --locked --manifest-path migration/tauri2-smoke/Cargo.toml
migration/tauri2-smoke/target/debug/cup-tauri2-smoke --automated
```

Windows 执行对应的 `cup-tauri2-smoke.exe`；Linux 需要 WebKitGTK 4.1 的开发包。自动模式隐藏两个窗口，在授权窗口得到真实 Rust 应答、未授权窗口得到 ACL 拒绝后退出 0。去掉 `--automated` 可以手动查看两个窗口的结果。调用的页面和 IPC 命令相同，能力仅授予 `smoke` 窗口。

`tauri2-smoke.yml` 在迁移分支上编译八个目标并上传二进制。它不打安装包、不运行真机测试、不使用签名密钥，也不发布。
