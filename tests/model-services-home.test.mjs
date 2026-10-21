import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { localServiceSummary } from '../src/utils/modelServices.js';

test('the service dashboard manages the installed OPUS direction and preserves legacy family configuration', () => {
    assert.deepEqual(
        localServiceSummary('local_mt@legacy', {}, { 'zh-en': { installed: true }, 'en-zh': { installed: false } }),
        {
            family: 'opus',
            ready: true,
            checking: false,
            manageId: 'zh-en',
        }
    );
    assert.equal(localServiceSummary('local_mt@legacy', {}, {}).checking, true);
    assert.equal(localServiceSummary('local_mt@legacy', {}, { 'en-zh': { installed: true } }).manageId, 'en-zh');
    const multi = localServiceSummary('local_mt@multi', { model: 'm2m100' }, { m2m100: { installed: true } });
    assert.equal(multi.ready, true);
    assert.equal(multi.manageId, 'm2m100');
    assert.equal(localServiceSummary('google', {}, {}).family, null);
});
test('prototype dashboard and add flow use localized labels in every shipped locale', async () => {
    const source = await readFile('src/window/Config/pages/Models/ServicesHome.jsx', 'utf8');
    const keys = [...source.matchAll(/['"]models\.([a-z_]+)['"]/g)].map((match) => match[1]);
    for (const locale of ['zh_CN', 'zh_TW', 'en_US']) {
        const {
            translation: { models },
        } = JSON.parse(await readFile(`src/i18n/locales/${locale}.json`, 'utf8'));
        for (const key of keys) assert.ok(models[key], `${locale}: ${key}`);
        for (const key of [
            'wizard_subtitle',
            'wizard_next',
            'wizard_step_choose',
            'wizard_step_check',
            'wizard_step_install',
        ])
            assert.ok(models[key]);
    }
});
