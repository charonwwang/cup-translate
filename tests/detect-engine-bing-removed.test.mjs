import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripComments } from './helpers/source.mjs';

/**
 * 背景：`bing` 语言检测引擎已删除。
 *
 * 依据（2026-10 实测）：
 *   · `bing_detect` 第一步取 token 的端点是
 *     `https://edge.microsoft.com/translate/auth` —— 带完整 Edge UA 复测仍 **HTTP 404**；
 *   · 已删除的 `src/services/translate/bing/index.jsx`（提交 a4d58de）用的是
 *     **同一个端点**，当时判定「上游全死且无自建入口」；
 *   · 即检测侧留下的是同一条死链路。
 *
 * 危害不只是多一次失败请求：`token.ok` 为 false 时该函数**静默落到末尾的
 * `return 'en'`**，中文会被判成英文 —— 界面显示错误的语言标签，并把错误的
 * 源语言传给翻译引擎。已用受控执行复现（喂 "你好世界" 得到 'en'）。
 *
 * 这些断言扫描的是**去掉注释后**的源码：本仓库大量使用「在注释里记录已删除的
 * 东西及其原因」，若不过滤注释，解释性文字本身会把扫描误判成「还在用 bing」。
 */

const LANG_DETECT = 'src/utils/lang_detect.js';
const CONFIG_TRANSLATE = 'src/window/Config/pages/Translate/index.jsx';

const readStripped = async (path) => stripComments(await readFile(path, 'utf8'));

test('lang_detect.js no longer defines or calls bing_detect', async () => {
    const code = await readStripped(LANG_DETECT);
    assert.doesNotMatch(code, /function\s+bing_detect/, 'bing_detect must be gone, not merely unreferenced');
    assert.doesNotMatch(code, /bing_detect\s*\(/, 'no code path may still call bing_detect');
    assert.doesNotMatch(code, /case\s+'bing'\s*:/, "the switch must not keep a 'bing' branch");
});

test('the dead Microsoft token endpoint is gone from the detect path', async () => {
    const code = await readStripped(LANG_DETECT);
    assert.doesNotMatch(code, /edge\.microsoft\.com/, 'the 404 auth endpoint must not remain in lang_detect.js');
});

test('the config UI no longer offers bing as a detection engine', async () => {
    const code = await readStripped(CONFIG_TRANSLATE);
    assert.doesNotMatch(code, /key='bing'/, "the detection-engine dropdown must not offer 'bing'");
});

test('removing bing did not damage its neighbours in the dropdown', async () => {
    // 反向守卫：删错了行会「顺带」删掉别的引擎，这里锁住其余选项仍在。
    const code = await readStripped(CONFIG_TRANSLATE);
    for (const engine of ['baidu', 'tencent', 'niutrans', 'google', 'yandex', 'local']) {
        assert.match(code, new RegExp(`key='${engine}'`), `the dropdown must still offer '${engine}'`);
    }
});

test('the detect switch still routes every remaining engine', async () => {
    // 反向守卫：确认删除 bing 时没有把其它 case 一起删掉。
    const code = await readStripped(LANG_DETECT);
    for (const engine of ['baidu', 'google', 'local', 'tencent', 'niutrans', 'yandex']) {
        assert.match(code, new RegExp(`case\\s+'${engine}'\\s*:`), `the switch must still route '${engine}'`);
        assert.match(
            code,
            new RegExp(`await\\s+${engine}_detect\\(`),
            `'${engine}' must still call ${engine}_detect()`
        );
    }
    assert.match(
        code,
        /default:\s*\n\s*return await local_detect\(text\);/,
        'unknown/removed engines must fall through to the offline local detector'
    );
});
