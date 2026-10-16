import assert from 'node:assert/strict';
import test from 'node:test';
import { translationResultToText } from '../src/utils/translationResult.js';

test('dictionary copy retains all senses and parts of speech, including secondary definitions', () => {
    assert.equal(
        translationResultToText({
            explanations: [
                { trait: '名词', explains: ['术语', '学期', '期限', '条款'] },
                { trait: '动词', explains: ['称为'] },
            ],
        }),
        '名词 术语；学期；期限；条款\n动词 称为'
    );
});

test('plain translations preserve paragraphs and empty dictionary entries do not leak objects', () => {
    assert.equal(translationResultToText('第一段\n\n第二段'), '第一段\n\n第二段');
    assert.equal(
        translationResultToText({ explanations: [{ trait: 'n.', explains: [] }, { explains: ['术语'] }] }),
        '术语'
    );
    assert.equal(translationResultToText({}), '');
    assert.equal(translationResultToText(null), '');
});
