import { checkPolicy } from './requestRuntime';
// Tauri HTTP fetch 的默认超时包装：
// @tauri-apps/api/http 的 fetch 不会自动超时，网络卡死/服务端挂起时
// 请求会无限等待，UI 永久卡在 loading。这里统一加 30 秒默认超时。
import { fetch as tauriFetch } from '@tauri-apps/api/http';

export const DEFAULT_TIMEOUT_SECONDS = 30;

export async function fetchWithTimeout(url, options = {}) {
    await checkPolicy('http', 'external');
    return tauriFetch(url, {
        timeout: DEFAULT_TIMEOUT_SECONDS,
        ...options,
    });
}

export { Body, ResponseType } from '@tauri-apps/api/http';
