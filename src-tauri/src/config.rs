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
                migrate_config_dir(&legacy_dir, &config_dir_path);
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

/// 把旧配置目录**原子地**迁移到新位置。
///
/// 返回 `true` 表示迁移成功（目标目录已就绪）。
///
/// 为什么不能直接 copy 到目标目录（round 53 实测复现的真实缺陷）：
/// `copy_dir_all` 逐个文件复制，而 `read_dir` 顺序不保证。只要
/// `config.json` 先被复制成功、之后某个文件失败（实测：一个坏 symlink
/// 排在 config.json 之后即可复现），就会留下「目标里已有 config.json、
/// 但其它文件缺失」的半迁移状态。调用方只在 `!config_path.exists()` 时才迁移，
/// 于是下次启动会**永久跳过**迁移——用户的部分设置丢失且再也恢复不了，
/// 日志里只有一行 warn。
///
/// 做法：先复制到同级的 `<identifier>.migrating` 临时目录，全部成功后再
/// `rename` 到目标。任何失败路径都会删掉临时目录，让目标目录保持不存在，
/// 下次启动可以重试。这样「要么完整成功、要么不留痕迹」成为不变量。
///
/// staging 名字刻意**不用** `Path::with_extension`：identifier 本身含点
/// （`com.cup-translate.app`），`with_extension("migrating")` 会得到
/// `com.cup-translate.migrating`——把 `.app` 当成扩展名替换掉，
/// 语义不明且可能与别的 identifier 目录相撞。
fn migrate_config_dir(legacy_dir: &std::path::Path, config_dir_path: &std::path::Path) -> bool {
    let staging = staging_dir_for(config_dir_path);
    let _ = std::fs::remove_dir_all(&staging);
    match copy_dir_all(legacy_dir, &staging) {
        Ok(()) => match std::fs::rename(&staging, config_dir_path) {
            Ok(()) => {
                info!("Config migration done");
                true
            }
            Err(e) => {
                warn!("Config migration failed to move into place: {:?}", e);
                let _ = std::fs::remove_dir_all(&staging);
                false
            }
        },
        Err(e) => {
            warn!("Config migration failed: {:?}", e);
            let _ = std::fs::remove_dir_all(&staging);
            false
        }
    }
}

