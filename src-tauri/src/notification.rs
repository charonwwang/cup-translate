// 系统通知文案的本地化。
//
// 背景：托盘（tray.rs）早已按 `app_language` 提供 17 种语言，前端也会跟随该设置切换，
// 但**系统通知**一直是无视语言设置的硬编码字符串：
//   · window.rs 的划词/剪贴板失败通知 -> 永远中文
//   · server.rs 的端口占用通知、main.rs 的重复启动/热键失败通知 -> 永远英文
// 于是把界面切成 English 的用户，仍会在划词失败时收到一条中文通知；
// 反之亦然。这与 CLAUDE.md §4.2 的既定策略不符——那里的契约是
// 「缺失时回退英文」，而不是「根本不看语言设置」。
//
// 语言覆盖范围**刻意保守**：只提供 en 与 zh_cn 两条。
// 原因同 §4.2：本项目没有母语校验能力，机翻会产出错误文案，
// 比回退英文更糟。因此其余语言一律回退英文（而非猜测性翻译）。
// 将来若要补语言，在这里加一条 match 臂即可，不要用机翻填充。

/// 一条通知的文案（标题 + 正文）。
pub struct NotificationText {
    pub title: &'static str,
    pub body: &'static str,
}

/// 后端会发出的所有通知。用枚举而不是裸字符串，
/// 这样新增通知时编译器会强制你在下面补全每种语言。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    /// 划词翻译：没有取到选中文本
    SelectionTranslateEmpty,
    /// 剪贴板翻译：剪贴板为空
    ClipboardTranslateEmpty,
    /// 本地服务端口被占用，起不来
    ServerStartFailed,
    /// 应用已在运行
    AlreadyRunning,
    /// 全局快捷键注册失败
    HotkeyRegisterFailed,
}

/// 把配置里的语言代码归一化到我们真正提供文案的几种。
///
/// 只区分 en 与 zh_cn/zh_tw 三类，其余一律回退 en——与 §4.2 的策略一致。
/// 注意 `zh_tw` 单独列出：繁体用户看到简体文案是**倒退**，
/// 因此这里让它走英文回退，而不是复用 zh_cn 的简体字符串。
fn normalized(language: &str) -> &'static str {
    match language {
        "zh_cn" => "zh_cn",
        _ => "en",
    }
}

impl NotificationKind {
    /// 取该通知在指定语言下的文案。
    ///
    /// `language` 为空（配置尚未初始化）时按英文处理：
    /// 通知可能比配置加载更早发出（如 `AlreadyRunning` 在启动早期），
    /// 此时读不到 `app_language`，回退英文是唯一不会误导用户的选择。
    pub fn text(self, language: &str) -> NotificationText {
        match normalized(language) {
            "zh_cn" => self.zh_cn(),
            _ => self.en(),
        }
    }

    fn en(self) -> NotificationText {
        match self {
            NotificationKind::SelectionTranslateEmpty => NotificationText {
                title: "Selection Translate",
                body: "No selected text found. Select some text first, then press the shortcut. \
                       If this keeps failing, allow this app to control \"System Events\" in \
                       System Settings -> Privacy & Security -> Automation.",
            },
            NotificationKind::ClipboardTranslateEmpty => NotificationText {
                title: "Clipboard Translate",
                body: "The clipboard is empty. Copy some text (Cmd+C) first, then press the shortcut.",
            },
            NotificationKind::ServerStartFailed => NotificationText {
                title: "Server start failed",
                body: "The local server port is unavailable. Change the server port in settings and restart the application.",
            },
            NotificationKind::AlreadyRunning => NotificationText {
                title: "The program is already running. Please do not start it again!",
                body: "",
            },
            NotificationKind::HotkeyRegisterFailed => NotificationText {
                title: "Failed to register global shortcut",
                body: "",
            },
        }
    }

    fn zh_cn(self) -> NotificationText {
        match self {
            NotificationKind::SelectionTranslateEmpty => NotificationText {
                title: "划词翻译",
                body: "未获取到选中文本。请先选中文字再按快捷键。若持续失败，请在 系统设置→隐私与安全→自动化 中允许本应用控制「系统事件」。",
            },
            NotificationKind::ClipboardTranslateEmpty => NotificationText {
                title: "剪贴板翻译",
                body: "剪贴板为空。请先复制文本（Cmd+C）再按快捷键。",
            },
            NotificationKind::ServerStartFailed => NotificationText {
                title: "本地服务启动失败",
                body: "端口不可用。请在设置中更换服务端口后重启应用。",
            },
            NotificationKind::AlreadyRunning => NotificationText {
                title: "程序已在运行，请勿重复启动！",
                body: "",
            },
            NotificationKind::HotkeyRegisterFailed => NotificationText {
                title: "全局快捷键注册失败",
                body: "",
            },
        }
    }
}

/// 读取当前界面语言。读不到（配置未初始化）时返回空串，
/// 由 [`NotificationKind::text`] 回退到英文。
pub fn current_language() -> String {
    crate::config::get_str("app_language").unwrap_or_default()
}

