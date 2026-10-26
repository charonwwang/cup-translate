import test from 'node:test';
import assert from 'node:assert/strict';
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
