import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const LOCAL_TTS_INFO = 'src/services/tts/local_tts/info.ts';
const RUST_TTS = 'src-tauri/src/tts.rs';

/**
 * 背景：`local_tts` 把语言键交给 Rust 的 `voice_for()` 解析成 espeak-ng 音色名。
 * 如果前端枚举加了一个键、而 `voice_for` 映射不到 espeak 支持的音色，
 * 合成会**失败**（用户看到「朗读」报错），而现有的 Rust 单测
 * （`language_keys_map_to_espeak_voices`）只硬写了 10 个**样例**键，
 * 对前端 25 个键里漏掉的那些**不会报警** —— 这正是一种
 * 「清单无法自证完整」的形态：手写的样例永远覆盖不到自己没想到的项。
 *
 * 因此这里改为**从权威来源推导**：
 *   · 被测集合 = `local_tts/info.ts` 的 Language 枚举（真实会被传下去的值）
 *   · 判据     = espeak-ng 官方 `docs/languages.md` 的标识清单（固定快照，见下）
 *
 * espeak-ng 的语言标识很少变动，所以把快照内联在测试里（避免测试依赖网络）。
 * 快照来源：https://github.com/espeak-ng/espeak-ng/blob/master/docs/languages.md
 * （Development version supports 127 languages；表中 Identifier 列共 119 个唯一标识）
 *
 * 实测（本轮）：把 local_tts 的 25 个键逐个经 voice_for 规则换算后比对快照，
 * **全部命中** —— 也就是说当前**没有**缺陷，这条护栏是为了防止将来回退。
 */

/** espeak-ng 支持的音色/语言标识（来自官方 languages.md 的 Identifier 列）。 */
const ESPEAK_VOICES = new Set([
    'af',
    'am',
    'an',
    'ar',
    'as',
    'az',
    'ba',
    'be',
    'bg',
    'bn',
    'bpy',
    'bs',
    'ca',
    'chr',
    'cmn',
    'cs',
    'cv',
    'cy',
    'da',
    'de',
    'el',
    'en',
    'eo',
    'es',
    'et',
    'eu',
    'fa',
    'fi',
    'fr',
    'ga',
    'gd',
    'gn',
    'grc',
    'gu',
    'hak',
    'he',
    'hi',
    'hr',
    'ht',
    'hu',
    'hy',
    'hyw',
    'ia',
    'id',
    'is',
    'it',
    'ja',
    'jbo',
    'ka',
    'kk',
    'kl',
    'kn',
    'ko',
    'kok',
    'ku',
    'ky',
    'la',
    'lb',
    'lt',
    'lv',
    'mi',
    'mk',
    'ml',
    'mn',
    'mr',
    'ms',
    'mt',
    'my',
    'nci',
    'ne',
    'nl',
    'no',
    'nog',
    'or',
    'pa',
    'pap',
    'piqd',
    'pl',
    'pt',
    'py',
    'qu',
    'ro',
    'ru',
    'sd',
    'si',
    'sk',
    'sl',
    'smj',
    'sq',
    'sr',
    'sv',
    'sw',
    'ta',
    'te',
    'th',
    'ti',
    'tk',
    'tn',
    'tr',
    'tt',
    'ug',
    'uk',
    'ur',
    'uz',
    'vi',
    'yue',
    'zh',
]);

/** 复刻 Rust `voice_for()` 的归一化规则（tts.rs:44-54）。 */
function voiceFor(lang) {
    const normalized = String(lang).trim().toLowerCase().replace(/_/g, '-');
    const primary = normalized.split('-')[0].trim();
    if (primary === '') return 'en';
    return ['zh', 'cmn', 'yue'].includes(primary) ? 'cmn' : primary;
}

test('every local_tts language resolves to a real espeak-ng voice', async () => {
    const info = await readFile(LOCAL_TTS_INFO, 'utf8');
    const entries = [...info.matchAll(/^\s{4}(\w+) = '([^']*)'/gm)].map((m) => [m[1], m[2]]);
    assert.ok(entries.length >= 20, `the Language enum should still be substantial, got ${entries.length}`);

    const unresolved = [];
    for (const [key, value] of entries) {
        if (value === 'auto') continue;
        const voice = voiceFor(value);
        if (!ESPEAK_VOICES.has(voice)) unresolved.push(`${key} (${value}) -> ${voice}`);
    }
    assert.deepEqual(unresolved, [], `these local_tts languages have no espeak-ng voice: ${unresolved.join(', ')}`);
});