/// 迁移用的临时目录：`<完整 identifier>.migrating`。
///
/// 显式拼接而不是 `with_extension`——后者会把 identifier 最后一段当扩展名
/// 替换掉（见 `migrate_config_dir` 的说明）。
fn staging_dir_for(config_dir_path: &std::path::Path) -> std::path::PathBuf {
    let mut staging = config_dir_path.to_path_buf();
    let name = config_dir_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    staging.set_file_name(format!("{name}.migrating"));
    staging
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

/// 判断一个服务实例是否该被保留。抽成纯函数以便单测——
/// `prune_service_list` 会**真的改写用户配置**，判错等于静默删掉用户的实例。
///
/// 关于 `instance.contains('@')` 这一项：在**当前**两张名单只含裸服务名
/// （deepl / bing / lingva / ecdict / lingva_tts，均不含 `@`）的前提下，
/// 它是**冗余**的——因为字符串相等要求逐字符相同，`"x@y"` 永不可能等于
/// `"deepl"`，所以 `!unusable_builtin.contains(instance)` 必然已为 true。
/// 保留它是为了**表达意图**（用户自建实例一律不动），
/// 而不是因为它改变了结果；有一条测试记录了这一点，
/// 另一条测试锁住「名单里不含 @」这个让它成立的前提。
///
/// 参数 `instance_config` 是该实例的配置对象：
/// - `None`：配置不存在（从未落盘）
/// - `Some(Json::Null)` 或非对象：视为「没有配置」
/// - `Some(Object)`：空对象视为「没配置过」，非空视为「用户配过」
fn should_keep_instance(
    instance: &str,
    unusable_builtin: &[&str],
    instance_config: Option<&serde_json::Value>,
) -> bool {
    // 用户自建实例（含 @）一律保留；不在 unusable 名单里的也一律保留
    if instance.contains('@') || !unusable_builtin.contains(&instance) {
        return true;
    }
    // 配置对象非空说明用户配置过（例如填了 DeepL 密钥 / 自建实例地址），保留
    match instance_config {
        Some(config) => config.as_object().is_none_or(|obj| !obj.is_empty()),
        None => false,
    }
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
        .filter(|instance| should_keep_instance(instance, unusable_builtin, get(instance).as_ref()))
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
    use super::{coerce_bool, coerce_i64, coerce_str, copy_dir_all, migrate_config_dir, staging_dir_for};

    /// 生成唯一临时目录，避免并行测试互踩。
    fn unique_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn copy_dir_all_copies_nested_files() {
        let base = unique_dir("cup-translate-copydir");
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("plugins/translate/demo")).unwrap();
        std::fs::write(src.join("config.json"), br#"{"app_language":"zh_cn"}"#).unwrap();
        std::fs::write(src.join("plugins/translate/demo/main.js"), b"export default 1;").unwrap();

        copy_dir_all(&src, &dst).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.join("config.json")).unwrap(),
            r#"{"app_language":"zh_cn"}"#
        );
        assert_eq!(
            std::fs::read(dst.join("plugins/translate/demo/main.js")).unwrap(),
            b"export default 1;"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn copy_dir_all_reports_failure_instead_of_silently_skipping() {
        // 一个指向不存在目标的 symlink 会让 fs::copy 失败（unix 才可造）
        #[cfg(unix)]
        {
            let base = unique_dir("cup-translate-copydir-fail");
            let src = base.join("src");
            let dst = base.join("dst");
            std::fs::create_dir_all(&src).unwrap();
            std::fs::write(src.join("config.json"), b"{}").unwrap();
            std::os::unix::fs::symlink("/nonexistent/nope", src.join("zz_broken")).unwrap();

            let result = copy_dir_all(&src, &dst);
            assert!(result.is_err(), "a broken symlink must surface as an error, not be skipped");
            let _ = std::fs::remove_dir_all(base);
        }
    }

    /// 迁移必须原子：失败时**不能**在目标留下 `config.json`，
    /// 否则下次启动的 `if !config_path.exists()` 为假，迁移永久不再执行。
    ///
    /// 这是 round 53 实测复现的真实缺陷：原先直接 copy 到目标目录，
    /// 只要 `config.json` 先成功、之后某个文件失败，就留下半迁移状态。
    /// 这里用「staging + rename」的等价流程验证修复后的不变量：
    /// **任何失败路径下，目标目录都不存在 config.json**。
    /// 原子性不变量：**任何失败路径下，目标目录都不能存在 config.json**，
    /// 否则下次启动的 `!config_path.exists()` 为假，迁移永久不再执行。
    ///
    /// 这条**调用生产函数** `migrate_config_dir`（我第一版把迁移流程在测试里
    /// 重抄了一遍，结果 4 个生产代码变异全部逃逸——等于没测）。
    #[test]
    fn a_failed_migration_never_leaves_a_partial_config_behind_in_the_real_code() {
        #[cfg(unix)]
        {
            let base = unique_dir("cup-translate-migrate-real");
            let legacy = base.join("com.pot-app.desktop");
            let target = base.join("com.cup-translate.app");
            std::fs::create_dir_all(&legacy).unwrap();
            std::fs::write(legacy.join("config.json"), br#"{"app_language":"zh_cn"}"#).unwrap();
            // 名字排在 config.json 之后 -> 复现「config.json 先成功、随后失败」
            std::os::unix::fs::symlink("/nonexistent/nope", legacy.join("zz_broken")).unwrap();

            let ok = migrate_config_dir(&legacy, &target);

            assert!(!ok, "migration must report failure");
            assert!(
                !target.join("config.json").exists(),
                "a failed migration must not leave config.json in the target, \
                 otherwise the next launch skips migration forever"
            );
            assert!(
                !staging_dir_for(&target).exists(),
                "the staging directory must be cleaned up on failure"
            );
            let _ = std::fs::remove_dir_all(base);
        }
    }

    /// 成功路径走生产函数：内容完整、staging 不残留。
    #[test]
    fn a_successful_migration_moves_the_whole_directory_into_place_in_the_real_code() {
        let base = unique_dir("cup-translate-migrate-real-ok");
        let legacy = base.join("com.pot-app.desktop");
        let target = base.join("com.cup-translate.app");
        std::fs::create_dir_all(legacy.join("plugins/demo")).unwrap();
        std::fs::write(legacy.join("config.json"), br#"{"app_language":"zh_cn"}"#).unwrap();
        std::fs::write(legacy.join("plugins/demo/main.js"), b"x").unwrap();

        let ok = migrate_config_dir(&legacy, &target);

        assert!(ok, "migration should succeed");
        assert_eq!(
            std::fs::read_to_string(target.join("config.json")).unwrap(),
            r#"{"app_language":"zh_cn"}"#
        );
        assert_eq!(std::fs::read(target.join("plugins/demo/main.js")).unwrap(), b"x");
        assert!(!staging_dir_for(&target).exists(), "staging must be gone after success");
        let _ = std::fs::remove_dir_all(base);
    }

    /// staging 名字必须保留**完整** identifier。
    /// `with_extension("migrating")` 会得到 `com.cup-translate.migrating`
    /// （把 `.app` 当扩展名替换掉），语义不明且可能与别的 identifier 相撞。
    #[test]
    fn the_staging_directory_keeps_the_full_identifier() {
        let target = std::path::PathBuf::from("/base/com.cup-translate.app");
        let staging = staging_dir_for(&target);
        assert_eq!(
            staging.file_name().unwrap().to_string_lossy(),
            "com.cup-translate.app.migrating",
            "the staging name must retain the whole identifier"
        );
        assert_ne!(
            staging,
            target.with_extension("migrating"),
            "with_extension would drop the trailing .app segment"
        );
        // 与旧 identifier 的 staging 不能相撞
        let other = staging_dir_for(&std::path::PathBuf::from("/base/com.pot-app.desktop"));
        assert_ne!(staging, other, "staging dirs for different identifiers must differ");
    }

    /// 残留的 staging 目录（上次崩溃留下）不该影响本次迁移。
    #[test]
    fn a_leftover_staging_directory_is_replaced() {
        let base = unique_dir("cup-translate-migrate-leftover");
        let legacy = base.join("com.pot-app.desktop");
        let target = base.join("com.cup-translate.app");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("config.json"), br#"{"a":1}"#).unwrap();
        let staging = staging_dir_for(&target);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("stale.txt"), b"stale").unwrap();

        let ok = migrate_config_dir(&legacy, &target);

        assert!(ok, "migration should succeed despite leftover staging");
        assert!(!target.join("stale.txt").exists(), "stale staging content must not survive");
        assert_eq!(std::fs::read_to_string(target.join("config.json")).unwrap(), r#"{"a":1}"#);
        let _ = std::fs::remove_dir_all(base);
    }

    /// rename 失败路径**是可达的**：目标目录已存在且非空、但没有 config.json 时
    /// （用户手动建过，或上次崩溃留下 history.db），Unix 的 `rename` 会返回
    /// `DirectoryNotEmpty`（os error 66，实测确认）。此时同样必须清理 staging。
    ///
    /// 这条补上了最后一个未被覆盖的分支——没有它，
    /// `no_cleanup_on_rename_fail` 变异会逃逸。
    #[test]
    fn a_failed_rename_also_cleans_up_the_staging_directory() {
        let base = unique_dir("cup-translate-migrate-rename-fail");
        let legacy = base.join("com.pot-app.desktop");
        let target = base.join("com.cup-translate.app");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("config.json"), br#"{"a":1}"#).unwrap();
        // 目标已存在且非空，但**没有** config.json
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("history.db"), b"old").unwrap();

        let ok = migrate_config_dir(&legacy, &target);

        assert!(!ok, "the rename must fail and be reported");
        assert!(
            !staging_dir_for(&target).exists(),
            "the staging directory must be cleaned up when the move fails"
        );
        // 用户原有的文件不能被破坏
        assert_eq!(std::fs::read(target.join("history.db")).unwrap(), b"old");
        // 目标仍不能有 config.json，否则下次启动会跳过迁移
        assert!(
            !target.join("config.json").exists(),
            "a failed move must not leave a config.json behind"
        );
        let _ = std::fs::remove_dir_all(base);
    }


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

    // ---- should_keep_instance：决定哪些「不可用」的旧服务会被清出用户配置 ----
    // 这些测试守住的是**破坏性行为**：判错会静默删除用户配置。
    // 特别注意 deepl：它同时出现在 builtin_translate_list（保留）与
    // UNUSABLE_TRANSLATE_BUILTIN（待清理）里——看似矛盾，实际是靠
    // 「配置对象是否为空」来区分「默认塞进去的」与「用户真的配过的」。

    use super::{should_keep_instance, UNUSABLE_TRANSLATE_BUILTIN, UNUSABLE_TTS_BUILTIN};

    #[test]
    fn a_user_configured_deepl_is_never_pruned() {
        // 用户填了密钥 -> 必须保留，否则升级一次配置就没了
        for cfg in [json!({"authKey": "k"}), json!({"type": "api", "authKey": "k"})] {
            assert!(
                should_keep_instance("deepl", UNUSABLE_TRANSLATE_BUILTIN, Some(&cfg)),
                "a deepl instance with a real config must survive pruning"
            );
        }
    }

    #[test]
    fn a_never_configured_deepl_is_pruned() {
        // 空对象 = 「从没配过」，是升级用户被默认塞进来的那种，应当清掉
        assert!(!should_keep_instance(
            "deepl",
            UNUSABLE_TRANSLATE_BUILTIN,
            Some(&json!({}))
        ));
        // 配置根本不存在（从未落盘）-> 清掉
        assert!(!should_keep_instance("deepl", UNUSABLE_TRANSLATE_BUILTIN, None));
    }

    /// 非对象配置值一律**保留**——这是 `as_object().is_none_or(..)` 的实际语义，
    /// 不是「非空对象才保留」。
    ///
    /// 对照真实配置文件确认过：服务配置要么是 `{}`（注册时写入的空对象），
    /// 要么整个键不存在；不会出现 null / 字符串 / 数组。
    /// 因此这条分支在实践中走不到，属于防御性代码。
    /// 本测试把它**明确记录下来**，免得后人（包括我自己）误以为它判的是「非对象=没配置」
    /// 而顺手「修正」成一个更严格、却会静默删用户配置的版本。
    #[test]
    fn a_non_object_config_is_conservatively_kept() {
        for weird in [json!(null), json!("oops"), json!(42), json!([1, 2])] {
            assert!(
                should_keep_instance("deepl", UNUSABLE_TRANSLATE_BUILTIN, Some(&weird)),
                "a non-object config ({weird}) is kept conservatively — pruning it risks \
                 deleting something the user did configure"
            );
        }
    }

    #[test]
    fn user_created_instances_are_never_pruned() {
        // 含 @ 的是用户显式创建的实例，哪怕配置为空也不能删
        for name in ["mydeepl@deepl", "self@lingva_tts", "@"] {
            assert!(
                should_keep_instance(name, UNUSABLE_TRANSLATE_BUILTIN, None),
                "'{name}' is a user-created instance and must never be pruned"
            );
        }
    }

    #[test]
    fn the_at_sign_check_is_redundant_under_the_current_lists() {
        // 记录一个容易误判的事实：`instance.contains('@')` 这一项**不影响结果**。
        // 论证：字符串相等要求逐字符相同，而名单里全是裸服务名，
        // 所以含 @ 的实例名永远不 equal 名单项 -> !contains 已为 true。
        // 这里直接对「删掉 @ 判定后的行为」做等价断言，
        // 免得后人以为它挡掉了什么（我自己第一版测试就误以为它被测到了）。
        fn without_at_check(instance: &str, unusable: &[&str]) -> bool {
            if !unusable.contains(&instance) {
                return true;
            }
            false // 名单命中且没有 @ 短路 -> 当作「未配置」处理
        }
        for name in ["mydeepl@deepl", "@deepl", "deepl@", "@"] {
            assert_eq!(
                should_keep_instance(name, UNUSABLE_TRANSLATE_BUILTIN, None),
                without_at_check(name, UNUSABLE_TRANSLATE_BUILTIN),
                "for '{name}' the @ check should not change the outcome"
            );
        }
    }

    #[test]
    fn no_pruning_list_entry_contains_an_at_sign() {
        // 上一条「@ 判定冗余」的论证依赖这个前提：名单里的项都是裸服务名。
        // 谁要是往名单里加了一条含 @ 的项，冗余性就不成立了，
        // 这条测试会先失败，提醒重新审视那段注释。
        for name in UNUSABLE_TRANSLATE_BUILTIN.iter().chain(UNUSABLE_TTS_BUILTIN) {
            assert!(
                !name.contains('@'),
                "'{name}' contains '@', which invalidates the documented reasoning that \
                 the @ check in should_keep_instance is redundant"
            );
        }
    }

    #[test]
    fn services_outside_the_unusable_list_are_always_kept() {
        // 只有 bing/ecdict/lingva 这类「代码已删除」的服务才在清理名单里；
        // 其余服务即使配置为空也必须保留（否则开箱即用的默认引擎会被删掉）。
        for name in ["google", "yandex", "openai", "ollama", "local_mt"] {
            assert!(
                should_keep_instance(name, UNUSABLE_TRANSLATE_BUILTIN, None),
                "'{name}' is not on the unusable list and must always be kept"
            );
        }
    }

    #[test]
    fn the_unusable_lists_only_name_services_that_are_gone_or_gated() {
        // 结构性护栏：清理名单里的每一项都必须是「代码已删除」（bing/ecdict/lingva）
        // 或「需要用户显式配置才可用」（deepl / lingva_tts）。
        // 若有人把仍在正常工作的服务加进来，用户配置会被静默清掉。
        let intentionally_gated: &[&str] = &["deepl", "lingva_tts"];
        let code_removed: &[&str] = &["bing", "ecdict", "lingva"];
        for name in UNUSABLE_TRANSLATE_BUILTIN.iter().chain(UNUSABLE_TTS_BUILTIN) {
            assert!(
                intentionally_gated.contains(name) || code_removed.contains(name),
                "'{name}' is on a pruning list but is neither removed from the code nor                  explicitly gated on user configuration — pruning it would silently                  delete working services from user config"
            );
        }
    }

    #[test]
    fn the_tts_unusable_list_covers_the_gated_tts_service() {
        // lingva_tts 的默认地址实测已死（CLAUDE.md §3.2），必须留在清理名单里；
        // 同时它又在 builtin_tts_list 里（供自建），二者靠空配置判定区分。
        assert!(UNUSABLE_TTS_BUILTIN.contains(&"lingva_tts"));
        assert!(should_keep_instance(
            "lingva_tts",
            UNUSABLE_TTS_BUILTIN,
            Some(&json!({"requestPath": "http://my-lingva"}))
        ));
        assert!(!should_keep_instance("lingva_tts", UNUSABLE_TTS_BUILTIN, Some(&json!({}))));
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
