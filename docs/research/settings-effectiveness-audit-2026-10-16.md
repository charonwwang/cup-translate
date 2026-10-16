# 设置生效核对与验收（2026-10-16）

不能将自动测试或模拟界面等同于所有设置的真实客户端验收。本表列出读写位置与当前证据，未实测项不标为通过。

## 本轮修复

- 热键页仅保留一条录入提示；冲突说明折叠，功能解释移到提示图标。
- 监听端口标题固定最小宽度、输入框独立宽度；移除重复 className 导致样式失效的问题。
- 默认置顶关闭时明确调用原生取消置顶；失焦关闭重开时重新订阅，手动置顶与关闭监听互斥。
- 主题选择统一交由 App 的 effect 管理，移除常规设置里重复且未清理的系统主题监听；修复深色设置卡片的背景。
- JSON 导入兼容旧版字符串字号，增加回归测试。

## 证据等级

- **原生客户端实测**：通过桌面 UI 切换深色、恢复跟随系统；字号 16→18→16，并从实际配置文件仅读取 app_theme/app_font_size/server_port 验证恢复后的持久值。新版已复验深色卡片、恢复跟随系统；重启后确认配置保留。实际客户端监听端口标题横排，热键页滚动到最后一项成功。
- **自动测试**：408 项通过，包括配置 JSON 校验/合并/回滚、旧字号类型兼容、热键保存、窗口置顶开/关与失焦监听。
- **此前隔离 UI 实测**：设置滚动、JSON 导出/校验预览/导入完成、历史复制/朗读/停止、词典回译与按钮状态。文件对话框/存储和语音使用模拟数据。
- **尚未完成的端到端验证**：开机登录自启、真实更新下载、真实代理连通、OCR 系统权限/识别、多显示器窗口位置、每个翻译/收藏/插件服务的网络与凭据。

## 逐项代码核对

