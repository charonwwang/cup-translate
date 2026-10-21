import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigTransfer, parseConfigTransfer, applyConfigTransfer } from '../src/utils/configTransfer.js';
test('JSON round-trip omits credentials by default and preserves them during merge', async () => {
    const source = {
        app_theme: 'dark',
        google: { api_key: 'test-value', custom_url: 'https://example.test' },
        proxy_password: 'test-password',
    };
    const text = createConfigTransfer(source);
    assert.ok(!text.includes('test-value'));
    assert.ok(!text.includes('test-password'));
    assert.equal(parseConfigTransfer(createConfigTransfer(source, true)).google.api_key, undefined);
    const values = new Map([['google', { api_key: 'existing-key' }]]);
    const store = {
        entries: async () => [...values],
        set: async (k, v) => values.set(k, v),
        save: async () => {},
        delete: async (k) => values.delete(k),
    };
    await applyConfigTransfer(store, parseConfigTransfer(text));
    assert.equal(values.get('google').api_key, 'existing-key');
    assert.equal(values.get('app_theme'), 'dark');
});
test('import rejects invalid format, nested prototype keys, wrong service lists and oversized input', () => {
    for (const text of [
        '{}',
        '[]',
        '{"format":"cup-translate-settings","version":1,"settings":{"google":{"__proto__":{}}}}',
        createConfigTransfer({ tts_service_list: [1] }),
    ])
        assert.throws(() => parseConfigTransfer(text));
    assert.throws(() => parseConfigTransfer(' '.repeat(2 * 1024 * 1024 + 1)));
});
test('failed commit restores all previous values, including removal of new keys', async () => {
    const values = new Map([['app_theme', 'light']]);
    let saves = 0;
    const store = {
        entries: async () => [...values],
        set: async (k, v) => values.set(k, v),
        delete: async (k) => values.delete(k),
        save: async () => {
            if (++saves === 1) throw Error('disk failed');
        },
    };
    await assert.rejects(applyConfigTransfer(store, { app_theme: 'dark', new_key: true }), /disk failed/);
    assert.deepEqual([...values], [['app_theme', 'light']]);
});
test('type mismatch does not mutate the store', async () => {
    let writes = 0;
    await assert.rejects(
        applyConfigTransfer(
            { entries: async () => [['proxy_enable', false]], set: async () => writes++ },
            { proxy_enable: 'yes' }
        ),
        /type mismatch/
    );
    assert.equal(writes, 0);
});

test('ports accept existing string/number forms but reject invalid ranges', async () => {
    assert.throws(() => parseConfigTransfer(createConfigTransfer({ server_port: 70000 })));
    const values = new Map([['proxy_port', '']]);
    const store = { entries: async () => [...values], set: async (k, v) => values.set(k, v), save: async () => {} };
    await applyConfigTransfer(store, parseConfigTransfer(createConfigTransfer({ proxy_port: 8080 })));
    assert.equal(values.get('proxy_port'), 8080);
});

test('font sizes from legacy dropdown string values remain portable', async () => {
    const imported = parseConfigTransfer(createConfigTransfer({ app_font_size: '18' }));
    assert.equal(imported.app_font_size, 18);
    const values = new Map([['app_font_size', '16']]);
    await applyConfigTransfer(
        { entries: async () => [...values], set: async (k, v) => values.set(k, v), save: async () => {} },
        imported
    );
    assert.equal(values.get('app_font_size'), 18);
});
