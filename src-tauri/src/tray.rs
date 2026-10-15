use crate::clipboard::*;
use crate::config::{get_bool, get_str, set};
use crate::window::config_window;
use crate::window::input_translate;
use crate::window::ocr_recognize;
use crate::window::ocr_translate;
use crate::window::updater_window;
use log::info;
use tauri::CustomMenuItem;
use tauri::GlobalShortcutManager;
use tauri::SystemTrayEvent;
use tauri::SystemTrayMenu;
use tauri::SystemTrayMenuItem;
use tauri::SystemTraySubmenu;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn update_tray(app_handle: tauri::AppHandle, mut language: String, mut copy_mode: String) {
    let tray_handle = app_handle.tray_handle();

    if language.is_empty() {
        language = match get_str("app_language") {
            Some(v) => v,
            None => {
                // 必须与前端默认值 (src/App.jsx / General/index.jsx) 保持一致。
                // 托盘初始化早于前端加载：此处若写入 'en'，前端 useConfig 的默认值
                // 'zh_cn' 会因配置项已存在而失效，导致全新安装时界面为英文。
                set("app_language", "zh_cn");
                "zh_cn".to_string()
            }
        };
    }
    if copy_mode.is_empty() {
        copy_mode = match get_str("translate_auto_copy") {
            Some(v) => v,
            None => {
                set("translate_auto_copy", "disable");
                "disable".to_string()
            }
        };
    }

    info!(
        "Update tray with language: {}, copy mode: {}",
        language, copy_mode
    );
    if let Err(e) = tray_handle.set_menu(match language.as_str() {
        "en" => tray_menu_en(),
        "zh_cn" => tray_menu_zh_cn(),
        "zh_tw" => tray_menu_zh_tw(),
        "ja" => tray_menu_ja(),
        "ko" => tray_menu_ko(),
        "fr" => tray_menu_fr(),
        "de" => tray_menu_de(),
        "ru" => tray_menu_ru(),
        "pt_br" => tray_menu_pt_br(),
        // pt_PT 在语言选择器里与 pt_br 并列，是独立选项；
        // 修复前它会落到 _ 分支拿到**英文**托盘。
        "pt_pt" => tray_menu_pt_pt(),
        "es" => tray_menu_es(),
        "it" => tray_menu_it(),
        "ar" => tray_menu_ar(),
        "he" => tray_menu_he(),
        "ta" => tray_menu_ta(),
        "fa" => tray_menu_fa(),
        "uk" => tray_menu_uk(),
        // nb_no / nn_no / tr / tk 的 locale 是不完整的占位文件
        // （分别只有 2 / 2 / 2 / 68 个 key，远少于完整语言的 342），
        // 全站文案本就回退英文，托盘保持英文与之一致；
        // 为它们编造托盘译文等于凭空发明翻译，故不添加。
        _ => tray_menu_en(),
    }) {
        log::warn!("Failed to set tray menu: {e:?}");
    }
    #[cfg(not(target_os = "linux"))]
    if let Err(e) = tray_handle.set_tooltip(&format!(
        "cup-translate {}",
        app_handle.package_info().version
    )) {
        log::warn!("Failed to set tray tooltip: {e:?}");
    }

    let enable_clipboard_monitor = match get_bool("clipboard_monitor") {
        Some(v) => v,
        None => {
            set("clipboard_monitor", false);
            false
        }
    };

    if let Err(e) = tray_handle
        .get_item("clipboard_monitor")
        .set_selected(enable_clipboard_monitor)
    {
        log::warn!("Failed to set tray clipboard_monitor state: {e:?}");
    }

    let copy_item = match copy_mode.as_str() {
        "source" => Some("copy_source"),
        "target" => Some("copy_target"),
        "source_target" => Some("copy_source_target"),
        "disable" => Some("copy_disable"),
        _ => None,
    };
    if let Some(id) = copy_item {
        if let Err(e) = tray_handle.get_item(id).set_selected(true) {
            log::warn!("Failed to set tray copy mode {id}: {e:?}");
        }
    }
}

