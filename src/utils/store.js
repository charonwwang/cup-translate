import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    // 外部改动配置文件时把内容读回内存，并通知 Rust 侧重载。
    //
    // 去抖由 fs-watch 插件自身完成：它的 `watch()` 默认 delayMs=2000，
    // 会先在插件层把连续事件收敛成一次回调。这里**不再**自己套一层定时器——
    // 原实现额外套了 100ms，注释因此写成「100ms 去抖」，
    // 而真实生效的窗口是插件的 2000ms，两者相差 20 倍，注释与行为不符，
    // 也让排查「改了配置为何没立刻同步」的人找错方向。
    // 显式写出 delayMs，避免依赖插件默认值（上游改默认值时行为会静默变化）。
    const _ = await watch(
        appConfigPath,
        async () => {
            try {
                await store.load();
                await invoke('reload_store');
            } catch (e) {
                console.error('[store] reload failed:', e);
            }
        },
        { delayMs: 100 }
    );
}
