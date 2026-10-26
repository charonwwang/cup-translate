import { commitServiceSettings } from './serviceConfigCommit.js';
// Qwen has one global configuration and shared model resources, including legacy @ keys.
export const isQwenKey = (key) => key === 'qwen_tts' || key?.startsWith('qwen_tts@');
export const canonicalQwenKey = (key) => (isQwenKey(key) ? 'qwen_tts' : key);
export function canonicalQwenList(list = []) {
    let seen = false;
    return list.flatMap((key) => {
        if (!isQwenKey(key)) return [key];
        if (seen) return [];
        seen = true;
        return ['qwen_tts'];
    });
}

export async function migrateQwenSettings(store, emit) {
    const list = await store.get('tts_service_list');
    if (!Array.isArray(list)) return;
    const next = canonicalQwenList(list);
    if (JSON.stringify(next) !== JSON.stringify(list)) {
        await commitServiceSettings(store, emit, { tts_service_list: next });
    }
    // Keep legacy config/history keys and all model files. TTS already resolves
    // legacy references by service name and reads the global qwen_tts object.
}
export async function saveQwenSettings(store, emit, draft, { register = false, enable = false } = {}) {
    const changes = { qwen_tts: { ...draft, configured: true } };
    if (register || enable) {
        const list = canonicalQwenList((await store.get('tts_service_list')) || ['google_tts']);
        changes.tts_service_list = list.includes('qwen_tts') ? list : [...list, 'qwen_tts'];
    }
    if (enable) changes.speech_policy = 'qwen';
    await commitServiceSettings(store, emit, changes);
}