pub fn tray_event_handler(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        #[cfg(target_os = "windows")]
        SystemTrayEvent::LeftClick { .. } => on_tray_click(),
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "input_translate" => on_input_translate_click(),
            "copy_source" => on_auto_copy_click(app, "source"),
            "clipboard_monitor" => on_clipboard_monitor_click(app),
            "copy_target" => on_auto_copy_click(app, "target"),
            "copy_source_target" => on_auto_copy_click(app, "source_target"),
            "copy_disable" => on_auto_copy_click(app, "disable"),
            "ocr_recognize" => on_ocr_recognize_click(),
            "ocr_translate" => on_ocr_translate_click(),
            "config" => on_config_click(),
            "check_update" => on_check_update_click(),
            "view_log" => on_view_log_click(app),
            "restart" => on_restart_click(app),
            "quit" => on_quit_click(app),
            _ => {}
        },
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn on_tray_click() {
    let event = match get_str("tray_click_event") {
        Some(v) => v,
        None => {
            set("tray_click_event", "config");
            "config".to_string()
        }
    };
    match event.as_str() {
        "config" => config_window(),
        "translate" => input_translate(),
        "ocr_recognize" => ocr_recognize(),
        "ocr_translate" => ocr_translate(),
        "disable" => {}
        _ => config_window(),
    }
}
fn on_input_translate_click() {
    input_translate();
}
fn on_clipboard_monitor_click(app: &AppHandle) {
    let enable_clipboard_monitor = match get_bool("clipboard_monitor") {
        Some(v) => v,
        None => {
            set("clipboard_monitor", false);
            false
        }
    };
    let current = !enable_clipboard_monitor;
    // Update Config File
    set("clipboard_monitor", current);
    // Update State and Start Monitor
    let state = app.state::<ClipboardMonitorEnableWrapper>();
    if let Ok(mut guard) = state.0.lock() {
        guard.replace_range(.., &current.to_string());
    } else {
        log::warn!("Clipboard monitor state mutex poisoned, skipping state update");
    }
    if current {
        start_clipboard_monitor(app.app_handle());
    }
    // Update Tray Menu Status
    if let Err(e) = app
        .tray_handle()
        .get_item("clipboard_monitor")
        .set_selected(current)
    {
        log::warn!("Failed to update tray clipboard_monitor state: {e:?}");
    }
}
fn on_auto_copy_click(app: &AppHandle, mode: &str) {
    info!("Set copy mode to: {}", mode);
    set("translate_auto_copy", mode);
    if let Err(e) = app.emit_all("translate_auto_copy_changed", mode) {
        log::warn!("Failed to emit translate_auto_copy_changed: {e:?}");
    }
    update_tray(app.app_handle(), "".to_string(), mode.to_string());
}
fn on_ocr_recognize_click() {
    ocr_recognize();
}
fn on_ocr_translate_click() {
    ocr_translate();
}

fn on_config_click() {
    config_window();
}

fn on_check_update_click() {
    updater_window();
}
fn on_view_log_click(app: &AppHandle) {
    use tauri::api::path::app_log_dir;
    let log_path = match app_log_dir(&app.config()) {
        Some(v) => v,
        None => {
            log::warn!("Cannot resolve app log dir, skipping view_log");
            return;
        }
    };
    let log_path_str = match log_path.to_str() {
        Some(v) => v,
        None => {
            log::warn!("App log dir path is not valid UTF-8, skipping view_log");
            return;
        }
    };
    if let Err(e) = tauri::api::shell::open(&app.shell_scope(), log_path_str, None) {
        log::warn!("Failed to open log dir: {e:?}");
    }
}
fn on_restart_click(app: &AppHandle) {
    info!("============== Restart App ==============");
    app.restart();
}
fn on_quit_click(app: &AppHandle) {
    if let Err(e) = app.global_shortcut_manager().unregister_all() {
        log::warn!("Failed to unregister global shortcuts on quit: {e:?}");
    }
    crate::hotkey::clear_registered_accelerators();
    info!("============== Quit App ==============");
    app.exit(0);
}

