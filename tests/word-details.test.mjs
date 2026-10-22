import test from 'node:test';
import assert from 'node:assert/strict';
import { wordDetailsPrompt, parseWordDetails } from '../src/utils/wordDetails.js';
import { buildWordEntry } from '../src/window/Translate/resultView.js';
import { resolveSpeechService } from '../src/utils/speechService.js';
import { translationResultToText } from '../src/utils/translationResult.js';

test('adapted instruction models request dictionary data in the same word translation only', () => {
    assert.ok(wordDetailsPrompt('window', 'English', 'en'));
    assert.ok(wordDetailsPrompt('window', 'Auto', 'en'));
    assert.equal(wordDetailsPrompt('Please close the window.', 'English', 'en'), null);
    assert.equal(wordDetailsPrompt('你好', 'Chinese', 'zh_cn'), null);
    assert.match(wordDetailsPrompt('window', 'English', 'en').content, /omit uncertain IPA/);
});
test('validated model details feed the existing dictionary renderer without fake audio URLs', () => {
    const raw = JSON.stringify({
        translation: '窗口',
        explanations: [{ trait: 'n.', explains: ['窗户', '窗口'] }],
        pronunciations: [{ region: 'UK', symbol: '/ˈwɪndəʊ/', voice: 'https://untrusted.example/audio' }],
        sentence: [{ source: 'Close the window.', target: '关上窗户。' }],
    });
    const result = parseWordDetails(raw, true);
    const word = buildWordEntry(result, 'window');
    assert.equal(word.pronunciations[0].symbol, '/ˈwɪndəʊ/');
    assert.equal(word.pronunciations[0].voice, '');
    assert.equal(word.senses[0].pos, 'n.');
    assert.equal(word.examples[0].target, '关上窗户。');
    assert.equal(result.metadataSource, 'model');
    assert.equal(translationResultToText(result), 'n. 窗户；窗口');
    assert.equal(parseWordDetails('窗口', true), '窗口');
    assert.equal(parseWordDetails(raw, false), raw);
});
test('missing IPA remains absent and malformed data is bounded', () => {
    const result = parseWordDetails(
        JSON.stringify({
            translation: '窗口',
            pronunciations: [{ symbol: 7 }],
            sentence: [{ source: 'x'.repeat(1000) }],
        }),
        true
    );
    assert.deepEqual(result.pronunciations, []);
    assert.equal(result.sentence[0].source.length, 512);
    assert.equal(parseWordDetails('```json\n{"translation":"窗口"}\n```', true).explanations[0].explains[0], '窗口');
});
test('services without speech use configured fallbacks and off is respected', () => {
    assert.equal(resolveSpeechService('openai', 'engine', ['google_tts']), 'google_tts');
    assert.equal(resolveSpeechService('ollama', 'engine', []), null);
    assert.equal(resolveSpeechService('local_mt', 'google', []), 'google_tts');
    assert.equal(resolveSpeechService('openai', 'local', []), 'local_tts');
    assert.equal(resolveSpeechService('google', 'off', ['local_tts']), null);
    assert.equal(resolveSpeechService('source', 'configured', []), null);
});
