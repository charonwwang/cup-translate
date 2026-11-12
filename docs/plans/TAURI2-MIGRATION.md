# Tauri 2.x 迁移计划（立项草案）

登记日期：2026-11-11。2026-11-12 更新：**维护基线正在验证，迁移实现待开始**。从构建验证通过的维护提交建立独立迁移分支。

## 1. 为什么要迁移

依赖审计（`docs/reviews/dependency-audit-2026-11-04.md` 的 2026-11-10 章节）显示，剩余的 Rust 告警里，
以下几类**无法在 Tauri 1.x 依赖约束内定向修复**：

| 告警 | 引入路径 | 在 Tauri 1.x 内能否修复 |
|---|---|---|
| `zip 0.6.6`（4 条） | `tauri 1.8.1` 的 `api::file::Extract`（更新包解压，验签之后才执行） | 否，0.6 线无修复版 |
| `h2 0.3.26`（1 条） | `hyper 0.14` ← `reqwest 0.11`（tauri 1.8 与 `reqwest_dav`） | 否，0.3 线无修复版 |
| `quick-xml 0.31`（2 条） | `tauri 1.8.1` → `notify-rust 4.11.3` | 否，4.19 与 tauri 1.8 的 `objc2-encode` 冲突 |
| `libsqlite3-sys 0.30.1`（1 条） | `tauri-plugin-sql`（v1 分支）→ `sqlx-sqlite` | 否，需要插件迁移 |

另：`libsqlite3-sys` 的告警在备份恢复路径上可达（`backup.rs` 允许写入外部 `history.db`）。
2026-11-11 已加入文件头校验作为纵深防御，但**不能替代升级 SQLite**。

因此，这 8 条 Rust 告警的根本修复路径是迁移 Tauri 2.x。

## 2. 当前约束与已知耦合点（需在立项时逐项处理）

- **插件**：`tauri-plugin-sql`、`tauri-plugin-store`、`tauri-plugin-log`、`tauri-plugin-autostart`、
  `tauri-plugin-single-instance`、`tauri-plugin-fs-watch` 目前都来自 `plugins-workspace` 的 `v1` 分支（锁定到 `fa8ee1d4`）。
  Tauri 2 需要对应的 v2 插件，**API 不兼容**。
- **前端 API**：`src/` 中大量使用 `@tauri-apps/api` v1 形式（`tauri-plugin-sql-api`、`tauri-plugin-store-api` 等），
  需要改为 v2 的 `@tauri-apps/plugin-*` 包。
- **配置**：`src-tauri/tauri.conf.json` 的 `tauri.*` 结构在 v2 中重排（`bundle`、`updater`、`allowlist` 变为 capabilities）。
  `webview.*.json` 的合并方式也需要重新验证（见 `MAINTENANCE.md` §7）。
- **更新器**：v2 的 updater 清单格式与签名流程有变化。`updater/*.mjs` 与 `publish-desktop.mjs` 需要同步。
  **私钥与公钥必须保持可用**，否则已安装用户的更新链路断裂（CLAUDE.md §3.3）。
- **feature 门控**：CLAUDE.md §3.3 规定的 `#[cfg(feature = "updater")]` 写法与 `default` 列表需要在 v2 下重新验证。
- **系统集成**：全局热键、托盘、窗口定位、剪贴板、通知等 Rust 模块都依赖 v1 API，
  需要逐个迁移并在真实 X11/Wayland 会话下验证（CLAUDE.md §7）。
- **构建**：CLAUDE.md §2 的四个构建坑（wry 版本、WebKitGTK 4.0→4.1、pnpm allowBuilds、custom-protocol）
  在 Tauri 2 下会变化，需要重新建立对应的构建文档与自检脚本。

## 3. 建议阶段

1. **阶段 A：调研与原型（不合并）**
   - 在独立分支建立最小 Tauri 2 工程，验证更新器签名、Linux WebKitGTK 4.1 与托盘、全局热键三件事能否工作。
   - 产出：可行性结论与阻塞清单。
2. **阶段 B：插件与 API 迁移**
   - 替换 v1 插件为 v2，改写前端调用。保留所有 `tests/*.test.mjs` 回归护栏，并按需更新断言。
