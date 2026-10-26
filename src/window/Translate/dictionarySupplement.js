// Optional dictionary work owns only metadata, never the successful translation.
export function hasDictionaryDetails(value) {
    return Boolean(
        value &&
            typeof value === 'object' &&
            (value.pronunciations?.some((item) => item.symbol || item.voice) ||
                value.sentence?.some((item) => item.source || item.target) ||
                value.explanations?.some((item) => item.trait && item.explains?.length))
    );
}

export function createDictionarySupplement({ publish, timeoutMs = 15000 }) {
    let current;
    const cancel = () => {
        current?.abort();
        current = null;
    };
    return {
        cancel,
        async run({ key, privacyMode, checkPolicy, lookup, enrich }) {
            cancel();
            if (privacyMode === 'device_only') {
                publish({ key, status: 'blocked', value: null });
                return;
            }
            const controller = new AbortController();
            current = controller;
            const { signal } = controller;
            const active = () => current === controller && !signal.aborted;
            let value = null;
            publish({ key, status: 'loading', value });
            const timer = setTimeout(() => {
                if (active()) publish({ key, status: 'timeout', value });
                controller.abort();
            }, timeoutMs);
            const commit = (next) => {
                if (!active()) return;
                if (hasDictionaryDetails(next)) value = next;
            };
            try {
                await checkPolicy();
                if (!active()) return;
                const initial = await lookup(signal);
                commit(initial);
                if (!active()) return;
                if (enrich) commit(await enrich(initial, signal, commit));
                if (active()) publish({ key, status: value ? 'ready' : 'empty', value });
            } catch {
                if (active()) publish({ key, status: 'failed', value });
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

// Existing pronunciation.voice is byte audio in built-in dictionaries. URLs are
// not byte audio and must never be handed to the player or fetched implicitly.
export function dictionaryAudioBytes(voice, privacyMode) {
    if (privacyMode === 'device_only') return null;
    return Array.isArray(voice) || ArrayBuffer.isView(voice) ? voice : null;
}
