import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    LOCAL_MODEL_CATALOG,
    filterLocalCatalog,
    localTaskRunning,
    resumableModelBase,
} from '../src/utils/localModelCatalog.js';

test('catalog entries select individual pinned model packs with complete comparison metadata', () => {
    assert.deepEqual(
        LOCAL_MODEL_CATALOG.map((model) => model.id),
        ['hymt-q4', 'hymt-q8', 'm2m100', 'en-zh', 'zh-en']
    );
    for (const model of LOCAL_MODEL_CATALOG) {
        assert.ok(model.bytes > 0 && model.disk > model.bytes);
        for (const field of ['name', 'tag', 'scope', 'scenario', 'memory', 'license', 'author', 'languages'])
            assert.ok(model[field]);
    }
    assert.equal(LOCAL_MODEL_CATALOG.find((m) => m.id === 'en-zh').bytes, 82482557);
    assert.equal(LOCAL_MODEL_CATALOG.find((m) => m.id === 'zh-en').bytes, 82482840);
});
test('installed filtering and persisted task states do not mistake a staged model for an installed one', () => {
    const status = { m2m100: { installed: true }, 'en-zh': { installed: false, task: { state: 'paused' } } };
    assert.deepEqual(
        filterLocalCatalog(LOCAL_MODEL_CATALOG, status, true).map((m) => m.id),
        ['m2m100']
    );
    assert.equal(filterLocalCatalog(LOCAL_MODEL_CATALOG, status, false).length, 5);
    for (const state of ['queued', 'downloading', 'verifying', 'warming'])
        assert.equal(localTaskRunning({ task: { state } }), true);
    for (const state of ['paused', 'cancelled', 'failed', 'ready'])
        assert.equal(localTaskRunning({ task: { state } }), false);
});
test('all catalog comparison and management labels are localized', async () => {
    const ui = await readFile('src/window/Config/pages/Models/ModelCatalog.jsx', 'utf8');
    const keys = [...ui.matchAll(/t\('models\.([a-z_]+)'/g)].map((match) => match[1]);
    for (const locale of ['en_US', 'zh_CN', 'zh_TW']) {
        const {
            translation: { models },
        } = JSON.parse(await readFile(`src/i18n/locales/${locale}.json`, 'utf8'));
        for (const key of keys) assert.ok(models[key], `${locale}: ${key}`);
        for (const model of LOCAL_MODEL_CATALOG)
            for (const field of ['scope', 'scenario', 'memory', 'languages']) assert.ok(models[model[field]]);
    }
});

test('a paused custom download preserves its source when reopening management', () => {
    const base = 'https://example.org/model/revision';
    assert.equal(resumableModelBase({ task: { state: 'paused', origin: base } }), base);
    assert.equal(resumableModelBase({ task: { state: 'ready', origin: base } }), '');
    assert.equal(resumableModelBase({ task: { state: 'paused', origin: 'https://huggingface.co' } }), '');
    assert.equal(resumableModelBase({}), '');
});
