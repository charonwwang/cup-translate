# 依赖审计基线（2026-11-04）

## 结论

本轮完成了 `zip`、`tar` 的定向升级和前端高危/中危告警清理，并建立了可重复执行的审计基线。审计**尚未清零**：Rust lockfile 仍有 34 条漏洞告警，前端生产依赖仍有 1 条 low。未将剩余项误记为已修复。

环境：macOS Apple Silicon、Node 24.21.0、pnpm 12.10.1、Rust 1.99.0、cargo-audit 0.22.2。

## 命令

```bash
cargo audit --file src-tauri/Cargo.lock --json > /tmp/cargo-audit.json
pnpm audit --prod --json --registry https://registry.npmjs.org > /tmp/pnpm-audit.json
```

审计数据库和网络状态会随时间变化；本文数字是上述日期的快照，不代表永久结论。

## 结果

| 范围 | 结果 |
|---|---|
| Rust lockfile | 34 条 `vulnerabilities`（按 advisory + 包版本计）；另有 14 条 unmaintained、10 条 unsound、3 条 yanked 警告 |
| 前端生产依赖 | 1 条 low，0 moderate/high/critical |
| 已清除 | 前端 `source-map-js` high、`react-router` moderate，以及 `lodash.omit`、`postcss-selector-parser`、`glob`、`minimatch` 相关告警 |
| 已升级 | `zip 2.2.0` → `9.3.0`；`tar 0.4.42` → `0.4.46`；`react-router-dom ^6.30.4` → `^7.18.5` |

## Rust 剩余项

| 包 | 版本 | 告警数 | 处理状态 |
|---|---:|---:|---|
| `quick-xml` | 0.30.0 / 0.31.0 / 0.32.0 / 0.36.2 | 8 | 待随上游依赖升级逐项消除 |
| `rustls` | 0.23.16 | 5 | 待升级或确认对应平台不参与构建 |
| `rustls-webpki` | 0.102.8 | 5 | 同上 |
| `zip` | 0.6.6 | 4 | Tauri 1.8 运行时依赖；更新包只会在 minisign 验签通过后解压，优先随 Tauri 升级移除 |
| `rkyv` | 0.7.45 | 2 | 待随上游依赖升级 |
| `h2` | 0.3.26 / 0.4.6 | 2 | 待随 `reqwest`/Tauri 依赖升级 |
| `crossbeam-channel` | 0.5.13 | 1 | 待升级 |
| `crossbeam-epoch` | 0.9.18 | 1 | 待升级 |
| `bytes` | 1.8.0 | 1 | 待随 HTTP 依赖升级 |
| `hashbrown` | 0.15.0 | 1 | 待升级 |
| `idna` | 0.5.0 | 1 | 待升级 |
| `ring` | 0.17.8 | 1 | 待升级 |
| `rsa` | 0.9.6 | 1 | 待评估；当前未见应用侧直接 RSA 私钥操作 |
| `tracing-subscriber` | 0.3.18 | 1 | 待升级 |

`cargo audit` 扫描整个 lockfile，包含不同平台的条件依赖；某条告警不等于所有平台二进制都会链接该代码。剩余项仍须在下一版逐项复核，不应长期忽略。

## 前端剩余项

| 包 | 严重度 | 说明 |
|---|---|---|
| `deepmerge` | low | NextUI 构建期依赖；目前无已发布的修补版本。原型污染风险保留在构建工具链，随 NextUI 升级复查。 |

## 已加的安全回归

- `zip 9` 的 `unix_mode()` 会清除 setuid/setgid/sticky 位，插件安装校验改为读取原始 Unix external attributes，继续拒绝特殊权限位、符号链接和特殊文件。
- 插件 ZIP 测试新增并发独立临时目录，避免测试互相干扰。
- 更新器仍要求 Tauri 内置公钥验签通过后才解压；本轮真实应用内升级验收记录见 `RELEASE-3.0.14.md`。

## 下一版门槛

1. 重跑上述两条命令，与本文基线对比，新增 high/critical 必须处理或明确记录不可达理由。
2. 优先消除 `zip 0.6.6`，随后评估 `quick-xml`、`rustls` 的定向升级。
3. 升级 NextUI 后复查 `deepmerge`。

---

## 2026-11-10 复核与定向升级

以下为上方基线之后的增量记录，**上方历史内容未改动**。环境：macOS Apple Silicon，Node 24.21.0（干净副本验证用 Node 22.11.0），pnpm 12.10.1，Rust 1.99.0，cargo-audit 0.22.2。

注：本次 `cargo audit` 的 yanked 在线检查超时，JSON 仍已生成，但 yanked 警告数可能不完整。

### 数量变化

