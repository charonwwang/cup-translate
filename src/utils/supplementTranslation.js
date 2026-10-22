// Optional details have their own deadline and never turn a successful translation into an error.
export async function supplementTranslation(provider, result, from, to, options, publish) {
    if (!provider.supplement || options.signal?.aborted || !result) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
        const value = await provider.supplement(result, from, to, {
            ...options,
            signal: controller.signal,
            setResult: (value) => {
                if (!controller.signal.aborted) publish(value);
            },
        });
        if (!controller.signal.aborted) publish(value);
    } catch {
        // Keep the original examples and main meanings when enrichment fails.
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
}
