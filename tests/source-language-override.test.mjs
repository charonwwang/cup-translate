import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getActiveSourceLanguage } from '../src/utils/sourceLanguage.js';

test('a manually selected source language wins over a stale detection result', () => {
    assert.equal(getActiveSourceLanguage('en', 'it'), 'en');
});

test('automatic mode uses the detected language', () => {
    assert.equal(getActiveSourceLanguage('auto', 'it'), 'it');
});

test('a manual selection works even when detection is empty', () => {
    assert.equal(getActiveSourceLanguage('en', ''), 'en');
});

test('automatic mode with no detection returns an empty language', () => {
    assert.equal(getActiveSourceLanguage('auto', ''), '');
    assert.equal(getActiveSourceLanguage(undefined, ''), '');
});

test('source label and speech resolve the same effective language', async () => {
    const sourceArea = await readFile('src/window/Translate/components/SourceArea/index.jsx', 'utf8');
    const targetArea = await readFile('src/window/Translate/components/TargetArea/index.jsx', 'utf8');

    assert.match(
        sourceArea,
        /const activeSourceLanguage = getActiveSourceLanguage\(sourceLanguage, detectLanguage\)/,
        'SourceArea must derive one effective language for both the label and speech'
    );
    assert.match(
        sourceArea,
        /let speechLanguage = activeSourceLanguage/,
        'the source speech button must not keep using detectLanguage directly'
    );
    assert.doesNotMatch(
        sourceArea,
        /t\(`languages\.\$\{detectLanguage\}`\)/,
        'the manual source selection must replace the previous detection in the chip'
    );
    assert.match(
        targetArea,
        /speakWithService\(sourceText\.trim\(\), activeSourceLanguage\)/,
        'the word pronunciation button must use the effective source language'
    );
});
