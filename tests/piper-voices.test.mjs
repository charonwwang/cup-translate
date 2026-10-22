import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preferredPiperVoice, piperTaskActive, voiceBytes } from '../src/utils/piperVoices.js';
import { resolveSpeechService } from '../src/utils/speechService.js';
import { assertPolicy } from '../src/utils/requestPolicy.js';

test('Piper preferences follow each spoken language and preserve locale boundaries', () => {
    const prefs = { en: 'en_GB-alba-medium', zh: 'zh_CN-huayan-medium', fr: 'fr_FR-siwis-medium' };
    assert.equal(preferredPiperVoice(prefs, 'en-US'), 'en_GB-alba-medium');
    assert.equal(preferredPiperVoice(prefs, 'ZH_tw'), 'zh_CN-huayan-medium');
    assert.equal(preferredPiperVoice(prefs, 'cmn'), 'zh_CN-huayan-medium');
    assert.equal(preferredPiperVoice(prefs, 'fr'), 'fr_FR-siwis-medium');
    assert.equal(preferredPiperVoice(prefs, 'ja'), null);
    assert.equal(preferredPiperVoice(prefs, 'yue'), null);
    assert.equal(preferredPiperVoice(prefs, 'auto'), null);
    assert.equal(preferredPiperVoice(null, 'en'), null);
});
test('Piper is an explicit offline choice independent of translation engine', () => {
    for (const engine of ['google', 'local_mt', 'openai', 'source'])
        assert.equal(resolveSpeechService(engine, 'piper', []), engine === 'google' ? 'google_tts' : 'piper_tts');
    assert.doesNotThrow(() => assertPolicy('device_only', 'tts', 'piper_tts'));
    assert.throws(() => assertPolicy('device_only', 'tts', 'piper-plugin'));
    assert.equal(resolveSpeechService('source', 'off', ['piper_tts']), null);
});
test('voice catalog uses pinned hashes, full cards, real sizes and no Japanese placeholder', async () => {
    const voices = JSON.parse(await readFile('src-tauri/resources/piper-catalog.json', 'utf8'));
    assert.equal(voices.length, 9);
    assert.equal(new Set(voices.map((v) => v.language)).size, 8);
    for (const v of voices) {
        assert.ok(v.base.startsWith('https://huggingface.co/'));
        assert.ok(v.base.includes(v.revision));
        assert.equal(v.revision.length, 40);
        assert.ok(v.modelCard.includes('License:'));
        assert.ok(voiceBytes(v) > 10_000_000);
        for (const a of v.files) {
            assert.match(a.sha256, /^[a-f0-9]{64}$/);
            assert.ok(a.bytes > 0);
        }
    }
    assert.match(voices.find((v) => v.language === 'zh').modelCard, /License: Unknown/);
    assert.equal(piperTaskActive({ state: 'downloading' }), true);
    assert.equal(piperTaskActive({ state: 'checking' }), true);
    assert.equal(piperTaskActive({ state: 'cancelled' }), false);
});

test('speech preferences transfer without moving downloaded models or changing existing defaults', async () => {
    const { createConfigTransfer, parseConfigTransfer } = await import('../src/utils/configTransfer.js');
    const settings = {
        speech_policy: 'piper',
        piper_voices: { en: 'en_GB-alba-medium', zh: 'zh_CN-huayan-medium' },
        tts_service_list: ['local_tts'],
    };
    const result = parseConfigTransfer(createConfigTransfer(settings));
    assert.deepEqual(result, settings);
    assert.equal(result.tts_service_list[0], 'local_tts');
});
