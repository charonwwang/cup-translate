import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertPolicy, RequestScope } from '../src/utils/requestPolicy.js';

async function runtime(get = async () => 'standard') {
    const source = (await readFile('src/utils/requestRuntime.js', 'utf8'))
        .replace(/^import .*;\n/gm, '')
        .replaceAll('export function ', 'function ')
        .replaceAll('export async function ', 'async function ');
    return new Function(
        'store',
        'assertPolicy',
        'RequestScope',
        `${source}; return { guardService, invalidateRequests };`
    )({ get }, assertPolicy, RequestScope);
}
const expired = (e) => e.name === 'AbortError';

test('example supplementation keeps its own policy and cancellation scope after the main result finishes', async () => {
    const { guardService, invalidateRequests } = await runtime();
    let finish, signal;
    const service = guardService('translate', 'google', {
        translate: async () => 'main result',
        supplement: async (_result, _from, _to, options) => {
            signal = options.signal;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    });
    assert.equal(await service.translate('text', {}), 'main result');
    const pending = service.supplement('main result', 'en', 'zh', {});
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    invalidateRequests();
    assert.equal(signal.aborted, true);
    finish('obsolete details');
    await assert.rejects(pending, expired);

    let calls = 0;
    const blocked = await runtime(async () => 'device_only');
    await assert.rejects(
        blocked
            .guardService('translate', 'google', {
                supplement: async () => {
                    calls++;
                },
            })
            .supplement('main result', 'en', 'zh', {})
    );
    assert.equal(calls, 0, 'supplementary requests must obey device-only policy');
});

test('an already aborted request never enters the provider', async () => {
    const { guardService } = await runtime();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const service = guardService('translate', 'google', { translate: async () => ++calls });
    await assert.rejects(service.translate('text', { signal: controller.signal }), expired);
    assert.equal(calls, 0);
});

test('invalidation during the initial policy read prevents dispatch', async () => {
    let complete;
    const { guardService, invalidateRequests } = await runtime(
        () =>
            new Promise((r) => {
                complete = r;
            })
    );
    let calls = 0;
    const request = guardService('translate', 'google', { translate: async () => ++calls }).translate('text', {});
    invalidateRequests();
    complete('standard');
    await assert.rejects(request, expired);
    assert.equal(calls, 0);
});

test('invalidation during final policy check rejects a completed result', async () => {
    let reads = 0,
        complete;
    const { guardService, invalidateRequests } = await runtime(() =>
        ++reads === 1
            ? Promise.resolve('standard')
            : new Promise((r) => {
                  complete = r;
              })
    );
    const request = guardService('translate', 'google', { translate: async () => 'old result' }).translate('text', {});
    while (!complete) await new Promise((r) => setImmediate(r));
    invalidateRequests();
    complete('standard');
    await assert.rejects(request, expired);
});

test('finished requests release the caller abort listener', async () => {
    const { guardService } = await runtime();
    const controller = new AbortController();
    const listeners = new Set();
    const signal = {
        aborted: false,
        addEventListener: (_name, fn) => listeners.add(fn),
        removeEventListener: (_name, fn) => listeners.delete(fn),
    };
    assert.equal(
        await guardService('translate', 'google', {
            translate: async (_text, options) => {
                assert.equal(listeners.size, 1);
                assert.ok(options.signal instanceof AbortSignal);
                return 'result';
            },
        }).translate('text', { signal }),
        'result'
    );
    assert.equal(listeners.size, 0);
    controller.abort();
});
