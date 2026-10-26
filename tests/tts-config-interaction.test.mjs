import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { componentHarness } from './helpers/componentHarness.mjs';
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function lingva({ rejectSave = false } = {}) {
    let requests = 0,
        closes = 0;
    const writes = [];
    const original = { requestPath: 'old.test', instanceName: 'Lingva' };
    const h = await componentHarness('src/services/tts/lingva/Config.jsx', 'Config', {
        INSTANCE_NAME_CONFIG_KEY: 'instanceName',
        store: { get: async () => original },
        Language: { en: 'en' },
        open() {},
        tts: async () => {
            requests++;
            throw new Error('DNS lookup failed '.repeat(100));
        },
    });
    const props = {
        instanceKey: 'lingva_tts@a',
        onClose: () => closes++,
        updateServiceList: async (...args) => {
            if (rejectSave) throw new Error('disk full');
            writes.push(args);
        },
    };
    h.render(props);
    await flush();
    const render = () => h.render(props);
    const button = (text) => h.find(render(), (n) => n.type === 'Button' && n.props.children.includes(text));
    return { ...h, render, button, writes, requests: () => requests, closes: () => closes };
}
test('Lingva: editing/connection testing does not save; DNS failure stays in inline detail; explicit offline save succeeds', async () => {
    const h = await lingva();
    h.find(h.render(), (n) => n.type === 'Input' && n.props.value === 'old.test').props.onValueChange('new.test');
    assert.equal(h.writes.length, 0);
    await h.button('models.speech_test').props.onPress();
    assert.equal(h.writes.length, 0);
    assert.equal(h.closes(), 0);
    assert.match(h.find(h.render(), (n) => n.type === 'pre').props.children.join(''), /DNS lookup failed/);
    await h.button('common.save').props.onPress();
    assert.equal(h.requests(), 1);
    assert.equal(h.closes(), 1);
    assert.equal(h.writes[0][1].requestPath, 'new.test');
});
test('Lingva: failed save preserves edited draft, shows error and does not close', async () => {
    const h = await lingva({ rejectSave: true });
    h.find(h.render(), (n) => n.type === 'Input' && n.props.value === 'old.test').props.onValueChange('new.test');
    await h.button('common.save').props.onPress();
    h.find(h.render(), (n) => n.type === 'Input' && n.props.value === 'new.test');
    assert.equal(h.closes(), 0);
    assert.equal(h.requests(), 0);
    assert.match(h.find(h.render(), (n) => n.type === 'pre').props.children.join(''), /disk full/);
});
test('System voice: opening does not persist defaults, save submits edited name and waits for disk commit', async () => {
    const writes = [];
    let closed = false;
    const h = await componentHarness('src/services/tts/local_tts/Config.jsx', 'Config', {
        INSTANCE_NAME_CONFIG_KEY: 'instanceName',
        store: { get: async () => null },
    });
    const props = {
        instanceKey: 'local_tts@a',
        updateServiceList: async (...args) => writes.push(args),
        onClose: () => {
            closed = true;
        },
    };
    h.render(props);
    await flush();
    assert.deepEqual(writes, []);
    h.find(h.render(), (n) => n.type === 'Input').props.onValueChange('My voice');
    await h.find(h.render(), (n) => n.type === 'Button').props.onPress();
    assert.deepEqual(writes, [['local_tts@a', { instanceName: 'My voice' }]]);
    assert.equal(closed, true);
});
test('Google and Piper/Kokoro registration waits for commit and retains the dialog on failure', async () => {
    for (const path of ['src/services/tts/google_tts/index.jsx', 'src/services/tts/piper_tts/Config.jsx']) {
        let closed = false;
        const h = await componentHarness(path, 'Config', { useNavigate: () => () => {} });
        const props = {
            instanceKey: 'piper_tts@a',
            updateServiceList: async () => {
                throw new Error('disk full');
            },
            onClose: () => {
                closed = true;
            },
        };
        const tree = h.render(props);
        await h.find(tree, (n) => n.type === 'Button' && n.props.color === 'primary').props.onPress();
        assert.equal(closed, false);
        assert.match(h.find(h.render(props), (n) => n.props.role === 'alert').props.children.join(''), /disk full/);
    }
});

