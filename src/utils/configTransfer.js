const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const sensitive = /password|secret|token|api[_-]?key|credential|authorization|cookie|access[_-]?key|^(key|ak|sk)$/i;
function validate(value, depth = 0) {
    if (depth > 12) throw new Error('Configuration is nested too deeply');
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
    if (Array.isArray(value)) {
        value.forEach((item) => validate(item, depth + 1));
        return;
    }
    if (!value || typeof value !== 'object') throw new Error('Invalid configuration value');
    for (const [key, item] of Object.entries(value)) {
        if (forbidden.has(key)) throw new Error('Invalid configuration key');
        validate(item, depth + 1);
    }
}
export function parseConfigTransfer(text) {
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Configuration exceeds 2 MB');
    const data = JSON.parse(text);
    if (
        data?.format !== 'cup-translate-settings' ||
        data.version !== 1 ||
        !data.settings ||
        Array.isArray(data.settings) ||
        typeof data.settings !== 'object'
    )
        throw new Error('Unsupported settings file');
    validate(data.settings);
    const entries = Object.entries(data.settings);
    if (!entries.length || entries.length > 2000) throw new Error('Invalid settings count');
    for (const [key, value] of entries) {
        if (!/^[\w.@:-]+$/.test(key)) throw new Error('Invalid settings key');
        if (key.endsWith('_service_list') && (!Array.isArray(value) || value.some((item) => typeof item !== 'string')))
            throw new Error('Invalid service list');
        if (key.startsWith('hotkey_') && typeof value !== 'string') throw new Error('Invalid shortcut');
        if (
            ['server_port', 'proxy_port'].includes(key) &&
            !(key === 'proxy_port' && value === '') &&
            (!['number', 'string'].includes(typeof value) ||
                !/^\d+$/.test(String(value)) ||
                Number(value) < 1 ||
                Number(value) > 65535)
        )
            throw new Error('Invalid port');
    }
    if (Object.hasOwn(data.settings, 'app_font_size')) {
        const size = Number(data.settings.app_font_size);
        if (!Number.isFinite(size) || size < 6 || size > 72) throw new Error('Invalid font size');
        data.settings.app_font_size = size;
    }
    return data.settings;
}
export function createConfigTransfer(settings) {
    const clean = (value) =>
        Array.isArray(value)
            ? value.map(clean)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                    Object.entries(value)
                        .filter(
                            ([key]) =>
                                !forbidden.has(key) &&
                                !sensitive.test(key) &&
                                key !== 'headers' &&
                                !key.startsWith('plugin')
                        )
                        .map(([key, item]) => [key, clean(item)])
                )
              : value;
    return JSON.stringify(
        {
            format: 'cup-translate-settings',
            version: 1,
            exportedAt: new Date().toISOString(),
            settings: clean(settings),
        },
        null,
        2
    );
}
function mergeSettings(current, imported) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(imported)) {
        if (
            !(
                ['server_port', 'proxy_port', 'app_font_size'].includes(key) &&
                ['string', 'number'].includes(typeof value)
            ) &&
            current[key] !== undefined &&
            current[key] !== null &&
            value !== null &&
            (Array.isArray(current[key]) !== Array.isArray(value) || typeof current[key] !== typeof value)
        )
            throw new Error(`Setting type mismatch: ${key}`);
        merged[key] =
            value && !Array.isArray(value) && typeof value === 'object'
                ? mergeSettings(current[key] || {}, value)
                : value;
    }
    return merged;
}
// Save once, restore the in-memory snapshot if a write/save fails.
export async function applyConfigTransfer(store, imported) {
    const previous = Object.fromEntries(await store.entries());
    const merged = mergeSettings(previous, imported);
    try {
        for (const key of Object.keys(imported)) await store.set(key, merged[key]);
        await store.save();
    } catch (error) {
        for (const key of Object.keys(imported)) {
            if (Object.hasOwn(previous, key)) await store.set(key, previous[key]);
            else await store.delete(key);
        }
        await store.save();
        throw error;
    }
}
