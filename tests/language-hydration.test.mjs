import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { automaticTargetLanguage } from '../src/utils/sourceLanguage.js';

async function component() {
    let source = await readFile('src/window/Translate/components/LanguageArea/index.jsx', 'utf8');
    source = source
        .replace(/^import .*;\n/gm, '')
        .replace('export default function LanguageArea()', 'function LanguageArea()');
    source = source.slice(0, source.indexOf('    return (')) + 'return { sourceLanguage, targetLanguage }; }';
    const config = {
        translate_remember_language: null,
        translate_source_language: null,
        translate_target_language: null,
        translate_second_language: 'en',
    };
    const atoms = { source: 'auto', target: 'en', detect: 'zh_cn' };
    const writes = [],
        slots = [],
        effects = [];
    let cursor = 0,
        dirty = false;
    const setAtom = (key, value) => {
        if (atoms[key] !== value) {
            atoms[key] = value;
            dirty = true;
        }
    };
    const hooks = {
        useState: (initial) => {
            const i = cursor++;
            slots[i] ??= initial;
            return [
                slots[i],
                (v) => {
                    if (slots[i] !== v) {
                        slots[i] = v;
                        dirty = true;
                    }
                },
            ];
        },
        useRef: (initial) => (slots[cursor++] ??= { current: initial }),
        useEffect: (fn, deps) => {
            const i = cursor++;
            const previous = slots[i];
            if (!previous || deps.some((v, j) => v !== previous[j])) effects.push(fn);
            slots[i] = deps;
        },
        useConfig: (key) => [
            config[key],
            (value) => {
                writes.push([key, value]);
                config[key] = value;
            },
        ],
        useAtom: (key) => [atoms[key], (v) => setAtom(key, v)],
        useAtomValue: (key) => atoms[key],
        useTranslation: () => ({ t: (v) => v }),
        getSystemTargetLanguage: () => 'zh_cn',
        automaticTargetLanguage,
        sourceLanguageAtom: 'source',
        targetLanguageAtom: 'target',
        detectLanguageAtom: 'detect',
    };
    const render = new Function(...Object.keys(hooks), `${source}; return LanguageArea;`)(...Object.values(hooks));
    return {
        config,
        atoms,
        writes,
        flush() {
            for (let i = 0; i < 10; i++) {
                cursor = 0;
                dirty = false;
                render();
                effects.splice(0).forEach((fn) => fn());
                if (!dirty) return;
            }
            throw Error('render did not settle');
        },
    };
}

test('language restoration waits for all preferences and never persists the window defaults', async () => {
    const app = await component();
    app.flush();
    app.config.translate_remember_language = true;
    app.config.translate_source_language = 'ja';
    app.flush();
    assert.deepEqual(app.writes, []);
    app.config.translate_target_language = 'fr';
    app.flush();
    assert.equal(app.atoms.source, 'ja');
    assert.equal(app.atoms.target, 'fr');
    assert.deepEqual(app.writes, [
        ['translate_source_language', 'ja'],
        ['translate_target_language', 'fr'],
    ]);
});

test('a remembered target remains selected even when detection reports the same language', async () => {
    const app = await component();
    Object.assign(app.config, {
        translate_remember_language: true,
        translate_source_language: 'auto',
        translate_target_language: 'zh_cn',
    });
    app.flush();
    assert.equal(app.atoms.target, 'zh_cn');
    assert.ok(app.writes.every(([key, value]) => key !== 'translate_target_language' || value === 'zh_cn'));
});
