use serde_json::Value;
use std::sync::Mutex;
static GATE: Mutex<()> = Mutex::new(());
const SERVICE: &str = "com.cup-translate.app.services";
fn secret_field(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    matches!(
        key.as_str(),
        "key"
            | "ak"
            | "sk"
            | "appkey"
            | "token"
            | "authtoken"
            | "accesstoken"
            | "refreshtoken"
            | "bearertoken"
    ) || [
        "authorization",
        "apikey",
        "authkey",
        "secret",
        "password",
        "cookie",
        "accesskey",
        "credential",
    ]
    .iter()
    .any(|s| key.contains(s))
}
fn entry(reference: &str) -> Result<keyring::Entry, String> {
    if !reference.starts_with("cup:") || reference.len() > 512 {
        return Err("Invalid credential reference".into());
    }
    keyring::Entry::new(SERVICE, reference)
        .map_err(|_| "System credential store unavailable".into())
}
fn seal_with<F>(key: &str, config: Value, mut save: F) -> Result<Value, String>
where
    F: FnMut(&str, &str) -> Result<(), String>,
{
    let mut result = config.clone();
    let Some(object) = result.as_object_mut() else {
        return Ok(result);
    };
    let mut refs = object
        .get("secretRefs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (field, value) in config.as_object().unwrap() {
        if field == "secretRefs" {
            continue;
        }
        if field == "headers" {
            if let Some(headers) = value.as_object() {
                for (header, value) in headers {
                    if let Some(secret) = value.as_str().filter(|s| !s.is_empty()) {
                        let field = format!("headers.{header}");
                        let reference = {
                            use sha2::{Digest, Sha256};
                            format!("cup:{key}:{field}:{:x}", Sha256::digest(secret.as_bytes()))
                        };
                        save(&reference, secret)?;
                        refs.insert(field, Value::String(reference));
                    }
                    object
                        .get_mut("headers")
                        .and_then(Value::as_object_mut)
                        .unwrap()
                        .remove(header);
                }
            }
        } else if secret_field(field) {
            if let Some(secret) = value.as_str().filter(|s| !s.is_empty()) {
                let reference = {
                    use sha2::{Digest, Sha256};
                    format!("cup:{key}:{field}:{:x}", Sha256::digest(secret.as_bytes()))
                };
                save(&reference, secret)?;
                refs.insert(field.clone(), Value::String(reference));
            }
            object.remove(field);
        }
    }
    if !refs.is_empty() {
        object.insert("secretRefs".into(), Value::Object(refs));
    }
    Ok(result)
}
#[tauri::command]
pub async fn seal_service_config(key: String, config: Value) -> Result<Value, String> {
    if !["openai", "ollama", "anki", "eudic"].contains(&key.split('@').next().unwrap_or("")) {
        return Err("Unsupported secret schema".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GATE.lock().map_err(|_| "Credential store busy")?;
        seal_with(&key, config, |reference, secret| {
            let item = entry(reference)?;
            item.set_password(secret)
                .map_err(|_| "Cannot save credential; configuration was not changed")?;
            if item
                .get_password()
                .map_err(|_| "Cannot verify credential")?
                != secret
            {
                return Err("Credential verification failed".into());
            }
            Ok(())
        })
    })
    .await
    .map_err(|_| "Credential worker failed")?
}
#[tauri::command]
pub async fn read_service_secret(reference: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GATE.lock().map_err(|_| "Credential store busy")?;
        entry(&reference)?
            .get_password()
            .map_err(|_| "Credential unavailable; rebind in Settings".into())
    })
    .await
    .map_err(|_| "Credential worker failed")?
}
pub fn scrub(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| !secret_field(key) && !key.starts_with("plugin"));
            // Unknown custom headers cannot be classified safely.
            object.remove("headers");
            for item in object.values_mut() {
                scrub(item);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub(item);
            }
        }
        _ => {}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn migration_is_verified_repeatable_and_failure_preserves_input() {
        let input = json!({"apiKey":"fake-only", "threads":4, "headers":{"Authorization":"fake-header", "X-Other":"safe"}, "promptList":[{"content":"custom"}]});
        assert!(seal_with("openai@old", input.clone(), |_, _| Err("offline".into())).is_err());
        assert_eq!(input["apiKey"], "fake-only");
        let safe = seal_with("openai@old", input, |_, _| Ok(())).unwrap();
        assert!(safe.get("apiKey").is_none());
        assert_eq!(safe["threads"], 4);
        assert!(safe["secretRefs"]["apiKey"]
            .as_str()
            .unwrap()
            .starts_with("cup:openai@old:apiKey:"));
        assert_eq!(
            seal_with("openai@old", safe.clone(), |_, _| panic!(
                "must not rewrite"
            ))
            .unwrap(),
            safe
        );
    }
    #[test]
    fn collection_credentials_are_sealed_and_backup_scrubbed() {
        for (key, field) in [("anki@fixture", "apiKey"), ("eudic@fixture", "token")] {
            let mut input = json!({"port": 8765});
            input[field] = json!("fake-only");
            let mut writes = 0;
            let safe = seal_with(key, input.clone(), |_, secret| {
                assert_eq!(secret, "fake-only");
                writes += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(writes, 1);
            assert!(safe.get(field).is_none());
            assert!(safe["secretRefs"][field]
                .as_str()
                .unwrap()
                .starts_with("cup:"));
            let repeated = seal_with(key, safe.clone(), |_, _| panic!("already sealed")).unwrap();
            assert_eq!(repeated, safe);
            let mut backup = json!({key: safe});
            scrub(&mut backup);
            assert!(!backup.to_string().contains("fake-only"));
            assert!(backup[key].get("secretRefs").is_none());
            assert!(seal_with(key, input, |_, _| Err("unavailable".into())).is_err());
        }
    }
    #[test]
    fn backup_removes_legacy_secrets_headers_and_unknown_plugins() {
        let mut data = json!({"openai@a":{"apiKey":"fake", "secretRefs":{"apiKey":"ref"}, "headers":{"X-Custom":"fake"},"model":"m"},"plugin-translate-x":{"arbitrary":"fake"}});
        scrub(&mut data);
        assert_eq!(data, json!({"openai@a":{"model":"m"}}));
    }
}

// The frontend store plugin writes with truncate; commit sensitive migrations via
// a same-directory rename instead. Existing backend readers see the same snapshot.
#[tauri::command]
pub async fn save_config_atomic(
    app_handle: tauri::AppHandle,
    settings: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use tauri::Manager;
        let _guard = GATE.lock().map_err(|_| "Configuration lock unavailable")?;
        let object = settings
            .as_object()
            .ok_or("Expected configuration object")?;
        // Supported schemas may never reintroduce plaintext at commit time.
        for (key, value) in object {
            if ["openai", "ollama", "anki", "eudic"].contains(&key.split('@').next().unwrap_or(""))
            {
                if let Some(fields) = value.as_object() {
                    if fields.iter().any(|(field, value)| {
                        field != "secretRefs"
                            && secret_field(field)
                            && value.as_str().is_some_and(|s| !s.is_empty())
                    }) {
                        return Err("Credential migration pending; cannot persist plaintext".into());
                    }
                    if fields
                        .get("headers")
                        .and_then(Value::as_object)
                        .is_some_and(|h| !h.is_empty())
                    {
                        return Err("Headers must be sealed before saving".into());
                    }
                }
            }
        }
        let root = app_handle
            .path_resolver()
            .app_config_dir()
            .ok_or("Config directory unavailable")?;
        std::fs::create_dir_all(&root).map_err(|_| "Cannot access configuration directory")?;
        let temporary = root.join("config.json.pending");
        let mut file =
            std::fs::File::create(&temporary).map_err(|_| "Cannot stage configuration")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot protect configuration")?;
        }
        file.write_all(
            &serde_json::to_vec(&settings).map_err(|_| "Cannot serialize configuration")?,
        )
        .map_err(|_| "Cannot write configuration")?;
        file.sync_all().map_err(|_| "Cannot flush configuration")?;
        drop(file);
        std::fs::rename(&temporary, root.join("config.json"))
            .map_err(|_| "Cannot atomically commit configuration")?;
        let state = app_handle.state::<crate::config::StoreWrapper>();
        let mut store = state
            .0
            .lock()
            .map_err(|_| "Configuration state unavailable")?;
        store
            .load()
            .map_err(|_| "Cannot refresh backend configuration")?;
        Ok(())
    })
    .await
    .map_err(|_| "Configuration worker failed")?
}

