use lingua::{Language, LanguageDetector, LanguageDetectorBuilder};
use std::sync::OnceLock;

/// 本地语种检测模型全局缓存。
/// lingua 的 `LanguageDetectorBuilder::build()` 需要加载全部语种 ngram 数据，
/// 每次翻译都重建一次代价很高，这里只构建一次复用。
static DETECTOR: OnceLock<LanguageDetector> = OnceLock::new();

fn build_detector() -> LanguageDetector {
    // https://crates.io/crates/lingua
    let languages = vec![
        Language::Chinese,
        Language::Japanese,
        Language::English,
        Language::Korean,
        Language::French,
        Language::Spanish,
        Language::German,
        Language::Russian,
        Language::Italian,
        Language::Portuguese,
        Language::Turkish,
        Language::Arabic,
        Language::Vietnamese,
        Language::Thai,
        Language::Indonesian,
        Language::Malay,
        Language::Hindi,
        Language::Mongolian,
        Language::Bokmal,
        Language::Nynorsk,
        Language::Persian,
        Language::Ukrainian,
    ];
    LanguageDetectorBuilder::from_languages(&languages).build()
}

/// 预热本地语种检测模型（启动时调用一次，避免首次翻译才加载）
pub fn init_lang_detect() {
    let detector = DETECTOR.get_or_init(build_detector);
    let _ = detector.detect_language_of("Hello Language");
}

/// 短文本字符集启发式：比 n-gram 检测更可靠（如 "hello" 被 n-gram 误判为意大利语）
fn detect_by_charset(text: &str) -> Option<&'static str> {
    let has_cjk = text
        .chars()
        .any(|c| matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF));
    let has_hiragana_katakana = text.chars().any(|c| matches!(c as u32, 0x3040..=0x30FF));
    let has_hangul = text
        .chars()
        // 谚文音节 (U+AC00..U+D7AF)、谚文字母 jamo (U+1100..U+11FF)，
        // 以及**谚文兼容字母** (U+3130..U+318F)。
        // 最后一段此前缺失：它含 ㅋㅋㅋ（笑）、ㅠㅠ（哭）、ㅎㅎ 等韩语网络用语里
        // 极常见的字符，也含字典/教学里的独立字母 ㄱㄴㄷ。这些不是完整音节，
        // 只列前两个区间会漏判——3 个字符的 "ㅋㅋㅋ" 会因 <8 字符走字符集，
        // 得 None 后被判成英语。
        .any(|c| matches!(c as u32, 0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F));
    let has_cyrillic = text.chars().any(|c| matches!(c as u32, 0x0400..=0x04FF));
    let has_arabic = text.chars().any(|c| matches!(c as u32, 0x0600..=0x06FF));
    let has_thai = text.chars().any(|c| matches!(c as u32, 0x0E00..=0x0E7F));

    if has_hiragana_katakana {
        return Some("ja");
    }
    if has_hangul {
        return Some("ko");
    }
    if has_cjk {
        return Some("zh_cn");
    }
    if has_cyrillic {
        return Some("ru");
    }
    if has_arabic {
        return Some("ar");
    }
    if has_thai {
        return Some("th");
    }
    None
}

#[tauri::command]
pub async fn lang_detect(text: String) -> Result<&'static str, ()> {
    tauri::async_runtime::spawn_blocking(move || detect_language(&text))
        .await
        .map_err(|_| ())?
}

fn detect_language(text: &str) -> Result<&'static str, ()> {
    let trimmed = text.trim();
    let char_count = trimmed.chars().count();
    // 超短文本（<8 字符）n-gram 检测不可靠（如 "hello" 被误判为意大利语），
    // 优先用字符集启发式（CJK/假名/谚文/西里尔等），无法判断时默认英语
    if char_count < 8 {
        if let Some(lang) = detect_by_charset(trimmed) {
            return Ok(lang);
        }
        return Ok("en");
    }
    // 字符集启发式优先（对混合文本更可靠）
    if let Some(lang) = detect_by_charset(trimmed) {
        return Ok(lang);
    }
    let detector = DETECTOR.get_or_init(build_detector);
    if let Some(lang) = detector.detect_language_of(trimmed) {
        match lang {
            Language::Chinese => Ok("zh_cn"),
            Language::Japanese => Ok("ja"),
            Language::English => Ok("en"),
            Language::Korean => Ok("ko"),
            Language::French => Ok("fr"),
            Language::Spanish => Ok("es"),
            Language::German => Ok("de"),
            Language::Russian => Ok("ru"),
            Language::Italian => Ok("it"),
            Language::Portuguese => Ok("pt_pt"),
            Language::Turkish => Ok("tr"),
            Language::Arabic => Ok("ar"),
            Language::Vietnamese => Ok("vi"),
            Language::Thai => Ok("th"),
            Language::Indonesian => Ok("id"),
            Language::Malay => Ok("ms"),
            Language::Hindi => Ok("hi"),
            Language::Mongolian => Ok("mn_cy"),
            Language::Bokmal => Ok("nb_no"),
            Language::Nynorsk => Ok("nn_no"),
            Language::Persian => Ok("fa"),
            Language::Ukrainian => Ok("uk"),
        }
    } else {
        Ok("en")
    }
}

