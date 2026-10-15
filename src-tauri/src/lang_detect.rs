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
    let has_cjk = text.chars().any(|c| {
        matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF)
    });
    let has_hiragana_katakana = text
        .chars()
        .any(|c| matches!(c as u32, 0x3040..=0x30FF));
    let has_hangul = text
        .chars()
        .any(|c| matches!(c as u32, 0xAC00..=0xD7AF | 0x1100..=0x11FF));
    let has_cyrillic = text
        .chars()
        .any(|c| matches!(c as u32, 0x0400..=0x04FF));
    let has_arabic = text
        .chars()
        .any(|c| matches!(c as u32, 0x0600..=0x06FF));
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
pub fn lang_detect(text: &str) -> Result<&str, ()> {
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