#[cfg(test)]
mod system_store_tests {
    #[test]
    #[ignore = "explicit integration check: writes and removes a new fake test credential"]
    fn fake_system_credential_roundtrip() {
        let name = format!("cup:validation-fake-{}", std::process::id());
        let item = keyring::Entry::new("com.cup-translate.validation-tests", &name).unwrap();
        item.set_password("FAKE-TEST-CREDENTIAL-NO-EXTERNAL-ACCESS")
            .unwrap();
        assert_eq!(
            item.get_password().unwrap(),
            "FAKE-TEST-CREDENTIAL-NO-EXTERNAL-ACCESS"
        );
        item.delete_credential().unwrap();
        assert!(item.get_password().is_err());
    }
}

#[cfg(test)]
mod schema_preservation_tests {
    #[test]
    fn backup_preserves_hotkeys_and_nonsensitive_limits() {
        let mut value = serde_json::json!({"hotkey_input_translate":"Alt+T","openai@old":{"max_tokens":1200,"authKey":"fake","model":"fixture"}});
        super::scrub(&mut value);
        assert_eq!(value["hotkey_input_translate"], "Alt+T");
        assert_eq!(value["openai@old"]["max_tokens"], 1200);
        assert!(value["openai@old"].get("authKey").is_none());
    }
}
