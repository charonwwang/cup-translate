import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkText } from '../src/services/tts/google_tts/chunkText.js';

/**
 * 背景（本轮实测）：google_tts 把长文本按 ~200 字符分段后逐段请求
 * Google 的 translate_tts 端点。原先的分段逻辑在**找不到分隔符**时
 * 仍然走 `slice(0, cut + 1)`，而 cut 此时被置为 maxLen，
 * 于是每段变成 201 个字符、超出上限。
 *
 * 中文没有空格，`lastIndexOf(' ', 200)` 返回 -1，回退到 '。'；
 * 而中文句号间隔常常远超 200，`lastIndexOf('。', 200)` 也可能是 -1，
 * 最终落到硬切分支——所以**中文长文本每段恒为 201**，实测 2/3 段越界。
 *
 * 溢出量只有 1 个字符，Google 端点未必因此拒绝请求，
 * 所以这里**不声称**它会导致功能故障；但它是实打实的越界，
 * 属于 off-by-one，修掉才是分段逻辑的本意。
 *
 * 这些测试直接 import 并执行**真实实现**（chunkText），不是复刻一份逻辑。
 */

test('no chunk ever exceeds the requested maximum length', () => {
    const cases = {
        '英文长文本（有空格）': 'word '.repeat(200),
        '中文长文本（无空格）': '这是一段用于测试的中文文本，'.repeat(60),
        中文无任何标点: '中'.repeat(1000),
        以空格开头: ' ' + 'a'.repeat(900),
        '第 200 个字符正好是空格': 'a'.repeat(200) + ' ' + 'b'.repeat(500),
        大量连续空格: ' '.repeat(800) + 'x'.repeat(300),
        混合中英标点: 'Hello 世界。foo bar. '.repeat(80),
        恰好等于上限: 'x'.repeat(200),
        上限加一: 'x'.repeat(201),
    };

    for (const [name, text] of Object.entries(cases)) {
        const chunks = chunkText(text);
        const tooLong = chunks.filter((c) => c.length > 200);
        assert.deepEqual(
            tooLong.map((c) => c.length),
            [],
            `${name}: every chunk must be <= 200 chars, got lengths ${chunks.map((c) => c.length).join(', ')}`
        );
    }
});

test('chunking never loses or reorders characters', () => {
    // 分段必须是无损的：拼回来要与原文（trim 后）完全一致，
    // 否则朗读会缺字或重复。这是比长度上限更重要的正确性约束。
    const cases = [
        'word '.repeat(200),
        '这是一段用于测试的中文文本，'.repeat(60),
        '中'.repeat(1000),
        'a'.repeat(200) + ' ' + 'b'.repeat(500),
        'Hello 世界。foo bar. '.repeat(80),
        'x'.repeat(201),
    ];

    for (const text of cases) {
        const chunks = chunkText(text);
        assert.equal(chunks.join(''), text.trim(), `chunking must be lossless for ${text.slice(0, 20)}…`);
    }
});

test('chunking terminates even when there is no delimiter at all', () => {
    // 最坏输入：完全没有分隔符。必须前进，不能死循环。
    // 用一个足够大的输入确保若步进为 0 会明显卡住。
    const chunks = chunkText('中'.repeat(5000));
    assert.ok(chunks.length >= 25, `expected the text to be split, got ${chunks.length} chunks`);
    assert.equal(chunks.join(''), '中'.repeat(5000));
    assert.ok(
        chunks.every((c) => c.length <= 200),
        'every chunk of a delimiter-free text must still respect the limit'
    );
});

test('a delimiter is kept at the end of the preceding chunk', () => {
    // 分隔符归前一段：这样朗读不会把词切断。
    const text = 'a'.repeat(150) + ' ' + 'b'.repeat(300);
    const chunks = chunkText(text);
    assert.ok(
        chunks[0].endsWith(' '),
        `expected the first chunk to end with the delimiter, got ${JSON.stringify(chunks[0].slice(-5))}`
    );
    assert.equal(chunks.join(''), text);
});

test('short and empty inputs are handled without producing empty chunks', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   '), []);
    assert.deepEqual(chunkText('hello'), ['hello']);
    assert.deepEqual(chunkText('  hello  '), ['hello']);
    // 任何情况下都不应产出空片段（会给端点发一次无意义的请求）
    for (const text of ['x'.repeat(500), 'word '.repeat(100), '中'.repeat(450)]) {
        const chunks = chunkText(text);
        assert.ok(
            chunks.every((c) => c.length > 0),
            'no chunk should ever be empty'
        );
    }
});

test('a custom limit is honoured as well', () => {
    // 让上限可配置后，同样不能越界（回归到「硬切用了 cut + 1」的错法就会失败）
    const chunks = chunkText('中'.repeat(100), 10);
    assert.ok(
        chunks.every((c) => c.length <= 10),
        `custom maxLen must be respected, got ${chunks.map((c) => c.length).join(', ')}`
    );
    assert.equal(chunks.join(''), '中'.repeat(100));
});
