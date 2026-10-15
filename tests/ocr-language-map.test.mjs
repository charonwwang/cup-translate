import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INFO = 'src/services/recognize/system/info.ts';
const INDEX = 'src/services/recognize/system/index.jsx';

/** 取出 TS 枚举里的成员名。 */
function enumMembers(source) {
    const start = source.indexOf('export enum Language {');
    assert.notEqual(start, -1, 'Language enum not found');
    const end = source.indexOf('}', start);
    return [...source.slice(start, end).matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
}

/** 取出某个 LangMap 对象的键名。 */
function mapKeys(source, name) {
    const start = source.indexOf(`const ${name} = {`);
    assert.notEqual(start, -1, `${name} not found`);
    const end = source.indexOf('};', start);
    return [...source.slice(start, end).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

/**
 * 背景（本轮实测）：system OCR 的语言映射键名与 Language 枚举对不上——
 *
 *   info.ts 枚举：  pt_pt = 'pt_pt'      （没有 'pt'）
 *   三个映射里：    pt: 'pt-PT'          （没有 'pt_pt'）
 *
 * 用户在 OCR 语言下拉里选「葡萄牙语（葡萄牙）」（languageList 里确实有 pt_pt）
 * 时，linuxLangMap['pt_pt'] / macOSLangMap['pt_pt'] / windowsLangMap['pt_pt']
 * 全是 undefined，于是 invoke('system_ocr', { lang: undefined }) ——
 * Rust 侧参数是 &str，serde 会以「invalid type: null, expected a string」
 * 之类的反序列化错误失败，用户看到的报错与我们想表达的「语言不支持」毫无关系。
 *
 * pt_br 因为键名两边一致，不受影响——所以只有这一个选项是坏的，
 * 属于「少数语言悄悄失效」的典型：不测就发现不了。
 *
 * 下面的测试把「枚举 ↔ 映射必须一一对应」钉死，防止再出现同类错配。
 */

test('the OCR enum and every platform language map agree on key names', async () => {
    const members = enumMembers(await readFile(INFO, 'utf8'));
    const source = await readFile(INDEX, 'utf8');

    assert.ok(members.length > 15, `expected a full enum, got ${members.length}`);

    for (const mapName of ['linuxLangMap', 'macOSLangMap', 'windowsLangMap']) {
        const keys = mapKeys(source, mapName);
        const missing = members.filter((m) => !keys.includes(m));
        assert.deepEqual(
            missing,
            [],
            `${mapName} is missing enum members (these would pass undefined to the backend): ${missing.join(', ')}`
        );

        // 反向：映射里不该有枚举中不存在的键（那是永不被命中的死条目）
        const extra = keys.filter((k) => !members.includes(k));
        assert.deepEqual(extra, [], `${mapName} has keys absent from the enum: ${extra.join(', ')}`);
    }
});

test('every language the OCR picker can offer is mapped by the system engine', async () => {
    // languageList 是 OCR 下拉的数据源；枚举之外它还可能列出别的语言。
    // system 引擎只支持自己 enumerated 的那些，但**下拉里的 pt_pt 必须能命中**，
    // 这正是本次修复的缺陷。
    const listSource = await readFile('src/utils/language.ts', 'utf8');
    const start = listSource.indexOf('export const languageList = [');
    const end = listSource.indexOf('];', start);
    const offered = [...listSource.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);

    assert.ok(offered.includes('pt_pt'), 'pt_pt is offered to users in the OCR language picker');

    const source = await readFile(INDEX, 'utf8');
    const keys = mapKeys(source, 'linuxLangMap');
    assert.ok(
        keys.includes('pt_pt'),
        "the system OCR map must key Portuguese (Portugal) as 'pt_pt' to match the enum and the picker"
    );
    assert.ok(keys.includes('pt_br'), 'pt_br must remain mapped');
});

test('no language map maps a key to a non-string or empty value', async () => {
    const source = await readFile(INDEX, 'utf8');
    for (const mapName of ['linuxLangMap', 'macOSLangMap', 'windowsLangMap']) {
        const s = source.indexOf(`const ${mapName} = {`);
        const e = source.indexOf('};', s);
        const body = source.slice(s, e);
        for (const m of body.matchAll(/^\s*(\w+):\s*([^,\n]+),/gm)) {
            const [, key, value] = m;
            assert.match(
                value.trim(),
                /^'[^']+'$/,
                `${mapName}.${key} should be a non-empty string literal, got ${value.trim()}`
            );
        }
    }
});
