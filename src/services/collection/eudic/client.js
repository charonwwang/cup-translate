import { CollectionError, withDeadline } from '../errors.js';
const BASE = 'https://api.frdic.com/api/open/v1/studylist';
const validId = (id) => (typeof id === 'string' && /^\d+$/.test(id)) || (Number.isSafeInteger(id) && id >= 0);

export function createEudicClient(transport, config = {}, { timeoutMs = 10000 } = {}) {
    const token = config.token?.trim();
    const language = 'en'; // Existing built-in contract: Eudic English vocabulary, not translation storage.
    async function request(path, method, body) {
        if (!token) throw new CollectionError('EUDIC_AUTH');
        let response;
        try {
            response = await withDeadline(
                () =>
                    transport(`${BASE}/${path}`, {
                        method,
                        timeout: timeoutMs / 1000,
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: /^NIS\s/i.test(token) ? token : `NIS ${token}`,
                        },
                        ...(method === 'GET' ? { query: { language } } : { body }),
                    }),
                timeoutMs,
                method === 'GET' ? 'EUDIC_TIMEOUT' : 'EUDIC_WRITE_UNKNOWN'
            );
        } catch (error) {
            if (error instanceof CollectionError) throw error;
            throw new CollectionError(method === 'GET' ? 'EUDIC_UNREACHABLE' : 'EUDIC_WRITE_UNKNOWN');
        }
        if (response.status === 401) throw new CollectionError('EUDIC_AUTH');
        if (response.status === 403 || response.status === 429) throw new CollectionError('EUDIC_LIMIT');
        if (!response.ok) throw new CollectionError(method === 'GET' ? 'EUDIC_HTTP' : 'EUDIC_WRITE_UNKNOWN');
        const data = response.data;
        if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            typeof data.message !== 'string' ||
            (data.error != null && data.error !== '') ||
            (data.code != null && ![200, 201].includes(data.code))
        ) {
            throw new CollectionError(method === 'GET' ? 'EUDIC_PROTOCOL' : 'EUDIC_WRITE_UNKNOWN');
        }
        return { data, status: response.status };
    }
    async function categories() {
        const { data, status } = await request('category', 'GET');
        if (
            status !== 200 ||
            !Array.isArray(data.data) ||
            !data.data.every((item) => item && validId(item.id) && typeof item.name === 'string')
        ) {
            throw new CollectionError('EUDIC_PROTOCOL');
        }
        return data.data;
    }
    return {
        testConnection: categories,
        async collect(source) {
            if (typeof source !== 'string' || !source.trim()) throw new CollectionError('COLLECTION_EMPTY');
            const name = config.name?.trim() || 'pot';
            let category = (await categories()).find((item) => item.name === name);
            if (!category) {
                const { data, status } = await request('category', 'POST', { language, name });
                if (status !== 201 || !validId(data.data?.id)) throw new CollectionError('EUDIC_WRITE_UNKNOWN');
                category = data.data;
            }
            // Official API retains words for compatibility; category_id replaces deprecated id.
            const { data, status } = await request('words', 'POST', {
                category_id: String(category.id),
                language,
                words: [source.trim()],
            });
            if (status !== 201 || !data.message.trim()) throw new CollectionError('EUDIC_WRITE_UNKNOWN');
            return true;
        },
    };
}
