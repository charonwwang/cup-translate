import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GOOGLE_TTS = 'src/services/tts/google_tts/index.jsx';

/**
 * 背景（本轮实测）：google_tts 的语言映射漏了 6 项，用户选这些语言却听到英文。
 *
 *     const langMap = { zh_cn: 'zh-CN', ... };   // 只有 22 项
 *     const googleLang = langMap[lang] || 'en';  // 缺失的一律变 'en'
 *
 * 传递进来的 `lang` 取自各 TTS 服务的 `Language` 枚举（见
 * `src/services/tts/lingva/info.ts` 等），该枚举有 30 项。漏掉的 7 项是：
 *     mn_cy / km / nb_no / nn_no / sv / pl / nl
 *
 * 实测 Google 的 `translate_tts` 端点对这 7 项里的 6 项**都支持**：
 *     tl=sv -> 200, 7680 bytes      tl=pl -> 200, 8256 bytes
 *     tl=nl -> 200, 9408 bytes      tl=no -> 200, 6720 bytes
 *     tl=km -> 200, 8064 bytes
 * 只有蒙古语确实不支持：mn / mn-Cyrl / mn-MN 全为 **HTTP 400**。
 *
 * ⚠️ 更正（2026-10 复核）：此处原先写「蒙古语是**唯一**不被支持的一项」，
 * **该表述不成立**。实测 `tl=fa`（波斯语）在 referer / client=tw-ob|gtx|t
 * 四种组合下**稳定返回 HTTP 400**（连试两次一致），而同一端点 tl=en / zh-CN
 * 均 200 —— 不是网络或参数问题。对照 Google 的**翻译**端点 tl=fa 正常返回
 * 「سلام」，可见是 TTS 端点的语言覆盖问题，与本项目无关。
 *
 * 于是**两种失败模式必须分清**（这与下面的断言直接相关）：
 *   · `mn_cy` **不在** langMap 里 -> 走 `|| 'en'` -> 请求成功 -> 用户选蒙古语
 *     却听到**英文**，界面无任何提示（静默错误）；
 *   · `fa` **在** langMap 里且值正确 -> 请求 400 -> 抛
 *     `Google TTS request failed: HTTP 400` -> 用户看到明确失败提示。
 *     把 fa 从表里删掉并不会让它「能用」，只会把它从「报错」变成「静默说英文」，
 *     因此本文件**不**要求删除 fa，而是把它作为已知的 Google 侧限制记录在案；
 *     待 Google 修复后 `tl=fa` 会自动恢复，无需改代码。
 *
 * 影响：用户给瑞典语/波兰语/荷兰语/挪威语/高棉语文本点朗读，听到的是
 * **英文发音**（读非拉丁文本时更接近乱码音节）。没有报错、没有提示。
 * 这是默认 TTS 路径（`local_tts` 与 `google_tts` 都在
 * `builtin_tts_list` 里，google_tts 免 key）。
 */

/** 去掉注释，避免注释里提到的代码被误判成真实代码。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 从源码里取出真实的 langMap 对象（不重写一份，避免守卫与实现脱节）。 */
function extractLangMap(source) {
    const m = source.match(/const langMap = \{([\s\S]*?)\};/);
    assert.notEqual(m, null, 'the langMap object must still exist');
    const entries = {};
    for (const em of m[1].matchAll(/(\w+):\s*'([^']*)'/g)) {
        entries[em[1]] = em[2];
    }
    return entries;
}