fn tray_menu_en() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Input Translate");
    let copy_source = CustomMenuItem::new("copy_source", "Source");
    let copy_target = CustomMenuItem::new("copy_target", "Target");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Clipboard Monitor");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "Source+Target");
    let copy_disable = CustomMenuItem::new("copy_disable", "Disable");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "OCR Recognize");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "OCR Translate");
    let config = CustomMenuItem::new("config", "Config");
    let check_update = CustomMenuItem::new("check_update", "Check Update");
    let view_log = CustomMenuItem::new("view_log", "View Log");
    let restart = CustomMenuItem::new("restart", "Restart");
    let quit = CustomMenuItem::new("quit", "Quit");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Auto Copy",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_zh_cn() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "输入翻译");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "监听剪切板");
    let copy_source = CustomMenuItem::new("copy_source", "原文");
    let copy_target = CustomMenuItem::new("copy_target", "译文");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "原文+译文");
    let copy_disable = CustomMenuItem::new("copy_disable", "关闭");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "文字识别");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "截图翻译");
    let config = CustomMenuItem::new("config", "偏好设置");
    let check_update = CustomMenuItem::new("check_update", "检查更新");
    let restart = CustomMenuItem::new("restart", "重启应用");
    let view_log = CustomMenuItem::new("view_log", "查看日志");
    let quit = CustomMenuItem::new("quit", "退出");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "自动复制",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_zh_tw() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "輸入翻譯");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "偵聽剪貼簿");
    let copy_source = CustomMenuItem::new("copy_source", "原文");
    let copy_target = CustomMenuItem::new("copy_target", "譯文");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "原文+譯文");
    let copy_disable = CustomMenuItem::new("copy_disable", "關閉");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "文字識別");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "截圖翻譯");
    let config = CustomMenuItem::new("config", "偏好設定");
    let check_update = CustomMenuItem::new("check_update", "檢查更新");
    let restart = CustomMenuItem::new("restart", "重啓程式");
    let view_log = CustomMenuItem::new("view_log", "查看日誌");
    let quit = CustomMenuItem::new("quit", "退出");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "自動複製",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_ja() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "翻訳を入力");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "クリップボードを監視する");
    let copy_source = CustomMenuItem::new("copy_source", "原文");
    let copy_target = CustomMenuItem::new("copy_target", "訳文");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "原文+訳文");
    let copy_disable = CustomMenuItem::new("copy_disable", "閉じる");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "テキスト認識");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "スクリーンショットの翻訳");
    let config = CustomMenuItem::new("config", "プリファレンス設定");
    let check_update = CustomMenuItem::new("check_update", "更新を確認する");
    let restart = CustomMenuItem::new("restart", "アプリの再起動");
    let view_log = CustomMenuItem::new("view_log", "ログを見る");
    let quit = CustomMenuItem::new("quit", "退出する");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "自動コピー",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_ko() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "입력 번역");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "감청 전단판");
    let copy_source = CustomMenuItem::new("copy_source", "원문");
    let copy_target = CustomMenuItem::new("copy_target", "번역문");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "원문+번역문");
    let copy_disable = CustomMenuItem::new("copy_disable", "닫기");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "문자인식");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "스크린샷 번역");
    let config = CustomMenuItem::new("config", "기본 설정");
    let check_update = CustomMenuItem::new("check_update", "업데이트 확인");
    let restart = CustomMenuItem::new("restart", "응용 프로그램 다시 시작");
    let view_log = CustomMenuItem::new("view_log", "로그 보기");
    let quit = CustomMenuItem::new("quit", "퇴출");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "자동 복사",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_fr() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Traduction d'entrée");
    let clipboard_monitor =
        CustomMenuItem::new("clipboard_monitor", "Surveiller le presse-papiers");
    let copy_source = CustomMenuItem::new("copy_source", "Source");
    let copy_target = CustomMenuItem::new("copy_target", "Cible");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "Source+Cible");
    let copy_disable = CustomMenuItem::new("copy_disable", "Désactiver");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Reconnaissance de texte");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Traduction d'image");
    let config = CustomMenuItem::new("config", "Paramètres");
    let check_update = CustomMenuItem::new("check_update", "Vérifier les mises à jour");
    let restart = CustomMenuItem::new("restart", "Redémarrer l'application");
    let view_log = CustomMenuItem::new("view_log", "Voir le journal");
    let quit = CustomMenuItem::new("quit", "Quitter");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Copier automatiquement",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}
