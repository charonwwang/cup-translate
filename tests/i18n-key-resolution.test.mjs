import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

/**
 * i18n key 的双向一致性。
 *
 * 背景（这是上一轮遗留的缺口）：locale JSON 的顶层长这样
 *
 *     { "translation": { "common": {...}, "config": {...} } }
 *
 * 而 i18next 的 `defaultNS` 默认就是 `'translation'`（`src/i18n/index.jsx` 的
 * `resources: { en: en_US }` 把整个 JSON 当作命名空间包），所以**运行时外壳会被剥掉**：
 * 代码里写的是 `t('config.general.label')`，不是 `t('translation.config.general.label')`。
 *
 * 上一轮的测试两侧都用了 `translation.` 前缀，自洽因此能跑，但它**没有校验
 * `t()` 里实际写的 key 能否解析**。本文件补上这个方向：
 *   1. 源码里出现的每个 `t('a.b')` 都必须能在 en_US 里查到（剥壳后）
 *   2. 每个 key 解析结果必须是**非空字符串**（不是对象、不是空串）
 *   3. 出现过的 key 必须真的被引用（反向：防止加了没人用的死 key）
 */

const LOCALE_DIR = 'src/i18n/locales';

/** 读取 locale 并剥掉 i18next 的 defaultNS 外壳，得到运行时真正查表的那一层。 */
async function runtimeLocale(name) {
    const raw = JSON.parse(await readFile(`${LOCALE_DIR}/${name}.json`, 'utf8'));
    assert.ok(
        raw.translation && typeof raw.translation === 'object',
        `${name}.json must keep its "translation" wrapper — that is the i18next defaultNS`
    );
    return raw.translation;
}

/** 逐段下钻；不存在返回 undefined。 */
function lookup(obj, key) {
    let cur = obj;
    for (const part of key.split('.')) {
        if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
        cur = cur[part];
    }
    return cur;
}

async function sourceFiles(dir = 'src') {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
        else if (/\.(jsx|js)$/.test(entry.name) && !path.includes('locales/')) out.push(path);
    }
    return out;
}

/** 收集源码里所有 `t('...')` 的 key，并记下出处。 */
async function referencedKeys() {
    const refs = new Map();
    for (const file of await sourceFiles()) {
        const source = await readFile(file, 'utf8');
        for (const m of source.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) {
            if (!refs.has(m[1])) refs.set(m[1], new Set());
            refs.get(m[1]).add(file);
        }
    }
    return refs;
}

test('the locale wrapper really is the i18next default namespace', async () => {
    // 这条断言把「为什么可以剥掉 translation」钉在源码上：
    // 若有人改了 defaultNS 或把 JSON 结构换了，这里会先失败，
    // 而不是让下面的 key 校验变成一个错误的基准。
    const source = await readFile('src/i18n/index.jsx', 'utf8');
    assert.ok(
        !source.includes('defaultNS'),
        'i18n/index.jsx must not override defaultNS; the tests assume i18next default "translation"'
    );
    assert.match(source, /resources:\s*\{/, 'i18n/index.jsx must keep a resources map');
    const wrapper = await runtimeLocale('en_US');
    for (const ns of ['common', 'config', 'services', 'translate', 'updater', 'languages']) {
        assert.ok(ns in wrapper, `en_US.json translation namespace is missing "${ns}"`);
    }
});

test('every key referenced by t() resolves in en_US', async () => {
    const en = await runtimeLocale('en_US');
    const refs = await referencedKeys();
    assert.ok(refs.size > 200, `expected a few hundred referenced keys, found ${refs.size}`);

    const missing = [];
    for (const [key, files] of refs) {
        if (lookup(en, key) === undefined) missing.push(`${key}  <- ${[...files][0]}`);
    }
    missing.sort();
    assert.deepEqual(
        missing,
        [],
        `these t() keys have no entry in en_US.json (they will render as the raw key):\n${missing.join('\n')}`
    );
});

test('every referenced key resolves to a non-empty string', async () => {
    // 解析到对象（中间节点）或空串都算坏：界面会显示空白或原始 key。
    const en = await runtimeLocale('en_US');
    const refs = await referencedKeys();

    const bad = [];
    for (const [key, files] of refs) {
        const value = lookup(en, key);
        if (value === undefined) continue; // 上一条测试负责
        if (typeof value !== 'string') {
            bad.push(`${key} resolves to ${typeof value} (${[...files][0]})`);
        } else if (value.trim() === '') {
            bad.push(`${key} is an empty string (${[...files][0]})`);
        }
    }
    assert.deepEqual(bad, [], `these keys do not resolve to usable text:\n${bad.join('\n')}`);
});

test('no key is written with the redundant translation. prefix in source', async () => {
    // 最容易犯的错：因为 JSON 里有外壳，就在 t() 里也写 translation.
    // 那会解析失败（外壳已被 defaultNS 消费掉），界面直接显示 key 本身。
    const offenders = [];
    for (const [key, files] of await referencedKeys()) {
        if (key.startsWith('translation.')) offenders.push(`${key}  <- ${[...files][0]}`);
    }
    assert.deepEqual(
        offenders,
        [],
        `t() must not include the "translation." namespace prefix:\n${offenders.join('\n')}`
    );
});

test('the keys added for round 36 resolve through the runtime path', async () => {
    // 明确覆盖上一轮新增的三个 key——用**运行时**路径（剥壳后）而不是原始 JSON 路径，
    // 这正是上一轮没做到的那一步。
    const en = await runtimeLocale('en_US');
    for (const key of [
        'config.history.clear_failed',
        'config.history.update_failed',
        'config.service.installed_plugins',
    ]) {
        const value = lookup(en, key);
        assert.equal(typeof value, 'string', `${key} must resolve to a string without the wrapper`);
        assert.notEqual(value.trim(), '', `${key} must not be empty`);
    }
    // 并且它们确实被引用（否则就是死 key）
    const refs = await referencedKeys();
    for (const key of ['config.history.clear_failed', 'config.history.update_failed']) {
        assert.ok(refs.has(key), `${key} is defined but never used by t()`);
    }
});

test('en_US and zh_CN define exactly the same key set', async () => {
    // 两个基准语言必须同构。若 zh_CN 少了 key，中文用户会掉到英文回退——
    // 不一定崩，但属于「以为翻译了其实没有」。
    const flatten = (obj, prefix = '') => {
        const out = [];
        for (const [k, v] of Object.entries(obj)) {
            const cur = prefix ? `${prefix}.${k}` : k;
            if (v !== null && typeof v === 'object') out.push(...flatten(v, cur));
            else out.push(cur);
        }
        return out;
    };
    const en = new Set(flatten(await runtimeLocale('en_US')));
    const zh = new Set(flatten(await runtimeLocale('zh_CN')));

    const missingInZh = [...en].filter((k) => !zh.has(k)).sort();
    const extraInZh = [...zh].filter((k) => !en.has(k)).sort();
    assert.deepEqual(missingInZh, [], `zh_CN is missing keys that en_US has:\n${missingInZh.join('\n')}`);
    assert.deepEqual(extraInZh, [], `zh_CN has keys that en_US lacks:\n${extraInZh.join('\n')}`);
});
