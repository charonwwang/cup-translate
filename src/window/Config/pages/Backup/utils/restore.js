import { invoke } from '@tauri-apps/api';
import { relaunch } from '@tauri-apps/api/process';

// A restored backup changes native state too (shortcuts, tray, plugins and the
// history database). Reloading just the settings window is not sufficient.
export async function finishRestore() {
    await invoke('reload_store');
    await relaunch();
}
