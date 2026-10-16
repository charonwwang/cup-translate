import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { translationResultToText } from '../src/utils/translationResult.js';
const code = (await readFile('src/utils/historyText.js', 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace('export function', 'function');
const historyResult = new Function('translationResultToText', `${code};return historyResult`)(translationResultToText);
test('history reads dictionary JSON as definitions while retaining ordinary text', () => {
    assert.equal(
        historyResult(JSON.stringify({ explanations: [{ trait: 'noun', explains: ['model', 'pattern'] }] })),
        'noun model；pattern'
    );
    assert.equal(historyResult('multimodal model'), 'multimodal model');
    assert.equal(historyResult('123'), '123');
});
