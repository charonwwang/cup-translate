import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnkiNote } from '../src/services/collection/anki/note.js';

test('A09: user HTML is escaped, newlines preserved, absent audio and symbols are safe', () => {
    const note = buildAnkiNote('<script>&"\'\nword', {
        explanations: [{ trait: '<n>', explains: ['<img src=x>', 'a&b'] }],
        pronunciations: [{ region: '<UK>' }, { symbol: null, voice: 'https://audio.example/file' }],
    });
    assert.equal(note.fields.Front, '&lt;script&gt;&amp;&quot;&#39;<br>word');
    assert.equal(note.fields.Back, '&lt;n&gt;. &lt;img src=x&gt;; a&amp;b');
    assert.equal(note.fields.Symbol1, '[&lt;UK&gt;] ');
    assert.deepEqual(note.audio, []);
    assert.equal(buildAnkiNote('word', 'text\n<&').fields.Back, 'text<br>&lt;&amp;');
    assert.deepEqual(buildAnkiNote('word', null).audio, []);
});

test('audio accepts bytes, preserves 500KB compatibility, bounds size and fields, and uses safe unique names', () => {
    const bytes = new Array(500000).fill(65);
    const target = {
        pronunciations: [{ region: '../evil', symbol: 'hi', voice: bytes }, { voice: [1, 2, 3] }, { voice: [4] }],
    };
    const first = buildAnkiNote('../../<word>', target);
    const second = buildAnkiNote('../../<word>', target);
    assert.equal(first.audio.length, 2);
    assert.equal(Buffer.from(first.audio[0].data, 'base64').length, bytes.length);
    assert.deepEqual(first.audio[1].fields, ['Voice2']);
    assert.match(first.audio[0].filename, /^cup-[a-zA-Z0-9_-]+-1\.mp3$/);
    assert.notEqual(first.audio[0].filename, second.audio[0].filename);
    for (const voice of ['', undefined, 'https://a', [-1], [256], [1.1], new Array(10 * 1024 * 1024 + 1)]) {
        assert.deepEqual(buildAnkiNote('w', { pronunciations: [{ voice }] }).audio, []);
    }
});
