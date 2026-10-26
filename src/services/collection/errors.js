// Never expose remote bodies, request contents, or credentials in UI/logs.
export class CollectionError extends Error {
    constructor(code) {
        super(code);
        this.name = 'CollectionError';
        this.code = code;
    }
}

export async function withDeadline(operation, timeoutMs, code) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new CollectionError(code)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
