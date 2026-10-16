import assert from 'node:assert/strict';
import test from 'node:test';
import { saveShortcut } from '../src/utils/shortcut.js';

test('failed native registration never persists a draft', async () => {
    let persisted = false;
    await assert.rejects(
        saveShortcut('hotkey_selection_translate', 'Alt+K', {
            register: async () => {
                throw Error('occupied');
            },
            persist: () => {
                persisted = true;
            },
        }),
        /occupied/
    );
    assert.equal(persisted, false);
});

test('successful registration commits only after the native operation completes', async () => {
    const calls = [];
    await saveShortcut('hotkey_selection_translate', 'Alt+K', {
        register: async (name, key) => {
            calls.push([name, key]);
        },
        persist: (key, force) => calls.push([key, force]),
    });
    assert.deepEqual(calls, [
        ['hotkey_selection_translate', 'Alt+K'],
        ['Alt+K', true],
    ]);
});

test('disabling follows the same transaction and uses the correct action', async () => {
    const calls = [];
    await saveShortcut('hotkey_clipboard_translate', '', {
        register: async (name, key) => calls.push([name, key]),
        persist: (key, force) => calls.push([key, force]),
    });
    assert.deepEqual(calls, [
        ['hotkey_clipboard_translate', ''],
        ['', true],
    ]);
});