fn tray_menu_de() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Eingabeübersetzung");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Zwischenablage überwachen");
    let copy_source = CustomMenuItem::new("copy_source", "Quelle");
    let copy_target = CustomMenuItem::new("copy_target", "Ziel");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "Quelle+Ziel");
    let copy_disable = CustomMenuItem::new("copy_disable", "Deaktivieren");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Texterkennung");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Bildübersetzung");
    let config = CustomMenuItem::new("config", "Einstellungen");
    let check_update = CustomMenuItem::new("check_update", "Auf Updates prüfen");
    let restart = CustomMenuItem::new("restart", "Anwendung neu starten");
    let view_log = CustomMenuItem::new("view_log", "Protokoll anzeigen");
    let quit = CustomMenuItem::new("quit", "Beenden");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Automatisch kopieren",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_ru() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Ввод перевода");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Следить за буфером обмена");
    let copy_source = CustomMenuItem::new("copy_source", "Источник");
    let copy_target = CustomMenuItem::new("copy_target", "Цель");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "Источник+Цель");
    let copy_disable = CustomMenuItem::new("copy_disable", "Отключить");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Распознавание текста");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Перевод изображения");
    let config = CustomMenuItem::new("config", "Настройки");
    let check_update = CustomMenuItem::new("check_update", "Проверить обновления");
    let restart = CustomMenuItem::new("restart", "Перезапустить приложение");
    let view_log = CustomMenuItem::new("view_log", "Просмотр журнала");
    let quit = CustomMenuItem::new("quit", "Выход");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Автоматическое копирование",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_fa() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "متن");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "گوش دادن به تخته برش");
    let copy_source = CustomMenuItem::new("copy_source", "منبع");
    let copy_target = CustomMenuItem::new("copy_target", "هدف");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "منبع + هدف");
    let copy_disable = CustomMenuItem::new("copy_disable", "متن");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "تشخیص متن");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "ترجمه عکس");
    let config = CustomMenuItem::new("config", "تنظیمات ترجیح");
    let check_update = CustomMenuItem::new("check_update", "بررسی بروزرسانی");
    let restart = CustomMenuItem::new("restart", "راه‌اندازی مجدد برنامه");
    let view_log = CustomMenuItem::new("view_log", "مشاهده گزارشات");
    let quit = CustomMenuItem::new("quit", "خروج");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "کپی خودکار",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_pt_br() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Traduzir Entrada");
    let clipboard_monitor =
        CustomMenuItem::new("clipboard_monitor", "Monitorando a área de transferência");
    let copy_source = CustomMenuItem::new("copy_source", "Origem");
    let copy_target = CustomMenuItem::new("copy_target", "Destino");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "Origem+Destino");
    let copy_disable = CustomMenuItem::new("copy_disable", "Desabilitar");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Reconhecimento de Texto");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Tradução de Imagem");
    let config = CustomMenuItem::new("config", "Configurações");
    let check_update = CustomMenuItem::new("check_update", "Checar por Atualização");
    let restart = CustomMenuItem::new("restart", "Reiniciar aplicativo");
    let view_log = CustomMenuItem::new("view_log", "Exibir Registro");
    let quit = CustomMenuItem::new("quit", "Sair");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Copiar Automaticamente",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_uk() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Введення перекладу");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Стежити за буфером обміну");
    let copy_source = CustomMenuItem::new("copy_source", "Джерело");
    let copy_target = CustomMenuItem::new("copy_target", "Мета");

    let copy_source_target = CustomMenuItem::new("copy_source_target", "Джерело+Мета");
    let copy_disable = CustomMenuItem::new("copy_disable", "Відключивши");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Розпізнавання тексту");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Переклад зображення");
    let config = CustomMenuItem::new("config", "Настройка");
    let check_update = CustomMenuItem::new("check_update", "Перевірити оновлення");
    let restart = CustomMenuItem::new("restart", "Перезапустити додаток");
    let view_log = CustomMenuItem::new("view_log", "Перегляд журналу");
    let quit = CustomMenuItem::new("quit", "Вихід");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Автоматичне копіювання",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_es() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Traducción de texto");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Vigilar el portapapeles");
    let copy_source = CustomMenuItem::new("copy_source", "Origen");
    let copy_target = CustomMenuItem::new("copy_target", "Destino");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "Origen+Destino");
    let copy_disable = CustomMenuItem::new("copy_disable", "Desactivar");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Reconocimiento de texto");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Traducción de captura de pantalla");
    let config = CustomMenuItem::new("config", "Ajustes generales");
    let check_update = CustomMenuItem::new("check_update", "Comprobar la actualización");
    let view_log = CustomMenuItem::new("view_log", "Ver registros");
    let restart = CustomMenuItem::new("restart", "Reiniciar la aplicación");
    let quit = CustomMenuItem::new("quit", "Salir");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Copia automática",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_it() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Input di traduzione");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Monitora gli appunti");
    let copy_source = CustomMenuItem::new("copy_source", "Origine");
    let copy_target = CustomMenuItem::new("copy_target", "Destinazione");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "Origine+Destinazione");
    let copy_disable = CustomMenuItem::new("copy_disable", "Disattiva");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Riconoscimento del testo");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Traduzione di schermate");
    let config = CustomMenuItem::new("config", "Impostazioni Generali");
    let check_update = CustomMenuItem::new("check_update", "Controlla aggiornamento");
    let view_log = CustomMenuItem::new("view_log", "Vedi log");
    let restart = CustomMenuItem::new("restart", "Riavvia applicazione");
    let quit = CustomMenuItem::new("quit", "Esci");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Copia automatica",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_pt_pt() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "Tradução do Texto");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "Monitorizar a área de transferência");
    let copy_source = CustomMenuItem::new("copy_source", "Origem");
    let copy_target = CustomMenuItem::new("copy_target", "Destino");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "Origem+Destino");
    let copy_disable = CustomMenuItem::new("copy_disable", "Desativar");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "Reconhecimento de Texto");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "Tradução de Imagem");
    let config = CustomMenuItem::new("config", "Configurações Gerais");
    let check_update = CustomMenuItem::new("check_update", "Procurar Atualização");
    let view_log = CustomMenuItem::new("view_log", "Exibir Registro");
    let restart = CustomMenuItem::new("restart", "Reiniciar aplicação");
    let quit = CustomMenuItem::new("quit", "Sair");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "Cópia automática",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_ar() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "تحديد النص");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "مراقبة الحافظة");
    let copy_source = CustomMenuItem::new("copy_source", "المصدر");
    let copy_target = CustomMenuItem::new("copy_target", "الهدف");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "المصدر+الهدف");
    let copy_disable = CustomMenuItem::new("copy_disable", "تعطيل");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "التعرف على النص");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "أخذ لقطة للترجمة");
    let config = CustomMenuItem::new("config", "إعدادات عامة");
    let check_update = CustomMenuItem::new("check_update", "تحقق من التحديث");
    let view_log = CustomMenuItem::new("view_log", "اعرض السجل");
    let restart = CustomMenuItem::new("restart", "إعادة تشغيل التطبيق");
    let quit = CustomMenuItem::new("quit", "خروج");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "النسخ التلقائي",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 语言选择器（src/window/Config/pages/General/index.jsx 的 DropdownItem key）
    /// 会原样写入 app_language 并传给 update_tray，因此托盘必须覆盖其中的每一种语言。
    ///
    /// **本清单是前端下拉的硬编码副本，必须与它逐项一致。**
    ///
    /// 曾经漏了 `he` / `ta`（前端有、生产分发也有），这里却没有——
    /// 于是本测试的循环**永远不会检查这两项**，长期显示绿色。
    /// 更要紧的是原文写着「前端新增语言却忘了加托盘菜单，本测试会失败」，
    /// 这句话**并不成立**：硬编码副本不会自己跟着前端变，新增语言时
    /// 循环仍只覆盖旧条目，**不会**失败。
    ///
    /// 权威护栏是 `tests/tray-language-parity.test.mjs`：它直接解析**真实**的
    /// 前端下拉与**真实**的 `update_tray` 分发，新增语言会立刻失败（已实测）。
    /// 这里保留一份独立副本，是为了让 `cargo test` 单独也能发现托盘分支被删。
    const UI_LANGUAGES: &[&str] = &[
        "zh_cn", "zh_tw", "en", "ja", "ko", "fr", "de", "es", "ru", "it", "tr", "pt_pt", "pt_br", "nb_no",
        "nn_no", "fa", "uk", "ar", "he", "ta", "tk",
    ];

    /// locale 文件只有 2 个 key 的占位语言：全站文案本就回退英文，
    /// 托盘回退英文与之一致，不属于缺陷。
    /// 这些语言的 locale 文件远不完整（2/2/2/68 个 key，完整语言为 342），
    /// 全站文案本就回退英文，托盘回退英文与之一致，不属于缺陷。
    const PLACEHOLDER_LOCALES: &[&str] = &["tr", "nb_no", "nn_no", "tk"];

    /// 复刻 update_tray 的语言分发，用于断言「该语言有没有专属菜单」。
    /// 返回 None 表示落到了 _ 分支（即英文托盘）。
    fn menu_for(language: &str) -> Option<&'static str> {
        Some(match language {
            "en" => "en",
            "zh_cn" => "zh_cn",
            "zh_tw" => "zh_tw",
            "ja" => "ja",
            "ko" => "ko",
            "fr" => "fr",
            "de" => "de",
            "ru" => "ru",
            "pt_br" => "pt_br",
            "pt_pt" => "pt_pt",
            "es" => "es",
            "it" => "it",
            "ar" => "ar",
            "he" => "he",
            "ta" => "ta",
            "fa" => "fa",
            "uk" => "uk",
            _ => return None,
        })
    }

    /// `UI_LANGUAGES` 必须与**真实的前端语言下拉**逐项一致。
    ///
    /// 为什么需要这条：`UI_LANGUAGES` 是被检查对象的清单，而清单**自证不了
    /// 完整性**——从它里面删一项，上面那个循环就少检查一项，测试依然全绿。
    /// 实测确认：把 `he` 从本清单删掉，`cargo test` 与 `pnpm test` **都是全绿**
    /// （`tests/tray-language-parity.test.mjs` 读的是前端下拉与 Rust 分发，
    /// 并不校验本清单）。所以本清单的完整性此前**无人守**，`he` / `ta`
    /// 就是这样悄悄漏掉的。
    ///
    /// 这里直接解析 `General/index.jsx` 里语言下拉的 `key='...'`，
    /// 与 `UI_LANGUAGES` 比对——比的是**权威来源**，不是另一份副本。
    #[test]
    fn the_ui_language_list_matches_the_frontend_picker() {
        // env!("CARGO_MANIFEST_DIR") 是 src-tauri/，前端源码在它的上一级
        let picker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri must have a parent")
            .join("src/window/Config/pages/General/index.jsx");
        let source = std::fs::read_to_string(&picker)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", picker.display()));

        // 边界：从 `aria-label='app language'` 到 `</DropdownMenu>`。
        // 不设边界会把主题/引擎的 key='...' 误当语言码（Node 那条护栏的注释里
        // 记着同一个坑）。
        let start = source
            .find("aria-label='app language'")
            .expect("the language dropdown must exist");
        let rest = &source[start..];
        let end = rest.find("</DropdownMenu>").expect("the dropdown must be closed");
        let menu = &rest[..end];

        // 逐个提取 key='xx' 的值
        let mut offered: Vec<&str> = Vec::new();
        let mut cursor = menu;
        while let Some(at) = cursor.find("key='") {
            let after = &cursor[at + "key='".len()..];
            let close = after.find('\'').expect("key literal must be closed");
            offered.push(&after[..close]);
            cursor = &after[close..];
        }

        assert!(
            offered.len() >= 20,
            "expected the picker to offer >=20 languages, got {}: {offered:?}",
            offered.len()
        );

        let mut offered_sorted = offered.clone();
        offered_sorted.sort_unstable();
        let mut declared: Vec<&str> = UI_LANGUAGES.to_vec();
        declared.sort_unstable();

        assert_eq!(
            declared, offered_sorted,
            "UI_LANGUAGES must list exactly the languages the picker offers — \
             a missing entry means that language is never checked below"
        );

        // 清单内不得重复（重复会掩盖漏项）
        let mut dedup = offered_sorted.clone();
        dedup.dedup();
        assert_eq!(dedup.len(), offered_sorted.len(), "the picker must not repeat a language key");
    }

    #[test]
    fn every_ui_language_has_a_tray_menu_route() {
        // 核心用例：修复前 es / it / ar / pt_pt 没有分支，
        // 用户把界面切成这些语言后，系统托盘仍是英文。
        let missing: Vec<_> = UI_LANGUAGES
            .iter()
            .filter(|l| !PLACEHOLDER_LOCALES.contains(l))
            .filter(|l| menu_for(l).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "these UI languages fall back to the English tray: {missing:?}"
        );
    }

    #[test]
    fn the_four_previously_missing_languages_are_covered() {
        // 逐个点名，避免将来有人「优化」掉其中某个分支
        for lang in ["es", "it", "ar", "pt_pt", "he", "ta"] {
            assert!(
                menu_for(lang).is_some(),
                "{lang} had no tray menu before the fix and must keep one"
            );
        }
    }

    #[test]
    fn placeholder_locales_may_fall_back_to_english() {
        // 显式记录「有意不覆盖」，与上面的断言配对，
        // 以免日后误以为漏了这三种语言
        for lang in PLACEHOLDER_LOCALES {
            assert!(
                menu_for(lang).is_none(),
                "{lang} is a 2-key placeholder locale and is intentionally English in the tray"
            );
        }
    }

    #[test]
    fn pt_pt_is_distinct_from_pt_br() {
        // pt_PT 与 pt_BR 在语言选择器里是两个独立条目，不能共用一个分支
        assert!(menu_for("pt_pt").is_some());
        assert!(menu_for("pt_br").is_some());
        assert_ne!(menu_for("pt_pt"), menu_for("pt_br"));
    }

    #[test]
    fn unknown_languages_fall_back_to_english() {
        assert!(menu_for("klingon").is_none());
        assert!(menu_for("").is_none());
    }

    // ---- 菜单项完整性：每个语言菜单必须含**同一套**菜单项 ----
    //
    // 动机：17 个 tray_menu_xx() 各自手写（每个 13 个 CustomMenuItem），
    // 少写一个 `.add_item(...)` 不会编译报错，只是那个语言下**菜单里没有这一项**。
    // 既有测试只覆盖「某语言有没有专属菜单」，覆盖不到「菜单里少了一项」——
    // 实测确认：从 fr 菜单删掉 `add_item(clipboard_monitor)` 后，全部测试仍然通过。
    //
    // 做法：**真的把菜单建出来**，再解析它的 Debug 输出取 id_str / title，
    // 而不是断言源码文本——后者只能证明「写了这行」，证明不了「真的加进去了」。
    // （tauri 只 re-export 了 SystemTrayMenu，没导出 SystemTrayMenuEntry，
    //   因此无法直接 match 枚举；Debug 是这些字段唯一的公开出口。）
    fn tray_menu_of(language: &str) -> tauri::SystemTrayMenu {
        match language {
            "en" => tray_menu_en(),
            "zh_cn" => tray_menu_zh_cn(),
            "zh_tw" => tray_menu_zh_tw(),
            "ja" => tray_menu_ja(),
            "ko" => tray_menu_ko(),
            "fr" => tray_menu_fr(),
            "de" => tray_menu_de(),
            "ru" => tray_menu_ru(),
            "pt_br" => tray_menu_pt_br(),
            "pt_pt" => tray_menu_pt_pt(),
            "es" => tray_menu_es(),
            "it" => tray_menu_it(),
            "ar" => tray_menu_ar(),
            "he" => tray_menu_he(),
            "ta" => tray_menu_ta(),
            "fa" => tray_menu_fa(),
            "uk" => tray_menu_uk(),
            other => panic!("no tray menu builder wired for '{other}'"),
        }
    }

    const ALL_TRAY_MENUS: &[&str] = &[
        "en", "zh_cn", "zh_tw", "ja", "ko", "fr", "de", "ru", "pt_br", "pt_pt", "es", "it", "ar", "he", "ta", "fa",
        "uk",
    ];

    /// 从 Debug 输出里抽取所有 `id_str: "xxx"`（含子菜单内的项）。
    fn ids_in(menu: &tauri::SystemTrayMenu) -> Vec<String> {
        let debug = format!("{menu:?}");
        debug
            .split("id_str: \"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .map(|id| id.to_string())
            .collect()
    }

    /// 从 Debug 输出里抽取所有 `title: "xxx"`。
    fn titles_in(menu: &tauri::SystemTrayMenu) -> Vec<String> {
        let debug = format!("{menu:?}");
        debug
            .split("title: \"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .map(|t| t.to_string())
            .collect()
    }

    #[test]
    fn every_language_menu_carries_the_same_items() {
        let base = ids_in(&tray_menu_of("en"));
        // 13 个菜单项（含 Auto Copy 子菜单里的 4 个）
        assert_eq!(base.len(), 13, "the English tray menu should have 13 items, got {base:?}");

        for language in ALL_TRAY_MENUS {
            let ids = ids_in(&tray_menu_of(language));
            let missing: Vec<_> = base.iter().filter(|id| !ids.contains(id)).collect();
            assert!(
                missing.is_empty(),
                "the '{language}' tray menu is missing these items: {missing:?} (has {ids:?})"
            );
            assert_eq!(
                ids.len(),
                base.len(),
                "the '{language}' tray menu has a different item count: {ids:?} vs en {base:?}"
            );
        }
    }

    #[test]
    fn every_menu_item_id_has_a_handler_and_vice_versa() {
        // 菜单项 id 与 tray_event_handler 的 match 分支一一对应：
        // 有菜单项没分支 -> 点了没反应；有分支没菜单项 -> 死代码。
        // 两边都是手写字符串，编译器不会帮忙。
        const HANDLED: &[&str] = &[
            "input_translate",
            "copy_source",
            "copy_target",
            "copy_source_target",
            "copy_disable",
            "clipboard_monitor",
            "ocr_recognize",
            "ocr_translate",
            "config",
            "check_update",
            "view_log",
            "restart",
            "quit",
        ];

        let built = ids_in(&tray_menu_of("en"));
        let unhandled: Vec<_> = built.iter().filter(|id| !HANDLED.contains(&id.as_str())).collect();
        assert!(
            unhandled.is_empty(),
            "these tray items have no handler in tray_event_handler: {unhandled:?}"
        );

        let orphaned: Vec<_> = HANDLED
            .iter()
            .filter(|id| !built.iter().any(|b| b == *id))
            .collect();
        assert!(
            orphaned.is_empty(),
            "these handlers exist but no menu item uses their id: {orphaned:?}"
        );
    }

    #[test]
    fn every_menu_item_has_a_non_empty_title() {
        // 空标题会在菜单里显示成一个无法辨认的空行
        for language in ALL_TRAY_MENUS {
            let menu = tray_menu_of(language);
            let titles = titles_in(&menu);
            assert!(!titles.is_empty(), "the '{language}' tray menu has no visible titles");
            let empty: Vec<_> = titles.iter().filter(|t| t.trim().is_empty()).collect();
            assert!(empty.is_empty(), "the '{language}' tray menu has empty titles: {empty:?}");
        }
    }

    #[test]
    fn the_copy_submenu_title_is_localized_per_language() {
        // Auto Copy 子菜单的标题是**逐语言本地化**的（17 个语言各不相同），
        // 不要在测试里写死 "Auto Copy"——那会把「本来正确的本地化」判成失败。
        //
        // 定位方式：子菜单在 Debug 输出里出现在**它被 add_submenu 的位置**，
        // 即第 3 项（index 2，前两项是 input_translate / clipboard_monitor）。
        // 最初这里用了 `titles.last()`，结果取到的是 "Quit"，断言形同虚设
        // ——变异测试（把 de 的子菜单标题换成英文）没有失败，才发现取错了位置。
        for language in ALL_TRAY_MENUS {
            let titles = titles_in(&tray_menu_of(language));
            let submenu = titles
                .get(2)
                .unwrap_or_else(|| panic!("the '{language}' menu has too few titles: {titles:?}"));
            assert!(
                !submenu.trim().is_empty(),
                "the '{language}' copy submenu title must not be empty"
            );
            if *language != "en" {
                assert_ne!(
                    submenu, "Auto Copy",
                    "the '{language}' copy submenu still uses the hardcoded English title"
                );
            }
        }

        // 英文基准必须是 "Auto Copy"，否则上面那条 `!=` 就失去了参照
        assert_eq!(
            titles_in(&tray_menu_of("en")).get(2).map(String::as_str),
            Some("Auto Copy")
        );
    }
}

fn tray_menu_he() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "תרגם טקסט");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "ניטור לוח ההעתקה");
    let copy_source = CustomMenuItem::new("copy_source", "מקור");
    let copy_target = CustomMenuItem::new("copy_target", "יעד");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "מקור+יעד");
    let copy_disable = CustomMenuItem::new("copy_disable", "השבת");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "זהה טקסט");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "תרגם צילום מסך");
    let config = CustomMenuItem::new("config", "הגדרות כלליות");
    let check_update = CustomMenuItem::new("check_update", "בדוק עדכונים");
    let view_log = CustomMenuItem::new("view_log", "הצג יומן רישום");
    let restart = CustomMenuItem::new("restart", "הפעל מחדש את היישום");
    let quit = CustomMenuItem::new("quit", "יציאה");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "העתקה אוטומטית",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}