| 范围 | 基线（11-04 文档） | 复核时工作区锁文件（升级前） | 本次升级后 |
|---|---|---|---|
| Rust vulnerabilities | 34 | 35（审计库新增 `libsqlite3-sys` 公告，其余同） | **23** |
| 前端生产依赖 | 1 low | 1 low（`deepmerge`，无修补版本） | 1 low（不变） |

### 本次定向升级（`src-tauri/Cargo.lock`，只改动下列包，未做全量 `cargo update`）

| 包 | 旧版本 → 新版本 | 清除的告警 |
|---|---|---|
| `bytes` | 1.8.0 → 1.12.1 | RUSTSEC-2026-0007 |
| `crossbeam-channel` | 0.5.13 → 0.5.17 | RUSTSEC-2025-0024 |
| `crossbeam-epoch` | 0.9.18 → 0.9.21 | RUSTSEC-2026-0204 |
| `hashbrown` | 0.15.0 → 0.15.5 | RUSTSEC-2024-0402 |
| `h2`（0.4 线） | 0.4.6 → 0.4.20 | 0.4.x 的 RUSTSEC-2026-0258 |
| `xcb` | 1.4.0 → 1.7.1 | 其依赖的 quick-xml 0.30 |
| `plist` | 1.7.0 → 1.10.0 | 其依赖的 quick-xml 0.32 |
| `wayland-scanner` | 0.31.5 → 0.31.11 | 其依赖的 quick-xml 0.36（Linux 构建期代码生成） |
| `url` | 2.5.2 → 2.5.4 | RUSTSEC-2024-0421（`idna` 0.5 整体换为 1.1） |

`quick-xml` 由三条线合并为 0.41.0；对应 0.30 / 0.32 / 0.36 的告警全部消失。

### 各剩余项的追溯（按发布目标的编译图判定）

判定方法：对 8 个发布目标（Windows x64/x86/arm64、macOS x64/arm64、Linux x64/i686/arm64）执行 `cargo tree -e normal,build --features custom-protocol`。

**A. 锁文件中存在，但不进入任何发布目标的编译图（15 条）**

| 包 | 告警数 | 来源 |
|---|---:|---|
| `rustls` 0.23.16 | 5 | `reqwest` 0.12 的可选 `rustls-tls` 特性；本应用 reqwest 使用 native-tls |
| `rustls-webpki` 0.102.8 | 5 | 同上（经 `rustls`） |
| `rkyv` 0.7.45 | 2 | `rust_decimal` 的可选 `rkyv` 特性（`byte-unit` → `tauri-plugin-log`） |
| `ring` 0.17.8 | 1 | 仅经 `rustls-webpki` |
| `rsa` 0.9.6 | 1 | `sqlx-mysql`（可选 mysql 特性） |
| `tracing-subscriber` 0.3.18 | 1 | `loom` → `state` → `tauri`，未出现在发布目标图中 |

这些条目由 Cargo.lock 按所有可选特性记录，发布二进制不编译它们。风险为零，但 `cargo audit` 仍会报告。处理方式需维护者决定：接受并在 `audit.toml` 中逐条登记理由（需复审），或等待上游去掉可选依赖。**本次未加忽略规则。**

**B. 进入发布产物，但受 Tauri 1.x 依赖约束，无法定向升级**

| 包 | 告警数 | 引入路径 | 可达性与阻塞 |
|---|---:|---|---|
| `zip` 0.6.6 | 4 | `tauri` 1.8.1 的 `api::file::Extract`（更新包解压） | tauri 在验签（`verify_signature`）之后才解压，攻击者需先拿到有效签名。0.6 线无修复版，需 Tauri 2.x 迁移。 |
| `h2` 0.3.26 | 1 | `hyper` 0.14 ← `reqwest` 0.11（tauri 1.8 与 `reqwest_dav` 0.1.5 共用） | 0.3 线无修复版；需 reqwest/hyper 迁移到 1.x，同样受 Tauri 约束。 |
| `quick-xml` 0.31.0 | 2 | `tauri` 1.8.1 → `notify-rust` 4.11.3（Windows 上经 `tauri-winrt-notification` 0.2.1） | `notify-rust` 4.11.4 仍锁 quick-xml 0.31；4.19.0 与 tauri 1.8 所需的 `mac-notification-sys` 依赖的 `objc2-encode` 冲突。无法在 Tauri 1.x 内定向修复。 |
| `libsqlite3-sys` 0.30.1 | 1 | `sqlx-sqlite` ← `tauri-plugin-sql`（v1 分支，锁定到 `fa8ee1d4`） | **应用实际使用**：前端 `tauri-plugin-sql-api` 用于历史库与翻译窗口（`src/window/Config/pages/History`、`TargetArea`、`utils/invoke_plugin.js`）。升级需要插件迁移到更新的 sqlx。 |

