// Bounded, in-memory only. Failed requests are never cached; concurrent identical
// requests share one promise. No timers or persistent history are created here.
export function createRequestCache({ capacity = 32, ttl = 120_000, now = Date.now } = {}) {
    const values = new Map();
    const pending = new Map();
    return async (key, request) => {
        if (key.length > 20_000) return request();
        const hit = values.get(key);
        if (hit && hit.expires > now()) {
            values.delete(key);
            values.set(key, hit);
            return hit.value;
        }
        values.delete(key);
        if (pending.has(key)) return pending.get(key);
        const promise = Promise.resolve()
            .then(request)
            .then((value) => {
                if (JSON.stringify(value)?.length <= 65_536) {
                    values.set(key, { value, expires: now() + ttl });
                    while (values.size > capacity) values.delete(values.keys().next().value);
                }
                return value;
            })
            .finally(() => pending.get(key) === promise && pending.delete(key));
        // Bound bookkeeping even under a burst of distinct queries.
        if (pending.size < capacity) pending.set(key, promise);
        return promise;
    };
}