/** 从 TTS 的 info.ts 里取出 Language 枚举的键（权威清单）。 */
function extractLanguageKeys(source) {
    return [...source.matchAll(/^\s{4}(\w+) = '/gm)].map((m) => m[1]);
}

test('google_tts maps every supported TTS language', async () => {
    const source = await readFile(GOOGLE_TTS, 'utf8');
    const code = stripComments(source);
    const langMap = extractLangMap(source);

    // 用权威清单（Language 枚举）做基准，而不是在测试里硬写一份名单——
    // 硬写的名单永远无法发现自己漏了一项。
    const enumSource = await readFile('src/services/tts/lingva/info.ts', 'utf8');
    const supported = extractLanguageKeys(enumSource).filter((k) => k !== 'auto');
    assert.ok(supported.length >= 25, `the Language enum should still be substantial, got ${supported.length}`);

    // 不被 Google 支持的语言；其余都必须有映射。
    // 只有 mn_cy：它不在表里会走 `|| 'en'`（静默说英文），这是当前唯一的
    // 可行选择。fa 不在此列 —— 它在表里且会明确报错，见文件头的说明。
    const KNOWN_UNSUPPORTED = new Set(['mn_cy']);

    const missing = supported.filter((k) => !(k in langMap) && !KNOWN_UNSUPPORTED.has(k));
    assert.deepEqual(missing, [], `these TTS languages would silently fall back to English: ${missing.join(', ')}`);

    // 反向：langMap 不该出现枚举里没有的键（拼错的键会永远取不到）
    const extra = Object.keys(langMap).filter((k) => !supported.includes(k));
    assert.deepEqual(extra, [], `langMap has keys that no Language enum provides: ${extra.join(', ')}`);

    // 结构断言：必须显式写出这 6 项，且挪威语两个变体都指向 'no'
    for (const [key, value] of Object.entries({ sv: 'sv', pl: 'pl', nl: 'nl', km: 'km', nb_no: 'no', nn_no: 'no' })) {
        assert.equal(langMap[key], value, `${key} must map to ${value}`);
    }
    assert.match(code, /if \(!googleLang\) throw new Error/);
});

test('google_tts does not send a language Google cannot synthesize', async () => {
    const langMap = extractLangMap(await readFile(GOOGLE_TTS, 'utf8'));

    // 实测 mn / mn-Cyrl / mn-MN 都是 HTTP 400，不能出现在映射里
    for (const value of Object.values(langMap)) {
        assert.doesNotMatch(value, /^mn\b/i, 'Google TTS returns HTTP 400 for Mongolian');
    }
});

/**
 * 把「两种失败模式」钉死，避免以后有人「顺手」把 fa 从表里删掉 ——
 * 那不会让波斯语能用，只会把它从「明确报错」降级成「静默说英文」，
 * 即把可诊断的失败变成不可诊断的失败。
 *
 * 同时守住：mn_cy 必须**不在**表里。若有人给它补一个 'mn' 映射，
 * 请求会 400，用户从「听到英文」变成「直接报错」—— 那不是本轮的修复目标
 * （Google 侧不支持，本项目无法通过改映射解决）。
 */
test('unsupported TTS languages explicitly fail instead of speaking English', async () => {
    const langMap = extractLangMap(await readFile(GOOGLE_TTS, 'utf8'));

    // fa（波斯语）：Google 的 translate_tts 对 tl=fa 稳定返回 400。
    // 保留在表里 => 抛 `Google TTS request failed: HTTP 400`（用户可见）。
    // 值必须仍是 Google 的波斯语代码，不要换成 fa-IR/fa_IR（实测同样 400，
    // 且会让报错信息里的语言与实际请求不符）。
    assert.equal(
        langMap.fa,
        'fa',
        'fa must stay mapped to the canonical Google code "fa": it is in the map on purpose so ' +
            'the HTTP 400 shows up as an explicit error instead of silently falling back to English'
    );

    // mn_cy（蒙古语）：不在表里 => 回退 'en'。
    assert.ok(
        !('mn_cy' in langMap),
        'mn_cy must NOT be mapped: Google returns HTTP 400 for every Mongolian spelling ' +
            '(mn / mn-Cyrl / mn-MN), so mapping it would turn a silent fallback into a hard error'
    );

    // 回退语句本身必须仍在，上面的两条语义都依赖它
    const code = stripComments(await readFile(GOOGLE_TTS, 'utf8'));
    assert.match(code, /if \(!googleLang\) throw new Error/);
});
