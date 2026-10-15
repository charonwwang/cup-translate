import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isFilledPort, isFilledString } from '../src/utils/configValue.js';

/**
 * 「配置值真的填了吗」的判定。
 *
 * 背景（round 48/49 实测，同类缺陷反复出现）：项目里多处用
 * `value === ''` / `value !== ''` 判断是否填了，而那是**精确比较空串**，
 * 纯空白（`'   '` / `'\t'` / `'\n'`）会穿过去。
 *
 * 已经实测到两处真实后果：
 *   1) `required_config.js`（round 48）：配置闸门放行纯空白的
 *      apiKey / requestPath，**全部 11 个登记引擎**都会发出注定失败的请求。
 *   2) `General/index.jsx`（round 49）：代理开关的
 *      `proxyHost === '' || proxyPort === ''` 放行纯空白 host，
 *      最终 Rust 的 `set_proxy()` 把 `http://   :7890` 写进
 *      http_proxy / https_proxy / all_proxy 环境变量。
 *      **用真实二进制验证过**：proxy_host='   ' 时 set_proxy() 成功返回、
 *      启动日志没有任何告警——也就是说这个坏值被当成了合法配置。
 */

test('isFilledString rejects empty and whitespace-only values', () => {
    for (const blank of ['', ' ', '   ', '\t', '\n', '\r\n', ' \t\n ']) {
        assert.equal(isFilledString(blank), false, `${JSON.stringify(blank)} must not count as filled`);
    }
});

test('isFilledString accepts values with incidental surrounding whitespace', () => {
    // 从网页/文档复制时尾部常带空格或换行，那是真实且正确的操作，不能误伤
    for (const good of ['a', ' 127.0.0.1 ', '\thttp://x\n', 'sk-abc']) {
        assert.equal(isFilledString(good), true, `${JSON.stringify(good)} must count as filled`);
    }
});

test('isFilledString rejects non-strings', () => {
    for (const bad of [0, 1, true, false, {}, [], null, undefined, NaN, () => {}]) {
        assert.equal(isFilledString(bad), false, `${String(bad)} must not count as filled`);
    }
});

test('isFilledPort handles both number and string ports', () => {
    // 这是本轮最关键的一条：端口经 nextPortValue 存进配置的是 **number**，
    // 若拿 isFilledString 去判，`isFilledString(7890) === false`——
    // 所有正常填写的端口都会被判为「没填」，比原缺陷更糟（直接锁死功能）。
    assert.equal(isFilledString(7890), false, 'this is exactly why isFilledPort must exist');
    assert.equal(isFilledPort(7890), true);
    assert.equal(isFilledPort('7890'), true);
    assert.equal(isFilledPort(' 7890 '), true);
    assert.equal(isFilledPort(1), true);
    assert.equal(isFilledPort(65535), true);

    for (const bad of [
        '',
        '   ',
        0,
        '0',
        -1,
        'abc',
        '12abc',
        1.5,
        '1.5',
        65536,
        '99999',
        NaN,
        Infinity,
        null,
        undefined,
        {},
        [],
    ]) {
        assert.equal(isFilledPort(bad), false, `${String(bad)} is not a valid port`);
    }
});

test('the helpers never mutate the values they inspect', () => {
    const config = { host: ' 127.0.0.1 ', port: ' 7890 ' };
    const snapshot = JSON.stringify(config);
    isFilledString(config.host);
    isFilledPort(config.port);
    assert.equal(JSON.stringify(config), snapshot, 'the helpers must be read-only');
});

test('the proxy switch no longer validates with === empty-string comparison', async () => {
    // 接线护栏：删掉 isFilledString / isFilledPort 调用、退回 `=== ''`，
    // 上面所有测试依然会通过（它们只测纯函数）。这里直接扫源码。
    const source = await readFile('src/window/Config/pages/General/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /isFilledString\s*\(\s*proxyHost\s*\)/, 'the proxy host must go through isFilledString');
    assert.match(code, /isFilledPort\s*\(\s*proxyPort\s*\)/, 'the proxy port must go through isFilledPort');
    assert.ok(
        !/proxyHost === '' \|\| proxyPort === ''/.test(code),
        "the proxy switch must not fall back to `=== ''`: a whitespace-only host passes it"
    );
    assert.match(
        source,
        /import \{[^}]*isFilledString[^}]*\} from '[^']*utils\/configValue'/,
        'the helper must be imported'
    );
});

test('the Rust set_proxy check trims before deciding', async () => {
    // Rust 侧同样有 `!value.is_empty()`，纯空白会穿过去。
    // 直接扫描源码确认用的是 trim。
    const source = await readFile('src-tauri/src/cmd.rs', 'utf8');
    const start = source.indexOf('pub fn set_proxy()');
    assert.notEqual(start, -1, 'set_proxy should exist');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.match(body, /trim\(\)\.is_empty\(\)/, 'set_proxy must reject whitespace-only hosts');
    assert.ok(
        !/filter\(\|value\| !value\.is_empty\(\)\)/.test(body),
        'set_proxy must not use the untrimmed is_empty check'
    );
});

test('the proxy host and port are required together, matching the Rust guard', async () => {
    // 前端与 Rust 的判据必须一致，否则会出现「前端放行、Rust 拒绝」的静默不一致：
    // Rust 为 host 与 port 都做了校验（host 非空白、port 为 1..=65535 的 u16）。
    const source = await readFile('src-tauri/src/cmd.rs', 'utf8');
    const start = source.indexOf('pub fn set_proxy()');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.match(body, /proxy_port/, 'set_proxy must read proxy_port');
    assert.match(body, /u16::try_from/, 'set_proxy must bound the port to u16');
    assert.match(body, /\*value != 0/, 'set_proxy must reject port 0');
});
