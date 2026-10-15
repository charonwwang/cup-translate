use crate::window::text_translate;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{ClipboardManager, Manager};

pub struct ClipboardMonitorEnableWrapper(pub Mutex<String>);

/// 是否已有一个轮询线程在跑。
///
/// `start_clipboard_monitor` 以前是「调用即起线程」，而托盘开关每次打开都会调用它。
/// 但轮询线程是 500ms 间隔才观察一次 `clipboard_monitor` 标志，
/// 因此「关掉再立刻打开」存在竞态窗口：
///   T2 还没看到 false 退出，T3 已经被启动 → 两个线程同时轮询，
///   剪贴板一变就翻译两次（弹两次窗 / 发两次请求）。
/// 用这个标志把「同时只允许一个轮询线程」变成硬约束。
static MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn start_clipboard_monitor(app_handle: tauri::AppHandle) {
    // 已有线程在跑就不再起第二个；该线程会在看到开关为 false 时自行退出。
    // compare_exchange 保证并发调用下也只有一个能拿到「启动权」。
    if MONITOR_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        log::info!("Clipboard monitor already running, not starting another thread");
        return;
    }

    // 这是 500ms 轮询的阻塞型循环，用普通线程而非 async 任务：
    // async 任务里调用 std::thread::sleep 会阻塞 tokio 工作线程，
    // 多次开关剪贴板监控会耗尽 async runtime 线程池。
    std::thread::spawn(move || {
        // 用 None 表示「尚未建立基线」：开启监控时不应把剪贴板里已有的旧内容
        // 当成一次新复制去翻译（此前 pre_text 初始化为 ""，导致一开开关就弹窗
        // 翻译剪贴板里的旧文本）。第一次成功读取只用来建立基线。
        let mut pre_text: Option<String> = None;
        loop {
            let handle = app_handle.app_handle();
            let state = handle.state::<ClipboardMonitorEnableWrapper>();
            if let Ok(clipboard_monitor) = state.0.try_lock() {
                if clipboard_monitor.contains("true") {
                    if let Ok(Some(v)) = app_handle.clipboard_manager().read_text() {
                        match &pre_text {
                            // 仅当内容相对上次基线发生变化时才翻译
                            Some(previous) if *previous == v => {}
                            Some(_) => {
                                text_translate(v.clone());
                                pre_text = Some(v);
                            }
                            // 首次读取：只建立基线，不翻译
                            None => pre_text = Some(v),
                        }
                    }
                } else {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        // 线程退出时释放启动权，允许下次开关重新拉起
        MONITOR_RUNNING.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::MONITOR_RUNNING;
    use std::sync::atomic::Ordering;

    #[test]
    fn monitor_flag_only_admits_one_runner_at_a_time() {
        // 模拟「关掉再立刻打开」的竞态：第二次启动必须被拒绝，
        // 否则会有两个线程同时轮询、重复翻译。
        MONITOR_RUNNING.store(false, Ordering::Release);
        assert!(MONITOR_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok());
        assert!(
            MONITOR_RUNNING
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err(),
            "a second monitor thread must not be admitted while one is running"
        );
        // 线程退出后重新允许启动
        MONITOR_RUNNING.store(false, Ordering::Release);
        assert!(MONITOR_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok());
        MONITOR_RUNNING.store(false, Ordering::Release);
    }
}