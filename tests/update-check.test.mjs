import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile('src/utils/updateCheck.js', 'utf8')).replace(/^import .*;\n/, '');
const { checkForUpdate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function transport(result) {
    const handlers = new Map();
    let removed = 0;
    return {
        listenEvent: async (name, handler) => {
            handlers.set(name, handler);
            return () => {
                removed++;
                handlers.delete(name);
            };
        },
        emitEvent: async (name) => {
            assert.equal(name, 'tauri://update');
            assert.equal(handlers.size, 2);
            if (result) handlers.get(result.name)({ payload: result.payload });
        },
        get removed() {
            return removed;
        },
    };
}
test('update availability and latest version both clean up listeners', async () => {
    for (const available of [true, false]) {
        const io = transport(
            available
                ? { name: 'tauri://update-available', payload: { version: '3.0.8' } }
                : { name: 'tauri://update-status', payload: { status: 'UPTODATE' } }
        );
        const result = await checkForUpdate(io);
        assert.equal(result.shouldUpdate, available);
        assert.equal(io.removed, 2);
    }
});
test('update network errors and timeouts reject instead of reporting up-to-date', async () => {
    for (const event of [null, { name: 'tauri://update-status', payload: { status: 'ERROR', error: '404' } }]) {
        const io = transport(event);
        await assert.rejects(checkForUpdate({ ...io, timeout: 5 }));
        assert.equal(io.removed, 2);
    }
});
test('emit failures clean up listeners', async () => {
    const io = transport(null);
    await assert.rejects(
        checkForUpdate({
            ...io,
            emitEvent: async () => {
                throw Error('IPC failed');
            },
        })
    );
    assert.equal(io.removed, 2);
});