test('voice_for normalization matches the Rust implementation', async () => {
    const rust = await readFile(RUST_TTS, 'utf8');

    // 结构断言：Rust 侧必须仍做 小写化 + 下划线转连字符 + 取主语言 + 空值回退
    assert.match(
        rust,
        /lang\.trim\(\)\.to_lowercase\(\)\.replace\('_', "-"\)/,
        'normalization must still lowercase and swap _ for -'
    );
    assert.match(rust, /"zh" \| "cmn" \| "yue" => "cmn"/, 'Chinese variants must map to cmn');
    assert.match(
        rust,
        /if primary\.is_empty\(\) \{\s*return "en"\.to_string\(\);/,
        'an empty primary tag must fall back to en'
    );

    // 行为断言：本测试的 JS 复刻与 Rust 规则逐项一致
    assert.equal(voiceFor('zh_cn'), 'cmn');
    assert.equal(voiceFor('zh_tw'), 'cmn');
    assert.equal(voiceFor('yue'), 'cmn');
    assert.equal(voiceFor('ZH_CN'), 'cmn');
    assert.equal(voiceFor('pt_br'), 'pt');
    assert.equal(voiceFor('en-US'), 'en');
    assert.equal(voiceFor(''), 'en');
    assert.equal(voiceFor('   '), 'en');
    assert.equal(voiceFor('-'), 'en');

    // 反向核对：确认前端枚举里**确实**存在中文变体，且它们的值都是 'zh'
    // （Rust 侧断言的是键 `voice_for("zh_cn")`，而前端枚举右侧的值才是
    //  真正传下去的字符串 `'zh'` —— 两者不是一回事，别混用）
    const info = await readFile(LOCAL_TTS_INFO, 'utf8');
    const enumEntries = [...info.matchAll(/^\s{4}(\w+) = '([^']*)'/gm)].map((m) => [m[1], m[2]]);
    const enumByKey = new Map(enumEntries);
    for (const key of ['zh_cn', 'zh_tw']) {
        assert.equal(enumByKey.get(key), 'zh', `${key} must still map to the espeak-ng primary tag 'zh'`);
    }
    assert.equal(voiceFor(enumByKey.get('zh_cn')), 'cmn');
    // yue 只出现在 recognize/tesseract 的枚举里，local_tts 没有这个键；
    // 但 Rust 的 voice_for 仍要为它兜底（作为原始语言标签直接传入时）
    assert.equal(enumByKey.has('yue'), false, 'local_tts intentionally has no yue key');
    assert.equal(voiceFor('yue'), 'cmn');
});

// ── 本轮新增：TTS 引擎探测的两条护栏（源码级，因为需要真实外部程序才可运行）──

/**
 * 背景（实测）：`tts.rs` 的 `detect_engine()` 原来用
 * `Command::new(prog).arg("--version").output().is_ok()` 判断引擎是否可用。
 * 但 `Ok` 只表示「进程被成功创建并运行完毕」，**与退出码无关** ——
 * 实测 `Command::new("false").arg("--version").output()` 返回 `Ok`，
 * 而 `status.success()` 为 `false`。于是一个能启动、但 `--version`
 * 不被支持（或任何以非 0 退出）的二进制会被误判为可用，
 * 用户点「朗读」时才真正失败。
 * （对照：「二进制不存在」会返回 `Err`，原写法能挡住那一种。）
 *
 * 修复：新增 `engine_available()`，要求退出码为 0。
 * 行为契约由 Rust 单测 `engine_probe_requires_a_zero_exit_status` 覆盖；
 * 这里只锁「不再退回 is_ok()」这条源码形态。
 */
test('tts engine probing checks the exit status, not merely that the process spawned', async () => {
    const source = await readFile(RUST_TTS, 'utf8');
    const code = source
        .replace(/^\s*\/\/\/.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split(/#\[cfg\(test\)\]/)[0];

    assert.doesNotMatch(
        code,
        /\.output\(\)\s*\.is_ok\(\)/,
        'is_ok() ignores the exit code: a binary that exits nonzero would count as available'
    );
    assert.match(code, /fn engine_available\(program: &str\) -> bool/, 'must funnel all probes through one helper');
    assert.match(code, /output\.status\.success\(\)/, 'the probe must require a zero exit status');
    // 三个候选引擎都必须走同一条判据，不允许某个分支偷偷用别的写法
    for (const engine of ['espeak-ng', 'espeak', 'spd-say']) {
        assert.match(code, new RegExp(`engine_available\\("${engine}"\\)`), `${engine} must use engine_available`);
    }
    // 反向自检：确认剥注释后仍有实质内容
    assert.ok(code.length > 2000, `stripped source looks too small: ${code.length} bytes`);
});

/**
 * 背景：原实现在 `match detect_engine()` 里**已经拿到**引擎，内层却再调一次
 * `detect_engine()` 重新判断：
 *
 *     match detect_engine() {
 *         Some(TtsEngine::EspeakNg) | Some(TtsEngine::Espeak) => {
 *             let engine = if matches!(detect_engine(), Some(TtsEngine::EspeakNg)) { ... }
 *
 * 这是两处独立的真值来源。当前 `OnceLock` 缓存让两者恒等，所以**没有**已知故障；
 * 但这属隐含耦合 —— 一旦缓存语义被改动（例如去掉 OnceLock 让它每次真探测），
 * 外层可能进 espeak 分支而内层判成 espeak-ng，于是去调用一个不存在的程序。
 * 现在改用模式绑定 `Some(engine @ (...))`，从根上消除这种可能。
 *
 * 诚实说明：本机没有安装任何本地 TTS 引擎，无法构造出真实的分叉场景；
 * 这条防的是脆弱性，不是已观测到的故障。
 */
test('tts_speak uses the engine it just probed instead of probing again', async () => {
    const source = await readFile(RUST_TTS, 'utf8');
    const code = source
        .replace(/^\s*\/\/\/.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split(/#\[cfg\(test\)\]/)[0];

    // 生产代码里 detect_engine() 只应出现两次：定义处 + tts_speak 里那一次
    const calls = code.match(/detect_engine\(\)/g) ?? [];
    assert.equal(
        calls.length,
        2,
        `detect_engine() should be defined once and called once in production code, found ${calls.length}`
    );
    // 必须用模式绑定取出引擎
    assert.match(
        code,
        /Some\(engine @ \(TtsEngine::EspeakNg \| TtsEngine::Espeak\)\)/,
        'the match must bind the engine so there is a single source of truth'
    );
    // 不允许再出现「用 matches! 重新判断探测结果」的写法
    assert.doesNotMatch(
        code,
        /matches!\(detect_engine\(\)/,
        're-probing inside the match discards the value already bound by it'
    );
});