/// 便捷入口：按当前语言取文案。
pub fn text(kind: NotificationKind) -> NotificationText {
    kind.text(&current_language())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [NotificationKind; 5] = [
        NotificationKind::SelectionTranslateEmpty,
        NotificationKind::ClipboardTranslateEmpty,
        NotificationKind::ServerStartFailed,
        NotificationKind::AlreadyRunning,
        NotificationKind::HotkeyRegisterFailed,
    ];

    /// 每种语言下每条通知都必须有**非空标题**。
    /// 正文允许为空（AlreadyRunning / HotkeyRegisterFailed 本来就只发标题）。
    #[test]
    fn every_notification_has_a_non_empty_title_in_every_language() {
        for kind in ALL {
            for lang in ["en", "zh_cn", "zh_tw", "ja", "", "unknown"] {
                let text = kind.text(lang);
                assert!(
                    !text.title.trim().is_empty(),
                    "{kind:?} in language {lang:?} has an empty title"
                );
            }
        }
    }

    /// en 与 zh_cn 必须是**真正不同**的文案。
    /// 如果哪天有人偷懒让 zh_cn 直接复用英文，这条会失败——
    /// 那正是「假本地化」最容易发生的地方。
    #[test]
    fn chinese_and_english_are_actually_different() {
        for kind in ALL {
            let en = kind.text("en");
            let zh = kind.text("zh_cn");
            assert_ne!(
                en.title, zh.title,
                "{kind:?} uses the same title for en and zh_cn — that is not localization"
            );
        }
    }

    /// 除 zh_cn 外一律回退英文（含 zh_tw）。
    ///
    /// zh_tw 单独强调：给它简体中文是**倒退**，宁可回退英文。
    /// 这条约束防止将来有人「顺手」把 zh_tw 指向 zh_cn。
    #[test]
    fn everything_except_zh_cn_falls_back_to_english() {
        for kind in ALL {
            let en = kind.text("en");
            for lang in ["zh_tw", "ja", "ko", "fr", "de", "es", "ru", "", "unknown", "ZH_CN", "zh-CN"] {
                let other = kind.text(lang);
                assert_eq!(
                    other.title, en.title,
                    "{kind:?} should fall back to English for language {lang:?}"
                );
                assert_eq!(other.body, en.body, "{kind:?} body mismatch for {lang:?}");
            }
        }
    }

    /// 便携性：文案里不该出现占位符残留或调试痕迹。
    #[test]
    fn notification_text_has_no_placeholder_leftovers() {
        for kind in ALL {
            for lang in ["en", "zh_cn"] {
                let text = kind.text(lang);
                for field in [text.title, text.body] {
                    assert!(!field.contains("{}"), "unformatted placeholder in {kind:?}/{lang}");
                    assert!(!field.contains("TODO"), "TODO left in {kind:?}/{lang}");
                    assert!(
                        !field.contains('\n'),
                        "notification text should not contain raw newlines ({kind:?}/{lang})"
                    );
                }
            }
        }
    }

    /// 英文文案不得混入中文（防止复制粘贴串味）。
    #[test]
    fn english_text_contains_no_cjk_characters() {
        for kind in ALL {
            let text = kind.text("en");
            for field in [text.title, text.body] {
                assert!(
                    !field.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                    "{kind:?} English text contains CJK characters: {field}"
                );
            }
        }
    }

    /// 读不到 app_language 时必须安全回退，而不是 panic 或返回空。
    #[test]
    fn a_missing_language_setting_falls_back_safely() {
        let text = NotificationKind::ServerStartFailed.text(&current_language());
        assert!(!text.title.trim().is_empty());
    }

    /// 结构性护栏：所有**通知**的文案都必须来自本模块，不得再写死字符串。
    ///
    /// 修复前的情形正是「五条通知散落在三个文件里、各自硬编码」：
    /// window.rs 两条永远中文，server.rs / main.rs 三条永远英文，
    /// 都不看 app_language。这条测试扫描源码，防止有人再新加一条硬编码通知。
    ///
    /// 注意只检查 `Notification::new(...)` 链上的 `.title(` / `.body(`——
    /// `WindowBuilder` 的 `.title(...)` 是窗口标题，不属于通知，不能误伤。
    #[test]
    fn notification_text_is_never_hardcoded_at_the_call_site() {
        for (name, source) in [
            ("window.rs", include_str!("window.rs")),
            ("server.rs", include_str!("server.rs")),
            ("main.rs", include_str!("main.rs")),
        ] {
            // 找出每个 `Notification::new(` 起、到 `.show()` 止的片段
            let mut rest = source;
            let mut checked = 0;
            while let Some(start) = rest.find("Notification::new(") {
                let tail = &rest[start..];
                let end = tail.find(".show()").unwrap_or(tail.len());
                let call = &tail[..end];
                checked += 1;

                // 允许的写法：.title(text.title) / .body(text.body) / .body(cwd) / .body(&e)
                // 不允许：直接把字符串字面量塞进 .title( / .body(
                for field in [".title(", ".body("] {
                    let mut scan = call;
                    while let Some(idx) = scan.find(field) {
                        let after = &scan[idx + field.len()..];
                        let arg_end = after.find(')').unwrap_or(after.len());
                        let arg = after[..arg_end].trim();
                        assert!(
                            !arg.starts_with('"'),
                            "{name}: a notification {field}...{arg} uses a hardcoded string — \
                             route it through notification.rs so it follows app_language"
                        );
                        scan = &after[arg_end..];
                    }
                }
                rest = &tail[end..];
            }
            assert!(checked > 0, "{name} should contain at least one notification call");
        }
    }
}