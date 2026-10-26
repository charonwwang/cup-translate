// Suppress concurrent clicks for a destination while its request is in flight.
export function createCollectionGate() {
    const pending = new Set();
    return {
        has: (key) => pending.has(key),
        async run(key, operation) {
            if (pending.has(key)) return;
            pending.add(key);
            try {
                return await operation();
            } finally {
                pending.delete(key);
            }
        },
    };
}
