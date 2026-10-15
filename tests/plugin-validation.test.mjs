import assert from 'node:assert/strict';
import test from 'node:test';

import { validPluginName, validPluginType } from '../src/utils/plugin_validation.js';

test('plugin names reject path traversal and separators', () => {
    // Valid plugin names (mirror Rust valid_plugin_name)
    assert.equal(validPluginName('plugin-openai_2'), true);
    assert.equal(validPluginName('plugin-abc'), true);
    // Path traversal / separator injection must be rejected
    assert.equal(validPluginName('../../plugin-evil'), false);
    assert.equal(validPluginName('plugin/evil'), false);
    assert.equal(validPluginName('plugin..'), false);
    assert.equal(validPluginName('plugin\\evil'), false);
    // Must start with "plugin"
    assert.equal(validPluginName('openai'), false);
    assert.equal(validPluginName(''), false);
    assert.equal(validPluginName(undefined), false);
});

test('plugin types reject unknown and traversing values', () => {
    assert.equal(validPluginType('translate'), true);
    assert.equal(validPluginType('recognize'), true);
    assert.equal(validPluginType('tts'), true);
    assert.equal(validPluginType('collection'), true);
    assert.equal(validPluginType('../translate'), false);
    assert.equal(validPluginType(''), false);
    assert.equal(validPluginType(undefined), false);
});
