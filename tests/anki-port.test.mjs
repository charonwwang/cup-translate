import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ANKI_DEFAULT_PORT, resolveAnkiPort } from '../src/services/collection/anki/port.js';

/**
 * Anki Connect 端口的健壮性。
 *
 * 背景（round 47 实测）：`src/services/collection/anki/index.jsx` 原本写的是
 *     const port = ankiConfig['port'] ?? 8765;
 * 而 `??` **只挡 null / undefined**：实测 `('' ?? 8765) === ''`。
 * 设置页又用 `onValueChange` 把输入框的值**原样**存进配置，所以用户清空
 * 端口输入框后，拼出来的 URL 是 `http://127.0.0.1:`。
 *
 * 用 node 的真实 URL 解析器实测后果分三类：
 *   'http://127.0.0.1:'      -> 解析成功但 port 为空 → 连到默认端口，不是用户要的
 *   'http://127.0.0.1:abc'   -> 抛 Invalid URL
 *   'http://127.0.0.1:99999' -> 抛 Invalid URL（超出 u16）
 *   'http://127.0.0.1:-1'    -> 抛 Invalid URL
 * 即清空会**静默连错端口**，填错会**直接抛错**，而用户只看到「收集失败」。
 *
 * 对照：General 页的 server_port 早已用 `utils/port.js` 的 `nextPortValue`
 * 做了同样的防护，Anki 这个兄弟输入框漏了——属于同一类契约在个别处失守。
 */

test('empty or whitespace port falls back to the default', () => {
    // 这是最常见的情况：用户清空输入框
    assert.equal(resolveAnkiPort(''), ANKI_DEFAULT_PORT);
    assert.equal(resolveAnkiPort('   '), ANKI_DEFAULT_PORT);
    assert.equal(resolveAnkiPort('\t\n'), ANKI_DEFAULT_PORT);
});

test('valid ports are preserved as numbers', () => {
    assert.equal(resolveAnkiPort(8765), 8765);
    assert.equal(resolveAnkiPort('8765'), 8765);
    assert.equal(resolveAnkiPort(3000), 3000);
    assert.equal(resolveAnkiPort('3000'), 3000);
    assert.equal(resolveAnkiPort(' 3000 '), 3000);
    assert.equal(resolveAnkiPort(1), 1);
    assert.equal(resolveAnkiPort(65535), 65535);
});

test('every rejected input falls back instead of producing a broken URL', () => {
    for (const bad of ['abc', '12abc', '-1', '0', '99999', '65536', '1.5', 'Infinity', '-Infinity', 'NaN']) {
        assert.equal(resolveAnkiPort(bad), ANKI_DEFAULT_PORT, `${bad} should fall back to the default`);
    }
    for (const bad of [null, undefined, {}, [], NaN, Infinity, true, () => {}]) {
        assert.equal(resolveAnkiPort(bad), ANKI_DEFAULT_PORT, `${String(bad)} should fall back`);
    }
});

test('the resolved port always yields a URL the real parser accepts', () => {
    // 行为断言：不只看返回值，而是把结果真的拼成 URL 交给 node 的解析器。
    // 修复前 '' 会产出 'http://127.0.0.1:'（能解析但端口不对），
    // 'abc' 会产出 'http://127.0.0.1:abc'（直接抛错）。
    const inputs = [
        '',
        ' ',
        'abc',
        '12abc',
        '-1',
        '0',
        '99999',
        '1.5',
        'Infinity',
        null,
        undefined,
        {},
        NaN,
        '8765',
        3000,
    ];
    for (const input of inputs) {
        const port = resolveAnkiPort(input);
        const url = `http://127.0.0.1:${port}`;
        const parsed = new URL(url);
        assert.equal(
            parsed.port,
            String(port),
            `input ${String(JSON.stringify(input))} produced ${url}, which parses to the wrong port`
        );
        assert.equal(parsed.hostname, '127.0.0.1');
    }
});

