import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionDraft, persistCollectionConfig } from '../src/services/collection/draft.js';
import { createCollectionGate } from '../src/services/collection/pending.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
};
function memoryStore(entries = {}, fail = false) {
    const values = new Map(Object.entries(entries));
    let disk = structuredClone(Object.fromEntries(values));
    return {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => values.set(key, structuredClone(value)),
        delete: async (key) => values.delete(key),
        save: async () => {
            if (fail) throw new Error('disk full');
            disk = structuredClone(Object.fromEntries(values));
        },
        disk: () => disk,
    };
}

test('A01: offline save persists draft and registers service without executing test or collection', async () => {
    const store = memoryStore();
    const states = [];
    let requests = 0;
    const editor = createCollectionDraft(
        { port: 8765 },
        {
            testConnection: () => {
                requests++;
                throw new Error('offline');
            },
            persist: (draft) => persistCollectionConfig(store, 'anki@one', draft),
            onChange: (state) => states.push(state),
        }
    );
    editor.change('port', '9876');
    assert.equal(await editor.save(), true);
    assert.equal(requests, 0);
    assert.deepEqual(store.disk(), { 'anki@one': { port: '9876' }, collection_service_list: ['anki@one'] });
    assert.equal(states.at(-1).status, 'saved_offline');
    await editor.test();
    assert.equal(states.at(-1).status, 'failed');
    assert.equal(await editor.save(), true);
    assert.equal(states.at(-1).status, 'saved_offline');
});

test('A10: changed port/key invalidate prior success and late successes/failures cannot label a new draft', async () => {
    const slow = deferred();
    const states = [];
    const editor = createCollectionDraft(
        { port: 8765, secretRefs: { apiKey: 'cup:test:ref' } },
        {
            testConnection: () => slow.promise,
            persist: async () => {},
            onChange: (state) => states.push(state),
        }
    );
    const pending = editor.test();
    assert.equal(states.at(-1).status, 'checking');
    editor.change('port', '9876');
    slow.resolve(6);
    await pending;
    assert.equal(states.at(-1).status, 'untested');
    assert.equal(states.at(-1).config.port, '9876');
    await editor.test();
    assert.equal(states.at(-1).status, 'connected');
    editor.change('apiKey', 'fake');
    assert.equal(states.at(-1).status, 'untested');
    assert.equal(states.at(-1).config.secretRefs.apiKey, undefined);
    editor.change('apiKey', '');
    assert.equal(states.at(-1).config.apiKey, '');
    const lateFailure = deferred();
    const other = createCollectionDraft(
        {},
        { testConnection: () => lateFailure.promise, persist: async () => {}, onChange: (state) => states.push(state) }
    );
    const checking = other.test();
    other.change('token', 'replacement');
    lateFailure.reject(new Error('old'));
    await checking;
    assert.equal(states.at(-1).status, 'untested');
});

test('closing editor drops draft; late test after unmount has no effect', async () => {
    const slow = deferred();
    const states = [];
    let saves = 0;
    const editor = createCollectionDraft(
        {},
        { testConnection: () => slow.promise, persist: () => saves++, onChange: (state) => states.push(state) }
    );
    editor.change('port', 1234);
    const pending = editor.test();
    editor.dispose();
    const count = states.length;
    slow.resolve(6);
    await pending;
    assert.equal(states.length, count);
    assert.equal(saves, 0);
});

test('save failure retains editable draft and restores memory/disk config and service list', async () => {
    for (const prior of [{}, { 'eudic@one': { name: 'old' }, collection_service_list: ['anki@old'] }]) {
        const store = memoryStore(prior, true);
        const states = [];
        const editor = createCollectionDraft(
            { name: 'new' },
            {
                testConnection: async () => {},
                persist: (draft) => persistCollectionConfig(store, 'eudic@one', draft),
                onChange: (state) => states.push(state),
            }
        );
        assert.equal(await editor.save(), false);
        assert.equal(states.at(-1).status, 'save_failed');
        assert.equal(states.at(-1).config.name, 'new');
        assert.deepEqual(store.disk(), prior);
        assert.deepEqual(await store.get('eudic@one'), prior['eudic@one'] ?? null);
        assert.deepEqual(await store.get('collection_service_list'), prior.collection_service_list ?? []);
        editor.change('name', 'retry');
        assert.equal(states.at(-1).config.name, 'retry');
    }
});

test('saving is awaited, prevents repeated submission/edits, and invalidates an in-flight test', async () => {
    const save = deferred(),
        check = deferred();
    const states = [];
    let saves = 0;
    const editor = createCollectionDraft(
        { name: 'one' },
        {
            testConnection: () => check.promise,
            persist: () => {
                saves++;
                return save.promise;
            },
            onChange: (state) => states.push(state),
        }
    );
    const pendingTest = editor.test();
    const pendingSave = editor.save();
    assert.equal(await editor.save(), false);
    editor.change('name', 'two');
    check.resolve();
    await pendingTest;
    assert.equal(states.at(-1).status, 'saving');
    save.resolve();
    await pendingSave;
    assert.equal(saves, 1);
    assert.equal(states.at(-1).status, 'saved_offline');
    assert.equal(states.at(-1).config.name, 'one');
});

test('collection gate suppresses concurrent clicks, releases on success and failure, allows explicit retry', async () => {
    const gate = createCollectionGate();
    const slow = deferred();
    let writes = 0;
    const pending = gate.run('anki', () => {
        writes++;
        return slow.promise;
    });
    assert.equal(gate.has('anki'), true);
    await gate.run('anki', () => writes++);
    assert.equal(writes, 1);
    slow.reject(new Error('uncertain'));
    await assert.rejects(pending);
    assert.equal(gate.has('anki'), false);
    await gate.run('anki', () => writes++);
    assert.equal(writes, 2);
});

test('dirty state follows edits and successful saves, with connection status preserved across repeated saves', async () => {
    const states = [];
    const editor = createCollectionDraft(
        { port: 8765 },
        {
            testConnection: async () => 6,
            persist: async () => {},
            onChange: (state) => states.push(state),
        }
    );
    editor.change('port', 9876);
    assert.equal(states.at(-1).dirty, true);
    editor.change('port', 8765);
    assert.equal(states.at(-1).dirty, false);
    await editor.test();
    editor.change('port', 9876);
    await editor.test();
    assert.equal(await editor.save(), true);
    assert.equal(states.at(-1).dirty, false);
    assert.equal(states.at(-1).status, 'saved_connected');
    assert.equal(await editor.save(), true);
    assert.equal(states.at(-1).status, 'saved_connected');
});
