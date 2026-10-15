use crate::{error::Error, APP};
use dirs::config_dir;
use log::{info, warn};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{Manager, Wry};
use tauri_plugin_store::{Store, StoreBuilder};

pub struct StoreWrapper(pub Mutex<Store<Wry>>);

/// 上游（pot-desktop）使用的旧配置目录名。
/// 品牌迁移后 identifier 变为 `com.cup-translate.app`，这里用于**一次性迁移**旧配置，
/// 避免老用户升级后设置丢失（服务配置、密钥、快捷键等）。
const LEGACY_IDENTIFIER: &str = "com.pot-app.desktop";

pub fn init_config(app: &mut tauri::App) {
    let identifier = app.config().tauri.bundle.identifier.clone();

    let config_path = config_dir().unwrap();
    let config_dir_path = config_path.join(&identifier);
    let config_path = config_dir_path.join("config.json");

    // 一次性迁移：新配置不存在、但旧配置存在时，把旧目录复制过来
    if !config_path.exists() {
        let legacy_dir = config_path
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join(LEGACY_IDENTIFIER));
        if let Some(legacy_dir) = legacy_dir {
            if legacy_dir.join("config.json").exists() {
                info!(
                    "Migrating config from legacy location {:?} -> {:?}",
                    legacy_dir, config_dir_path
                );
                if let Err(e) = copy_dir_all(&legacy_dir, &config_dir_path) {
                    warn!("Config migration failed: {:?}", e);
                } else {
                    info!("Config migration done");
                }
            }
        }
    }

    info!("Load config from: {:?}", config_path);
    let mut store = StoreBuilder::new(app.handle(), config_path).build();

    match store.load() {
        Ok(_) => info!("Config loaded"),
        Err(e) => {
            warn!("Config load error: {:?}", e);
            info!("Config not found, creating new config");
        }
    }
    app.manage(StoreWrapper(Mutex::new(store)));
    let _ = check_service_available();
    prune_unconfigured_dead_services();
}

/// 递归复制目录（用于旧配置迁移，不依赖额外 crate）
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn check_available(list: Vec<String>, builtin: Vec<&str>, plugin: Vec<String>, key: &str) {
    let origin_length = list.len();
    let mut new_list = list.clone();
    for service in list {
        let name = service.split("@").collect::<Vec<&str>>()[0];
        let mut is_available = true;
        if name.starts_with("plugin") {
            if !plugin.contains(&name.to_string()) {
                is_available = false;
            }
        } else {
            if !builtin.contains(&name) {
                is_available = false;
            }
        }
        if !is_available {
            new_list.retain(|x| x != &service);
        }
    }
    if new_list.len() != origin_length {
        set(key, new_list);
    }
}

/// 上游已停服、或缺少配置就必然失败的内置服务（裸实例名，2026 实测）：
/// - `deepl`：必须填 API key，空配置必然失败（免 key 端点已 429 封禁）
/// - `bing`：取 token 的 `edge.microsoft.com/translate/auth` 返回 404（代码已删除）
/// - `lingva`：`lingva.pot-app.com` 域名已不存在 NXDOMAIN（代码已删除）
/// - `ecdict`：上游 `pot-app.com/api/dict` 返回 404/405（代码已删除）
/// - TTS `lingva_tts`：默认地址同上已死（代码保留给自建实例，但未配置的裸实例清理）
///
/// 对这些「从未配置过」的旧版默认实例做一次性清理，让升级用户也开箱即用。
/// 用户显式创建的 `name@id` 实例、以及已填写配置的实例一律保留。
/// 注意：代码已删除的服务（bing/ecdict/lingva）不受此保留规则保护——
/// `check_service_available()` 会把它们的**所有**实例直接清掉（前端已无对应实现，留着必崩 UI）。
const UNUSABLE_TRANSLATE_BUILTIN: &[&str] = &["deepl", "bing", "lingva", "ecdict"];
const UNUSABLE_TTS_BUILTIN: &[&str] = &["lingva_tts"];

