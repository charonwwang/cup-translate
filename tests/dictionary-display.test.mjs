import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as view from '../src/window/Translate/resultView.js';
import * as dictionary from '../src/window/Translate/dictionarySupplement.js';
import { createCollectionGate } from '../src/services/collection/pending.js';
import { resolveSpeechService, speechText } from '../src/utils/speechService.js';
import { translationResultToText } from '../src/utils/translationResult.js';
import { getActiveSourceLanguage } from '../src/utils/sourceLanguage.js';

const requireVite = createRequire(import.meta.resolve('vite'));
const { transformSync } = requireVite('esbuild');
const source = readFileSync('src/window/Translate/components/TargetArea/index.jsx', 'utf8');
const compiled = transformSync(
    source.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '').replace('export default function', 'function'),
    { loader: 'jsx' }
).code;

function render({
    text,
    language,
    result = '成功译文',
    privacyMode = 'normal',
    speech = 'local_tts',
    dictionaryState,
    cachedPronunciation = '',
}) {
    const calls = [];
    const pronunciationQueries = [];
    const speechKeys = [];
    let state = 0;
    const env = {
        ...view,
        ...dictionary,
        createCollectionGate,
        resolveSpeechService,
        speechText,
        translationResultToText,
        getActiveSourceLanguage,
        React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
        useState: (initial) => {
            const index = state++;
            return [index === 5 ? result : index === 2 && dictionaryState ? dictionaryState : initial, () => {}];
        },
        useRef: (current) => ({ current }),
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useConfig: (key, fallback) => [
            { tts_service_list: [speech], collection_service_list: ['anki'] }[key] ?? fallback,
        ],
        useAtomValue: (key) =>
            ({ sourceText: text, sourceLanguage: language, targetLanguage: 'zh_cn', detectLanguage: language })[key],
        sourceTextAtom: 'sourceText',
        sourceLanguageAtom: 'sourceLanguage',
        targetLanguageAtom: 'targetLanguage',
        detectLanguageAtom: 'detectLanguage',
        useTranslation: () => ({ t: (key) => key }),
        useToastStyle: () => ({}),
        useSpeech: (key) => {
            speechKeys.push(key);
            return {
                status: 'idle',
                stop() {},
                toggle: async (load) => {
                    await load();
                },
            };
        },
        getServiceName: (key) => key,
        getDisplayInstanceName: (_name, fallback) => fallback(),
        getServiceSouceType: () => 'builtin',
        ServiceSourceType: { PLUGIN: 'plugin' },
        whetherPluginService: () => false,
        INSTANCE_NAME_CONFIG_KEY: 'name',
        builtinServices: {
            local_mt: {
                info: { icon: '' },
                Language: { en: 'en', zh_cn: 'zh-CN' },
                translate: {
                    pronunciationFor: (...args) => {
                        pronunciationQueries.push(args);
                        return cachedPronunciation;
                    },
                },
            },
            google: { translate() {}, Language: {} },
        },
        builtinTtsServices: {
            local_tts: { Language: { en: 'en', zh_cn: 'zh_cn' }, tts: async (...args) => calls.push(args) },
        },
        builtinCollectionServices: { anki: { info: { icon: '' }, collection: async (...args) => calls.push(args) } },
        toast: {
            success() {},
            error: (error) => {
                throw new Error(error);
            },
        },
        logError() {},
    };
    for (const name of [
        'Dropdown',
        'DropdownItem',
        'DropdownMenu',
        'DropdownTrigger',
        'Tooltip',
        'SpeechPreference',
        ...source.match(/\bLu\w+/g),
    ])
        env[name] = name;
    const component = new Function('env', `with(env) { ${compiled}; return TargetArea; }`)(env);
    const tree = component({
        name: 'local_mt',
        index: 0,
        privacyMode,
        serviceInstanceConfigMap: {},
        pluginList: {},
        translateServiceInstanceList: ['local_mt'],
    });
    const nodes = [];
    function walk(node) {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
            nodes.push(node);
            node.children?.forEach(walk);
        }
    }
    walk(tree);
    return {
        tree,
        nodes,
        calls,
        pronunciationQueries,
        speechKeys,
        labels: nodes.map((node) => node.props['aria-label']).filter(Boolean),
        text: JSON.stringify(tree),
    };
}

