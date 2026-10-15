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

    let Some(config_path) = config_dir() else {
        log::warn!("init_config: cannot resolve config dir, config persistence disabled");
        return;
    };
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
    if let Err(e) = check_service_available() {
        warn!("Service availability check failed: {:?}", e);
    }
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
    let new_list = retain_available(list, &builtin, &plugin);
    if new_list.len() != origin_length {
        set(key, new_list);
    }
}

/// 过滤掉「前端已无对应实现」的服务实例，返回应当保留的列表。
///
/// 单独抽成纯函数是为了能直接测：这个函数**会改写用户配置**，
/// 判错就会静默删掉用户的服务实例（CLAUDE.md §4.1 第 5 步记录过
/// 「local_mt 加了前端忘了加 Rust，用户配置活不过一次重启」）。
///
/// 规则：
/// - 实例键形如 `name` 或 `name@id`（早期版本没有 `@id`），取 `@` 前部分作为服务名
/// - 服务名以 `plugin` 开头视为插件，需存在于 `plugin` 列表
/// - 否则视为内置服务，需存在于 `builtin` 白名单
///
/// 注意 `retain` 删除的是**所有**与不可用实例键相等的元素，这是刻意的：
/// 同一不可用服务的重复项（用户手工编辑或迁移产生）应当一并清掉。
fn retain_available(list: Vec<String>, builtin: &[&str], plugin: &[String]) -> Vec<String> {
    let mut new_list = list.clone();
    for service in list {
        // `str::split` 至少产出一个元素，空串也会得到 [""]，故此处不会 panic。
        let name = service.split('@').next().unwrap_or("");
        let is_available = if name.starts_with("plugin") {
            plugin.iter().any(|p| p == name)
        } else {
            builtin.contains(&name)
        };
        if !is_available {
            new_list.retain(|x| x != &service);
        }
    }
    new_list
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
    let builtin_tts_list: Vec<&str> = vec!["google_tts", "lingva_tts", "local_tts"];
    let builtin_collection_list: Vec<&str> = vec!["anki", "eudic"];

    let plugin_recognize_list: Vec<String> = get_plugin_list("recognize").unwrap_or_default();
    let plugin_translate_list: Vec<String> = get_plugin_list("translate").unwrap_or_default();
    let plugin_tts_list: Vec<String> = get_plugin_list("tts").unwrap_or_default();
    let plugin_collection_list: Vec<String> = get_plugin_list("collection").unwrap_or_default();

    // 每个服务列表独立校验：某个列表的值损坏（例如被手工改成非字符串数组）时，
    // 只跳过它自己，不能让其余列表一并失去清理（早先用 `?` 会在第一个坏列表处
    // 直接返回 Err，导致后续列表永远不被校验，且调用方 `let _ =` 又会吞掉错误）。
    let checks: [(&str, &[&str], &Vec<String>); 4] = [
        (
            "recognize_service_list",
            &builtin_recognize_list,
            &plugin_recognize_list,
        ),
        (
            "translate_service_list",
            &builtin_translate_list,
            &plugin_translate_list,
        ),
        ("tts_service_list", &builtin_tts_list, &plugin_tts_list),
        (
            "collection_service_list",
            &builtin_collection_list,
            &plugin_collection_list,
        ),
    ];
    for (key, builtin, plugin) in checks {
        let Some(value) = get(key) else {
            continue;
        };
        match serde_json::from_value::<Vec<String>>(value) {
            Ok(list) => check_available(list, builtin.to_vec(), plugin.clone(), key),
            Err(e) => {
                warn!("Skipping service check for {}: invalid value ({:?})", key, e);
            }
        }
    }
    Ok(())
}

pub fn get_plugin_list(plugin_type: &str) -> Option<Vec<String>> {
    let app_handle = APP.get()?;
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
    let app_handle = APP.get()?;
    let state = app_handle.state::<StoreWrapper>();
    let store = state.0.lock().ok()?;
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
    let Some(app_handle) = APP.get() else {
        log::warn!("set({key}): app not initialized, dropping write");
        return;
    };
    let state = app_handle.state::<StoreWrapper>();
    let mut store = match state.0.lock() {
        Ok(v) => v,
        Err(_) => {
            log::warn!("set({key}): store mutex poisoned, dropping write");
            return;
        }
    };
    if let Err(e) = store.insert(key.to_string(), json!(value)) {
        log::warn!("set({key}): insert failed: {e:?}");
        return;
    }
    if let Err(e) = store.save() {
        log::warn!("set({key}): save failed: {e:?}");
    }
}