fn prune_unconfigured_dead_services() {
    prune_service_list("translate_service_list", UNUSABLE_TRANSLATE_BUILTIN);
    prune_service_list("tts_service_list", UNUSABLE_TTS_BUILTIN);
}

fn prune_service_list(config_key: &str, unusable_builtin: &[&str]) {
    let Some(value) = get(config_key) else {
        return;
    };
    let Ok(list) = serde_json::from_value::<Vec<String>>(value) else {
        return;
    };
    let new_list: Vec<String> = list
        .iter()
        .filter(|instance| {
            if instance.contains('@') || !unusable_builtin.contains(&instance.as_str()) {
                return true;
            }
            // 配置对象非空说明用户配置过（例如填了 DeepL 密钥 / 自建实例地址），保留
            match get(instance) {
                Some(config) => config.as_object().is_none_or(|obj| !obj.is_empty()),
                None => false,
            }
        })
        .cloned()
        .collect();
    if new_list.len() != list.len() {
        info!(
            "Prune unusable services in {}: {:?} -> {:?}",
            config_key, list, new_list
        );
        set(config_key, new_list);
    }
}

pub fn check_service_available() -> Result<(), Error> {
    let builtin_recognize_list: Vec<&str> = vec![
        "baidu_ocr",
        "baidu_accurate_ocr",
        "baidu_img_ocr",
        "iflytek_ocr",
        "iflytek_intsig_ocr",
        "iflytek_latex_ocr",
        "qrcode",
        "simple_latex_ocr",
        "system",
        "tencent_ocr",
        "tencent_accurate_ocr",
        "tencent_img_ocr",
        "tesseract",
        "volcengine_ocr",
        "volcengine_multi_lang_ocr",
    ];
    // ⚠️ 必须与前端注册表保持一致，否则用户添加的服务会在下次启动时被静默清掉：
    //   src/services/translate/index.jsx（builtinServices）/ src/services/tts/index.jsx
    // 新增引擎时同步补这里（CLAUDE.md §4.1 约定）。代码已删除的服务
    // （bing/ecdict/lingva）**不要**加回来——保留名单会让残留配置项撑崩服务列表 UI。
    let builtin_translate_list: Vec<&str> = vec![
        "alibaba",
        "baidu",
        "baidu_field",
        "bing_dict",
        "caiyun",
        "cambridge_dict",
        "chatglm",
        "deepl",
        "geminipro",
        "google",
        "local_mt",
        "niutrans",
        "ollama",
        "openai",
        "tencent",
        "transmart",
        "volcengine",
        "yandex",
        "youdao",
    ];
    let builtin_tts_list: Vec<&str> = vec!["lingva_tts", "local_tts"];
    let builtin_collection_list: Vec<&str> = vec!["anki", "eudic"];

    let plugin_recognize_list: Vec<String> = get_plugin_list("recognize").unwrap_or_default();
    let plugin_translate_list: Vec<String> = get_plugin_list("translate").unwrap_or_default();
    let plugin_tts_list: Vec<String> = get_plugin_list("tts").unwrap_or_default();
    let plugin_collection_list: Vec<String> = get_plugin_list("collection").unwrap_or_default();
    if let Some(recognize_service_list) = get("recognize_service_list") {
        let recognize_service_list: Vec<String> = serde_json::from_value(recognize_service_list)?;
        check_available(
            recognize_service_list,
            builtin_recognize_list,
            plugin_recognize_list,
            "recognize_service_list",
        );
    }
    if let Some(translate_service_list) = get("translate_service_list") {
        let translate_service_list: Vec<String> = serde_json::from_value(translate_service_list)?;
        check_available(
            translate_service_list,
            builtin_translate_list,
            plugin_translate_list,
            "translate_service_list",
        );
    }
    if let Some(tts_service_list) = get("tts_service_list") {
        let tts_service_list: Vec<String> = serde_json::from_value(tts_service_list)?;
        check_available(
            tts_service_list,
            builtin_tts_list,
            plugin_tts_list,
            "tts_service_list",
        );
    }
    if let Some(collection_service_list) = get("collection_service_list") {
        let collection_service_list: Vec<String> = serde_json::from_value(collection_service_list)?;
        check_available(
            collection_service_list,
            builtin_collection_list,
            plugin_collection_list,
            "collection_service_list",
        );
    }
    Ok(())
}

