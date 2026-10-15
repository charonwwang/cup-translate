import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ANKI = 'src/services/collection/anki/index.jsx';

/**
 * 背景（本轮实测）：anki 生词本在三种常见情况下会把请求发坏或直接抛错。
 *
 * AnkiConnect 的权威契约（API_LEGACY.md，v6 addNote）：
 *   "The optional `audio`, `video`, and `picture` properties accept one media
 *    object or an array. Each object needs `filename` and a nonempty
 *    `data`, `path`, or `url`."
 * 即 audio 数组里的**每一项都必须是对象**。
 *
 * ── 缺陷 1：没有语音时发出 `"audio":[null]`
 *    let audio;
 *    if (pronunciation.voice) { ... audio = {...}; }
 *    results.push({ regionSymbol, audio });          // audio 可能是 undefined
 *    ...
 *    audio: pronunciations.map((p) => p.audio),      // -> [undefined, ...]
 *
 *    关键：`JSON.stringify` 会**省略对象属性**里的 undefined，但**数组元素**
 *    里的 undefined 会变成 `null`。
 *        JSON.stringify({a: undefined})  === '{}'
 *        JSON.stringify([undefined])      === '[null]'
 *    所以真的发出了 `"audio":[null]`，与契约不符。
 *    google 与 bing_dict **恒设** `voice: ''`，因此这是它们的**常态**路径。
 *
 * ── 缺陷 2：音频下载失败时把 URL 文本当成 mp3
 *    cambridge_dict 在音频 fetch 失败时**保留 URL 字符串**（index.jsx:91-94），
 *    而 `String.fromCharCode(...aString)` 不会抛错，于是 URL 文本被 base64
 *    后当作 mp3 发给 Anki —— 音频是坏的，且没有任何提示。
 *
 * ── 缺陷 3：symbol 缺失时抛 TypeError
 *    symbol = symbol[0] === '/' ? symbol : `/${symbol}/`;
 *    symbol 为 undefined -> `TypeError: Cannot read properties of undefined
 *    (reading '0')`，整次「添加到生词本」失败。
 *
 * ── 缺陷 4：大数据量语音触发 RangeError
 *    String.fromCharCode(...bytes) 在参数很多时抛
 *    `RangeError: Maximum call stack size exceeded`（实测 50 万元素触发）。
 *
 * 可达性：AnkiConnect 跑在用户本机（默认 127.0.0.1:8765），需要用户在 Anki 里
 * 安装该插件；本机未运行 Anki（实测 HTTP 000），因此下面的测试用受控输入
 * 驱动**真实的构造逻辑**，不依赖外部服务。
 */

/** 去掉注释，避免注释里写的代码被误判成真实代码。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 按括号配平抽出内部函数体（不依赖缩进宽度）。 */
function extractFunctionBody(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `${signature} must exist`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return { body: source.slice(open + 1, i), start, open };
        }
    }
    throw new Error(`unbalanced braces while extracting ${signature}`);
}

/** 用真实的 ankiPronunciation 函数体构造可调用函数。 */
function realAnkiPronunciation(source) {
    const { body } = extractFunctionBody(source, 'function ankiPronunciation(target)');
    return new Function('btoa', 'source', `return function ankiPronunciation(target) { ${body} };`)(
        (s) => Buffer.from(s, 'binary').toString('base64'),
        'hello'
    );
}

/** 抽出 addNote 的 audio 组装表达式（源码里的实际写法）。 */
function realAudioExpression(source) {
    const m = source.match(/audio:\s*(pronunciations[\s\S]*?),\n\s*\},\n\s*\}\);/);
    assert.notEqual(m, null, 'the audio field assembly must still exist in addNote');
    return m[1];
}

