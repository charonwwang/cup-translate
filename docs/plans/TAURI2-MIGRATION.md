# Tauri 2.x 迁移计划（立项草案）

登记日期：2026-11-11。状态：**草案，未开始实施**。本文只规划，不改代码。

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

- 所有 `pnpm test`（当前 585 项）与 Rust 测试（当前 199 项，6 项按原标记忽略）通过，或有明确说明的替换。
- 更新链路：**从当前正式版（3.0.14）升级到迁移版**，在 macOS 与 Windows 上各做一次真实应用内升级，
  配置与历史记录保留（参照 `RELEASE-3.0.14.md` 的验收方式）。
- 构建：Linux 容器内（`.github/actions/build-for-linux`）的完整构建通过。
- 真机：Windows、Linux（X11 与纯 Wayland）的安装、启动、热键、划词、弹窗定位。这些目前都**未验证**，迁移不能替代它们。

## 5. 风险

- 插件 API 变化面大，回归护栏（字符串断言）可能通过而运行时失败。必须有真机验证作为兜底。
- 更新器签名链路一旦断裂，已安装用户无法自动升级。阶段 D 之前不得发布迁移版。
- 迁移期间应继续维护 3.0.x 线，安全修复不等待迁移完成。

## 6. 当前不做的事

- 不在本计划中承诺时间表。立项需要维护者确认优先级与人力。
- 不在 3.0.x 分支上混入迁移代码。