test('parseInt-style lenient parsing is not used', () => {
    // parseInt('12abc') === 12 —— 会把垃圾后缀悄悄吞掉，让「写错了」变成
    // 「悄悄用了另一个端口」。必须判为非法并回退，而不是当成 12。
    assert.equal(resolveAnkiPort('12abc'), ANKI_DEFAULT_PORT);
    assert.notEqual(resolveAnkiPort('12abc'), 12);
    assert.equal(resolveAnkiPort('8765xyz'), ANKI_DEFAULT_PORT);
});

test('the collection service no longer uses nullish coalescing for the port', async () => {
    // 接线护栏：删掉 resolveAnkiPort 调用、退回 `?? 8765` 会让上面所有测试
    // 依然通过（它们只测纯函数）。这里直接扫源码，确保调用点存在。
    const source = await readFile('src/services/collection/anki/index.jsx', 'utf8');
    assert.match(
        source,
        /resolveAnkiPort\s*\(/,
        'anki/index.jsx must call resolveAnkiPort — `?? 8765` lets an empty string through'
    );
    // 必须剔除注释再判定：本测试的第一版直接在原文里搜 `?? 8765`，
    // 结果匹配到了**我自己写的解释性注释**（"用 resolveAnkiPort 而不是 `?? 8765`"），
    // 于是护栏把正确的修复判成违规。剔除注释后只检查真实代码。
    // （同类「关键词出现在注释里骗过/误伤护栏」的坑见 round 44 的 fetch 护栏。）
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(
        !/\?\?\s*8765/.test(code),
        'anki/index.jsx must not fall back to `?? 8765`: it does not catch the empty string'
    );
    assert.match(code, /const port = resolveAnkiPort\(/, 'the port must come from resolveAnkiPort');
});

test('the settings input validates before writing to config', async () => {
    const source = await readFile('src/services/collection/anki/Config.jsx', 'utf8');
    assert.match(
        source,
        /nextPortValue\s*\(/,
        "Config.jsx must validate with nextPortValue, like General's server_port input"
    );
    // 不能再把输入框的原始值直接写进配置
    assert.ok(!/port:\s*value,/.test(source), 'Config.jsx must not write the raw input value into the config');
});

test('the fallback constant matches Anki Connect s actual default port', async () => {
    // 8765 是 Anki Connect 的默认端口；同时确认设置页的默认值也一致，
    // 否则「清空输入框」与「从未设置过」会连到不同端口。
    assert.equal(ANKI_DEFAULT_PORT, 8765);
    const source = await readFile('src/services/collection/anki/Config.jsx', 'utf8');
    assert.match(source, /port:\s*8765/, "Config.jsx's default must match ANKI_DEFAULT_PORT");
});

test('the empty-string and trim branches are equivalent redundancy, not load-bearing', () => {
    // 变异测试实测：删掉「空串 -> 默认值」分支、或把 raw.trim() 换成 raw，
    // 行为**完全不变**（下面的断言就是这个等价性的证据）。
    // 记录在此，避免以后有人以为它们是不可达的死防御而困惑，也避免
    // 有人误以为删掉它们会削弱防护。
    //   · Number('') === 0  —— 0 通过 Number.isInteger，被 `parsed < 1` 判非法
    //   · Number('  3000  ') === 3000 —— Number() 自己忽略首尾空白
    assert.equal(Number(''), 0);
    assert.equal(Number.isInteger(Number('')), true);
    assert.equal(Number('  3000  '), 3000);
    assert.equal(Number('   '), 0);

    // 因此这些输入无论走哪条分支，结果都必须一样
    for (const blank of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
        assert.equal(resolveAnkiPort(blank), ANKI_DEFAULT_PORT, `${JSON.stringify(blank)} must fall back`);
    }
    for (const padded of [' 3000 ', '\t3000\n', '  65535  ']) {
        assert.equal(resolveAnkiPort(padded), Number(padded.trim()), `${JSON.stringify(padded)} must parse`);
    }
});
