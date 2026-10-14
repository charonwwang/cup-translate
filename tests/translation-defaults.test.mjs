import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST } from '../src/services/translate/defaults.js';

test('a working translation result appears before region-restricted fallbacks on new installs', async () => {
    assert.deepEqual(DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST, ['google', 'yandex']);
    for (const path of [
        'src/window/Translate/index.jsx',
        'src/window/Config/pages/Service/Translate/index.jsx',
    ]) {
        const source = await readFile(path, 'utf8');
        assert.match(source, /DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST/);
    }
});

test('Yandex region restriction is reported concisely', async () => {
    const source = await readFile('src/services/translate/yandex/index.jsx', 'utf8');
    assert.match(source, /res\.status === 403 && res\.data\?\.message === 'Forbidden area'/);
    assert.match(source, /Yandex is unavailable in this region/);
});
