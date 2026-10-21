import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveLocalModel, multilingualLanguage } from '../src/services/translate/local_mt/options.js';
import { serviceEligibility } from '../src/utils/serviceEligibility.js';

const provider = {
    Language: {
        auto: 'auto',
        en: 'en',
        zh_cn: 'zh',
        zh_tw: 'zh',
        ja: 'ja',
        fr: 'fr',
        de: 'de',
        nn_no: 'nn',
        mn_mo: 'mn',
    },
};
const config = { model: 'm2m100' };
test('one multilingual model serves each selected direction without changing the target', () => {
    for (const [from, to] of [
        ['en', 'ja'],
        ['ja', 'fr'],
        ['fr', 'de'],
        ['zh_cn', 'ja'],
    ]) {
        assert.equal(resolveLocalModel(config, from, to), 'm2m100');
        assert.equal(
            serviceEligibility('local_mt@multilingual', config, from, to, 'device_only', provider, {
                m2m100: { installed: true },
            }),
            null
        );
    }
    assert.equal(
        serviceEligibility('local_mt@multilingual', config, 'ja', 'fr', 'device_only', provider, {
            'en-zh': { installed: true },
        }),
        'not_ready'
    );
});
test('unsupported language variants and unresolved detection never reach inference', () => {
    for (const [from, to] of [
        ['auto', 'fr'],
        ['en', 'zh_tw'],
        ['nn_no', 'en'],
        ['mn_mo', 'en'],
        ['en', 'en'],
        ['pt_br', 'pt_pt'],
    ]) {
        assert.equal(resolveLocalModel(config, from, to), null);
    }
    assert.equal(multilingualLanguage('pt-BR'), 'pt');
    assert.equal(multilingualLanguage('mn_cy'), 'mn');
    assert.equal(resolveLocalModel({ model: 'unknown' }, 'en', 'zh_cn'), null);
});
test('legacy OPUS configurations retain direction-specific downloads and filtering', () => {
    assert.equal(resolveLocalModel({}, 'en', 'zh_cn'), 'en-zh');
    assert.equal(resolveLocalModel({ model: 'opus' }, 'zh_cn', 'en'), 'zh-en');
    assert.equal(resolveLocalModel({}, 'ja', 'fr'), null);
    assert.equal(resolveLocalModel({}, 'en', 'zh_tw'), null);
});
test('the real provider passes selected languages to one native model and preserves thread/quality options', async () => {
    const text = await readFile('src/services/translate/local_mt/index.jsx', 'utf8');
    const body = text
        .replace(/^import .*;\n/gm, '')
        .replace(/^export \*.*;\n/gm, '')
        .replace('export async function translate', 'async function translate');
    const calls = [];
    const { localThreadCount } = await import('../src/services/translate/local_mt/options.js');
    const translate = new Function(
        'invoke',
        'resolveLocalModel',
        'multilingualLanguage',
        'localThreadCount',
        `${body};return translate;`
    )(
        async (...args) => {
            calls.push(args);
            return 'fixture translation';
        },
        resolveLocalModel,
        multilingualLanguage,
        localThreadCount
    );
    await translate('Bonjour', 'auto', 'ja', { detect: 'fr', config: { ...config, threads: '4', quality: 'fast' } });
    assert.deepEqual(calls, [
        [
            'local_mt_translate',
            { pair: 'm2m100', text: 'Bonjour', threads: 4, source: 'fr', target: 'ja', quality: 'fast' },
        ],
    ]);
    await assert.rejects(translate('text', 'en', 'zh_tw', { config }), /does not support/);
    assert.equal(calls.length, 1);
});

test('model management locates each family without reusing another model instance or resetting names', async () => {
    const { findLocalInstance } = await import('../src/utils/localModelInstance.js');
    const values = {
        translate_service_list: ['google', 'local_mt@multi', 'local_mt@legacy'],
        'local_mt@multi': { model: 'm2m100', instanceName: 'My multilingual model', quality: 'fast' },
        'local_mt@legacy': { instanceName: 'Legacy name', threads: '6' },
    };
    const store = { get: async (key) => values[key] ?? null };
    const multi = await findLocalInstance(store, 'm2m100');
    const opus = await findLocalInstance(store, 'opus');
    assert.equal(multi.key, 'local_mt@multi');
    assert.equal(opus.key, 'local_mt@legacy');
    assert.equal(opus.config.instanceName, 'Legacy name');
    assert.equal(multi.config.quality, 'fast');
    assert.equal((await findLocalInstance(store, 'unknown')).key, undefined);
});
