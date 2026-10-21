// Bounded, in-memory only. Failed requests are never cached; concurrent identical
// requests with the same cancellation owner share one promise. No timers or persistent history are created here.
export function createRequestCache({ capacity = 32, ttl = 120_000, now = Date.now } = {}) {
    const values = new Map();
    const pending = new Map();
    return async (key, request, signal) => {
        if (key.length > 20_000) return request();
        const hit = values.get(key);
        if (hit && hit.expires > now()) {
            values.delete(key);
            values.set(key, hit);
            return hit.value;
        }
        values.delete(key);
        const existing = pending.get(key);
        if (existing && existing.signal === signal && !signal?.aborted) return existing.promise;
        const promise = Promise.resolve()
            .then(request)
            .then((value) => {
                if (signal?.aborted) throw new DOMException('Request expired', 'AbortError');
                if (JSON.stringify(value)?.length <= 65_536) {
                    values.set(key, { value, expires: now() + ttl });
                    while (values.size > capacity) values.delete(values.keys().next().value);
                }
                return value;
            })
            .finally(() => pending.get(key)?.promise === promise && pending.delete(key));
        // Bound bookkeeping even under a burst of distinct queries.
        if (pending.size < capacity || pending.has(key)) pending.set(key, { promise, signal });
        return promise;
    };
}