pub fn is_first_run() -> bool {
    let Some(app_handle) = APP.get() else {
        return true;
    };
    let state = app_handle.state::<StoreWrapper>();
    let is_empty = match state.0.lock() {
        Ok(store) => store.is_empty(),
        Err(_) => true,
    };
    is_empty
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

    // ---- retain_available：决定哪些服务实例会被从用户配置里删掉 ----
    // 这些测试守住的是**破坏性行为**：判错会静默删除用户配置，
    // 而用户只会看到「我的服务实例没了」。

    use super::retain_available;

    fn owned(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn plugins() -> Vec<String> {
        vec!["plugin-translate-demo".to_string()]
    }

    #[test]
    fn keeps_builtin_instances_that_are_whitelisted() {
        let list = owned(&["google", "yandex"]);
        assert_eq!(
            retain_available(list.clone(), &["google", "yandex"], &plugins()),
            list
        );
    }

    #[test]
    fn keeps_instances_with_an_at_id_suffix() {
        // 实例键形如 name@id：判定只看 @ 前的服务名
        let list = owned(&["google@ab12", "yandex@cd34"]);
        assert_eq!(
            retain_available(list.clone(), &["google", "yandex"], &plugins()),
            list
        );
    }

    #[test]
    fn drops_builtin_instances_that_left_the_whitelist() {
        // 代码已删除的服务（bing/ecdict/lingva）不该留在配置里
        let list = owned(&["google", "bing", "lingva@x1", "yandex"]);
        assert_eq!(
            retain_available(list, &["google", "yandex"], &plugins()),
            owned(&["google", "yandex"])
        );
    }

    #[test]
    fn keeps_plugin_instances_that_exist_on_disk() {
        let list = owned(&["plugin-translate-demo", "plugin-translate-demo@id1"]);
        assert_eq!(
            retain_available(list.clone(), &["google"], &plugins()),
            list
        );
    }

    #[test]
    fn drops_plugin_instances_whose_plugin_was_uninstalled() {
        // 插件被删掉后，指向它的实例也必须清掉，否则服务列表 UI 必崩
        let list = owned(&["plugin-translate-gone", "google"]);
        assert_eq!(
            retain_available(list, &["google"], &plugins()),
            owned(&["google"])
        );
    }

    #[test]
    fn drops_every_duplicate_of_an_unavailable_instance() {
        // 重复项（手工编辑配置或迁移产生）应当一并清掉，而非只删一个
        let list = owned(&["bing", "bing", "google"]);
        assert_eq!(
            retain_available(list, &["google"], &plugins()),
            owned(&["google"])
        );
    }

    #[test]
    fn a_plugin_is_not_kept_just_because_its_name_is_whitelisted_as_builtin() {
        // 前缀决定走哪个名单：以 plugin 开头的名字不会去 builtin 里找
        let list = owned(&["plugin-x"]);
        let builtin_with_same_name: &[&str] = &["plugin-x"];
        assert_eq!(
            retain_available(list, builtin_with_same_name, &plugins()),
            Vec::<String>::new(),
            "a plugin-prefixed name must be judged against the plugin list, not the builtin one"
        );
    }

    #[test]
    fn empty_string_never_panics_and_is_dropped() {
        // split('@') 对空串返回 [""]，取 next() 不会 panic；空服务名无效，应被清掉
        let list = owned(&["", "google"]);
        assert_eq!(
            retain_available(list, &["google"], &plugins()),
            owned(&["google"])
        );
    }

    #[test]
    fn an_empty_list_is_returned_unchanged() {
        // 空列表不应产生任何写入
        assert_eq!(
            retain_available(Vec::new(), &["google"], &plugins()),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_lone_at_sign_is_treated_as_an_empty_service_name() {
        // "@id" 的 @ 前为空 -> 服务名 "" -> 不在白名单 -> 清掉
        let list = owned(&["@id1"]);
        assert_eq!(
            retain_available(list, &["google"], &plugins()),
            Vec::<String>::new()
        );
    }

    #[test]
    fn available_instances_are_never_reordered() {
        // 保留顺序：服务列表的第一项是默认服务，顺序变化会改变默认引擎
        let list = owned(&["yandex@a", "google@b", "yandex@c"]);
        assert_eq!(
            retain_available(list.clone(), &["google", "yandex"], &plugins()),
            list
        );
    }
}