test('language-aware input classification never infers a word from missing spaces', () => {
    for (const [text, lang, mode] of [
        ['hello', 'en', 'word'],
        ["don't", 'en_US', 'word'],
        ['卸载向导', 'zh_cn', 'text'],
        ['你好', 'zh_cn', 'text'],
        ['hello', '', 'text'],
        ['hello', 'auto', 'text'],
        ['bonjour', 'fr', 'phrase'],
        ['uninstall wizard', 'en', 'phrase'],
        ['Please uninstall the wizard.', 'en', 'sentence'],
        ['请卸载向导。', 'zh_cn', 'sentence'],
        ['One. Two.', 'en', 'paragraph'],
    ])
        assert.equal(view.classifySourceText(text, lang), mode, text);
});

test('switching the source text invalidates source, example and translated audio owners', () => {
    const oldCard = render({ text: '这是一段旧的中文长文本。', language: 'zh_cn' });
    const current = render({ text: 'performance', language: 'en' });
    for (let index = 0; index < 3; index++) assert.notEqual(oldCard.speechKeys[index], current.speechKeys[index]);
});

test('W01–W03: real card render names source/target actions and only English words show missing IPA', async () => {
    for (const [text, language] of [
        ['hello', 'en'],
        ['卸载向导', 'zh_cn'],
        ['uninstall wizard', 'en'],
        ['Please uninstall the wizard.', 'en'],
    ]) {
        const card = render({ text, language, privacyMode: 'device_only' });
        assert.ok(card.labels.includes('translate.speak_source'), text);
        assert.equal(card.text.includes('models.no_phonetics'), text === 'hello');
        card.nodes.find((node) => node.props['aria-label'] === 'translate.speak_source').props.onClick();
        await new Promise(setImmediate);
        assert.deepEqual(card.calls[0].slice(0, 2), [text, language]);
        assert.ok(card.text.includes('成功译文'));
        if (text === 'hello')
            assert.ok(card.nodes.find((node) => node.props.title === 'models.google_blocked').props.disabled);
    }
});

test('IPA is displayed without treating synthetic TTS as a regional recording; URL audio is never fetched', () => {
    const result = {
        pronunciations: [{ symbol: '/həˈləʊ/', region: 'UK', voice: 'https://example.invalid/audio' }],
        explanations: [{ trait: 'n.', explains: ['你好'] }],
    };
    const card = render({ text: 'hello', language: 'en', result });
    assert.ok(card.text.includes('/həˈləʊ/'));
    assert.equal(card.labels.filter((label) => label === 'translate.speak_source').length, 1);
    assert.equal(dictionary.dictionaryAudioBytes(result.pronunciations[0].voice, 'normal'), null);
    assert.equal(dictionary.dictionaryAudioBytes([1, 2], 'device_only'), null);
    assert.deepEqual(dictionary.dictionaryAudioBytes([1, 2], 'normal'), [1, 2]);
});

test('W06: collection receives the successful original payload with and without phonetics', async () => {
    for (const result of [
        '你好',
        { pronunciations: [{ symbol: '/həˈləʊ/' }], explanations: [{ explains: ['你好'] }] },
    ]) {
        const card = render({ text: 'hello', language: 'en', result });
        const button = card.nodes.find(
            (node) =>
                node.type === 'button' && node.props.onClick && node.children.some((child) => child?.type === 'img')
        );
        await button.props.onClick();
        assert.equal(card.calls[0][1], result);
    }
});

const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const tick = () => new Promise(setImmediate);

test('W04: empty and failed lookups change only optional metadata', async () => {
    for (const lookup of [
        async () => '普通译文',
        async () => {
            throw new Error('unavailable');
        },
    ]) {
        const events = [];
        const task = dictionary.createDictionarySupplement({ publish: (value) => events.push(value) });
        await task.run({ checkPolicy: async () => {}, lookup });
        assert.ok(['empty', 'failed'].includes(events.at(-1).status));
        assert.equal(events.at(-1).value, null);
    }
});

