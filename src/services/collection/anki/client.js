import { resolveAnkiPort } from './port.js';
import { CollectionError, withDeadline } from '../errors.js';

const id = (value) => Number.isSafeInteger(value) && value > 0;
const names = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const validators = {
    version: (value) => Number.isInteger(value) && value >= 6,
    deckNames: names,
    modelNames: names,
    modelFieldNames: names,
    createDeck: id,
    createModel: (value) => value && typeof value === 'object' && !Array.isArray(value) && id(value.id),
    addNote: id,
};

export function ankiBusinessError(message) {
    if (/key|authori|permission|access denied/i.test(message)) return 'ANKI_AUTH';
    if (/duplicate|already exists/i.test(message)) return 'ANKI_DUPLICATE';
    if (/field|model|deck/i.test(message)) return 'ANKI_MODEL';
    return 'ANKI_WRITE_FAILED';
}

// transport accepts plain JSON and returns {ok, status, data}; no retries, especially for writes.
export function createAnkiClient(transport, config = {}, { timeoutMs = 10000 } = {}) {
    const port = resolveAnkiPort(config.port);
    return async function requestAnki(action, params = {}) {
        if (!validators[action]) throw new CollectionError('ANKI_PROTOCOL');
        const uncertain = action === 'addNote' ? 'ANKI_WRITE_UNKNOWN' : 'ANKI_TIMEOUT';
        let response;
        try {
            response = await withDeadline(
                () =>
                    transport(`http://127.0.0.1:${port}`, {
                        method: 'POST',
                        timeout: timeoutMs / 1000,
                        body: { action, version: 6, params, ...(config.apiKey ? { key: config.apiKey } : {}) },
                    }),
                timeoutMs,
                uncertain
            );
        } catch (error) {
            if (error instanceof CollectionError) throw error;
            throw new CollectionError(action === 'addNote' ? 'ANKI_WRITE_UNKNOWN' : 'ANKI_UNREACHABLE');
        }
        if (response.status === 401 || response.status === 403) throw new CollectionError('ANKI_AUTH');
        if (!response.ok) throw new CollectionError(action === 'addNote' ? 'ANKI_WRITE_UNKNOWN' : 'ANKI_HTTP');
        const data = response.data;
        if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            !Object.hasOwn(data, 'result') ||
            !Object.hasOwn(data, 'error') ||
            (data.error !== null && typeof data.error !== 'string')
        ) {
            throw new CollectionError(action === 'addNote' ? 'ANKI_WRITE_UNKNOWN' : 'ANKI_PROTOCOL');
        }
        if (data.error !== null) throw new CollectionError(ankiBusinessError(data.error));
        if (!validators[action](data.result)) {
            throw new CollectionError(action === 'addNote' ? 'ANKI_WRITE_UNKNOWN' : 'ANKI_PROTOCOL');
        }
        return data.result;
    };
}

export const testAnkiConnection = (request) => request('version');
