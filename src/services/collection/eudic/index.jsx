import { createCollectionTransport } from '../transport';
import { fetchWithTimeout, Body, ResponseType } from '../../../utils/fetchWithTimeout';
import { resolveSecrets } from '../../../utils/credentials';
import { store } from '../../../utils/store';
import { createEudicClient } from './client';
const transport = createCollectionTransport(fetchWithTimeout, Body, ResponseType);
export async function testConnection(config) {
    return createEudicClient(transport, await resolveSecrets(config)).testConnection();
}
export async function collection(source, target, options = {}) {
    const config = await resolveSecrets(options.config ?? (await store.get('eudic')) ?? {});
    return createEudicClient(transport, config).collect(source);
}
export * from './Config';
export * from './info';