async function actualLingva(fetch) {
    const code = (await readFile('src/services/tts/lingva/index.jsx', 'utf8'))
        .replace(/^import .*$/gm, '')
        .replace(/^export \*.*$/gm, '')
        .replace('export async function tts', 'async function tts');
    return new Function('fetch', `${code}; return tts;`)(fetch);
}

test('Lingva connection test rejects actual HTTP failures and invalid audio, and clears previous success', async () => {
    for (const response of [
        { ok: false, status: 503 },
        { ok: true, data: {} },
        { ok: true, data: { audio: [] } },
        { ok: true, data: { audio: [256] } },
        { ok: true, data: { audio: 'not bytes' } },
    ]) {
        let current = { ok: true, data: { audio: [82, 73, 70, 70] } };
        const tts = await actualLingva(async () => current);
        const h = await componentHarness('src/services/tts/lingva/Config.jsx', 'Config', {
            INSTANCE_NAME_CONFIG_KEY: 'instanceName',
            store: { get: async () => ({ requestPath: 'fixture.invalid' }) },
            Language: { en: 'en' },
            tts,
            open() {},
        });
        const props = {
            instanceKey: 'lingva_tts@test',
            onClose() {},
            updateServiceList() {
                throw new Error('unexpected save');
            },
        };
        h.render(props);
        await flush();
        const click = async () =>
            h
                .find(h.render(props), (n) => n.type === 'Button' && n.props.children.includes('models.speech_test'))
                .props.onPress();
        await click();
        h.find(h.render(props), (n) => n.props.role === 'status' && n.props.children.includes('models.speech_test_ok'));
        current = response;
        await click();
        h.find(h.render(props), (n) => n.props.role === 'alert');
        assert.throws(() =>
            h.find(
                h.render(props),
                (n) => n.props.role === 'status' && n.props.children.includes('models.speech_test_ok')
            )
        );
    }
});

test('voice config read errors stay visible, retry preserves stored config and stale reads cannot replace it', async () => {
    for (const service of ['lingva', 'local_tts']) {
        let attempt = 0,
            closed = 0,
            finishOld;
        const original = { instanceName: 'Stored voice', requestPath: 'stored.invalid' };
        const h = await componentHarness(`src/services/tts/${service}/Config.jsx`, 'Config', {
            INSTANCE_NAME_CONFIG_KEY: 'instanceName',
            store: {
                get: async () => {
                    attempt++;
                    if (attempt === 1) throw new Error('read unavailable');
                    if (attempt === 2)
                        return new Promise((resolve) => {
                            finishOld = resolve;
                        });
                    return original;
                },
            },
            Language: { en: 'en' },
            tts() {},
            open() {},
        });
        const props = {
            instanceKey: `${service}@a`,
            onClose: () => closed++,
            updateServiceList() {
                throw new Error('unexpected save');
            },
        };
        h.render(props);
        await flush();
        const failed = h.render(props);
        h.find(failed, (n) => n.props.role === 'alert');
        assert.match(h.find(failed, (n) => n.type === 'pre').props.children.join(''), /read unavailable/);
        h.find(failed, (n) => n.type === 'Button' && n.props.children.includes('translate.retry')).props.onPress();
        h.render(props);
        await flush();
        const changed = { ...props, instanceKey: `${service}@b` };
        h.render(changed);
        await flush();
        finishOld({ instanceName: 'Stale voice' });
        await flush();
        h.find(h.render(changed), (n) => n.type === 'Input' && n.props.value === 'Stored voice');
        assert.equal(closed, 0);
    }
});