3. **阶段 C：系统集成迁移**
   - 热键、托盘、窗口定位、通知、备份。每项都需要真机验证（见第 4 节）。
4. **阶段 D：发布链路**
   - 更新器清单、签名、CI。先在不发布的 `build-desktop` 矩阵上跑通，再考虑正式发布。
5. **阶段 E：清理与审计**
   - 重跑 `cargo audit`，核对 8 条 Rust 告警是否消除。更新 CLAUDE.md 与 `docs/BUILD.md`。

## 4. 验收门槛

- 所有 `pnpm test`（当前 586 项）、Qwen Python 测试（当前 8 项）与 Rust 测试（当前 200 项，6 项按原标记忽略）通过，或有明确说明的替换。
- 更新链路：**从当前正式版（3.0.14）升级到迁移版**，在 macOS 与 Windows 上各做一次真实应用内升级，
  配置与历史记录保留（参照 `RELEASE-3.0.14.md` 的验收方式）。
- 构建：Linux 容器内（`.github/actions/build-for-linux`）的完整构建通过。
- 真机：Windows、Linux（X11 与纯 Wayland）的安装、启动、热键、划词、弹窗定位，以及隔离账号的收藏写入。详见 [实机验收清单](DESKTOP-HARDWARE-ACCEPTANCE.md)，Actions 成功只计为构建通过。

### 迁移的兼容性基线

- 最小切片先验证打包后的 WebView 能加载本地页面，以及 IPC 成功与拒绝各一个用例。用临时配置根目录或独立系统测试用户启动，不读取生产配置，不监听应用正式端口，不访问正式更新端点。最小切片通过只代表 Tauri 2 壳可启动。
- 保留 `com.cup-translate.app`、产品名与正式二进制名。配置与备份代码现在以 `<系统配置目录>/com.cup-translate.app` 为根；锁定的 v1 SQL 插件用 `app_dir()`，在 Tauri 1.8.1 中等同于 `app_config_dir()`。v2 [SQL 插件说明](https://v2.tauri.app/plugin/sql/#usage)也以 AppConfig 为相对路径根。实际测试要比较打开的绝对路径、原有设置和历史数据，排除因打开一个新建空库导致的假通过。
- 存储阶段用 v1 写入合成设置、服务实例、快捷键、至少两条历史与一个测试插件文件。记录 `config.json` 的语义内容、`history.db` 的 schema 和有序行；用 v2 读取并增加一条历史，重启复查，再单独检验备份恢复。现有 Keyring 服务名与 `secretRefs` 兼容性用独立系统账号和测试凭证验证。
- 把 [Tauri 2 迁移指南](https://v2.tauri.app/start/migrate/from-tauri-1/)作为配置与 API 对照。仅为各窗口实际使用的命令声明权限；分别覆盖受限文件路径、外部 URL 和无权限窗口。对依赖第三方服务的网络功能，用本地 fixture 验证，保留既有代理、隐私模式与超时语义。
- 更新器阶段先按 [官方 updater 指南](https://v2.tauri.app/plugin/updater/)评估 `bundle.createUpdaterArtifacts = "v1Compatible"`，保留正式验签公钥并复核发布脚本对 v1 兼容载荷的命名与架构映射。用隔离更新源测试；测试产物不得进入公开 Release 或清单。
- 审计逐条核对当前 8 个 ID：`h2` RUSTSEC-2026-0258；`libsqlite3-sys` RUSTSEC-2026-0459；`quick-xml` RUSTSEC-2026-0194 / 0195；`zip` RUSTSEC-2026-0367 / 0368 / 0369 / 0429。相同审计库版本对比两个锁文件并重查发布目标依赖树。框架迁移不会自动去掉 `reqwest_dav` 引入的旧 HTTP 栈；SQLite 也以实际解析到的版本为准。

## 5. 风险

- 插件 API 变化面大，回归护栏（字符串断言）可能通过而运行时失败。必须有真机验证作为兜底。
- 更新器签名链路一旦断裂，已安装用户无法自动升级。阶段 D 之前不得发布迁移版。
- 迁移期间应继续维护 3.0.x 线，安全修复不等待迁移完成。

## 6. 当前不做的事

- 不在本计划中承诺时间表。立项需要维护者确认优先级与人力。
- 不在 3.0.x 分支上混入迁移代码。
