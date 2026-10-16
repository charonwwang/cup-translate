import assert from 'node:assert/strict';
import test from 'node:test';
import { localThreadCount, resolveLocalPair } from '../src/services/translate/local_mt/options.js';

test('local models are checked for the requested direction, not hardcoded en-zh', () => {
    assert.equal(resolveLocalPair('en', 'zh_cn'), 'en-zh');
    assert.equal(resolveLocalPair('zh_tw', 'en'), 'zh-en');
    assert.equal(resolveLocalPair('cmn', 'en-US'), 'zh-en');
    assert.equal(resolveLocalPair('auto', 'zh'), null);
    assert.equal(resolveLocalPair('fr', 'zh'), null);
    assert.equal(resolveLocalPair('zh', 'zh_cn'), null);
});

test('frontend thread settings match the native two-thread default and reject bad input', () => {
    for (const input of [undefined, '', 'bad', -5, 0]) assert.equal(localThreadCount(input), 2);
    assert.equal(localThreadCount('4'), 4);
    assert.equal(localThreadCount('999999'), 64);
    assert.equal(localThreadCount('1.9'), 1);
});
