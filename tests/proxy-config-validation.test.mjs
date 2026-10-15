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

test('the WebDav backup button refuses to run without a URL and account', async () => {
    // 修复前 webdav 分支**没有任何前置校验**：空 url 被原样传给 Rust，
    // 最终用户看到的是 reqwest 的原始报错（用真实 url crate 实测过）：
    //   url=''    -> `relative URL without a base`
    //   url='   ' -> `invalid international domain name`
    // 对「忘了填地址」这件事毫无提示作用；而 aliyun 分支早就有对照的
    // aliyun_login_first 提示。
    const source = await readFile('src/window/Config/pages/Backup/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    assert.match(code, /isFilledString\s*\(\s*davUrl\s*\)/, 'the WebDav URL must be validated');
    assert.match(code, /isFilledString\s*\(\s*davUserName\s*\)/, 'the WebDav account must be validated');
    assert.match(
        code,
        /t\('config\.backup\.webdav_not_configured'\)/,
        'the user must get a localized explanation, not a raw reqwest error'
    );
    assert.match(
        source,
        /import \{[^}]*isFilledString[^}]*\} from '[^']*utils\/configValue'/,
        'the helper must be imported'
    );

    // 校验必须发生在真正发起请求之前
    const checkAt = code.indexOf('isFilledString(davUrl)');
    const callAt = code.indexOf('webdav.backup(');
    assert.notEqual(checkAt, -1, 'the check must exist');
    assert.notEqual(callAt, -1, 'the backup call must exist');
    assert.ok(checkAt < callAt, 'the guard must run before the request is sent');
});

test('the WebDav prompt is a real localized string, not a key or an English copy', async () => {
    // 新增 key 必须真的存在于两个基准语言里，且两边文案不同
    // （zh_CN 复用英文属于「假本地化」，locale 相关测试会拦，这里就近断言一次）。
    const en = JSON.parse(await readFile('src/i18n/locales/en_US.json', 'utf8'));
    const zh = JSON.parse(await readFile('src/i18n/locales/zh_CN.json', 'utf8'));
    const key = 'webdav_not_configured';
    const enText = en.translation.config.backup[key];
    const zhText = zh.translation.config.backup[key];
    assert.equal(typeof enText, 'string', `en_US must define config.backup.${key}`);
    assert.equal(typeof zhText, 'string', `zh_CN must define config.backup.${key}`);
    assert.ok(enText.trim() !== '', 'the English prompt must not be empty');
    assert.ok(zhText.trim() !== '', 'the Chinese prompt must not be empty');
    assert.notEqual(enText, zhText, 'zh_CN must not simply reuse the English text');
    assert.ok(/[\u4e00-\u9fff]/.test(zhText), 'the Chinese prompt should actually contain Chinese characters');
});
