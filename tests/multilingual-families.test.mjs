import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalModel, hyLanguage } from '../src/services/translate/local_mt/options.js';
import { localServiceSummary } from '../src/utils/modelServices.js';
import { filterKokoroVoices, speechLanguageKey, isKokoroBusy } from '../src/utils/multilingualVoices.js';
import { resolveSpeechService } from '../src/utils/speechService.js';
import { assertPolicy } from '../src/utils/requestPolicy.js';
import { readFile } from 'node:fs/promises';
test('HY-MT specification follows its service instance while language stays in the translation window', () => {
    assert.equal(resolveLocalModel({ model: 'hymt' }, 'en', 'ja'), 'hymt-q4');
    assert.equal(resolveLocalModel({ model: 'hymt', variant: 'hymt-q8' }, 'fr', 'zh_tw'), 'hymt-q8');
    assert.equal(resolveLocalModel({ model: 'hymt' }, 'auto', 'fr'), null);
    assert.equal(resolveLocalModel({ model: 'hymt' }, 'en', 'sv'), null);
    assert.equal(resolveLocalModel({ model: 'hymt' }, 'en', 'en'), null);
    assert.equal(hyLanguage('zh-TW'), 'zh_tw');
    assert.equal(resolveLocalModel({ model: 'm2m100' }, 'en', 'zh_tw'), null);
    assert.equal(resolveLocalModel({}, 'en', 'zh_cn'), 'en-zh');
    const summary = localServiceSummary(
        'local_mt@hy',
        { model: 'hymt', variant: 'hymt-q8' },
        { 'hymt-q4': { installed: true }, 'hymt-q8': { installed: false } }
    );
    assert.equal(summary.ready, false);
    assert.equal(summary.manageId, 'hymt-q8');
});
test('one multilingual TTS family routes speech independently of its translating engine', () => {
    for (const engine of ['source', 'google', 'local_mt', 'openai'])
        assert.equal(resolveSpeechService(engine, 'kokoro', []), engine === 'google' ? 'google_tts' : 'kokoro_tts');
    assert.doesNotThrow(() => assertPolicy('device_only', 'tts', 'kokoro_tts'));
    assert.throws(() => assertPolicy('device_only', 'tts', 'kokoro-custom'));
    assert.equal(speechLanguageKey('zh_TW'), 'zh');
    assert.equal(speechLanguageKey('pt-BR'), 'pt');
    assert.deepEqual(
        filterKokoroVoices(
            [
                { sid: 3, name: 'af_heart', language: 'en' },
                { sid: 45, name: 'zf_xiaobei', language: 'zh' },
            ],
            'zh_cn'
        ).map((v) => v.sid),
        [45]
    );
    assert.equal(isKokoroBusy({ task: { state: 'checking' } }), true);
    assert.equal(isKokoroBusy({ task: { state: 'cancelled' } }), false);
});
test('Kokoro is one pinned package with shared speaker embeddings and seven verified language frontends', async () => {
    const m = JSON.parse(await readFile('src-tauri/resources/kokoro-model.json', 'utf8'));
    const voices = JSON.parse(await readFile('src-tauri/resources/kokoro-voices.json', 'utf8'));
    assert.ok(m.archiveBytes > 100_000_000);
    assert.match(m.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(m.files.filter((f) => f.name === 'model.int8.onnx').length, 1);
    assert.equal(m.files.filter((f) => f.name === 'voices.bin').length, 1);
    assert.deepEqual([...new Set(voices.map((v) => v.language))].sort(), ['en', 'es', 'fr', 'hi', 'it', 'pt', 'zh']);
    for (const v of voices) {
        assert.ok(v.sample && v.bytes > 0);
        assert.match(v.sha256, /^[a-f0-9]{64}$/);
    }
});
