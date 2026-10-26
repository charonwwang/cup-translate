// One controller per mounted editor. Every edit invalidates pending test results immediately.
export function createCollectionDraft(initial, { testConnection, persist, onChange }) {
    let config = structuredClone(initial);
    let saved = JSON.stringify(config);
    let revision = 0;
    let active = true;
    let saving = false;
    let status = 'untested';
    const publish = (next, error = null) => {
        status = next;
        if (active) onChange({ config, status, error, saving, dirty: JSON.stringify(config) !== saved });
    };
    return {
        change(field, value) {
            if (saving) return;
            revision++;
            config = { ...config, [field]: value };
            if (field === 'apiKey' || field === 'token') {
                config.secretRefs = { ...config.secretRefs };
                delete config.secretRefs[field];
            }
            publish('untested');
        },
        async test() {
            const generation = ++revision;
            const snapshot = structuredClone(config);
            publish('checking');
            try {
                await testConnection(snapshot);
                if (active && revision === generation) publish('connected');
            } catch (error) {
                if (active && revision === generation) publish('failed', error);
            }
        },
        async save() {
            if (saving) return false;
            saving = true;
            const connected = status === 'connected' || status === 'saved_connected';
            revision++;
            publish('saving');
            try {
                await persist(structuredClone(config));
                saved = JSON.stringify(config);
                saving = false;
                publish(connected ? 'saved_connected' : 'saved_offline');
                return true;
            } catch {
                saving = false;
                publish('save_failed');
                return false;
            }
        },
        dispose() {
            active = false;
            revision++;
        },
    };
}

// Store.save is the existing atomic disk commit. Roll back staged memory on failure.
export async function persistCollectionConfig(store, key, draft) {
    const previous = await store.get(key);
    const list = (await store.get('collection_service_list')) ?? [];
    const next = list.includes(key) ? list : [...list, key];
    try {
        await store.set(key, draft);
        await store.set('collection_service_list', next);
        await store.save();
    } catch (error) {
        if (previous == null) await store.delete(key);
        else await store.set(key, previous);
        await store.set('collection_service_list', list);
        throw error;
    }
    return next;
}