test('W04: changing text/language or retrying discards late lookup and enrichment results', async () => {
    for (const stage of ['lookup', 'enrich']) {
        const old = deferred();
        const events = [];
        const task = dictionary.createDictionarySupplement({ publish: (value) => events.push(value) });
        const first = task.run({
            checkPolicy: async () => {},
            lookup: () => (stage === 'lookup' ? old.promise : {}),
            enrich: stage === 'enrich' ? () => old.promise : undefined,
        });
        await tick();
        task.cancel();
        await task.run({
            checkPolicy: async () => {},
            lookup: async () => ({ pronunciations: [{ symbol: '/new/' }] }),
        });
        old.resolve({ pronunciations: [{ symbol: '/old/' }] });
        await first;
        assert.equal(events.at(-1).value.pronunciations[0].symbol, '/new/');
    }
});

test('W04: deadline clears loading and rejects late data even when provider ignores abort', async () => {
    const old = deferred();
    const events = [];
    const task = dictionary.createDictionarySupplement({ publish: (value) => events.push(value), timeoutMs: 5 });
    const pending = task.run({ checkPolicy: async () => {}, lookup: () => old.promise });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(events.at(-1).status, 'timeout');
    old.resolve({ pronunciations: [{ symbol: '/late/' }] });
    await pending;
    assert.equal(events.at(-1).status, 'timeout');
});

test('W05: device-only and policy change while checking send no lookup or enrichment request', async () => {
    let calls = 0;
    const events = [];
    const task = dictionary.createDictionarySupplement({ publish: (value) => events.push(value) });
    const options = {
        lookup: async () => {
            calls++;
        },
        enrich: async () => {
            calls++;
        },
        checkPolicy: async () => {},
    };
    await task.run({ ...options, privacyMode: 'device_only' });
    assert.equal(events.at(-1).status, 'blocked');
    const policy = deferred();
    const pending = task.run({ ...options, checkPolicy: () => policy.promise });
    task.cancel();
    policy.resolve();
    await pending;
    assert.equal(calls, 0);
});

test('a new card immediately hides dictionary metadata owned by the old text or language', () => {
    const old = {
        key: JSON.stringify(['hello', 'en', 'zh_cn', 'local_mt', null, 'normal']),
        status: 'ready',
        value: { pronunciations: [{ symbol: '/old/' }] },
    };
    for (const [text, language] of [
        ['world', 'en'],
        ['hello', 'fr'],
    ]) {
        const card = render({ text, language, dictionaryState: old });
        assert.ok(!card.text.includes('/old/'));
    }
});

test('failed optional metadata leaves the rendered translation and original/target speech actions usable', async () => {
    const card = render({
        text: 'hello',
        language: 'en',
        dictionaryState: {
            key: JSON.stringify(['hello', 'en', 'zh_cn', 'local_mt', null, 'normal']),
            status: 'failed',
            value: null,
        },
    });
    assert.ok(card.text.includes('models.dictionary_failed'));
    assert.ok(card.text.includes('成功译文'));
    card.nodes.find((node) => node.props['aria-label'] === 'translate.speak_target').props.onClick();
    await tick();
    assert.deepEqual(card.calls[0].slice(0, 2), ['成功译文', 'zh_cn']);
});

test('supplied non-English pronunciations remain visible without missing-English-IPA warnings', () => {
    for (const [text, language, symbol] of [
        ['卸载向导', 'zh_cn', 'Xièzài xiàngdǎo'],
        ['bonjour', 'fr', '/bɔ̃ʒuʁ/'],
        ['请卸载向导。', 'zh_cn', 'Qǐng xièzài xiàngdǎo'],
    ]) {
        const card = render({
            text,
            language,
            result: { pronunciations: [{ symbol }], explanations: [{ explains: ['译文'] }] },
        });
        assert.ok(card.text.includes(symbol));
        assert.ok(!card.text.includes('models.no_phonetics'));
        assert.ok(!card.text.includes('translate.play_recording'));
    }
});

test('cached provider pronunciation is displayed for Chinese text without an extra dictionary request', () => {
    const card = render({
        text: '卸载向导',
        language: 'zh_cn',
        result: 'Uninstall wizard',
        cachedPronunciation: 'Xièzài xiàngdǎo',
    });
    assert.ok(card.text.includes('Xièzài xiàngdǎo'));
    assert.ok(card.text.includes('Uninstall wizard'));
    assert.ok(!card.text.includes('models.no_phonetics'));
    assert.deepEqual(card.pronunciationQueries, [['卸载向导', 'zh-CN', 'zh-CN']]);
    assert.deepEqual(card.calls, []);
});
