import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildParagraphEntry,
    buildPhraseEntry,
    buildSentencePairs,
    buildWordEntry,
    classifySourceText,
    splitSentences,
} from '../src/window/Translate/resultView.js';

test('input classification separates words, phrases, and paragraphs', () => {
    assert.equal(classifySourceText('query'), 'word');
    assert.equal(classifySourceText('take something into account'), 'phrase');
    assert.equal(
        classifySourceText('Good design is clear. It removes friction. Clarity is part of the product.'),
        'paragraph'
    );
    assert.equal(classifySourceText('第一句。第二句。'), 'paragraph');
});

test('sentence splitting keeps punctuation and line order', () => {
    assert.deepEqual(splitSentences('One. Two! 三。四？'), ['One.', 'Two!', '三。', '四？']);
});

test('paragraph comparison only pairs sentences when both sides align', () => {
    assert.deepEqual(buildSentencePairs('One. Two.', '一。二。'), [
        { source: 'One.', target: '一。' },
        { source: 'Two.', target: '二。' },
    ]);
    assert.deepEqual(buildSentencePairs('One. Two.', '合在一起。'), [{ source: 'One. Two.', target: '合在一起。' }]);
});

test('word entries normalize dictionary objects and plain string results', () => {
    const dictionary = buildWordEntry(
        {
            pronunciations: [{ region: 'US', symbol: '/ˈkwɪəri/' }],
            explanations: [{ trait: 'v.', explains: ['询问'] }],
            sentence: [{ source: 'A query.', target: '一个疑问。' }],
        },
        'query'
    );
    assert.equal(dictionary.word, 'query');
    assert.equal(dictionary.senses[0].meanings[0], '询问');
    assert.equal(dictionary.examples.length, 1);

    const plain = buildWordEntry('情态', 'modality', 'mōˈdalədē');
    assert.deepEqual(plain.pronunciations, [{ region: '', symbol: 'mōˈdalədē', voice: '' }]);
    assert.deepEqual(plain.senses, [{ pos: '', meanings: ['情态'] }]);
});

test('phrase and paragraph entries always expose copyable translation text', () => {
    assert.equal(buildPhraseEntry('考虑到；顾及').translation, '考虑到；顾及');
    assert.equal(
        buildPhraseEntry({
            explanations: [
                { trait: '动词短语', explains: ['考虑到'] },
                { trait: '书面', explains: ['顾及'] },
            ],
        }).alternatives[0].text,
        '顾及'
    );
    assert.equal(buildParagraphEntry('第一句。第二句。').translation, '第一句。第二句。');
});