fn tray_menu_ta() -> tauri::SystemTrayMenu {
    let input_translate = CustomMenuItem::new("input_translate", "உரை மொழிபெயர்ப்பு");
    let clipboard_monitor = CustomMenuItem::new("clipboard_monitor", "இடைநிலை நினைவகத்தைக் கண்காணி");
    let copy_source = CustomMenuItem::new("copy_source", "மூலம்");
    let copy_target = CustomMenuItem::new("copy_target", "இலக்கு");
    let copy_source_target = CustomMenuItem::new("copy_source_target", "மூலம்+இலக்கு");
    let copy_disable = CustomMenuItem::new("copy_disable", "முடக்கு");
    let ocr_recognize = CustomMenuItem::new("ocr_recognize", "உரை ஏற்பு");
    let ocr_translate = CustomMenuItem::new("ocr_translate", "திரைக்காட்சி மொழிபெயர்ப்பு");
    let config = CustomMenuItem::new("config", "பொது அமைப்புகள்");
    let check_update = CustomMenuItem::new("check_update", "புதுப்பிப்பைச் சரிபார்க்கவும்");
    let view_log = CustomMenuItem::new("view_log", "பதிவைக் காண்க");
    let restart = CustomMenuItem::new("restart", "பயன்பாட்டை மறுதொடக்கம் செய்");
    let quit = CustomMenuItem::new("quit", "வெளியேறு");
    SystemTrayMenu::new()
        .add_item(input_translate)
        .add_item(clipboard_monitor)
        .add_submenu(SystemTraySubmenu::new(
            "தானியங்கி நகல்",
            SystemTrayMenu::new()
                .add_item(copy_source)
                .add_item(copy_target)
                .add_item(copy_source_target)
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(copy_disable),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(ocr_recognize)
        .add_item(ocr_translate)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(config)
        .add_item(check_update)
        .add_item(view_log)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(restart)
        .add_item(quit)
}
