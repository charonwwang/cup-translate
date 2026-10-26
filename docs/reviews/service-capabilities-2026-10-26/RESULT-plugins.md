# plugins 独立修复结果

日期：2026-10-26。原仓库基线 `10f2a6e`。分支 `codex/fix-plugin-compat`；worktree `/Users/charonwwang/Desktop/charon/project/cup-translate-plugins`。准确提交号见本报告所在提交及交付消息。

## 实际实现

- JS/Rust 共享同一可移植 ID 测试语料，支持三个上游点分 ID，保留合法旧 ID。`service_instance_core.js` 原本已委托共享校验器，本次不重复改写实例解析。
- 新增 `plugin_package.rs` 统一包结构、元信息、资源、目录发现、二进制路径规则。检查 ID、类别、必需元信息、配置项、语言映射、入口文件、图标和全部归档路径；前端发现入口先通过后端检查再拼接图标。拒绝路径穿越、Windows 分隔符/设备名/盘符/尾随点、符号链接（含父目录）、特殊权限位和特殊文件、重复/大小写冲突条目。
- 安装先在 WebView 编译检查 JS 语法（不执行代码），后端用入口 SHA256 绑定被检查的内容；CRC/尺寸/资源验证在空暂存目录全部完成后才替换。限 4096 条目、256 MiB 单文件、512 MiB 解压总量、64 KiB 元信息、4 MiB 入口。解压在后台线程执行。保留一个旧目录，替换失败回滚，事务标记支持进程中断后发现恢复。启动发现不再删除未知用户目录。
- 新包要求文件 stem 等于 info.id。旧重命名目录只允许以原目录名且保持原 manifest ID 升级，不重写实例键/配置。无法确定身份时明确拒绝，不静默迁移。
- 安装界面逐包保留结果，取消和异常均结束 loading；坏包不会阻断后续包。新提示同步 en_US/zh_CN/zh_TW，其他语言沿用已有英语 fallback。Pot 入口标注第三方及兼容未逐项验证。
- 插件配置与服务列表单次提交，保存失败保留草稿并恢复内存状态。类别从已验证 manifest 取得，因此不依赖已有 TTS 弹窗的错误 pluginType 参数。
- 卸载按包 ID 清理全部 `@实例`，保护最后一个非收藏服务，等待配置持久化再删除包；磁盘拒绝时恢复引用。后端卸载也校验路径并清理上一版本。失败不会提示成功。
- `load_plugin` 经 Rust 校验磁盘路径再返回源码，JS 加载时验证类别入口可调用，每次调用重查隐私策略；Rust 二进制入口另行检查。二进制必须是包内常规文件，支持包内相对/绝对路径，不再解析系统 PATH 或目录外命令。
- [安装与开发文档](../../plugins/README.md) 说明 `.potext`、自定义宿主协议、没有直接 npm 安装能力、权限现实边界、旧包升级和二进制适配限制。[兼容清单](../../plugins/COMPATIBILITY.md) 含固定来源 commit、逐文件及包摘要、平台、网络前提、日期与测试层次。

## 核对评审后的修正

- ID 阻断属实，安装、发现、实例、加载和二进制必须一起修；不能只放开正则。
- 当前固定 ECDICT 源码通过 `Database.load` 加载 `stardict.db`，不执行二进制。评审中的平台程序不是该版本源码的必要条件；完整词库未下载，所以没有把受控 SQL 测试写成真实查词兼容。
- 固定上游 Anki 模板把 `Body` 写成 `Boxy`，却调用未定义的 `Body.json`；在首次 HTTP 前即可复现失败。清单明确“不兼容（该固定版本）”，未修改第三方源码，也没有操作真实 Anki。
- 现有隐私策略已不授予插件设备内可信身份；本次补强缓存入口和 Rust 加载入口。插件没有沙箱，不能保证任意已运行第三方任务在模式切换时停止。文档没有宣称插件支持设备内模式。
- 原卸载回调接收包 ID、却按实例键做精确删除，不能清掉多个实例；原配置保存也未等待落盘。这两处已用实际生命周期函数及测试修复。
- 遵守任务约束，未改 QwenSpeech 或 TTS ConfigModal。`pluginType='translate'` 复制残留交主 session 清理；本任务已不依赖该参数决定保存类别。

