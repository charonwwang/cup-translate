import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

/**
 * 上一轮修的是 Rust 侧通知文案不跟随 app_language。这一轮补前端同类问题：
 * 仍有几处**直接把英文（含内部标签）显示给用户**，绕过了 i18n：
 *
 *   History/index.jsx        toast.error('[history] clear failed: ' + e)
 *   History/index.jsx        toast.error('[history] update failed: ' + e)
 *   Service/SelectPluginModal toast.success('Installed ' + count + ' plugins')
 *
 * 这些字符串里 `[history]` 是给日志用的内部标签，不该出现在界面上；
 * 而中文用户看到「Installed 3 plugins」同样是未本地化。
 *
 * 修复方式：日志继续保留原始错误（诊断需要），界面文案改走 t()。
 */

const LOCALE_DIR = 'src/i18n/locales';

// 注意：本文件里的 key 都带 `translation.` 前缀，因为这里读的是**原始 JSON**，
// 而 JSON 顶层就是 { "translation": {...} } 这层外壳。
// 运行时 i18next 会把这层剥掉（defaultNS 默认即 'translation'），
// 所以源码里 `t()` 写的是 `config.x` 而不是 `translation.config.x`。
// 「源码 key 能否解析」由 tests/i18n-key-resolution.test.mjs 负责，那边用的是剥壳后的视图。

async function loadLocale(name) {
    return JSON.parse(await readFile(`${LOCALE_DIR}/${name}.json`, 'utf8'));
}

function leafKeys(obj, prefix = '') {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        const cur = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object') out.push(...leafKeys(v, cur));
        else out.push(cur);
    }
    return out;
}

const NEW_KEYS = ['translation.config.history.clear_failed', 'translation.config.history.update_failed'];

const NEW_SERVICE_KEY = 'translation.config.service.installed_plugins';

test('the newly used keys exist in both baselines', async () => {
    for (const locale of ['en_US', 'zh_CN']) {
        const keys = new Set(leafKeys(await loadLocale(locale)));
        for (const key of [...NEW_KEYS, NEW_SERVICE_KEY]) {
            assert.ok(keys.has(key), `${locale}.json is missing ${key}`);
        }
    }
});

test('the two baselines really differ for the new keys', async () => {
    // 防止「加了 key 但两边都写英文」这种假本地化——
    // 与 notification.rs 里那条 en/zh_cn 必须不同的断言是同一个思路。
    const en = await loadLocale('en_US');
    const zh = await loadLocale('zh_CN');
    for (const key of [...NEW_KEYS, NEW_SERVICE_KEY]) {
        const path = key.split('.');
        const get = (o) => path.reduce((acc, p) => acc[p], o);
        assert.notEqual(get(en), get(zh), `${key} is identical in en_US and zh_CN — that is not localization`);
    }
});

test('the plugin-count message interpolates the count', async () => {
    // 'Installed 3 plugins' 里数字是变量。改走 i18n 后必须用插值，
    // 否则会退化成固定文案、丢掉数量信息。
    for (const locale of ['en_US', 'zh_CN']) {
        const value = (await loadLocale(locale)).translation.config.service.installed_plugins;
        assert.match(
            value,
            /\{\{\s*count\s*\}\}/,
            `${locale} installed_plugins must interpolate {{count}}, got ${JSON.stringify(value)}`
        );
    }
});

test('the history page no longer leaks its internal log tag to the UI', async () => {
    const source = await readFile('src/window/Config/pages/History/index.jsx', 'utf8');

    // 界面上不允许再出现硬编码的 '[history] ... failed' 文案
    assert.ok(
        !/toast\.(error|success)\(\s*'\[history\]/.test(source),
        'the history page must not toast a raw "[history] ..." string at the user'
    );
    // 日志里**应该**保留它（诊断用），否则排查问题时没有上下文
    assert.ok(
        /logError\('\[history\] clear failed: ' \+ e\)/.test(source),
        'the raw error should still go to the log for diagnostics'
    );
    assert.ok(
        /logError\('\[history\] update failed: ' \+ e\)/.test(source),
        'the raw error should still go to the log for diagnostics'
    );
    // 用户可见的两条都走 t()
    assert.ok(source.includes("t('config.history.clear_failed')"), 'clear failure must use the i18n key');
    assert.ok(source.includes("t('config.history.update_failed')"), 'update failure must use the i18n key');
});

test('the plugin install toast uses i18n with an interpolated count', async () => {
    const source = await readFile('src/window/Config/pages/Service/SelectPluginModal/index.jsx', 'utf8');
    assert.ok(
        !source.includes("'Installed ' + count + ' plugins'"),
        'the plugin install toast must not be a hardcoded English string'
    );
    assert.ok(
        source.includes("t('config.service.installed_plugins', { count })"),
        'the plugin install toast must pass the count through i18n'
    );
});

test('no user-facing toast or error bypasses i18n anywhere in src/', async () => {
    // 汇总式护栏，覆盖本轮修的三处以及将来新加的。
    //
    // 判定要足够精确，否则会误报（第一版就误报了本轮自己的修复）：
    //   · toast.error('Install failed')         -> 违规（纯字面量）
    //   · toast.error(`${t('a.b')}: ${e}`)      -> 合规（模板里用了 t）
    //   · toast.error(t('a.b'))                 -> 合规
    //   · toast.error(message)                  -> 合规（变量，静态无法判断）
    // 规则：实参以引号开头，且整段实参里**没有出现 t(**，才算违规。
    const offenders = [];

    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(path);
                continue;
            }
            if (!/\.(jsx|js)$/.test(entry.name)) continue;
            const source = await readFile(path, 'utf8');
            source.split('\n').forEach((line, i) => {
                const m = line.match(/toast\.(error|success|loading)\(\s*([`'"])((?:\\.|(?!\2).)*)\2/);
                if (!m) return;
                const literal = m[3];
                if (literal.trim() === '') return; // 空串是清空提示，不是文案
                if (literal.includes('t(')) return; // 模板里含 t(...)，文案已翻译
                offenders.push(`${path}:${i + 1} -> ${literal.slice(0, 60)}`);
            });
        }
    }
    await walk('src');

    assert.deepEqual(
        offenders,
        [],
        `these toasts show a hardcoded string instead of a translated one:\n${offenders.join('\n')}`
    );
});