pub fn get_plugin_list(plugin_type: &str) -> Option<Vec<String>> {
    let app_handle = APP.get().unwrap();
    let config_dir = dirs::config_dir()?;
    let config_dir = config_dir.join(app_handle.config().tauri.bundle.identifier.clone());
    let plugin_dir = config_dir.join("plugins");
    let plugin_dir = plugin_dir.join(plugin_type);

    // dirs in plugin_dir
    let mut plugin_list = vec![];
    if plugin_dir.exists() {
        let read_dir = std::fs::read_dir(plugin_dir).ok()?;
        for entry in read_dir {
            let entry = entry.ok()?;

            if entry.path().is_dir() {
                let name = entry.file_name().to_str()?.to_string();
                if name.starts_with("plugin") {
                    plugin_list.push(name);
                } else {
                    // Remove old plugin
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    Some(plugin_list)
}

pub fn get(key: &str) -> Option<Value> {
    let state = APP.get().unwrap().state::<StoreWrapper>();
    let store = state.0.lock().unwrap();
    store.get(key).cloned()
}

/// 安全读取字符串配置项。类型不符（如用户手改 config.json 写成数字/布尔）时
/// 返回 None 而非 panic，调用方按「未配置」兜底。
pub fn get_str(key: &str) -> Option<String> {
    get(key).as_ref().and_then(coerce_str)
}

/// 安全读取布尔配置项。
pub fn get_bool(key: &str) -> Option<bool> {
    get(key).as_ref().and_then(coerce_bool)
}

/// 安全读取整数配置项（兼容 JSON number / 手改写成数字字符串的场景）。
pub fn get_i64(key: &str) -> Option<i64> {
    get(key).as_ref().and_then(coerce_i64)
}

/// 纯函数版本的字符串强转（便于单元测试），不依赖全局 store。
fn coerce_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// 纯函数版本的布尔强转。
fn coerce_bool(v: &Value) -> Option<bool> {
    v.as_bool()
}

/// 纯函数版本的整数强转，兼容 JSON number 与数字字符串。
fn coerce_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

pub fn set<T: serde::ser::Serialize>(key: &str, value: T) {
    let state = APP.get().unwrap().state::<StoreWrapper>();
    let mut store = state.0.lock().unwrap();
    store.insert(key.to_string(), json!(value)).unwrap();
    store.save().unwrap();
}

pub fn is_first_run() -> bool {
    let state = APP.get().unwrap().state::<StoreWrapper>();
    let store = state.0.lock().unwrap();
    store.is_empty()
}

#[cfg(test)]
mod tests {
    use super::{coerce_bool, coerce_i64, coerce_str};
    use serde_json::json;

    #[test]
    fn string_coercion_rejects_non_string_values() {
        assert_eq!(coerce_str(&json!("zh_cn")), Some("zh_cn".to_string()));
        assert_eq!(coerce_str(&json!(350)), None);
        assert_eq!(coerce_str(&json!(true)), None);
        assert_eq!(coerce_str(&json!(null)), None);
    }

    #[test]
    fn bool_coercion_rejects_non_bool_values() {
        assert_eq!(coerce_bool(&json!(true)), Some(true));
        assert_eq!(coerce_bool(&json!(false)), Some(false));
        assert_eq!(coerce_bool(&json!("true")), None);
        assert_eq!(coerce_bool(&json!(1)), None);
    }

    #[test]
    fn int_coercion_accepts_numbers_and_numeric_strings() {
        assert_eq!(coerce_i64(&json!(350)), Some(350));
        assert_eq!(coerce_i64(&json!("350")), Some(350));
        assert_eq!(coerce_i64(&json!("-5")), Some(-5));
        assert_eq!(coerce_i64(&json!("abc")), None);
        assert_eq!(coerce_i64(&json!(true)), None);
        assert_eq!(coerce_i64(&json!(null)), None);
    }
}
