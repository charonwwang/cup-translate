import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const SYSTEM_LANGUAGE = 'src/utils/systemLanguage.js';
const LANGUAGE_AREA = 'src/window/Translate/components/LanguageArea/index.jsx';

/**
 * getSystemTargetLanguage() 决定「首次启动时目标语言默认是什么」，
 * 以及 LanguageArea 里「源=目标时自动切换」的兜底值。
 * 它依赖 navigator.language，因此这里用一个最小的 navigator 桩来**真实执行**
 * 该模块（不用源码断言去复刻逻辑）。
 */
async function withNavigator(language, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const value = language === undefined ? undefined : { language };
    Object.defineProperty(globalThis, 'navigator', {
        value,
        configurable: true,
        writable: true,
    });
    try {
        // 加查询串以绕过 ESM 模块缓存，让每次调用都重新读取 navigator
        const mod = await import(`../${SYSTEM_LANGUAGE}?nav=${encodeURIComponent(String(language))}&t=${Date.now()}`);
        return fn(mod);
    } finally {
        if (descriptor) {
            Object.defineProperty(globalThis, 'navigator', descriptor);
        } else {
            delete globalThis.navigator;
        }
    }
}

test('system language maps to a supported target language', async () => {
    const cases = [
        ['zh-CN', 'zh_cn'],
        ['zh', 'zh_cn'],
        ['zh-Hans', 'zh_cn'],
        ['zh-TW', 'zh_tw'],
        ['zh-HK', 'zh_tw'],
        ['en-US', 'en'],
        ['en', 'en'],
        ['ja-JP', 'ja'],
        ['ko-KR', 'ko'],
        ['pt-BR', 'pt_br'],
        ['pt-PT', 'pt_pt'],
        ['pt', 'pt_pt'],
        ['fr-FR', 'fr'],
        ['de-DE', 'de'],
    ];
    for (const [locale, expected] of cases) {
        await withNavigator(locale, ({ getSystemTargetLanguage }) => {
            assert.equal(getSystemTargetLanguage(), expected, `navigator.language='${locale}'`);
        });
    }
});

test('an unknown locale falls back through prefix matching, then to English', async () => {
    // 前缀匹配：'xx-YY' -> 查 'xx'
    await withNavigator('ru-RU', ({ getSystemTargetLanguage }) => {
        assert.equal(getSystemTargetLanguage(), 'ru');
    });
    // 完全不认识的语言 -> en（而不是抛错或返回 undefined）
    await withNavigator('klingon', ({ getSystemTargetLanguage }) => {
        assert.equal(getSystemTargetLanguage(), 'en');
    });
});

test('a missing or malformed navigator never throws', async () => {
    // 首次启动/异常环境下 navigator 可能不可用；函数必须始终返回一个语言代码
    for (const value of [undefined, '', 'ZZ']) {
        await withNavigator(value, ({ getSystemTargetLanguage }) => {
            const result = getSystemTargetLanguage();
            assert.equal(typeof result, 'string');
            assert.notEqual(result, '');
        });
    }
});

test('every mapped value is a language the app actually offers', async () => {
    // LOCALE_MAP 里的值必须都存在于 languageList，否则目标语言下拉会显示成 key
    const source = await readFile(SYSTEM_LANGUAGE, 'utf8');
    const mapBody = source.slice(
        source.indexOf('const LOCALE_MAP'),
        source.indexOf('};', source.indexOf('const LOCALE_MAP'))
    );
    const values = [...mapBody.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(values.length >= 20, `expected a substantial locale map, found ${values.length} entries`);

    const languageSource = await readFile('src/utils/language.ts', 'utf8');
    const listBody = languageSource.slice(
        languageSource.indexOf('export const languageList'),
        languageSource.indexOf(']', languageSource.indexOf('export const languageList'))
    );
    const offered = new Set([...listBody.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    assert.ok(offered.size >= 20, `expected languageList to offer many languages, found ${offered.size}`);

    const unknown = [...new Set(values)].filter((v) => !offered.has(v));
    assert.deepEqual(
        unknown,
        [],
        `these target languages are produced by the locale map but not offered in languageList: ${unknown.join(', ')}`
    );
});

test('the auto-switch logic lives in exactly one place, and it is the live one', async () => {
    // 回归护栏：src/utils/systemLanguage.js 曾导出一个 `getSmartTargetLanguage`，
    // 被 LanguageArea **导入却从未调用**；真正生效的是 LanguageArea 里就地写的
    // useEffect。两者条件相反（`sourceLang !== 'auto'` vs `sourceLanguage === 'auto'`），
    // 留着死函数会误导后来者去改一份不生效的实现。
    const util = await readFile(SYSTEM_LANGUAGE, 'utf8');
    assert.equal(
        /export\s+function\s+getSmartTargetLanguage/.test(util),
        false,
        'getSmartTargetLanguage was dead code and must not come back without a real call site'
    );

    const area = await readFile(LANGUAGE_AREA, 'utf8');
    assert.equal(
        /getSmartTargetLanguage/.test(area.replace(/\/\/.*$/gm, '')),
        false,
        'LanguageArea must not import the removed dead helper'
    );
    // 生效的那份逻辑必须仍然在
    assert.match(
        area,
        /sourceLanguage\s*===\s*'auto'\s*&&\s*detectLanguage\s*&&\s*detectLanguage\s*===\s*targetLanguage/,
        'the live auto-switch condition must stay in LanguageArea'
    );
});

test('no module exports a function that nothing imports', async () => {
    // 更一般地：逮住「导出了但全仓库无人使用」的函数——正是上面那个死函数的成因。
    // 只检查 src/utils 下的小工具模块（组件有大量合法的内部导出，会误报）。
    const utilDir = 'src/utils';
    const files = (await readdir(utilDir)).filter((f) => /\.(js|ts)$/.test(f) && f !== 'index.js');

    const corpus = [];
    async function collect(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                await collect(path);
            } else if (/\.(js|jsx|ts)$/.test(entry.name)) {
                corpus.push({ path, source: await readFile(path, 'utf8') });
            }
        }
    }
    await collect('src');

    const offenders = [];
    for (const file of files) {
        const path = `${utilDir}/${file}`;
        const source = await readFile(path, 'utf8');
        for (const m of source.matchAll(/^export\s+function\s+(\w+)/gm)) {
            const name = m[1];
            // 除自身文件外，是否有任何文件引用了它
            const used = corpus.some((other) => other.path !== path && other.source.includes(name));
            if (!used) offenders.push(`${path}: ${name}`);
        }
    }
    assert.deepEqual(offenders, [], `these exported helpers are never imported anywhere: ${offenders.join(', ')}`);
});