## 验证结果

环境：macOS 27.0.1 (26A434), arm64；Node 24.21.0；pnpm 12.10.1。所有数据写入测试临时目录/独立 worktree。

| 命令/层次 | 结果 |
| --- | --- |
| `pnpm --config.verify-deps-before-run=false test` | 530 通过，0 失败，含真实宿主函数及配置生命周期行为测试 |
| `pnpm --config.verify-deps-before-run=false build` | Vite 构建通过（最后一次前端构建 3.88 秒） |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked plugin --no-default-features` | 22 通过，0 失败；实际编译完整应用测试 target，176 项不相关测试未运行 |
| `git diff --check` | 通过 |
| 四类确定性插件 | 实际 ZIP 安装/发现、配置序列化重读、JS 宿主四类调用、收藏真实本地程序、升级无旧资源残留、失败保留旧版、卸载通过 |
| 真实上游点分 ID 样本 | 固定 commit 原样源码/元信息/图标重打包，三类安装/发现通过；不是上游 release 二进制包 |
| 受控服务 | Lingva HTTP 注入返回音频字节；ECDICT SQL 注入返回释义/音标；Anki 入口在 HTTP 前失败被准确捕获 |
| 恶意/损坏包 | 穿越、Windows 非法路径、symlink、特殊位、冲突路径、坏 ZIP、空入口、非法元信息/资源、条目/大小限额、摘要不匹配均拒绝；旧版本保持 |
| 恢复/批量 | 事务标记中断后恢复、未知目录不删除、旧重命名升级、多包中间失败后继续均通过 |

本机 pnpm 12 默认执行前的依赖检查拒绝仓库现有 overrides/锁文件组合；复用原 node_modules 还遇到元信息读取异常。已移除 worktree 的依赖软链，以 `npx --yes pnpm@10.18.3 install --frozen-lockfile --ignore-scripts` 在 worktree 独立安装固定依赖，再用上述 pnpm 12 命令执行。没有改包版本、依赖清单、锁文件或打包配置；没有写原目录依赖。

## 未验证与集成注意

- 未执行桌面 GUI 文件选择、配置点击、真实 WebView IPC、桌面进程重启、真实音频播放、Windows/Linux 实机及安装包构建。配置与恢复测试是持久化/目录层和受控 JS 宿主层，不能冒充桌面全链路验收。
- 未访问真实 Lingva 服务、未下载完整 ECDICT 数据、未测试隔离 Anki profile 或真实收藏，未使用真实凭证。没有操作日常卡片。
- 入口语法在安装界面预检，入口绑定是否为函数、顶层运行异常和业务返回值最终仍在加载/调用阶段确认。预检不是沙箱或业务健康检查。上一个目录保留供恢复。
- 二进制执行范围收紧会拒绝依赖系统 PATH 的旧插件；清单不承诺这些插件兼容。自定义符号链接配置目录也会被拒绝。严格离线场景需要退出应用后在设备内模式启动。
- 原目录评审/产品规范以及所有带“ 2”的文件均未修改；未推送、发布或合并。新测试源码保留第三方许可证。
- 可能冲突的共享文件：`src-tauri/src/{main,cmd,config}.rs`，三语资源 `src/i18n/locales/{en_US,zh_CN,zh_TW}.json`，`src/window/{Translate,Recognize}/index.jsx`，`src/window/Config/pages/{History,Service}/index.jsx`，`Service/{PluginConfig,SelectPluginModal}/index.jsx`，`src/utils/{plugin_validation,invoke_plugin}.js` 及对应现有测试。新模块和 fixtures 专属于本任务；主 session 应统一 review 这些局部改动后集成。

## 主 session 回修 R3

重装只独立核对旧 manifest 身份，不再要求旧 main.js 或图标健康。规范 ID 目录允许用正确包修复缺失或损坏 manifest，旧目录进入 previous 备份；可读且不同的身份仍拒绝。旧别名只有确认 ID 与类别后才修复，身份不可读时明确提示恢复 info.json 或移除旧包。新增实际 ZIP 安装测试覆盖缺入口、缺图标、缺 manifest、坏 JSON、备份保留和别名身份保护。Rust plugin 定向测试 24 通过。
