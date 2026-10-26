import { createCollectionTransport } from '../transport';
import { fetchWithTimeout, Body, ResponseType } from '../../../utils/fetchWithTimeout';
import { store } from '../../../utils/store';
import { resolveSecrets } from '../../../utils/credentials';
import { createAnkiClient, testAnkiConnection } from './client';
import { collectAnki } from './collect';

const transport = createCollectionTransport(fetchWithTimeout, Body, ResponseType);
export async function testConnection(config) {
    return testAnkiConnection(createAnkiClient(transport, await resolveSecrets(config)));
}
export async function collection(source, target, options = {}) {
    const config = await resolveSecrets(options.config ?? (await store.get('anki')) ?? {});
    return collectAnki(createAnkiClient(transport, config), source, target);
}
export * from './Config';
export * from './info';
