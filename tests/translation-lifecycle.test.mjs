import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequestCache } from '../src/utils/requestCache.js';
import { supplementTranslation } from '../src/utils/supplementTranslation.js';
import {
    resolveLocalModel,
    multilingualLanguage,
    localThreadCount,
} from '../src/services/translate/local_mt/options.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('plugin subprocesses are dispatched away from the window thread during continuous OCR', async () => {
    const source = await readFile('src-tauri/src/cmd.rs', 'utf8');
    assert.match(source, /pub async fn run_binary\([\s\S]*?spawn_blocking\(move/);
});
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

test('eligibility refresh preserves mounted cards while the local status query is pending', async () => {
    const source = await readFile('src/window/Translate/index.jsx', 'utf8');
    const marker = source.indexOf('        setCheckingServices(true);');
    const start = source.lastIndexOf('    useEffect(() => {', marker);
    const end = source.indexOf('    const primaryServiceKey', marker);
    const status = deferred();
    const updates = [];
    const environment = {
        useEffect: (fn) => fn(),
        setEligible: (value) => updates.push(value),
        setCheckingServices() {},
        serviceInstanceConfigMap: { local_mt: {} },
        pluginList: { translate: {} },
        privacyMode: 'standard',
        from: 'en',
        to: 'zh_cn',
        detected: 'en',
        sourceText: 'New text',
        translationLanguages: () => ({ source: 'en', target: 'zh_cn' }),
        translateServiceInstanceList: ['local_mt'],
        resolveLocalModel: () => 'en-zh',
        invoke: () => status.promise,
        providers: { local_mt: {} },
        serviceEligibility: () => false,
        secondLanguage: 'en',
        revision: 0,
        glossary: {},
    };
    new Function(...Object.keys(environment), source.slice(start, end))(...Object.values(environment));
    assert.deepEqual(updates, [], 'existing result cards must not unmount during refresh');
    status.resolve({ installed: true });
    await tick();
    assert.deepEqual(updates, [['local_mt']]);
});

async function sourceHarness({ plugin = false, incremental = false } = {}) {
    const source = await readFile('src/window/Translate/components/SourceArea/index.jsx', 'utf8');
    const start = source.indexOf('const handleNewText = async (text) => {');
    const end = source.indexOf('// Keep the native event listener stable', start);
    const ocr = deferred();
    let text = '';
    const environment = {
        inputEpoch: { current: 0 },
        invalidateRequests() {},
        hideWindow: false,
        appWindow: { show() {}, hide() {}, setFocus() {} },
        setDetectLanguage() {},
        setWindowType() {},
        setSourceText(value) {
            text = typeof value === 'function' ? value(text) : value;
        },
        syncSourceText() {},
        invoke: async () => 'image',
        recognizeServiceList: ['system'],
        getServiceSouceType: () => (plugin ? 'plugin' : 'builtin'),
        ServiceSourceType: { PLUGIN: 'plugin' },
        recognizeLanguage: 'en',
        getServiceName: (value) => value,
        serviceInstanceConfigMap: { system: {} },
        pluginList: { recognize: { system: { language: { en: 'en' } } } },
        invoke_plugin: async () => [() => ocr.promise, {}],
        recognizeServices: { system: { Language: { en: 'en' }, recognize: () => ocr.promise } },
        deleteNewline: false,
        incrementalTranslate: incremental,
        detect_language: async () => {},
        t: (key) => key,
    };
    const handle = new Function(...Object.keys(environment), `${source.slice(start, end)};return handleNewText;`)(
        ...Object.values(environment)
    );
    return { handle, ocr, text: () => text };
}

for (const plugin of [false, true]) {
    for (const incremental of [false, true]) {
        test(`stale ${plugin ? 'plugin' : 'builtin'} OCR cannot overwrite/append to newer input (incremental=${incremental})`, async () => {
            const harness = await sourceHarness({ plugin, incremental });
            await harness.handle('[IMAGE_TRANSLATE]');
            await harness.handle('new selection');
            harness.ocr.resolve('old screenshot');
            await tick();
            assert.equal(harness.text(), 'new selection');
        });
    }
    test(`stale ${plugin ? 'plugin' : 'builtin'} OCR errors cannot overwrite newer input`, async () => {
        const harness = await sourceHarness({ plugin });
        await harness.handle('[IMAGE_TRANSLATE]');
        await harness.handle('new selection');
        harness.ocr.reject(new Error('old OCR failed'));
        await tick();
        assert.equal(harness.text(), 'new selection');
    });
}

