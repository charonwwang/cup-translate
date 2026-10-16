import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeechService, speechText } from '../src/utils/speechService.js';
import { normalizeShortcut } from '../src/utils/shortcut.js';
test('speech follows providers and local models require explicit voice choice', () => {
    assert.equal(resolveSpeechService('google', 'engine', ['local_tts']), 'google_tts');
    assert.equal(resolveSpeechService('lingva', 'engine'), 'lingva_tts');
    assert.equal(resolveSpeechService('local_mt', 'engine', ['google_tts']), null);
    assert.equal(resolveSpeechService('local_mt', 'engine', null), null);
    assert.equal(resolveSpeechService('local_mt', 'google'), 'google_tts');
    assert.equal(resolveSpeechService('local_mt', 'engine', ['local_tts']), 'local_tts');
});
test('dictionary speech and reverse translation contain definitions without grammatical labels', () => {
    assert.equal(speechText({ explanations: [{ trait: 'noun', explains: ['model', 'pattern'] }] }), 'model；pattern');
    assert.equal(speechText(' translated '), 'translated');
    assert.equal(speechText(null), '');
});
test('shortcut aliases and modifier order compare equally', () => {
    assert.equal(normalizeShortcut('Command+Shift+T'), normalizeShortcut('shift+cmd+t'));
    assert.equal(normalizeShortcut(null), '');
    assert.notEqual(normalizeShortcut('Alt+T'), normalizeShortcut('Alt+Shift+T'));
});
