import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const DEEPL = 'src/services/translate/deepl/index.jsx';

/**
 * 背景（本轮实测）：DeepL 的 API-key 分支把一个 `&&` 写成了逗号表达式。
 *
 *     if ((result.translations, result.translations[0])) {
 *         return result.translations[0].text.trim();
 *     } else {
 *         throw JSON.stringify(result);
 *     }
 *
 * 逗号运算符 `(a, b)` 会先求值 a 再**丢弃**，整个条件等价于只判断 b。
 * 于是 `result.translations` 缺失时，求值 `result.translations[0]` 先抛
 * `TypeError: Cannot read properties of undefined (reading '0')`，
 * 那个本意要抛出服务端原始报错的 `throw JSON.stringify(result)` **永远走不到**。
 *
 * 实测（喂各种无 translations 的错误响应体）：
 *   {"message":"Quota exceeded..."} -> 修复前 TypeError / 修复后 原样 JSON
 *   {"error":{"message":"Forbidden"}} -> 修复前 TypeError / 修复后 原样 JSON
 *
 * 这是**笔误**而非有意为之：同一文件里另外两个分支处理的是同一个问题
 * （响应体里有没有期待字段），都写了真守卫：
 *   line 52:  if (result && result.result && result.result.texts) {
 *   line 77:  if (result['data']) {
 * 只有 115 行退化成了逗号表达式。
 *
 * 用户影响：DeepL 在配额用尽等情况下会用 **HTTP 200 + 错误体** 回应
 * （`res.ok` 的判据是 2xx，见 @tauri-apps/api 的 Response.ok 定义），
 * 原本应显示「配额用尽」，实际显示的是无意义的内建 TypeError 文案。
 */

/** 去掉注释，避免注释里提到的写法被误判成真实代码。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the DeepL response guard is a real guard, not a comma expression', async () => {
    const code = stripComments(await readFile(DEEPL, 'utf8'));

    // 1) 逗号运算符形态必须消失
    assert.doesNotMatch(
        code,
        /\(\s*result\.translations\s*,\s*result\.translations\[0\]\s*\)/,
        'a comma expression discards its left operand, so the guard never protects anything'
    );

    // 2) 必须是真正的 && 守卫
    assert.match(
        code,
        /if \(result\.translations && result\.translations\[0\]\) \{/,
        'the translations guard must short-circuit with &&'
    );

    // 3) 三个分支都要有真守卫（防止将来只有一处退化）
    const guards = [
        /if \(result && result\.result && result\.result\.texts\) \{/,
        /if \(result\['data'\]\) \{/,
        /if \(result\.translations && result\.translations\[0\]\) \{/,
    ];
    for (const g of guards) {
        assert.match(code, g, `missing a response-shape guard: ${g}`);
    }
});

test('real branch: a 200-with-error body surfaces the server message, not a TypeError', async () => {
    const source = await readFile(DEEPL, 'utf8');
    const body = extractFunctionBody(source, 'translate_by_key');

    // 用真实的函数体求值；把 fetch 换成返回受控响应的桩
    const makeRunner = (response) =>
        new Function(
            'fetch',
            'Body',
            // 函数体自己会声明 url，不要再注入同名变量；
            // 且它内部用了 await，所以要包一层 async 并 return 出结果。
            `return async (text, from, to, key) => { ${body} };`
        )(async () => response, { json: (v) => v, text: (v) => v });

    // 场景 1：HTTP 200 + 错误体（无 translations）—— DeepL 配额用尽时的真实形态
    const errorBody = { message: 'Quota exceeded. Check your usage limits.' };
    const run = makeRunner({ ok: true, status: 200, data: errorBody });
    await assert.rejects(
        () => run('hello', 'en', 'zh', 'fake-key:fx'),
        (err) => {
            // 必须抛出服务端的原始报错内容…
            assert.equal(err, JSON.stringify(errorBody), `expected the raw body, got: ${String(err)}`);
            // …而不是内建的 TypeError 文案
            assert.doesNotMatch(String(err), /Cannot read properties of undefined/);
            return true;
        }
    );

    // 场景 2：translations 为空数组
    const run2 = makeRunner({ ok: true, status: 200, data: { translations: [] } });
    await assert.rejects(
        () => run2('hello', 'en', 'zh', 'fake-key:fx'),
        (err) => {
            assert.equal(err, JSON.stringify({ translations: [] }));
            return true;
        }
    );

    // 场景 3：正常响应仍然返回译文
    const run3 = makeRunner({ ok: true, status: 200, data: { translations: [{ text: '  你好  ' }] } });
    assert.equal(await run3('hello', 'en', 'zh', 'fake-key:fx'), '你好');
});

/** 取出一个具名 async 函数的函数体（括号配平，不依赖缩进）。 */
function extractFunctionBody(source, name) {
    const start = source.indexOf(`async function ${name}(`);
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
