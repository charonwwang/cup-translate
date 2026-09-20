# cup-translate · 贡献指南

欢迎为 cup-translate 贡献力量！这是一个从 **pot-app/pot-desktop** fork 而来的
社区续版。你可以在**不受原仓库归档限制**的情况下自由 PR / Issue。

---

## 本项目定位（先读这个）

- 定位：**把「划词翻译」这个核心闭环做到极致的轻量工具**，Linux/Wayland 优先。
- 与上游关系：从已归档的 pot-desktop fork，独立演进，保留 GPL-3.0。
- 非目标：不加无度功能、不堆默认全开的模块（OCR/TTS/生词本按需开启）。

> 在贡献前，请确保你的变更符合上述定位，否则可能被要求收窄。

## 如何贡献

### 1. 提 issue
- 用 `Good First Issue` / `bug` / `enhancement` 标签。
- 汇报 bug 请附：操作系统、桌面/会话（X11/Wayland）、WebKit 版本、相关日志。

### 2. 本地开发
```bash
git clone https://github.com/<你的账号>/cup-translate.git
cd cup-translate
pnpm install            # 前端
pnpm tauri dev          # 开发模式
pnpm tauri build        # 构建
```

### 3. 分支与 PR
- 从 `master`（或约定主分支）切 feature 分支
- 提交信息：`fix:`, `feat:`, `refactor:`, `docs:`, `chore:` 前缀 + 简述
- 提交前跑 `cargo fmt` 与前端 lint
- PR 只合一个功能/修复，描述清楚动机与改动面

## 代码结构速览

| 目录/文件 | 说明 |
|---|---|
| `src/` | 前端 React 界面 + 服务（`services/translate` 等） |
| `src-tauri/` | Rust 后端（`window.rs` 划词、`hotkey.rs` 热键、`clipboard.rs` 剪贴板监听、`server.rs` HTTP 服务） |
| `src-tauri/src/window.rs` | 划词翻译核心 `selection_translate()` |
| `src/services/translate/` | 翻译引擎插件（每引擎一目录） |

## 工作流

- 环境搭建、未知地从上游过来的历史问题，先在 `docs/MAINTENANCE.md` 与 Issue 里检索。
- PR 会被打上「需要 review」状态，欢迎 QA。首个维护者有多名时请互相 review。

## 首份待办（高频痛点，欢迎认领）

- [ ] Wayland 纯环境下的划词/全局热键方案加强与文档
- [ ] WebKit2GTK 2.42 + Nvidia 崩溃规避文档化 / 代码处理
- [ ] 修复在纯 Wayland (Hyprland) 下弹窗跟随鼠标的分期方案
- [ ] 重新组织 `README`（英文版对齐上游）

---

感谢为社区续版出力 ☕