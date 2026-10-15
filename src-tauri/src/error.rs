// create the error type that represents all errors possible in our program
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Error(#[from] Box<dyn std::error::Error>),
    #[error(transparent)]
    Dav(#[from] reqwest_dav::Error),
    #[error(transparent)]
    DavRe(#[from] reqwest_dav::re_exports::reqwest::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error(transparent)]
    WalkDir(#[from] walkdir::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    StripPrefix(#[from] std::path::StripPrefixError),
    #[error(transparent)]
    Arboard(#[from] arboard::Error),
    #[error(transparent)]
    Image(#[from] image::ImageError),
    #[error(transparent)]
    Selection(#[from] font_kit::error::SelectionError),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
}

// we must manually implement serde::Serialize
impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这个 `Serialize` 实现是**所有 Rust 错误抵达前端前的最后一道关口**：
    /// Tauri 的命令返回值里带 `Result<_, Error>` 的，最终都会走这里，
    /// 而前端 `Recognize/TextArea` / `Translate/SourceArea` 拿到的是
    /// `e.toString()` **原样展示**。因此这里序列化出来的字符串就是用户看到的全部内容。
    ///
    /// 这些测试钉住三件事：
    /// 1. 序列化结果确实是**字符串**（不是 `{}`、不是数组）；
    /// 2. 字符串**非空**（空串会让界面显示一句空白，用户完全无从判断）；
    /// 3. 保留底层错误的原始信息（`#[error(transparent)]` 的语义），
    ///    不能退化成只显示变体名。
    fn serialize_to_json(err: &Error) -> String {
        serde_json::to_string(err).expect("Error must always be serializable")
    }

    #[test]
    fn every_variant_serializes_to_a_non_empty_string() {
        // 逐变体构造真实错误，而不是只挑一个（r86 的教训：只测一个变体会漏掉其余）
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let serde_err = serde_json::from_str::<i32>("{ not json").unwrap_err();
        let strip_err = std::path::Path::new("/a").strip_prefix("/b").unwrap_err();

        let variants: Vec<(&str, Error)> = vec![
            ("Io", Error::Io(io_err)),
            ("Error", Error::Error("Get Cache Dir Failed".into())),
            ("Serde", Error::Serde(serde_err)),
            ("StripPrefix", Error::StripPrefix(strip_err)),
        ];

        for (name, err) in variants {
            let json = serialize_to_json(&err);
            // 必须是 JSON 字符串字面量，而不是 `{}` / `[]` / `null`
            assert!(
                json.starts_with('"') && json.ends_with('"'),
                "Error::{name} must serialize to a string, got {json}"
            );
            let text = err.to_string();
            assert!(
                !text.trim().is_empty(),
                "Error::{name} must not stringify to an empty message (the UI would show a blank line)"
            );
        }
    }

    #[test]
    fn the_underlying_message_survives_serialization() {
        // transparent 的意义就是「不要把底层原因吃掉」。
        // 若有人把 `#[error(transparent)]` 改成 `#[error("io error")]`，这条会红。
        let err = Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "operation not permitted",
        ));
        let json = serialize_to_json(&err);
        assert!(
            json.contains("operation not permitted"),
            "the underlying io message must survive; got {json}"
        );
    }

    #[test]
    fn the_custom_message_variant_keeps_its_text_verbatim() {
        // cmd.rs 里多处 `Error::Error("...".into())` 是**手写**给用户看的文案
        // （例如 "Get Cache Dir Failed"），必须原样到达前端，不能被包装或截断。
        let err = Error::Error("Get Cache Dir Failed".into());
        assert_eq!(
            serialize_to_json(&err),
            "\"Get Cache Dir Failed\"",
            "a hand-written user-facing message must arrive verbatim"
        );
    }

    #[test]
    fn serialization_is_a_plain_json_string_not_an_object() {
        // Tauri 的 IPC 直接把这个值交给前端；如果它变成对象，
        // 前端 `e.toString()` 会得到 "[object Object]" —— 同样是无用信息。
        let err = Error::Error("boom".into());
        let value: serde_json::Value = serde_json::from_str(&serialize_to_json(&err)).unwrap();
        assert!(
            value.is_string(),
            "the frontend calls e.toString(); a non-string payload degrades to [object Object]"
        );
        assert_eq!(value.as_str(), Some("boom"));
    }

    #[test]
    fn the_serde_impl_does_not_panic_on_any_constructible_variant() {
        // 序列化发生在错误路径上——它自己再 panic 会掩盖原始错误，
        // 且发生在无法预料的时机。这里覆盖所有能在测试里构造出来的变体。
        let cases: Vec<Error> = vec![
            Error::Io(std::io::Error::other("x")),
            Error::Error("x".into()),
            Error::Serde(serde_json::from_str::<i32>("x").unwrap_err()),
            Error::StripPrefix(std::path::Path::new("/a").strip_prefix("/b").unwrap_err()),
        ];
        for err in cases {
            let _ = serialize_to_json(&err); // 不 panic 即通过
        }
    }
}
