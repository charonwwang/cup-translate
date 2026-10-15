import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const BING = 'src/services/translate/bing_dict/index.jsx';

/**
 * 背景（本轮实测）：bing_dict 在「查不到词」时抛内建 TypeError，而不是它的友好提示。
 *
 *     const meaningGroups = result.value[0].meaningGroups;
 *     if (meaningGroups.length === 0) {
 *         throw `Words not yet included: ${text}`;     // <- 本意要给的提示
 *     }
 *
 * 服务端在查不到词等情况下会回 **HTTP 200 + 没有 value 字段**（或 value 为空数组）。
 * 此时 `result.value[0]` 先抛 `TypeError: Cannot read properties of undefined
 * (reading '0')`，下面那句 `Words not yet included` **永远走不到**。
 *
 * 实测三种响应体形态（均 HTTP 200）：
 *     {}                     -> TypeError: ... (reading '0')
 *     { value: [] }          -> TypeError: ... (reading 'meaningGroups')
 *     { value: null }        -> TypeError: ... (reading '0')
 *
 * 同类引擎的对照（说明这是遗漏而非有意）：
 *     cambridge_dict:  if (entryNodes.length === 0) throw new Error('Words not yet included: ...')
 *     volcengine:      let { TranslationList } = result; if (TranslationList) { ... }
 *
 * 可达性（诚实说明）：bing_dict **在** `builtin_translate_list` 白名单里，
 * 用户能在引擎列表里选中它；但它的端点是 cn.bing.com，本机实测不可达
 * （cn.bing.com HTTP 000，www.bing.com 302 跳回 cn.bing.com），
 * 因此**无法**用真实请求确认服务端返回形态。下面的测试用 fetch 桩
 * 驱动**真实的函数体**，不依赖网络。
 */

/** 取出一个具名 async 函数的函数体（括号配平，不依赖缩进宽度）。 */
function extractFunctionBody(source, name) {
    const start = source.indexOf(`export async function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}`);
}

/** 用真实的 translate 函数体构造一个可调用函数，fetch 由调用方提供。 */
function realTranslate(source, fetchImpl) {
    const body = extractFunctionBody(source, 'translate');
    const displayFormat = source.match(/const DISPLAY_FORMAT_DEFAULT = '([^']*)'/);
    assert.notEqual(displayFormat, null, 'DISPLAY_FORMAT_DEFAULT must exist');
    return new Function('fetch', 'DISPLAY_FORMAT_DEFAULT', `return async (text, from, to) => { ${body} };`)(
        fetchImpl,
        displayFormat[1]
    );
}

const respond = (data) => async () => ({ ok: true, status: 200, data });

test('bing_dict reports "words not yet included" instead of a TypeError', async () => {
    const source = await readFile(BING, 'utf8');

    // 结构断言：深层取值必须用可选链，且守卫要能同时挡住「缺失」与「为空」
    assert.doesNotMatch(
        source,
        /result\.value\[0\]\.meaningGroups/,
        'a bare result.value[0].meaningGroups throws TypeError when value is missing or empty'
    );
    assert.match(
        source,
        /const meaningGroups = result\.value\?\.\[0\]\?\.meaningGroups;/,
        'meaningGroups must be read with optional chaining'
    );
    assert.match(
        source,
        /if \(!Array\.isArray\(meaningGroups\) \|\| meaningGroups\.length === 0\)/,
        'the guard must reject both a missing and an empty meaningGroups'
    );
});

test('real translate: a 200 response with no value yields the friendly message', async () => {
    const source = await readFile(BING, 'utf8');

    // 三种「服务端没给 value」的形态都必须走友好提示，而不是 TypeError
    const shapes = [{}, { value: [] }, { value: null }];
    for (const shape of shapes) {
        const translate = realTranslate(source, respond(shape));
        await assert.rejects(
            () => translate('zzzznotaword', 'en-us', 'zh-cn'),
            (err) => {
                assert.doesNotMatch(
                    String(err),
                    /Cannot read properties of/,
                    `shape ${JSON.stringify(shape)} leaked a TypeError: ${String(err)}`
                );
                assert.match(
                    String(err),
                    /Words not yet included: zzzznotaword/,
                    `shape ${JSON.stringify(shape)} should report the friendly message, got: ${String(err)}`
                );
                return true;
            }
        );
    }

    // meaningGroups 为空数组同样走友好提示
    const translateEmpty = realTranslate(source, respond({ value: [{ meaningGroups: [] }] }));
    await assert.rejects(
        () => translateEmpty('zzzznotaword', 'en-us', 'zh-cn'),
        (err) => {
            assert.match(String(err), /Words not yet included/);
            return true;
        }
    );
});

test('real translate: a normal response still builds the same result shape', async () => {
    const source = await readFile(BING, 'utf8');

    const normal = {
        value: [
            {
                meaningGroups: [
                    {
                        partsOfSpeech: [{ description: '发音', name: 'noun' }],
                        meanings: [{ richDefinitions: [{ fragments: [{ text: '/həˈloʊ/' }] }] }],
                    },
                    {
                        partsOfSpeech: [{ description: '快速释义', name: 'noun' }],
                        meanings: [{ richDefinitions: [{ fragments: [{ text: '你好' }, { text: '喂' }] }] }],
                    },
                    {
                        partsOfSpeech: [{ description: '变形', name: 'verb' }],
                        meanings: [{ richDefinitions: [{ fragments: [{ text: 'helloed' }] }] }],
                    },
                ],
            },
        ],
    };
    const translate = realTranslate(source, respond(normal));
    const result = await translate('hello', 'en-us', 'zh-cn');

    assert.deepEqual(result, {
        pronunciations: [{ region: 'noun', symbol: '/həˈloʊ/', voice: '' }],
        explanations: [{ trait: 'noun', explains: ['你好', '喂'] }],
        associations: ['helloed'],
        sentence: [],
    });
});

test('real translate: one malformed entry does not break the whole lookup', async () => {
    const source = await readFile(BING, 'utf8');

    // 同一条词条里，缺 richDefinitions 的那条应被跳过，完好的那条仍要出来
    const partial = {
        value: [
            {
                meaningGroups: [
                    {
                        partsOfSpeech: [{ description: '发音', name: 'noun' }],
                        meanings: [], // 没有 richDefinitions
                    },
                    {
                        partsOfSpeech: [{ description: '发音', name: 'noun' }],
                        meanings: [{ richDefinitions: [{ fragments: [{ text: '/ɡʊd/' }] }] }],
                    },
                ],
            },
        ],
    };
    const translate = realTranslate(source, respond(partial));
    const result = await translate('good', 'en-us', 'zh-cn');

    assert.equal(result.pronunciations.length, 1, 'the well-formed entry must survive');
    assert.equal(result.pronunciations[0].symbol, '/ɡʊd/');
});

test('real translate: a non-2xx response still reports the HTTP error', async () => {
    const source = await readFile(BING, 'utf8');

    const translate = realTranslate(source, async () => ({
        ok: false,
        status: 503,
        data: { message: 'unavailable' },
    }));
    await assert.rejects(
        () => translate('hello', 'en-us', 'zh-cn'),
        (err) => {
            assert.match(String(err), /Http Request Error/);
            assert.match(String(err), /503/);
            return true;
        }
    );
});
