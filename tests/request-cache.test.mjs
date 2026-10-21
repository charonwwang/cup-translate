import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestCache } from '../src/utils/requestCache.js';

test('a new request does not inherit another caller cancellation through in-flight deduplication', async () => {
    const cached = createRequestCache();
    const first = new AbortController();
    const second = new AbortController();
    let rejectOld;
    const old = cached(
        'same text',
        () =>
            new Promise((_resolve, reject) => {
                rejectOld = reject;
            }),
        first.signal
    );
    await Promise.resolve();
    first.abort();
    const fresh = cached('same text', async () => 'fresh result', second.signal);
    rejectOld(new DOMException('Cancelled', 'AbortError'));
    await assert.rejects(old, { name: 'AbortError' });
    assert.equal(await fresh, 'fresh result');
    assert.equal(await cached('same text', () => assert.fail('successful result should be cached')), 'fresh result');
});

test('concurrent identical translations share a request; successful repeats use cache', async () => {
    const cached = createRequestCache();
    let calls = 0;
    const request = async () => {
        calls++;
        return '译文';
    };
    assert.deepEqual(await Promise.all([cached('a', request), cached('a', request)]), ['译文', '译文']);
    assert.equal(await cached('a', request), '译文');
    assert.equal(calls, 1);
});

test('failures are never cached and the user can retry', async () => {
    const cached = createRequestCache();
    await assert.rejects(
        cached('a', async () => {
            throw Error('offline');
        }),
        /offline/
    );
    assert.equal(await cached('a', async () => 'recovered'), 'recovered');
});

test('expiry and LRU bound both lifetime and resident entries', async () => {
    let time = 0,
        calls = 0;
    const cached = createRequestCache({ capacity: 2, ttl: 10, now: () => time });
    const request = async () => ++calls;
    await cached('a', request);
    await cached('b', request);
    await cached('a', request);
    await cached('c', request);
    await cached('b', request);
    assert.equal(calls, 4, 'least recently used b must have been evicted');
    time = 11;
    await cached('b', request);
    assert.equal(calls, 5, 'expired entries must refetch');
});

test('different engine configurations cannot share a cached translation', async () => {
    const cached = createRequestCache();
    assert.equal(await cached('endpoint-a/en/zh/text', async () => 'a'), 'a');
    assert.equal(await cached('endpoint-b/en/zh/text', async () => 'b'), 'b');
});
