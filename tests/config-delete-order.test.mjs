import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
async function deletion(store) {
    const source = await readFile('src/hooks/useConfig.jsx', 'utf8');
    const body = source.slice(source.indexOf('export const deleteKey =')).replace('export const ', 'const ');
    return new Function('store', `${body};return deleteKey;`)(store);
}
test('an absent configuration key never triggers deletion or a save', async () => {
    const calls = [];
    const remove = await deletion({
        has: async () => false,
        delete: () => calls.push('delete'),
        save: () => calls.push('save'),
    });
    assert.equal(await remove('absent'), false);
    assert.deepEqual(calls, []);
});
test('service configuration removal awaits deletion before persisting', async () => {
    let finish;
    const calls = [];
    const remove = await deletion({
        has: async () => true,
        delete: () =>
            new Promise((r) => {
                finish = () => {
                    calls.push('delete');
                    r();
                };
            }),
        save: () => calls.push('save'),
    });
    const result = remove('fixture');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, []);
    finish();
    assert.equal(await result, true);
    assert.deepEqual(calls, ['delete', 'save']);
});
