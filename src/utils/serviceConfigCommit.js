// Stage related settings together, commit once, then notify consumers. A failed disk
// write restores the in-memory originals too; no list/config success event is sent.
export async function commitServiceSettings(store, emit, changes) {
    const previous = await Promise.all(Object.keys(changes).map(async (key) => [key, await store.get(key)]));
    try {
        for (const [key, value] of Object.entries(changes)) await store.set(key, value);
        await store.save();
    } catch (error) {
        for (const [key, value] of previous) {
            if (value == null) await store.delete(key);
            else await store.set(key, value);
        }
        throw error;
    }
    // Notification failure cannot undo a successful disk commit.
    for (const [key, value] of Object.entries(changes)) {
        try {
            await emit(`${key.replaceAll('.', '_').replaceAll('@', ':')}_changed`, await store.get(key));
        } catch {
            /* refreshed on reopen */
        }
    }
}
