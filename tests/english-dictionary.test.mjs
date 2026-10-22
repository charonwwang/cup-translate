import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnglishDictionary } from '../src/utils/englishDictionary.js';
import { resolveSpeechService } from '../src/utils/speechService.js';
import { assertPolicy } from '../src/utils/requestPolicy.js';

test('dictionary preserves distinct IPA, regions and actual examples without trusting audio URLs', () => {
    const details = parseEnglishDictionary([
        {
            phonetics: [
                { text: '/treɪs/', audio: 'https://example.org/trace-us.mp3' },
                { text: '/treɪs/', audio: 'https://untrusted.example/' },
                { text: '/different/', audio: 'https://example.org/trace-uk.mp3' },
            ],
            meanings: [
                {
                    definitions: [
                        { example: 'No trace remained.' },
                        { example: 'No trace remained.' },
                        { example: 'Trace the line.' },
                    ],
                },
            ],
        },
    ]);
    assert.deepEqual(
        details.pronunciations.map((item) => item.region),
        ['US', 'UK']
    );
    assert.ok(details.pronunciations.every((item) => item.voice === ''));
    assert.deepEqual(details.sentence, [
        { source: 'No trace remained.', target: '' },
        { source: 'Trace the line.', target: '' },
    ]);
    assert.deepEqual(parseEnglishDictionary({ title: 'Not found' }), { pronunciations: [], sentence: [] });
});

test('native provider speech wins over every fallback preference, and generic providers use selected fallback', () => {
    for (const policy of ['engine', 'piper', 'kokoro', 'qwen', 'local', 'google', 'configured']) {
        assert.equal(resolveSpeechService('google', policy, ['piper_tts']), 'google_tts');
        assert.equal(resolveSpeechService('lingva', policy, ['piper_tts']), 'lingva_tts');
    }
    assert.equal(resolveSpeechService('local_mt', 'qwen'), 'qwen_tts');
    assert.equal(resolveSpeechService('local_mt', 'engine', ['piper_tts@voice']), 'piper_tts@voice');
    assert.equal(resolveSpeechService('openai', 'configured', ['qwen_tts']), 'qwen_tts');
    assert.equal(resolveSpeechService('google', 'off'), null);
    assert.doesNotThrow(() => assertPolicy('device_only', 'tts', 'qwen_tts'));
});
