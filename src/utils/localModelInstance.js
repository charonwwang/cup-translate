// Model selection is per service instance. Missing model preserves legacy OPUS configs.
export async function findLocalInstance(store, model) {
    const list = (await store.get('translate_service_list')) ?? ['google'];
    for (const key of list.filter((key) => key.split('@')[0] === 'local_mt')) {
        const config = await store.get(key);
        if ((config?.model ?? 'opus') === model) return { key, list, config };
    }
    return { list };
}
