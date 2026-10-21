use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct Cancellation {
    cancelled: AtomicBool,
    changed: Notify,
}

impl Cancellation {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("Local translation cancelled".into())
        } else {
            Ok(())
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_one();
    }

    pub(crate) async fn cancelled(&self) {
        if self.check().is_err() {
            return;
        }
        self.changed.notified().await;
    }
}

struct Entry {
    cancellation: Arc<Cancellation>,
    created: Instant,
    claimed: bool,
}

fn tasks() -> &'static Mutex<HashMap<String, Entry>> {
    static TASKS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Registration is a separate handshake: cancellation cannot overtake registration
// and accidentally allow an already obsolete IPC invocation to start work.
#[tauri::command]
pub fn local_mt_prepare_request() -> Result<String, String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let mut tasks = tasks()
        .lock()
        .map_err(|_| "Translation task registry unavailable")?;
    tasks.retain(|_, entry| entry.claimed || entry.created.elapsed() < Duration::from_secs(120));
    if tasks.len() >= 64 {
        return Err("Too many local translation requests".into());
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    tasks.insert(
        id.clone(),
        Entry {
            cancellation: Arc::new(Cancellation::default()),
            created: Instant::now(),
            claimed: false,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn local_mt_cancel_request(request_id: String) -> Result<(), String> {
    if let Some(entry) = tasks()
        .lock()
        .map_err(|_| "Translation task registry unavailable")?
        .remove(&request_id)
    {
        entry.cancellation.cancel();
    }
    Ok(())
}

pub(crate) struct Request {
    id: String,
    pub(crate) cancellation: Arc<Cancellation>,
}

impl Request {
    pub(crate) fn claim(id: Option<String>) -> Result<Self, String> {
        // Legacy callers also use bounded admission and release their entry on drop.
        let id = match id {
            Some(id) => id,
            None => local_mt_prepare_request()?,
        };
        let mut tasks = tasks()
            .lock()
            .map_err(|_| "Translation task registry unavailable")?;
        let entry = tasks
            .get_mut(&id)
            .ok_or("Local translation cancelled or expired")?;
        if entry.claimed {
            return Err("Local translation request already started".into());
        }
        entry.claimed = true;
        let cancellation = Arc::clone(&entry.cancellation);
        Ok(Self { id, cancellation })
    }
}

pub(crate) async fn acquire<'a>(
    gate: &'a tokio::sync::Mutex<()>,
    cancellation: &Cancellation,
) -> Result<tokio::sync::MutexGuard<'a, ()>, String> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("Local translation cancelled".into()),
        permit = gate.lock() => {
            cancellation.check()?;
            Ok(permit)
        },
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        let _ = local_mt_cancel_request(self.id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_dispatch_prevents_claim() {
        let id = local_mt_prepare_request().unwrap();
        local_mt_cancel_request(id.clone()).unwrap();
        assert!(Request::claim(Some(id)).is_err());
    }

    #[test]
    fn running_task_observes_cancellation_and_cannot_be_claimed_twice() {
        let id = local_mt_prepare_request().unwrap();
        let request = Request::claim(Some(id.clone())).unwrap();
        assert!(Request::claim(Some(id.clone())).is_err());
        assert!(request.cancellation.check().is_ok());
        local_mt_cancel_request(id).unwrap();
        assert!(request.cancellation.check().is_err());
    }

    #[tokio::test]
    async fn cancellation_wakes_a_queued_task_without_waiting_for_inference() {
        let gate = tokio::sync::Mutex::new(());
        let _running = gate.lock().await;
        let id = local_mt_prepare_request().unwrap();
        let request = Request::claim(Some(id.clone())).unwrap();
        let wait = acquire(&gate, &request.cancellation);
        let cancel = async {
            tokio::task::yield_now().await;
            local_mt_cancel_request(id).unwrap();
        };
        let (result, _) = tokio::time::timeout(Duration::from_millis(100), async {
            tokio::join!(wait, cancel)
        })
        .await
        .unwrap();
        assert!(result.is_err());
        // The cancelled queue entry cannot block the next selection.
        drop(request);
        drop(_running);
        let fresh = Request::claim(None).unwrap();
        assert!(acquire(&gate, &fresh.cancellation).await.is_ok());
    }

    #[test]
    fn completed_request_releases_registration() {
        let id = local_mt_prepare_request().unwrap();
        drop(Request::claim(Some(id.clone())).unwrap());
        assert!(Request::claim(Some(id)).is_err());
    }
}
