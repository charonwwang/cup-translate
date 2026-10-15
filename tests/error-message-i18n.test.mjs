import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

/**
 * 「当前服务不支持所选语言」这条提示，过去是**硬编码英文字面量**
 * （`'Language not supported'`），共 11 处，其中 7 处会直接显示给用户：
 *   · TargetArea 的 setError -> 红色错误框
 *   · SourceArea 的 setSourceText -> 源文本区
 *   · TextArea(OCR) 的 setError -> 红色错误框
 * 另 4 处 throw 会被 catch 后 toast 出来。
 *
 * 而这个项目有 21 个语言文件。用户在中文界面下遇到不支持的语言时，
 * 看到的却是一句英文——属于「界面已经本地化、错误提示却没有」的漏网。
 *
 * 这类缺陷不会被构建或类型检查发现（字符串总是合法的），
 * 所以需要一条断言：用户可见的提示必须走 i18n。
 */

const UI_SOURCES = [
    'src/window/Translate/components/TargetArea/index.jsx',
    'src/window/Translate/components/SourceArea/index.jsx',
    'src/window/Recognize/TextArea/index.jsx',
];

/** 递归收集 src/ 下所有 js/jsx 文件 */
async function collectSources(dir = 'src') {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            out.push(...(await collectSources(full)));
        } else if (/\.jsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

test('the "language not supported" message has a translation key', async () => {
    for (const locale of ['en_US', 'zh_CN']) {
        const raw = await readFile(`src/i18n/locales/${locale}.json`, 'utf8');
        const parsed = JSON.parse(raw);
        const value = parsed?.translation?.common?.language_not_supported;
        assert.equal(typeof value, 'string', `${locale}.json is missing translation.common.language_not_supported`);
        assert.ok(value.trim() !== '', `${locale}.json has an empty language_not_supported`);
        // 必须是真正的译文，不能是把 key 当文案
        assert.notEqual(value, 'language_not_supported', `${locale}.json just repeats the key`);
    }
});

test('no user-visible surface hardcodes the English message', async () => {
    // 硬编码字面量一旦回来，用户就会在中文界面看到英文
    const offenders = [];
    for (const file of await collectSources()) {
        const source = await readFile(file, 'utf8');
        if (source.includes("'Language not supported'") || source.includes('"Language not supported"')) {
            offenders.push(file);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        `these files hardcode the English message instead of using t('common.language_not_supported'): ${offenders.join(', ')}`
    );
});

test('the surfaces that could hit an unsupported language use the translation key', async () => {
    // 反向断言：这三个文件**确实**在用 t()，防止有人把调用整段删掉
    // （只查「没有硬编码」是不够的——删掉整段错误提示也能让上一测试通过）
    for (const file of UI_SOURCES) {
        const source = await readFile(file, 'utf8');
        assert.ok(
            source.includes("t('common.language_not_supported')"),
            `${file} should render the localized message via t('common.language_not_supported')`
        );
        // 使用点必须在 useTranslation 之后，否则 t 会是 undefined
        const tDef = source.indexOf('const { t } = useTranslation()');
        const firstUse = source.indexOf("t('common.language_not_supported')");
        assert.ok(tDef !== -1, `${file} uses t() but never calls useTranslation()`);
        assert.ok(
            firstUse > tDef,
            `${file} uses t() before its useTranslation() declaration — t would be undefined at runtime`
        );
    }
});

test('i18n keys used in source actually exist in the locale files', async () => {
    // 通用护栏：src 里 t('x.y') 引用的 key 必须真的存在于 en_US / zh_CN。
    // 打错 key 时 i18next 会显示原始 key 字符串，界面看起来很怪但不会报错。
    const locales = {};
    for (const name of ['en_US', 'zh_CN']) {
        locales[name] = JSON.parse(await readFile(`src/i18n/locales/${name}.json`, 'utf8'));
    }
    const lookup = (obj, path) => path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);

    const missing = new Map();
    for (const file of await collectSources()) {
        const source = await readFile(file, 'utf8');
        // 只取形如 t('a.b') / t(`a.b`) 的静态 key（跳过带变量的）
        for (const m of source.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]\s*\)/g)) {
            const key = m[1];
            // 前缀 t 的命名空间用法（如 t('languages.xx')）在 translation 之下
            for (const [name, obj] of Object.entries(locales)) {
                if (lookup(obj, `translation.${key}`) === undefined) {
                    if (!missing.has(key)) missing.set(key, new Set());
                    missing.get(key).add(name);
                }
            }
        }
    }
    const report = [...missing.entries()]
        .filter(([, names]) => names.size === 2) // 两个基准语言都缺才算问题
        .map(([key]) => key);
    assert.deepEqual(
        report,
        [],
        `these i18n keys are used in src but missing from en_US and zh_CN: ${report.join(', ')}`
    );
});

test('every locale file stays valid JSON with the shared structure', async () => {
    // 手工编辑语言文件容易多/少一个逗号，构建不会发现（只有运行时加载失败）
    const files = (await readdir('src/i18n/locales')).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 21, `expected at least 21 locale files, found ${files.length}`);
    for (const file of files) {
        const raw = await readFile(`src/i18n/locales/${file}`, 'utf8');
        const parsed = JSON.parse(raw); // 语法错误会在这里抛出
        assert.ok(parsed.translation, `${file} must have a top-level "translation" object`);
        assert.ok(parsed.translation.common, `${file} must have translation.common`);
    }
});
