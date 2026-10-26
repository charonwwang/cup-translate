import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('promoting a secondary engine to primary restarts its request with the current display role', async () => {
    const source = await readFile('src/window/Translate/components/TargetArea/index.jsx', 'utf8');
    const start = source.indexOf('    useEffect(() => {', source.indexOf('// listen to translation'));
    const end = source.indexOf('\n\n    const addToHistory', start);
    const effect = source.slice(start, end);
    let previous,
        cleanup,
        cancelled = 0;
    const calls = [];
    const base = {
        setResult: () => {},
        setTermChecks: () => {},
        setDictionaryState: () => {},
        setHide: () => {},
        setError: () => {},
        setSkipped: () => {},
        dictionaryRequest: { current: null },
        activeRequest: { current: null },
        requestController: { current: { abort: () => cancelled++ } },
        sourceText: 'Hello',
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        autoCopy: 'disable',
        hideWindow: false,
        clipboardMonitor: false,
        detectLanguage: 'en',
        activeSourceLanguage: 'en',
        requestRevision: 1,
        privacyMode: 'device_only',
        glossary: {},
        serviceInstanceConfigMap: {},
        currentTranslateServiceInstanceKey: 'local_mt@multilingual',
        copyToClipboard: () => {},
    };
    const render = (primary, overrides = {}) => {
        const scope = {
            ...base,
            primary,
            ...overrides,
            translate: () => calls.push(primary),
            useEffect: (fn, deps) => {
                if (!previous || deps.some((v, i) => v !== previous[i])) {
                    cleanup?.();
                    cleanup = fn();
                    previous = deps;
                }
            },
        };
        new Function(...Object.keys(scope), effect)(...Object.values(scope));
    };
    render(false);
    render(true);
    render(true);
    assert.deepEqual(calls, [false, true]);
    assert.equal(cancelled, 1, 'the old role request must be invalidated');
    render(true, { detectLanguage: 'fr' });
    assert.equal(calls.length, 2, 'manual source language must not restart for unrelated detection updates');
    render(true, { sourceLanguage: 'auto', activeSourceLanguage: '' });
    assert.equal(calls.length, 2, 'cleared detection must not retranslate the previous source text');
    render(true, { sourceLanguage: 'auto', activeSourceLanguage: 'en' });
    assert.equal(calls.length, 3, 'automatic mode starts only when detection is ready');
});
