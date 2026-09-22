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

#[tauri::command]
pub fn lang_detect(text: &str) -> Result<&str, ()> {
    let detector = DETECTOR.get_or_init(build_detector);
    if let Some(lang) = detector.detect_language_of(text) {
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
        return Ok("en");
    }
}