test('anki: the audio array never contains null entries', async () => {
    const code = stripComments(await readFile(ANKI, 'utf8'));

    // 契约要求：每项都是对象。null 项来自 map 出来的 undefined。
    assert.doesNotMatch(
        code,
        /audio:\s*pronunciations\.map\(\(pronunciation\) => pronunciation\.audio\),/,
        'mapping straight to pronunciation.audio emits [null] when there is no voice'
    );
    assert.match(code, /\.filter\(Boolean\)/, 'empty audio entries must be filtered out');

    // 结构上确认：没有语音时不构造 audio 对象
    assert.match(
        code,
        /if \(Array\.isArray\(pronunciation\.voice\) && pronunciation\.voice\.length > 0\) \{/,
        'only a real byte array may be treated as voice'
    );
});

test('anki: symbol and voice are read defensively', async () => {
    const code = stripComments(await readFile(ANKI, 'utf8'));

    assert.doesNotMatch(code, /symbol = symbol\[0\] === '\/'/, 'symbol[0] throws when symbol is missing');
    assert.doesNotMatch(
        code,
        /String\.fromCharCode\(\.\.\.pronunciation\.voice\)/,
        'spreading a large byte array can exceed the call stack'
    );
});

test('real ankiPronunciation: no voice produces no audio object at all', async () => {
    const source = await readFile(ANKI, 'utf8');
    const build = realAnkiPronunciation(source);

    // google / bing_dict 的常态：有音标、无语音
    const result = build({
        pronunciations: [
            { region: 'UK', symbol: '/həˈloʊ/', voice: '' },
            { region: 'US', symbol: '/həˈloʊ/', voice: '' },
        ],
    });

    assert.equal(result.length, 2);
    for (const p of result) {
        assert.equal(p.audio, undefined, 'no voice must mean no audio object');
        assert.match(p.regionSymbol, /^\[(UK|US)\] \/həˈloʊ\/$/);
    }

    // 契约检查：过滤后不含 null 项，且序列化结果里没有 null
    const payload = { audio: result.map((p) => p.audio).filter(Boolean) };
    assert.doesNotMatch(JSON.stringify(payload), /null/, 'the serialized payload must not contain a null entry');
});

test('real ankiPronunciation: a real byte array becomes a valid base64 audio object', async () => {
    const source = await readFile(ANKI, 'utf8');
    const build = realAnkiPronunciation(source);

    const bytes = [73, 68, 51, 4, 0, 0]; // "ID3" 开头的假 mp3
    const result = build({ pronunciations: [{ region: 'US', symbol: 'hi', voice: bytes }] });

    assert.equal(result.length, 1);
    const audio = result[0].audio;
    assert.notEqual(audio, undefined, 'a byte array must produce an audio object');
    assert.equal(audio.filename, '[US]_hello.mp3');
    assert.deepEqual(audio.fields, ['Voice1']);
    assert.equal(audio.data, Buffer.from('ID3\x04\x00\x00', 'binary').toString('base64'));
    assert.match(result[0].regionSymbol, /^\[US\] \/hi\/$/);
});

test('real ankiPronunciation: a URL string is not mistaken for audio bytes', async () => {
    const source = await readFile(ANKI, 'utf8');
    const build = realAnkiPronunciation(source);

    // cambridge_dict 音频下载失败时 voice 会保持 URL 字符串
    const url = 'https://dictionary.cambridge.org/media/english/uk_pron/u/ukh/ukhel/ukhello.mp3';
    const result = build({ pronunciations: [{ region: 'UK', symbol: '/həˈloʊ/', voice: url }] });

    assert.equal(
        result[0].audio,
        undefined,
        'a URL string must not be base64-encoded and sent as if it were mp3 bytes'
    );
});

test('real ankiPronunciation: a missing symbol does not throw', async () => {
    const source = await readFile(ANKI, 'utf8');
    const build = realAnkiPronunciation(source);

    // 不该抛 TypeError
    const result = build({ pronunciations: [{ region: 'UK' }, { region: 'US', symbol: null }] });
    assert.equal(result.length, 2);
    assert.equal(result[0].regionSymbol, '[UK] //');
    assert.equal(result[1].regionSymbol, '[US] //');

    // region 缺失也要能走通
    const noRegion = build({ pronunciations: [{ symbol: '/hi/' }] });
    assert.equal(noRegion[0].regionSymbol, ' /hi/');
});

test('real ankiPronunciation: a large voice array does not overflow the stack', async () => {
    const source = await readFile(ANKI, 'utf8');
    const build = realAnkiPronunciation(source);

    // 展开写法在 50 万元素时抛 RangeError（实测）
    const big = new Array(500000).fill(65);
    const result = build({ pronunciations: [{ region: 'US', symbol: 'hi', voice: big }] });

    assert.notEqual(result[0].audio, undefined, 'a large voice must still be encoded');
    assert.equal(Buffer.from(result[0].audio.data, 'base64').length, 500000);
});

test('the real audio expression filters empty entries', async () => {
    const source = await readFile(ANKI, 'utf8');
    const expression = realAudioExpression(source);

    // 用真实的表达式在受控输入上求值
    const pronunciations = [{ audio: undefined }, { audio: { data: 'x' } }];
    const value = new Function('pronunciations', `return ${expression};`)(pronunciations);

    assert.deepEqual(value, [{ data: 'x' }], 'the sent audio array must drop empty entries');
});