`libsqlite3-sys` 的公告为 C SQLite 的 CVE 转发。利用需要恶意数据库文件输入。已核实（2026-11-11，`src-tauri/src/backup.rs` 第 97 行）：备份恢复的白名单**允许写入 `history.db`**，即用户导入的备份 zip 中的外部 SQLite 文件会成为应用打开的历史库。因此该告警在"导入不可信备份"路径上**可达**，优先级不应下调。缓解方向：恢复时校验 SQLite 文件头与 schema，或在导入前拒绝来源不明的备份。

### 下一步门槛（更新）

1. Tauri 2.x 迁移是消除 `zip`、`h2`、`quick-xml 0.31` 以及 `libsqlite3-sys` 插件侧问题的前提，应单独立项。
2. `quick-xml 0.31` 随 tauri 1.8 的通知依赖链，不做单独处理，记为 Tauri 迁移的附带任务。
3. A 类 15 条已按维护者 2026-11-11 的明确授权登记在仓库根 `.cargo/audit.toml`，复审截止 2027-02-11。
4. 备份恢复路径的 SQLite 文件头校验已于 2026-11-11 加入（`src-tauri/src/backup.rs`）；它是纵深防御，不替代 `libsqlite3` 升级。

---

## 2026-11-11 处理结果

| 事项 | 结果 |
|---|---|
| 固定 WebView2 更新渠道 | **已退役**。`webview.*.json` 不再覆盖更新端点；删除 `updater-for-fix-runtime.mjs`、`updater:fixRuntime` 脚本和 `update-fix-runtime.json` 上传。`tests/packaging.test.mjs` 同步更新，20/20 通过。详见 `MAINTENANCE.md` §7。 |
| 备份恢复的 SQLite 文件校验 | **已加入**（`src-tauri/src/backup.rs`）：恢复 `history.db` 时先检查 16 字节文件头，非 SQLite 内容在解压前被拒绝；空文件允许。这是纵深防御，**不能消除 libsqlite3 本身的解析风险**，`libsqlite3-sys` 告警仍然存在。 |
| 15 条锁文件专属告警 | **已登记忽略**（2026-11-11，维护者明确授权）。配置位于仓库根 `.cargo/audit.toml`（cargo-audit 只读取 `./.cargo/audit.toml`），复审截止 2027-02-11。登记后实测 `cargo audit` 从 23 条降到 8 条。 |
| Tauri 2.x 迁移 | **已立项草案**：`docs/plans/TAURI2-MIGRATION.md`，列出阻塞、阶段与验收门槛。未开始实施。 |

当前 `cargo audit` 结果：**8 条**告警（15 条锁文件专属已按授权登记忽略；剩余 8 条均进入发布产物，需 Tauri 2.x 迁移）。

### 已登记的忽略清单（2026-11-11）

以下 15 个 ID 已在 8 个发布目标上核实不进入编译图，并已登记在仓库根 `.cargo/audit.toml`：

- `rustls`：RUSTSEC-2024-0399、RUSTSEC-2026-0285、RUSTSEC-2026-0346、RUSTSEC-2026-0348、RUSTSEC-2026-0349
- `rustls-webpki`：RUSTSEC-2026-0049、RUSTSEC-2026-0098、RUSTSEC-2026-0099、RUSTSEC-2026-0104、RUSTSEC-2026-0382
- `ring`：RUSTSEC-2025-0009
- `rkyv`：RUSTSEC-2026-0001、RUSTSEC-2026-0235
- `rsa`：RUSTSEC-2023-0071
- `tracing-subscriber`：RUSTSEC-2025-0055

写入规则（已同步写进 `.cargo/audit.toml` 注释）：

1. 只压制上述 ID，不压制同 crate 的新公告。
2. 若对应可选特性被启用（reqwest 改用 rustls-tls、sqlx 启用 mysql、rust_decimal 启用 rkyv），
   或这些 crate 进入任一发布目标编译图，立即删除对应条目。
3. 2027-02-11 前复审；上游若有修复版本，优先升级并删除忽略。
4. 进入发布产物的 8 条（`zip`、`h2`、`quick-xml 0.31`、`libsqlite3-sys`）**不得**加入忽略。

`tests/dependency-audit.test.mjs` 守护这份清单：条目必须与上述 15 个 ID 完全一致，
且 8 条发布产物告警不得出现在忽略列表中。登记后实测 `cargo audit` 输出 8 条告警（退出码 1），
这 8 条均需 Tauri 2.x 迁移才能消除。
