import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    // 文件变更去抖：拖动滑块等连续写入会触发大量 watch 事件，
    // 每次都 load() + reload_store() 会造成 thundering herd
    let reloadTimer = null;
    const _ = await watch(appConfigPath, async () => {
        if (reloadTimer) {
            clearTimeout(reloadTimer);
        }
        reloadTimer = setTimeout(async () => {
            reloadTimer = null;
            try {
                await store.load();
                await invoke('reload_store');
            } catch (e) {
                console.error('[store] reload failed:', e);
            }
        }, 100);
    });
}
