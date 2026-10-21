import { sealConfig, supportedSecretService } from './credentials';
import { invalidateRequests } from './requestRuntime';
import { emit, listen } from '@tauri-apps/api/event';
import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();
const affectsRequest = (key, value) =>
    key === 'privacy_mode' ||
    key === 'glossary_v2' ||
    key.endsWith('_service_list') ||
    key.includes('@') ||
    (value && typeof value === 'object' && !Array.isArray(value));
const requestFingerprint = async () =>
    JSON.stringify(
        (await store.entries())
            .filter(([key, value]) => affectsRequest(key, value))
            .sort(([a], [b]) => a.localeCompare(b))
    );

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    try {
        await store.load();
    } catch {
        /* new installation */
    }
    store.save = async () => {
        await invoke('save_config_atomic', { settings: Object.fromEntries(await store.entries()) });
    };
    await listen('request_context_invalidated', () => invalidateRequests());
    const originalSet = store.set.bind(store);
    store.set = async (key, value) => {
        const safe = await sealConfig(key, value);
        await originalSet(key, safe);
        if (affectsRequest(key, value)) {
            invalidateRequests();
            await emit('request_context_invalidated', { key });
        }
    };
    // Stage all supported schemas before one atomic commit; failures retain disk originals.
    const pending = [];
    for (const [key, value] of await store.entries()) {
        if (!supportedSecretService(key)) continue;
        try {
            const safe = await sealConfig(key, value);
            if (JSON.stringify(safe) !== JSON.stringify(value)) pending.push({ key, value, safe });
        } catch {
            console.warn('Credential migration pending; rebind in Settings');
        }
    }
    if (pending.length) {
        try {
            for (const item of pending) await originalSet(item.key, item.safe);
            await store.save();
        } catch {
            for (const item of pending) await originalSet(item.key, item.value);
            console.warn('Credential migration not committed; original configuration retained');
        }
    }
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
                const previous = await requestFingerprint();
                await store.load();
                if (previous !== (await requestFingerprint())) {
                    invalidateRequests();
                    await emit('request_context_invalidated', {});
                }
                await invoke('reload_store');
            } catch (e) {
                console.error('[store] reload failed:', e);
            }
        },
        { delayMs: 100 }
    );
}
