import { invoke } from '@tauri-apps/api/tauri';
export const supportedSecretService = (key) => ['openai', 'ollama', 'anki', 'eudic'].includes(key.split('@')[0]);
export async function sealConfig(key, config) {
    return supportedSecretService(key) ? invoke('seal_service_config', { key, config }) : config;
}
export async function resolveSecrets(config) {
    const copy = structuredClone(config);
    for (const [field, ref] of Object.entries(copy.secretRefs ?? {})) {
        if (!field.startsWith('headers.') && typeof copy[field] === 'string' && copy[field]) continue;
        const value = await invoke('read_service_secret', { reference: ref });
        if (field.startsWith('headers.')) {
            copy.headers ??= {};
            copy.headers[field.slice(8)] = value;
        } else copy[field] = value;
    }
    return copy;
}