#[cfg(test)]
mod tests {
    use super::detect_by_charset;

    // ---- 字符集启发式：这是纯函数，但一旦区间写错会影响**所有**翻译的源语言判定 ----

    #[test]
    fn cjk_and_kana_and_hangul_are_distinguished() {
        // 日文优先于中文：日文混用汉字，只看 CJK 会误判成中文
        assert_eq!(detect_by_charset("こんにちは世界"), Some("ja")); // 假名 + 汉字
        assert_eq!(detect_by_charset("こんにちは"), Some("ja")); // 纯假名
        assert_eq!(detect_by_charset("カタカナ"), Some("ja")); // 片假名
        assert_eq!(detect_by_charset("你好世界"), Some("zh_cn"));
        assert_eq!(detect_by_charset("안녕하세요"), Some("ko"));
    }

    #[test]
    fn hangul_compatibility_jamo_is_recognised_as_korean() {
        // U+3130..U+318F 谚文兼容字母。韩语网络用语里极常见：
        // ㅋㅋㅋ（笑）、ㅠㅠ（哭）、ㅎㅎ（笑）。这些**不是**完整音节
        // (U+AC00..U+D7AF)，也不是 jamo 区 (U+1100..U+11FF)，
        // 只列后两个区间会漏掉它们，导致短韩文输入被判定为英语。
        assert_eq!(detect_by_charset("ㅋㅋㅋ"), Some("ko"));
        assert_eq!(detect_by_charset("ㅠㅠ"), Some("ko"));
        assert_eq!(detect_by_charset("ㅎㅎㅎ"), Some("ko"));
        // 字典/教学里的独立字母
        assert_eq!(detect_by_charset("ㄱㄴㄷ"), Some("ko"));
    }

    #[test]
    fn cyrillic_arabic_and_thai_are_recognised() {
        assert_eq!(detect_by_charset("Привет"), Some("ru"));
        assert_eq!(detect_by_charset("مرحبا"), Some("ar"));
        assert_eq!(detect_by_charset("สวัสดี"), Some("th"));
    }

    #[test]
    fn latin_and_unknown_scripts_return_none() {
        // 拉丁字母不做字符集判断，交给 n-gram（避免把 "hello" 误判成意大利语）
        assert_eq!(detect_by_charset("hello world"), None);
        assert_eq!(detect_by_charset(""), None);
        assert_eq!(detect_by_charset("12345"), None);
        assert_eq!(detect_by_charset("!@#$%"), None);
    }

    #[test]
    fn cjk_extension_and_compatibility_blocks_count_as_chinese() {
        // 扩展 A (U+3400..U+4DBF) 与兼容表意文字 (U+F900..U+FAFF)
        assert_eq!(detect_by_charset("㐀㐁"), Some("zh_cn"));
        assert_eq!(detect_by_charset("豈更"), Some("zh_cn"));
    }

    #[test]
    fn script_priority_is_stable_for_mixed_text() {
        // 优先级 ja > ko > zh_cn：混合文本要按此顺序命中，
        // 否则「日文汉字」会被判成中文。改优先级会导致大规模误判。
        assert_eq!(detect_by_charset("日本語のテスト"), Some("ja"));
        assert_eq!(detect_by_charset("한국어 테스트"), Some("ko"));
        // 中文里夹一个假名 -> 仍按 ja（假名是更强信号）
        assert_eq!(detect_by_charset("你好あ"), Some("ja"));
    }
}
