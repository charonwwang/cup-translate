import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQwenList, migrateQwenSettings, saveQwenSettings } from '../src/utils/qwenConfig.js';
import { resolveSpeechService } from '../src/utils/speechService.js';
function fixture(initial, fail = false) {
    const memory = new Map(Object.entries(structuredClone(initial)));
    let disk = structuredClone(initial),
        saves = 0;
    const events = [];
    const store = {
        get: async (key) => structuredClone(memory.get(key) ?? null),
        set: async (key, value) => memory.set(key, structuredClone(value)),
        delete: async (key) => memory.delete(key),
        save: async () => {
            saves++;
            if (fail) throw new Error('disk full');
            disk = Object.fromEntries(memory);
        },
    };
    return { store, emit: async (...args) => events.push(args), events, memory, disk: () => disk, saves: () => saves };
}
test('Q07: migration preserves first position, global config, legacy history and model state; second run is a no-op', async () => {
    const config = { variant: '1.7B', voice: 'Ryan' };
    const f = fixture({
        tts_service_list: ['local_tts@a', 'qwen_tts@old', 'google_tts', 'qwen_tts', 'qwen_tts@two'],
        qwen_tts: config,
        history: [{ speech: 'qwen_tts@old' }],
        models: ['0.6B', '1.7B'],
    });
    await migrateQwenSettings(f.store, f.emit);
    await migrateQwenSettings(f.store, f.emit);
    assert.deepEqual(f.disk().tts_service_list, ['local_tts@a', 'qwen_tts', 'google_tts']);
    assert.deepEqual(f.disk().qwen_tts, config);
    assert.deepEqual(f.disk().models, ['0.6B', '1.7B']);
    assert.equal(f.disk().history[0].speech, 'qwen_tts@old');
    assert.equal(f.saves(), 1);
    assert.equal(resolveSpeechService('hy_mt', 'configured', ['qwen_tts@old']), 'qwen_tts');
});
test('Q07: legacy registration without global config does not invent a configured model', async () => {
    const f = fixture({ tts_service_list: ['qwen_tts@a', 'qwen_tts@b'] });
    await migrateQwenSettings(f.store, f.emit);
    assert.equal(await f.store.get('qwen_tts'), null);
    assert.deepEqual(canonicalQwenList(f.disk().tts_service_list), ['qwen_tts']);
});
test('Q03: save and register atomically, enable only on explicit request, survive reload', async () => {
    const f = fixture({ tts_service_list: ['google_tts'], speech_policy: 'local' });
    await saveQwenSettings(f.store, f.emit, { variant: '0.6B', voice: 'Serena' }, { register: true });
    assert.equal(f.disk().speech_policy, 'local');
    assert.deepEqual(f.disk().tts_service_list, ['google_tts', 'qwen_tts']);
    await saveQwenSettings(f.store, f.emit, { variant: '1.7B', voice: 'Ryan' }, { enable: true });
    const reloaded = fixture(f.disk());
    assert.equal(await reloaded.store.get('speech_policy'), 'qwen');
    assert.equal((await reloaded.store.get('qwen_tts')).voice, 'Ryan');
    assert.deepEqual(await reloaded.store.get('tts_service_list'), ['google_tts', 'qwen_tts']);
});
test('Q02/Q04: model-center configuration save preserves list and policy', async () => {
    const f = fixture({ tts_service_list: ['google_tts'], speech_policy: 'engine' });
    await saveQwenSettings(f.store, f.emit, { voice: 'Eric', variant: '0.6B' });
    assert.deepEqual(f.disk().tts_service_list, ['google_tts']);
    assert.equal(f.disk().speech_policy, 'engine');
});
test('Q06: disk failure restores all memory settings and publishes no success; draft remains retryable', async () => {
    const initial = {
        tts_service_list: ['google_tts'],
        speech_policy: 'engine',
        qwen_tts: { voice: 'Vivian', variant: '0.6B' },
    };
    const f = fixture(initial, true);
    const draft = { voice: 'Dylan', variant: '1.7B' };
    await assert.rejects(saveQwenSettings(f.store, f.emit, draft, { enable: true }), /disk full/);
    assert.deepEqual(Object.fromEntries(f.memory), initial);
    assert.deepEqual(f.disk(), initial);
    assert.deepEqual(f.events, []);
    assert.equal(draft.voice, 'Dylan');
});
test('failed first-time save removes staged settings instead of leaving a fake configured service', async () => {
    const f = fixture({ tts_service_list: ['google_tts'] }, true);
    await assert.rejects(saveQwenSettings(f.store, f.emit, { voice: 'Ryan' }, { register: true }));
    assert.equal(await f.store.get('qwen_tts'), null);
    assert.deepEqual(await f.store.get('tts_service_list'), ['google_tts']);
});
test('post-commit notification failure does not report a successfully persisted save as failed', async () => {
    const f = fixture({ tts_service_list: ['google_tts'] });
    await saveQwenSettings(
        f.store,
        async () => {
            throw new Error('window closed');
        },
        { voice: 'Ryan', variant: '0.6B' },
        { enable: true }
    );
    assert.equal(f.disk().speech_policy, 'qwen');
    assert.equal(f.disk().qwen_tts.voice, 'Ryan');
});