| 分组 / 配置项 | 使用位置（最多列两处） | 生效时机 / 当前验证 |
|---|---|---|
| General / `check_update` | `src-tauri/src/updater.rs:10`、`src-tauri/src/updater.rs:13` | 保存后重启 / 下次启动使用，外部行为未端到端验收 |
| General / `server_port` | `src/window/Recognize/ControlArea/index.jsx:33`、`src-tauri/src/server.rs:14` | 保存后重启 / 下次启动使用，外部行为未端到端验收 |
| General / `app_language` | `src/App.jsx:25`、`src-tauri/src/notification.rs:119` | 代码已连接，未单项原生验收 |
| General / `app_theme` | `src/App.jsx:24` | 原生 UI 切换与恢复、保存值已核实 |
| General / `app_font` | `src/App.jsx:26` | 代码已连接，未单项原生验收 |
| General / `app_fallback_font` | `src/App.jsx:27` | 代码已连接，未单项原生验收 |
| General / `app_font_size` | `src/App.jsx:28`、`src/window/Translate/components/TargetArea/index.jsx:82` | 原生 UI 切换与恢复、保存值已核实 |
| General / `transparent` | `src/window/Config/index.jsx:14`、`src/window/Updater/index.jsx:18` | 代码已连接，未单项原生验收 |
| General / `dev_mode` | `src/App.jsx:23` | 代码已连接，未单项原生验收 |
| General / `tray_click_event` | `src-tauri/src/tray.rs:138`、`src-tauri/src/tray.rs:141` | 代码已连接，未单项原生验收 |
| General / `proxy_enable` | `src-tauri/src/main.rs:145` | 保存后重启 / 下次启动使用，外部行为未端到端验收 |
| General / `proxy_host` | `src-tauri/src/cmd.rs:219` | 保存后重启 / 下次启动使用，外部行为未端到端验收 |
| General / `proxy_port` | `src-tauri/src/cmd.rs:227` | 保存后重启 / 下次启动使用，外部行为未端到端验收 |
| General / `proxy_username` | 本页处理 / 尚无外部读取 | 未实现后端读取；当前禁用，不列为可用功能 |
| General / `proxy_password` | 本页处理 / 尚无外部读取 | 未实现后端读取；当前禁用，不列为可用功能 |
| General / `no_proxy` | `src-tauri/src/cmd.rs:232`、`src-tauri/src/cmd.rs:240` | 保存后重启 / 下次启动使用，外部行为未端到端验收 |
| Translate / `translate_source_language` | `src/window/Translate/components/LanguageArea/index.jsx:17` | 代码已连接，未单项原生验收 |
| Translate / `translate_target_language` | `src/window/Translate/components/LanguageArea/index.jsx:20` | 代码已连接，未单项原生验收 |
| Translate / `translate_second_language` | `src/window/Translate/components/TargetArea/index.jsx:91`、`src/window/Translate/components/LanguageArea/index.jsx:23` | 代码已连接，未单项原生验收 |
| Translate / `translate_detect_engine` | `src/utils/lang_detect.js:257`、`src/utils/lang_detect.js:270` | 代码已连接，未单项原生验收 |
| Translate / `translate_auto_copy` | `src/window/Translate/components/TargetArea/index.jsx:110`、`src-tauri/src/tray.rs:34` | 代码已连接，未单项原生验收 |
| Translate / `clipboard_monitor` | `src/window/Translate/components/TargetArea/index.jsx:112`、`src-tauri/src/tray.rs:83` | 代码已连接，未单项原生验收 |
| Translate / `incremental_translate` | `src/window/Translate/components/SourceArea/index.jsx:34` | 代码已连接，未单项原生验收 |
| Translate / `history_disable` | `src/window/Translate/components/TargetArea/index.jsx:92` | 代码已连接，未单项原生验收 |
| Translate / `dynamic_translate` | `src/window/Translate/components/SourceArea/index.jsx:35` | 代码已连接，未单项原生验收 |
| Translate / `translate_delete_newline` | `src/window/Translate/components/SourceArea/index.jsx:36` | 代码已连接，未单项原生验收 |
| Translate / `translate_remember_language` | `src/window/Translate/components/LanguageArea/index.jsx:16` | 代码已连接，未单项原生验收 |
| Translate / `translate_window_position` | `src/window/Translate/index.jsx:91`、`src-tauri/src/window.rs:246` | 代码已连接，未单项原生验收 |
| Translate / `translate_remember_window_size` | `src/window/Translate/index.jsx:92` | 代码已连接，未单项原生验收 |
| Translate / `hide_source` | `src/window/Translate/components/SourceArea/index.jsx:41` | 代码已连接，未单项原生验收 |
| Translate / `hide_language` | `src/window/Translate/index.jsx:101` | 代码已连接，未单项原生验收 |
| Translate / `translate_hide_window` | `src/window/Translate/components/TargetArea/index.jsx:111`、`src/window/Translate/components/SourceArea/index.jsx:40` | 代码已连接，未单项原生验收 |
| Translate / `translate_close_on_blur` | `src/window/Translate/index.jsx:89` | 本轮修复双向切换；自动回归测试，未逐项原生触发 |
| Translate / `translate_always_on_top` | `src/window/Translate/index.jsx:90` | 本轮修复双向切换；自动回归测试，未逐项原生触发 |
| Recognize / `recognize_language` | `src/window/Recognize/ControlArea/index.jsx:32`、`src/window/Translate/components/SourceArea/index.jsx:37` | 代码已连接，未单项原生验收 |
| Recognize / `recognize_delete_newline` | `src/window/Recognize/TextArea/index.jsx:27` | 代码已连接，未单项原生验收 |
| Recognize / `recognize_auto_copy` | `src/window/Recognize/TextArea/index.jsx:26` | 代码已连接，未单项原生验收 |
| Recognize / `recognize_hide_window` | `src/window/Recognize/TextArea/index.jsx:28`、`src/window/Recognize/ImageArea/index.jsx:16` | 代码已连接，未单项原生验收 |
| Recognize / `recognize_close_on_blur` | `src/window/Recognize/index.jsx:55` | 代码已连接，未单项原生验收 |
| Hotkey / `hotkey_selection_translate` | `src-tauri/src/hotkey.rs:203`、`src-tauri/src/hotkey.rs:216` | 自动测试与 Carbon 占用预检验证；未重绑用户的全部快捷键 |
| Hotkey / `hotkey_clipboard_translate` | `src-tauri/src/hotkey.rs:204`、`src-tauri/src/hotkey.rs:222` | 自动测试与 Carbon 占用预检验证；未重绑用户的全部快捷键 |
| Hotkey / `hotkey_input_translate` | `src-tauri/src/hotkey.rs:205`、`src-tauri/src/hotkey.rs:228` | 自动测试与 Carbon 占用预检验证；未重绑用户的全部快捷键 |
| Hotkey / `hotkey_ocr_recognize` | `src-tauri/src/hotkey.rs:206`、`src-tauri/src/hotkey.rs:231` | 自动测试与 Carbon 占用预检验证；未重绑用户的全部快捷键 |
| Hotkey / `hotkey_ocr_translate` | `src-tauri/src/hotkey.rs:207`、`src-tauri/src/hotkey.rs:232` | 自动测试与 Carbon 占用预检验证；未重绑用户的全部快捷键 |

其他动态设置：服务列表、各服务实例配置与语音策略分别在翻译/识别/朗读/收藏入口读取；未使用用户的全部 API 密钥验证网络服务。开机自启通过原生 autostart 插件读写，本轮仅读取状态，没有修改登录启动项。

## 明确限制

- 代理账号密码 UI 当前禁用，Rust 不读取；不能宣称认证代理已支持。
- 端口与代理变更需要重启，不是点完开关立刻重建服务。
- 已恢复测试前主题“跟随系统”和字号 16；未改动热键、代理或开机启动配置。
- 安装包仍为本地临时签名，重新编译后系统授权身份的持久性未获保证。


## 本地打包修复与最终原生验证

- 本轮初次重启发现 .app 签名资源封装无效；`codesign --verify --deep --strict` 报错。移除生成包中的 FinderInfo/ResourceFork 非安全元数据后，完整 ad-hoc 签名并通过严格校验。没有清除 quarantine 等安全属性，没有修改 TCC 授权。
- 新增 `packaging/sign-macos-local.sh`，`pnpm package:macos:local` 将打包与开发签名串联。正式发行仍需 Developer ID 与公证。
- 已成功启动新构建，通过现有 127.0.0.1:60828/config 接口打开配置窗口（HTTP 200），再用原生 UI 验证。
- 原生截图：general-native-verified.png、general-native-dark-verified.png、hotkey-native-verified.png，位于 docs/design/ui-review-v3/screenshots/。
- 再次检查实际配置，主题 system、字号 16、端口 60828，测试值已恢复；没有改写热键、开机启动或代理设置。
