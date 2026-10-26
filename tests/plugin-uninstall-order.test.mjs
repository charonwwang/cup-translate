import assert from 'node:assert/strict';
import test from 'node:test';
import { savePluginInstance, uninstallPlugin } from '../src/utils/plugin_lifecycle.js';
function fixture(list) {
    const data = { tts_service_list: list, 'plugin.demo@a': { voice: 'saved' }, 'plugin.demo@b': { voice: 'other' } };
    let disk = structuredClone(data);
    const calls = [];
    const store = {
        get: async (key) => data[key],
        set: async (key, value) => {
            data[key] = value;
        },
        delete: async (key) => {
            delete data[key];
        },
        save: async () => {
            disk = structuredClone(data);
            calls.push('saved');
        },
    };
    const deps = {
        store,
        emit: async (name) => calls.push(name),
        kind: 'tts',
        name: 'plugin.demo',
        removePackage: async () => calls.push('removed'),
    };
    return { deps, calls, data, disk: () => disk };
}
test('refused last-service uninstall never changes disk or removes files', async () => {
    const f = fixture(['plugin.demo@a', 'plugin.demo@b']);
    await assert.rejects(() => uninstallPlugin(f.deps), /PLUGIN_LAST_SERVICE/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.disk()['plugin.demo@a'].voice, 'saved');
});
test('uninstall removes all plugin instances, preserving unrelated services and config', async () => {
    const f = fixture(['google_tts', 'plugin.demo@a', 'plugin.demo@b']);
    await uninstallPlugin(f.deps);
    assert.deepEqual(f.disk().tts_service_list, ['google_tts']);
    assert.equal(f.disk()['plugin.demo@a'], undefined);
    assert.equal(f.disk()['plugin.demo@b'], undefined);
    assert.ok(f.calls.indexOf('saved') < f.calls.indexOf('removed'));
    assert.equal(f.calls.at(-1), 'reload_plugin_list');
});
test('filesystem refusal restores persisted references and keeps instance settings', async () => {
    const f = fixture(['google_tts', 'plugin.demo@a']);
    f.deps.removePackage = async () => {
        throw new Error('disk refused');
    };
    await assert.rejects(() => uninstallPlugin(f.deps), /disk refused/);
    assert.deepEqual(f.disk().tts_service_list, ['google_tts', 'plugin.demo@a']);
    assert.equal(f.disk()['plugin.demo@a'].voice, 'saved');
});
test('failed configuration save never removes the package', async () => {
    const f = fixture(['google_tts', 'plugin.demo@a']);
    f.deps.store.save = async () => {
        throw new Error('save refused');
    };
    await assert.rejects(() => uninstallPlugin(f.deps), /save refused/);
    assert.ok(!f.calls.includes('removed'));
    assert.deepEqual(f.data.tts_service_list, ['google_tts', 'plugin.demo@a']);
});
test('plugin instance save commits settings and registration together; repeated save is idempotent', async () => {
    const f = fixture(['google_tts']);
    const args = { ...f.deps, key: 'plugin.demo@new', config: { voice: 'new' } };
    await savePluginInstance(args);
    await savePluginInstance(args);
    assert.deepEqual(f.disk().tts_service_list, ['google_tts', 'plugin.demo@new']);
    assert.deepEqual(f.disk()['plugin.demo@new'], { voice: 'new' });
});
test('failed instance save restores old in-memory state and leaves persisted configuration intact', async () => {
    const f = fixture(['google_tts']);
    f.deps.store.save = async () => {
        throw new Error('save refused');
    };
    await assert.rejects(
        () => savePluginInstance({ ...f.deps, key: 'plugin.demo@new', config: { voice: 'new' } }),
        /save refused/
    );
    assert.deepEqual(f.data.tts_service_list, ['google_tts']);
    assert.equal(f.data['plugin.demo@new'], undefined);
    assert.deepEqual(f.disk().tts_service_list, ['google_tts']);
});

test('batch install rejects invalid JS before replacement and continues with later packages', async () => {
    const { installPlugins } = await import('../src/utils/plugin_lifecycle.js');
    const installed = [];
    const results = await installPlugins({
        paths: ['good', 'bad', 'last'],
        invoke: async (command, args) => {
            if (command === 'inspect_plugin_entry')
                return { script: args.path === 'bad' ? 'function {' : 'function tts() {}', digest: 'checked' };
            assert.equal(args.entryChecks[args.pathList[0]], 'checked');
            installed.push(args.pathList[0]);
            return [{ path: args.pathList[0], success: true }];
        },
    });
    assert.deepEqual(installed, ['good', 'last']);
    assert.deepEqual(
        results.map((result) => result.success),
        [true, false, true]
    );
    assert.match(results[1].error, /SyntaxError/);
});
