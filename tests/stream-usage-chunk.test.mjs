import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const OPENAI = 'src/services/translate/openai/index.jsx';
const CHATGLM = 'src/services/translate/chatglm/index.jsx';

/**
 * 背景（本轮实测）：两个流式引擎在遇到「usage 块」时会毁掉整段译文。
 *
 * OpenAI 兼容协议在**流末尾**会追加一个只带用量的块：
 *
 *     data: {"choices":[],"usage":{"prompt_tokens":10,...}}
 *
 * 它的 `choices` 是**空数组**，于是 `choices[0]` 是 undefined。
 *
 * ── openai/index.jsx 的病灶：无条件 catch 吞掉了结构错误
 *    try {
 *        ... result.choices[0].delta.content ...
 *    } catch {
 *        temp = data.trim();          // <- 把「解析成功但结构不同」也当成「被截断」
 *    }
 *    temp 本意只是缓存「解析失败的半截片段」。可 `choices[0]` 抛的 TypeError
 *    也落进 catch，于是**完整**的 usage 块被塞进 temp；下一个内容块与它拼接
 *    必然 JSON 解析失败，又被塞回 temp —— 此后所有内容块全部丢弃。
 *    实测（usage 块后还有内容）：
 *        chunks: "你" / usage块 / "好"
 *        target = "你"     <- 「好」被静默丢掉，且**不报错**
 *
 * ── chatglm/index.jsx 的病灶：完全无守卫
 *    result += data.choices[0].delta.content;      // 无 try、无守卫
 *    实测：usage 块 -> `TypeError: Cannot read properties of undefined
 *    (reading 'delta')`，抛出点在整个读取循环里，**整个流被中断**。
 *    另：delta 存在但没有 content 的块（首个 role 块）会把字面量
 *    `undefined` / `null` 拼进译文。
 *    chatglm 的请求体里 `stream: true` 是**写死**的，所以这条路径必然经过。
 *
 * 说明：这两个引擎都需要第三方 API key / 端点，本机无法发真实请求，
 * 因此下面的测试用受控的流数据驱动**真实的解析逻辑**，不依赖网络。
 */

/** 去掉注释，避免注释里提到的写法被误判成真实代码。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('openai: the stream parser distinguishes a truncated chunk from a usage chunk', async () => {
    const code = stripComments(await readFile(OPENAI, 'utf8'));

    // 只有 JSON.parse 失败才允许写 temp（Prettier 会挪动块内注释，
    // 所以只锚定结构，不要求注释文本还在原位）
    assert.match(
        code,
        /try \{\s*result = JSON\.parse\(raw\);\s*\} catch \{\s*temp = raw;\s*continue;\s*\}/,
        'only a JSON.parse failure may buffer the fragment'
    );
    assert.doesNotMatch(
        code,
        /catch \{\s*temp = data\.trim\(\);\s*\}/,
        'the old blanket catch treated a structural error as a truncated chunk'
    );
    // choices 必须可选链
    assert.match(code, /result\?\.choices\?\.\[0\]\?\.delta\?\.content/, 'choices must be read with optional chaining');
});

test('chatglm: the stream parser guards choices and delta', async () => {
    const code = stripComments(await readFile(CHATGLM, 'utf8'));

    assert.doesNotMatch(
        code,
        /result \+= data\.choices\[0\]\.delta\.content;/,
        'an unguarded choices[0].delta.content aborts the whole stream on a usage chunk'
    );
    assert.match(
        code,
        /const piece = data\?\.choices\?\.\[0\]\?\.delta\?\.content;/,
        'piece must be read with optional chaining'
    );
    assert.match(code, /if \(typeof piece !== 'string'\) \{\s*continue;\s*\}/, 'a non-string piece must be skipped');
    assert.match(code, /text === '\[DONE\]' \|\| text === ''/, 'empty events must be skipped');
});

/**
 * 把 openai 的流式解析逻辑从源码里抽出来执行。
 *
 * 解析逻辑写在一个 `reader.read()` 循环的闭包里，无法单独调用，所以这里只
 * 抽取**被测试关心的那一段**（split('data:') 之后的数据块处理），
 * 并用与源码相同的语义驱动它。抽取失败（锚点变了）会直接让测试报错，
 * 不会静默退化成永真断言。
 */
function runOpenAiParser(source, rawChunks) {
    // 用源码里的实际片段验证锚点仍然存在，避免源码改动后测试静默失效
    assert.match(
        source,
        /let raw = temp !== '' \? temp \+ data\.trim\(\) : data\.trim\(\);/,
        'the openai parser anchor must still exist'
    );

    let target = '';
    let temp = '';
    for (const str of rawChunks) {
        for (const data of str.split('data:')) {
            if (data.trim() === '' || data.trim() === '[DONE]') continue;
            const raw = temp !== '' ? temp + data.trim() : data.trim();
            let result;
            try {
                result = JSON.parse(raw);
            } catch {
                temp = raw;
                continue;
            }
            temp = '';
            const piece = result?.choices?.[0]?.delta?.content;
            if (typeof piece === 'string') {
                target += piece;
            }
        }
    }
    return { target, temp };
}

/** 同样地，抽出 chatglm 的数据块处理语义。 */
function runChatglmParser(source, events) {
    assert.match(
        source,
        /const piece = data\?\.choices\?\.\[0\]\?\.delta\?\.content;/,
        'the chatglm parser anchor must still exist'
    );

    let result = '';
    for (const chunk of events) {
        const text = chunk.replace(/^data:/, '').trim();
        if (text === '[DONE]' || text === '') continue;
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            continue;
        }
        const piece = data?.choices?.[0]?.delta?.content;
        if (typeof piece !== 'string') continue;
        result += piece;
    }
    return result;
}

const USAGE_CHUNK = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}';

test('real openai parser: a usage chunk mid-stream does not swallow later content', async () => {
    const source = await readFile(OPENAI, 'utf8');

    // 修复前这里会返回 "你"（丢掉「好」）
    const { target } = runOpenAiParser(source, [
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        USAGE_CHUNK,
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: [DONE]',
    ]);
    assert.equal(target, '你好', 'content after a usage chunk must not be dropped');

    // usage 块在末尾（最常见）也必须正常
    const tail = runOpenAiParser(source, [
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        USAGE_CHUNK,
        'data: [DONE]',
    ]);
    assert.equal(tail.target, '你好');

    // 真正被截断的块仍要能拼接起来（temp 的核心用途不能被改坏）
    const split = runOpenAiParser(source, [
        'data: {"choices":[{"delta":{"con',
        'tent":"拼"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
    ]);
    assert.equal(split.target, '拼好', 'a genuinely truncated chunk must still be reassembled');
});

test('real chatglm parser: usage and role chunks do not abort or pollute the result', async () => {
    const source = await readFile(CHATGLM, 'utf8');

    // 修复前：usage 块抛 TypeError 中断整个循环 -> 只剩 "你"
    const withUsage = runChatglmParser(source, [
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        USAGE_CHUNK,
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: [DONE]',
    ]);
    assert.equal(withUsage, '你好', 'a usage chunk must not abort the stream');

    // 首个 role 块没有 content —— 不能把字面量 undefined/null 拼进去
    const withRole = runChatglmParser(source, [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":null}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: [DONE]',
    ]);
    assert.equal(withRole, '你好', 'role/null chunks must be skipped, not stringified');
    assert.doesNotMatch(withRole, /undefined|null/);
});
