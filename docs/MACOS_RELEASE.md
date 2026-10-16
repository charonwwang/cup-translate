# macOS 安装包与自动更新

源码和安装包统一在公开仓库 `charonwwang/cup-translate` 发布。每个版本附安装包和对应 GPL-3.0 源码包，保留 pot-desktop fork 署名与许可证；无需独立下载仓库。

## 首次配置（仓库所有者操作）

1. 源码仓库已公开，无需新建 `cup-translate-releases`。
2. 在 Settings → Secrets and variables → Actions 中保留已有的 `TAURI_PRIVATE_KEY` 和 `TAURI_KEY_PASSWORD`。它们是 **Tauri 更新签名**，与 Apple 证书无关。不要在聊天、日志或代码中粘贴密钥。发布前实际验证更新包签名是否匹配客户端内置公钥；不匹配会停止发布，不能随意换密钥。
3. 无需新建 Personal Access Token 或 `RELEASE_PUBLISH_TOKEN`：同仓库发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，仅发布 job 申请 `contents: write`，检查和构建保持只读。如果仓库或组织策略禁止 workflow 写入 Contents，需要管理员允许此发布权限。
4. 无需设置 `RELEASE_REPOSITORY` variable，workflow 使用当前 `github.repository`。如果之前为独立下载仓库配置过该变量，现在不再使用。
5. workflow 使用 `macos-release` environment；如已配置环境审批或 secrets 访问限制，请允许此 workflow 使用对应环境和签名 secrets。

令牌只在 CI 使用，绝不写进客户端或安装包。源码包包含该版本全部已跟踪文件。

## 当前无付费 Apple 账号

运行 Actions → **Release macOS**，填写已有源码标签，如 `v3.0.8`，`developer_id` 保持 **false**。

此路径为 `.app` 做 ad-hoc 签名、生成带 Applications 拖放入口的压缩 DMG，并为更新包做独立的 Tauri 密码学签名。它不具备 Developer ID 签名和 Apple 公证，首次下载运行可能被 Gatekeeper 拦截。用户需按系统提供的“隐私与安全性 → 仍要打开”等流程处理。此流程不会删除 quarantine 或关闭系统安全策略；如需默认受信任的公开分发体验，需要加入 Apple Developer Program。

本地打包：`pnpm package:macos:dmg`。默认输出 `src-tauri/target/release/bundle/dmg/cup-translate_<版本>_<架构>.dmg`。本地不提供更新私钥时只生成安装包，不生成可发布的更新签名。

## 将来启用 Developer ID 与公证

准备以下 Actions secrets，运行同一 workflow 并启用 `developer_id`：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书及私钥导出的 `.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_SIGNING_IDENTITY` | 完整 Developer ID Application 签名身份 |
| `APPLE_ID` | Apple 账号邮箱 |
| `APPLE_PASSWORD` | 该账号生成的 App-specific password |
| `APPLE_TEAM_ID` | Developer Team ID |

CI 导入证书，通过 Tauri 签名与公证，并校验 app 的签名与公证票据。Apple secrets 只在启用该模式时需要。请在 GitHub Secret 页面直接填写，不在聊天里提供。

## 发布步骤与校验

1. 审查并提交这次改动，确保新 workflow、打包脚本、客户端和测试都包含在版本中。推送到当前公开源码仓库。本文不代表已自动提交、推送或发布。
2. 建立并推送高于已安装版本的稳定标签，如 `v3.0.8`。旧 `Package` workflow 已改为手动入口，不再随标签自动发布，避免抢占同版本 Release。macOS 版本使用 **Release macOS**，不要对同一标签同时运行两套发布流程。旧流程的 Release 不会设为 latest。
3. 手动运行 **Release macOS**，输入该标签。标签必须包含新脚本，且发布期间不要移动标签。
4. CI 在 Apple Silicon 和 Intel runner 分别构建，统一 package/Cargo/Tauri 版本、配置公开更新端点，执行前端测试。发布阶段使用同一标签生成对应源码包，验证两份更新包签名，再创建草稿、上传所有附件，最后公开并标记 latest。
5. 公开附件：两份 DMG、两份 `.app.tar.gz` 及 `.sig`、对应源码包、`update.json`、`SHA256SUMS`。失败草稿可以重跑补齐；已发布版本不可覆盖，应发布新版本。
6. 未登录访问 `https://github.com/charonwwang/cup-translate/releases/latest/download/update.json` 应返回 JSON；两个 darwin 平台的更新包均应能匿名下载。
7. 用较低版本分别在 Apple Silicon/Intel 上验证“检查更新 → 安装 → 重启 → 版本变化”。网络失败必须显示检查失败，无更新时不能安装。只有完成此步骤，才能称在线更新端到端验证通过。

旧客户端仍可能使用 `/releases/download/updater/update.json` 固定地址；仅把仓库改为公开并不会将这个地址自动迁移到 `/releases/latest/download/update.json`。上一轮本地包则指向独立下载仓库。以上客户端均建议先手动安装一次带当前仓库新端点的 DMG。后台启动检查遵循“启动时检查更新”开关，超时 30 秒；“关于 → 检查更新”和托盘入口可以手动检查。手动窗口区分检查中、最新、可更新及错误，支持失败后重新检查，安装期间阻止重复操作。

公开更新清单采用版本 Release 的 `releases/latest/download/update.json`，不删除旧版本附件。Tauri 安装前验证签名；CI 也会提前验证，防止现有 Secret 与内置公钥不匹配。务必离线备份更新签名私钥，丢失后不能直接换公钥让旧客户端自动信任新密钥。

当前流程新增的是 macOS 双架构公开分发。Windows/Linux 和 fixed-runtime 的旧清单机制未统一迁移，不应宣称这些平台已完成新流程的端到端更新验证。
