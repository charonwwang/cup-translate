import { validPluginName, validPluginType } from './plugin_validation.js';
const eventName = (key) => `${key.replaceAll('.', '_').replaceAll('@', ':')}_changed`;

export async function savePluginInstance({ store, emit, kind, key, config }) {
    if (!validPluginType(kind) || !validPluginName(key.split('@')[0])) throw new Error('Invalid plugin instance');
    const listKey = `${kind}_service_list`;
    const previous = (await store.get(listKey)) ?? [];
    const oldConfig = await store.get(key);
    const list = previous.includes(key) ? previous : [...previous, key];
    try {
        await store.set(key, config);
        await store.set(listKey, list);
        await store.save();
    } catch (error) {
        if (oldConfig == null) await store.delete(key);
        else await store.set(key, oldConfig);
        await store.set(listKey, previous);
        throw error;
    }
    await emit(eventName(listKey), list);
    await emit(eventName(key), await store.get(key));
}

export async function uninstallPlugin({ store, emit, removePackage, kind, name }) {
    if (!validPluginType(kind) || !validPluginName(name)) throw new Error('Invalid plugin path');
    const listKey = `${kind}_service_list`;
    const previous = (await store.get(listKey)) ?? [];
    const removed = previous.filter((key) => key.split('@')[0] === name);
    const list = previous.filter((key) => key.split('@')[0] !== name);
    if (removed.length && kind !== 'collection' && list.length === 0) throw new Error('PLUGIN_LAST_SERVICE');
    try {
        await store.set(listKey, list);
        await store.save();
    } catch (error) {
        await store.set(listKey, previous);
        throw error;
    }
    try {
        await removePackage();
    } catch (error) {
        await store.set(listKey, previous);
        await store.save();
        throw error;
    }
    // Broadcast the persisted list even if orphaned configuration cleanup fails.
    await emit(eventName(listKey), list);
    for (const key of removed) await store.delete(key);
    await store.save();
    await emit('reload_plugin_list');
}

// Compile without executing third-party top-level code. Callable binding is checked at load.
export async function installPlugins({ invoke, paths }) {
    const results = [];
    for (const path of paths) {
        try {
            const { script, digest } = await invoke('inspect_plugin_entry', { path });
            new Function(script);
            const [result] = await invoke('install_plugin', { pathList: [path], entryChecks: { [path]: digest } });
            results.push(result);
        } catch (error) {
            results.push({ path, success: false, error: String(error) });
        }
    }
    return results;
}
