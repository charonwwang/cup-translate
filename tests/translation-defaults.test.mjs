import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST } from '../src/services/translate/defaults.js';

test('local offline model and Google are the priority translation engines', async () => {
    // 用户需求：翻译引擎优先本地小模型 + 谷歌翻译
    // local_mt 需先下载模型（OPUS-MT CT2 int8，79MB），未下载时优雅跳过
    assert.deepEqual(DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST, ['google', 'local_mt']);
    for (const path of ['src/window/Translate/index.jsx', 'src/window/Config/pages/Service/Translate/index.jsx']) {
        const source = await readFile(path, 'utf8');
        assert.match(source, /DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST/);
    }
});

test('local_mt model status is checked before translation to avoid errors', async () => {
    // 未下载模型时优雅跳过（setSkipped），不抛错误
    const source = await readFile('src/window/Translate/components/TargetArea/index.jsx', 'utf8');
    assert.match(source, /local_mt_model_status/);
    assert.match(source, /setSkipped\(true\)/);
});

test('Yandex region restriction is reported concisely', async () => {
    const source = await readFile('src/services/translate/yandex/index.jsx', 'utf8');
    assert.match(source, /res\.status === 403 && res\.data\?\.message === 'Forbidden area'/);
    assert.match(source, /Yandex is unavailable in this region/);
});