async function googleHarness(fetch) {
    const source = (await readFile('src/services/translate/google/index.jsx', 'utf8'))
        .replace(/^import .*;\n/gm, '')
        .replace(/^export \*.*;\n/gm, '')
        .replace(/^export /gm, '');
    return new Function('fetch', 'createRequestCache', `${source};return {translate, supplement};`)(
        fetch,
        createRequestCache
    );
}

test('Google returns main meanings before requesting example translations; supplementation is independent', async () => {
    const example = deferred();
    const queries = [];
    const data = [];
    data[0] = [['主释义'], [null, null, null, 'IPA']];
    data[1] = [['noun', null, [['主释义']]]];
    data[2] = 'en';
    data[13] = [[['An example sentence.']]];
    const google = await googleHarness(async (_url, options) => {
        queries.push(options.query.q);
        if (options.query.q === 'word') return { ok: true, data };
        return example.promise;
    });
    const main = await google.translate('word', 'en', 'zh');
    assert.deepEqual(queries, ['word']);
    assert.equal(main.explanations[0].explains[0], '主释义');
    assert.deepEqual(main.sentence, [{ source: 'An example sentence.', target: '' }]);
    const pending = google.supplement(main, 'en', 'zh', {});
    await tick();
    example.resolve({ ok: true, data: [[['例句译文']]] });
    const enriched = await pending;
    assert.equal(enriched.sentence[0].target, '例句译文');
    assert.equal(main.sentence[0].target, '', 'cached main result must not be mutated');
});

test('Google abort stops retries after an in-flight response and does not publish it', async () => {
    const response = deferred();
    const controller = new AbortController();
    let calls = 0;
    const google = await googleHarness(async () => {
        calls++;
        return response.promise;
    });
    const pending = google.translate('word', 'en', 'zh', { signal: controller.signal });
    await tick();
    controller.abort();
    response.resolve({ ok: false, status: 429 });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('optional example failures and late results preserve the main result', async () => {
    const main = { sentence: [{ source: 'Example.', target: '' }] };
    const controller = new AbortController();
    const response = deferred();
    let published = 0;
    const pending = supplementTranslation(
        { supplement: () => response.promise },
        main,
        'en',
        'zh',
        { signal: controller.signal },
        () => published++
    );
    controller.abort();
    response.resolve({ sentence: [{ source: 'Example.', target: 'late' }] });
    await pending;
    await supplementTranslation(
        {
            supplement: async () => {
                throw new Error('offline');
            },
        },
        main,
        'en',
        'zh',
        {},
        () => published++
    );
    assert.equal(published, 0);
    assert.equal(main.sentence[0].target, '');
});

async function localHarness(invoke) {
    const source = (await readFile('src/services/translate/local_mt/index.jsx', 'utf8'))
        .replace(/^import .*;\n/gm, '')
        .replace(/^export \*.*;\n/gm, '')
        .replace(/^export /gm, '');
    return new Function(
        'invoke',
        'resolveLocalModel',
        'multilingualLanguage',
        'localThreadCount',
        `${source};return translate;`
    )(invoke, resolveLocalModel, multilingualLanguage, localThreadCount);
}

test('aborting local translation cancels native work and settles without waiting for decoding', async () => {
    const native = deferred();
    const calls = [];
    const translate = await localHarness(async (command, args) => {
        calls.push([command, args]);
        if (command === 'local_mt_prepare_request') return 'request-1';
        if (command === 'local_mt_translate') return native.promise;
    });
    const controller = new AbortController();
    const pending = translate('Hello', 'en', 'zh', { signal: controller.signal, config: {} });
    await tick();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(calls.some(([command, args]) => command === 'local_mt_translate' && args.requestId === 'request-1'));
    assert.ok(calls.some(([command, args]) => command === 'local_mt_cancel_request' && args.requestId === 'request-1'));
    native.reject(new Error('native cancelled'));
    await tick();
});

test('cancellation during native registration prevents inference dispatch', async () => {
    const registration = deferred();
    const commands = [];
    const translate = await localHarness(async (command) => {
        commands.push(command);
        if (command === 'local_mt_prepare_request') return registration.promise;
    });
    const controller = new AbortController();
    const pending = translate('Hello', 'en', 'zh', { signal: controller.signal, config: {} });
    controller.abort();
    registration.resolve('request-2');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(commands, ['local_mt_prepare_request', 'local_mt_cancel_request']);
});
