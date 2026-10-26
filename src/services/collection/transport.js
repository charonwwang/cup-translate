// Read text first so malformed JSON is a protocol failure, not a transport failure.
// Dependencies are injected to exercise the exact Tauri request/response mapping with local HTTP.
export function createCollectionTransport(fetchRequest, Body, ResponseType) {
    return async (url, options) => {
        const response = await fetchRequest(url, {
            ...options,
            responseType: ResponseType.Text,
            ...(options.body ? { body: Body.json(options.body) } : {}),
        });
        let data = null;
        try {
            data = JSON.parse(response.data);
        } catch {
            // The client validates null and supplies a localized protocol/uncertain-write error.
        }
        return { ok: response.ok, status: response.status, data };
    };
}
