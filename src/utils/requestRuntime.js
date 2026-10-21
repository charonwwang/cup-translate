import { store } from './store';
import { assertPolicy, RequestScope } from './requestPolicy';
const scopes = new Set();
export function registerRequestController(controller) {
    const scope = { cancel: () => controller.abort() };
    scopes.add(scope);
    return () => scopes.delete(scope);
}
export function invalidateRequests() {
    for (const scope of scopes) scope.cancel();
    scopes.clear();
}
export async function checkPolicy(kind, name) {
    assertPolicy(await store.get('privacy_mode'), kind, name);
}
export function guardService(kind, name, provider) {
    const method = { translate: 'translate', tts: 'tts', recognize: 'recognize' }[kind];
    const guarded = {
        ...provider,
        async [method](...args) {
            const scope = new RequestScope({ kind, name });
            scopes.add(scope);
            const last = args.length - 1;
            const options = args[last];
            const onAbort = () => scope.cancel();
            try {
                if (options && typeof options === 'object') {
                    if (options.signal?.aborted) scope.cancel();
                    options.signal?.addEventListener('abort', onAbort, { once: true });
                    args[last] = {
                        ...options,
                        config: options.config ? structuredClone(options.config) : options.config,
                        signal: scope.signal,
                        setResult: options.setResult
                            ? (value) => {
                                  if (scope.active) options.setResult(value);
                              }
                            : undefined,
                    };
                }
                await checkPolicy(kind, name);
                scope.assertActive();
                const value = await provider[method](...args);
                scope.assertActive();
                await checkPolicy(kind, name);
                scope.assertActive();
                return value;
            } catch (error) {
                if (!scope.active) throw new DOMException('Request expired', 'AbortError');
                // Preserve a safe category; provider errors may include echoed input or credentials.
                throw new Error(
                    kind === 'translate'
                        ? 'Translation failed; check this service in Settings and retry'
                        : 'Text processing failed; check provider configuration'
                );
            } finally {
                options?.signal?.removeEventListener('abort', onAbort);
                scopes.delete(scope);
            }
        },
    };
    if (provider[method]) Object.assign(guarded[method], provider[method]);
    if (provider.supplement) {
        guarded.supplement = guardService(kind, name, { [method]: provider.supplement })[method];
    }
    return guarded;
}
