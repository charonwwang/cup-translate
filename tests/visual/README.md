# 实际客户端组件的隔离检查

运行 `pnpm dev --host 127.0.0.1`，打开：

- `/tests/visual/index.html?view=translate`：词典（默认关闭所有 TTS，覆盖空列表）。
- `?view=translate&scenario=phrase`：短语结果，只显示译文。
- `?view=translate&scenario=paragraph`：段落整段译文，可切换逐句对照。
- `?view=translate&width=350`：默认窄窗布局。
- `?view=translate&source=en&detect=it`：手动源语言覆盖旧的自动识别结果。
- `?view=translate&theme=dark&font=20`：深色、大字号。
- `?view=translate&scenario=multi`：两个引擎，第一份展开，第二份按需展开。
- `?view=translate&scenario=error`：失败与重试。
- `?view=translate&scenario=loading`：持续加载。
- `?view=config`：设置页，八个原有分区均可进入。

页面直接加载 `/src/main.jsx`，桌面 IPC、文件、数据库、HTTP、剪贴板全部模拟在内存中；不读取真实配置，不访问翻译服务，不写系统剪贴板。更改设置只影响本页，刷新后还原。窗口操作和原生功能需在 Tauri 客户端中验收。

本入口不在 Vite 的两个生产入口中，生产包不包含它。翻译结果是固定测试数据，不代表线上引擎质量。

检查要点：380 / 340px 浮窗下无横向溢出；释义字号大于词性；例句展开/收起；多引擎展开/收起；复制后仅有一个成功提示；清空原文后旧译文消失；深色及字体偏好；设置导航及滚动。
