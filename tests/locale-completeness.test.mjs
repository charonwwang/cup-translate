import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const LOCALES_DIR = 'src/i18n/locales';
const I18N_INDEX = 'src/i18n/index.jsx';
const GENERAL_PAGE = 'src/window/Config/pages/General/index.jsx';

/** 把嵌套的语言 JSON 摊平成 "a.b.c" -> 文案。 */
function flatten(obj, prefix = '') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(out, flatten(value, full));
        } else {
            out[full] = value;
        }
    }
    return out;
}

async function loadLocale(name) {
    return flatten(JSON.parse(await readFile(`${LOCALES_DIR}/${name}.json`, 'utf8')));
}

async function localeNames() {
    const entries = await readdir(LOCALES_DIR);
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/** 从 src/i18n/index.js 里取出 resources 中「资源键 -> 语言文件」的映射。 */
async function resourceMap() {
    const source = await readFile(I18N_INDEX, 'utf8');
    const body = source.slice(source.indexOf('resources: {'), source.indexOf('},\n});'));
    const map = {};
    for (const m of body.matchAll(/(\w+):\s*(\w+),/g)) {
        map[m[2]] = m[1];
    }
    return map;
}

/**
 * 背景（本轮实测）：21 个语言文件完整度差异极大。以 en_US 的 361 个 key 为基准：
 *
 *   nb_NO / nn_NO / tr_TR   2 个（0%）—— 只有 Ok 与 Lingva
 *   tk_TM  68 (18%)   ja_JP 93 (25%)   fa_IR 97 (26%)
 *   ko_KR 219 (60%)   es_ES 221 (61%)  ...
 *
 * 而这些语言在「应用语言」下拉里**都能直接选中**，界面里没有任何「翻译未完成」
 * 的提示。用户选日文后，设置界面（translation.config 缺 101 个、
 * translation.services 缺 140 个）会**整片显示英文**——看起来像 bug。
 *
 * 这些测试不试图「补齐翻译」（我没有母语校验能力，机翻会产生错误文案），
 * 而是把现状钉成可追踪的事实：
 *   1) 语言文件必须都是合法 JSON 且非空；
 *   2) 每个在 UI 里可选的语言必须在 i18n resources 里注册（否则选中即报错）；
 *   3) 记录每门语言的完整度，任何**退步**都会失败；
 *   4) 极不完整的语言必须被显式登记，避免悄悄新增一个 0% 的选项。
 */

test('every locale file is valid JSON with a translation root', async () => {
    for (const name of await localeNames()) {
        const raw = JSON.parse(await readFile(`${LOCALES_DIR}/${name}.json`, 'utf8'));
        assert.ok(raw.translation, `${name}.json must have a "translation" root`);
        assert.ok(Object.keys(flatten(raw)).length > 0, `${name}.json must not be empty`);
    }
});

test('every selectable UI language is registered in the i18n resources', async () => {
    const source = await readFile(GENERAL_PAGE, 'utf8');
    const start = source.indexOf("aria-label='app language'");
    assert.notEqual(start, -1, 'the app language dropdown should be locatable');
    const end = source.indexOf('</DropdownMenu>', start);
    assert.notEqual(end, -1, 'the app language dropdown should be closed');

    const selectable = [...source.slice(start, end).matchAll(/key='([^']+)'/g)].map((m) => m[1]);
    assert.ok(selectable.length >= 15, `expected a full language list, got ${selectable.length}`);

    const resources = await resourceMap();
    const registered = new Set(Object.values(resources));

    // i18n 的 resource 键是小写下划线风格（tr、nb_no、zh_cn…），
    // 与下拉里的 key 一致；逐个核对，避免「能选但没加载」导致选中后全空白。
    const missing = selectable.filter((key) => !registered.has(key) && !registered.has(key.toLowerCase()));
    assert.deepEqual(missing, [], `these languages are selectable but not loaded: ${missing.join(', ')}`);
});

test('no locale silently regresses in completeness', async () => {
    // 完整度基线：key 数一旦变少就说明有翻译被删掉。
    // 新增 key 不受影响（只增不减）；要下调基线必须在本次改动里显式修改此表。
    const BASELINE = {
        en_US: 362,
        zh_CN: 362,
        zh_TW: 342,
        ar_AE: 343,
        fr_FR: 343,
        pt_BR: 343,
        pt_PT: 343,
        ru_RU: 343,
        ta_IN: 343,
        uk_UA: 343,
        de_DE: 328,
        it_IT: 310,
        he_IL: 298,
        es_ES: 222,
        ko_KR: 220,
        fa_IR: 98,
        ja_JP: 94,
        tk_TM: 69,
        tr_TR: 3,
        nb_NO: 3,
        nn_NO: 3,
    };

    const names = await localeNames();
    const regressed = [];
    for (const name of names) {
        const count = Object.keys(await loadLocale(name)).length;
        const floor = BASELINE[name];
        assert.notEqual(floor, undefined, `${name}.json exists but has no completeness baseline`);
        if (count < floor) {
            regressed.push(`${name}: ${count} < ${floor}`);
        }
    }
    assert.deepEqual(regressed, [], `translations were lost:\n  ${regressed.join('\n  ')}`);
});

test('the near-empty locales are explicitly known, not accidental', async () => {
    // 这三种语言只有 2 个 key（Ok / Lingva），选中后界面几乎全是英文回退。
    // 登记在此，避免将来有人悄悄再加一个几乎为空的语言而不自知；
    // 若补齐翻译，请把它们从这里移除并同步 BASELINE。
    const KNOWN_INCOMPLETE = ['nb_NO', 'nn_NO', 'tr_TR'];

    const empty = [];
    for (const name of await localeNames()) {
        if (Object.keys(await loadLocale(name)).length < 10) {
            empty.push(name);
        }
    }
    assert.deepEqual(
        empty.sort(),
        [...KNOWN_INCOMPLETE].sort(),
        'the set of near-empty locales changed; complete the translation or update this list'
    );
});

test('the i18n fallback chain still terminates at English', async () => {
    // nb_no <-> nn_no 互指，而两者都只有 2 个 key；pt_pt <-> pt_br 互指且都完整。
    // 互指本身可以，但必须始终存在 default: ['en'] 兜底，
    // 否则某个 key 在整条链上都缺失时会渲染成原始 key（如 "translate.copy"）。
    const source = await readFile(I18N_INDEX, 'utf8');
    const start = source.indexOf('fallbackLng: {');
    assert.notEqual(start, -1, 'fallbackLng must be configured');
    const end = source.indexOf('},', start);
    const block = source.slice(start, end);

    assert.match(block, /default:\s*\[\s*'en'\s*\]/, "fallbackLng must end with default: ['en']");
    // 互指的双方不能都是空的——那等于没回退
    for (const pair of [
        ['nb_no', 'nn_no'],
        ['pt_pt', 'pt_br'],
    ]) {
        const [a, b] = pair;
        if (new RegExp(`${a}:\\s*\\['${b}'\\]`).test(block)) {
            const ca = Object.keys(await loadLocale(a.slice(0, 2) + a.slice(2).toUpperCase())).length;
            const cb = Object.keys(await loadLocale(b.slice(0, 2) + b.slice(2).toUpperCase())).length;
            assert.ok(
                ca > 10 || cb > 10,
                `${a} <-> ${b} point at each other but both are near-empty, so the pair provides no fallback`
            );
        }
    }
});
