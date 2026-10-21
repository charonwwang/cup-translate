import test from 'node:test';
import assert from 'node:assert/strict';
import { translationLanguages, automaticTargetLanguage } from '../src/utils/sourceLanguage.js';
import { serviceEligibility } from '../src/utils/serviceEligibility.js';

test('user source and target corrections replace stale detection without target fallback', () => {
    assert.deepEqual(translationLanguages('en', 'fr', 'zh_cn'), { source: 'en', target: 'zh_cn' });
    assert.deepEqual(translationLanguages('auto', 'en', 'en'), { source: 'en', target: 'en' });
    assert.deepEqual(translationLanguages('ja', 'en', 'fr'), { source: 'ja', target: 'fr' });
    assert.equal(automaticTargetLanguage('auto', 'zh_cn', 'zh_cn', 'en', true), 'zh_cn');
    assert.equal(automaticTargetLanguage('auto', 'zh_cn', 'zh_cn', 'en', false), 'en');
    assert.equal(automaticTargetLanguage('en', 'zh_cn', 'zh_cn', 'en', false), 'zh_cn');
});
test('language corrections change the eligible local direction while multilingual API services remain available', () => {
    const provider = {
        Language: {
            auto: 'auto',
            en: 'English',
            zh_cn: 'Chinese',
            zh_tw: 'Traditional Chinese',
            ja: 'Japanese',
            fr: 'French',
        },
    };
    const status = { 'en-zh': { installed: true }, 'zh-en': { installed: true } };
    const config = { requestPath: 'http://localhost:1234/v1', allowAnonymous: true };
    const eligible = (key, source, target) =>
        !serviceEligibility(key, config, source, target, 'standard', provider, status);
    assert.equal(eligible('local_mt', 'fr', 'zh_cn'), false);
    assert.equal(eligible('local_mt', 'en', 'zh_cn'), true);
    assert.equal(eligible('local_mt', 'zh_cn', 'en'), true);
    assert.equal(eligible('local_mt', 'en', 'ja'), false);
    assert.equal(eligible('local_mt', 'en', 'zh_tw'), false);
    assert.equal(eligible('openai', 'en', 'ja'), true);
    assert.equal(eligible('openai', 'ja', 'fr'), true);
});
