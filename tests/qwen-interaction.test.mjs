import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { componentHarness } from './helpers/componentHarness.mjs';
import { saveQwenSettings } from '../src/utils/qwenConfig.js';
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function setup({ installed = true, fail = false, statusError = '', requestError = '', mode = 'models' } = {}) {
    const memory = new Map([
        ['qwen_tts', { voice: 'Vivian', variant: '0.6B' }],
        ['tts_service_list', ['google_tts']],
        ['speech_policy', 'engine'],
    ]);
    const events = [],
        playback = [],
        calls = [];
    let closed = 0,
        finish;
    let status = { models: installed ? { '0.6B': { device: 'cpu' } } : {}, task: {}, logPath: '/test/qwen.log' };
    const store = {
        get: async (k) => memory.get(k) ?? null,
        set: async (k, v) => memory.set(k, v),
        delete: async (k) => memory.delete(k),
        save: async () => {
            if (fail) throw new Error('disk full');
        },
    };
    const speechCode = (await readFile('src/hooks/useSpeech.js', 'utf8'))
        .replace(/^import .*$/gm, '')
        .replace('export function', 'function');
    let h;
    const makeSpeech = () =>
        new Function('useEffect', 'useRef', 'useState', 'window', `${speechCode}; return useSpeech;`)(
            h.hooks.useEffect,
            h.hooks.useRef,
            h.hooks.useState,
            {
                AudioContext: function () {
                    return {
                        resume: async () => {},
                        close: async () => {},
                        decodeAudioData: async () => ({}),
                        createBufferSource: () => ({
                            connect() {},
                            disconnect() {},
                            start: () => playback.push('start'),
                            stop: () => playback.push('stop'),
                        }),
                    };
                },
            }
        );
    let speechHook;
    h = await componentHarness('src/window/Config/pages/Models/QwenSpeech.jsx', 'QwenSpeech', {
        store,
        emit: async (...args) => events.push(args),
        saveQwenSettings,
        useSpeech: (...args) => {
            speechHook ||= makeSpeech();
            return speechHook(...args);
        },
        invoke: async (cmd) => {
            calls.push(cmd);
            if (cmd === 'qwen_status') {
                if (statusError) throw new Error(statusError);
                return status;
            }
            if (cmd === 'qwen_tts_request' && requestError) throw new Error(requestError);
            if (cmd === 'qwen_tts_request')
                return new Promise((resolve) => {
                    finish = resolve;
                });
            if (cmd === 'qwen_device_check')
                return { supported: true, diskAvailable: 100e9, modelBytes: 1, environments: [] };
            if (cmd === 'qwen_install')
                status = { ...status, task: { variant: '0.6B', state: 'model', fallback: 'cpu' } };
        },
    });
    const props = {
        open: true,
        onClose: () => {
            closed++;
        },
        mode,
    };
    h.render(props);
    await flush();
    const render = (next = props) => h.render(next);
    const button = (key) => h.find(render(), (node) => node.type === 'Button' && node.props.children.includes(key));
    const voice = () => h.find(render(), (node) => node.type === 'Select' && node.props.label === 'models.qwen_voice');
    return {
        ...h,
        render,
        button,
        voice,
        memory,
        events,
        playback,
        calls,
        closed: () => closed,
        finish: () => finish([1]),
        props,
        completeInstall: () => {
            status = { ...status, models: { '0.6B': { device: 'cpu' } }, task: { variant: '0.6B', state: 'ready' } };
        },
    };
}
test('Q02: close button and Modal dismiss (X/Esc/backdrop) share discard-only behavior', async () => {
    for (const dismiss of ['button', 'modal']) {
        const h = await setup();
        h.voice().props.onSelectionChange(new Set(['Ryan']));
        if (dismiss === 'button') h.button('common.close').props.onPress();
        else h.render().props.onClose();
        assert.equal(h.closed(), 0);
        h.button('models.qwen_discard').props.onPress();
        assert.equal(h.closed(), 1);
        assert.equal(h.memory.get('qwen_tts').voice, 'Vivian');
        assert.equal(h.memory.get('speech_policy'), 'engine');
        assert.deepEqual(h.events, []);
        h.render({ ...h.props, open: false });
    }
});
test('Q03/Q06: actual save handler keeps failed draft open and emits only after successful register', async () => {
    for (const fail of [true, false]) {
        const h = await setup({ fail, mode: 'service' });
        h.voice().props.onSelectionChange(new Set(['Dylan']));
        await h.button('common.save').props.onPress();
        assert.equal(h.closed(), fail ? 0 : 1);
        assert.equal(h.voice().props.selectedKeys[0], 'Dylan');
        assert.deepEqual(h.memory.get('tts_service_list'), fail ? ['google_tts'] : ['google_tts', 'qwen_tts']);
        assert.equal(h.memory.get('speech_policy'), 'engine');
        if (fail) assert.ok(h.find(h.render(), (n) => n.type === 'pre').props.children.includes('Error: disk full'));
    }
});
test('Q04: installation task and CPU fallback are displayed without saving or enabling on close', async () => {
    const h = await setup({ installed: false });
    await h.button('models.wizard_next').props.onPress();
    h.find(h.render(), (n) => n.type === 'Checkbox').props.onValueChange(true);
    h.button('models.wizard_to_install').props.onPress();
    await h.button('models.begin_install').props.onPress();
    assert.ok(
        h
            .find(h.render(), (n) => n.type === 'p' && n.props.role === 'status')
            .props.children.join('')
            .includes('models.qwen_cpu_fallback')
    );
    h.button('models.close_background').props.onPress();
    assert.equal(h.closed(), 1);
    assert.equal(h.memory.get('speech_policy'), 'engine');
    assert.deepEqual(h.events, []);
});
test('Q05: closing during preview loading cancels late audio; playback and stop states are visible', async () => {
    const h = await setup();
    const pending = h.button('models.qwen_test').props.onPress();
    await flush();
    h.find(h.render(), (n) => n.props.role === 'status' && n.props.children.includes('models.qwen_preview_loading'));
    h.button('common.close').props.onPress();
    h.finish();
    await pending;
    assert.deepEqual(h.playback, []);
    const pending2 = h.button('models.qwen_test').props.onPress();
    await flush();
    h.finish();
    await pending2;
    h.find(h.render(), (n) => n.props.role === 'status' && n.props.children.includes('models.qwen_preview_playing'));
    h.button('models.qwen_preview_stop').props.onPress();
    assert.deepEqual(h.playback, ['start', 'stop']);
});
test('Q08: status failures are actionable, include detail, and do not allow blank saving', async () => {
    const h = await setup({ statusError: 'missing dependencies: reinstall runtime' });
    assert.match(h.find(h.render(), (n) => n.type === 'pre').props.children.join(''), /missing dependencies/);
    assert.equal(h.button('models.wizard_next').props.isDisabled, true);
    h.button('common.close').props.onPress();
    assert.equal(h.closed(), 1);
});
test('Q01: service entry delegates ownership to Qwen, and selection closes before configuration opens', async () => {
    const Config = () => {};
    const h = await componentHarness('src/window/Config/pages/Service/Tts/ConfigModal/index.jsx', 'ConfigModal', {
        getServiceSouceType: () => 'buildin',
        whetherPluginService: () => false,
        getServiceName: (key) => key.split('@')[0],
        builtinServices: { qwen_tts: { Config } },
    });
    let closed;
    const tree = h.render({
        serviceInstanceKey: 'qwen_tts@old',
        isOpen: true,
        onOpenChange: (v) => {
            closed = v;
        },
        pluginList: {},
    });
    assert.equal(tree.type, Config);
    assert.equal(tree.props.open, true);
    tree.props.onClose();
    assert.equal(closed, false);
    const s = await componentHarness('src/window/Config/pages/Service/Tts/SelectModal/index.jsx', 'SelectModal', {
        builtinServices: { qwen_tts: { info: { name: 'qwen_tts' } }, google_tts: { info: { name: 'google_tts' } } },
        createServiceInstanceKey: (key) => `${key}@new`,
    });
    for (const name of ['qwen_tts', 'google_tts']) {
        const events = [];
        const root = s.render({
            isOpen: true,
            onOpenChange() {},
            setCurrentConfigKey: (key) => events.push(key),
            onConfigOpen: () => events.push('open'),
        });
        const content = root.props.children[0].props.children[0](() => events.push('close'));
        const selected = s.find(
            content,
            (n) =>
                n.type === 'Button' &&
                n.props.startContent?.props.src === undefined &&
                n.props.children[0]?.props?.children?.includes(`services.tts.${name}.title`)
        );
        selected.props.onPress();
        assert.deepEqual(events, ['close', name === 'qwen_tts' ? name : `${name}@new`, 'open']);
    }
});
test('Q04: observing install completion never commits configuration or changes fallback policy', async () => {
    const h = await setup({ installed: false });
    h.completeInstall();
    await h.timers[0]();
    h.button('common.close').props.onPress();
    assert.equal(h.closed(), 1);
    assert.equal(h.memory.get('speech_policy'), 'engine');
    assert.deepEqual(h.events, []);
});
test('Q05: an old preview cannot resume after close and reopen', async () => {
    const h = await setup();
    const pending = h.button('models.qwen_test').props.onPress();
    await flush();
    h.button('common.close').props.onPress();
    h.render({ ...h.props, open: false });
    h.render(h.props);
    await flush();
    h.finish();
    await pending;
    assert.deepEqual(h.playback, []);
    assert.equal(h.voice().props.selectedKeys[0], 'Vivian');
});
test('Q08: missing model, dependency and corrupt model synthesis failures preserve recovery details and log path', async () => {
    for (const requestError of [
        'Model is not installed; install model',
        'Missing Python dependency; reinstall runtime',
        'Corrupt model weights; reinstall model',
    ]) {
        const h = await setup({ requestError });
        await h.button('models.qwen_test').props.onPress();
        assert.match(h.find(h.render(), (n) => n.type === 'pre').props.children.join(''), new RegExp(requestError));
        h.find(h.render(), (n) => n.type === 'p' && n.props.children.includes('/test/qwen.log'));
        assert.deepEqual(h.playback, []);
        assert.equal(h.closed(), 0);
    }
});
test('Q03: the separate enable button changes fallback policy only after saving', async () => {
    const h = await setup();
    await h.button('models.qwen_save_enable').props.onPress();
    assert.equal(h.memory.get('speech_policy'), 'qwen');
    assert.deepEqual(h.memory.get('tts_service_list'), ['google_tts', 'qwen_tts']);
    assert.equal(h.closed(), 1);
});
