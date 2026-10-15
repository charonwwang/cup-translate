import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MAX_PORT, nextPortValue } from '../src/utils/port.js';

/**
 * 模块对外的正式 API 只有 nextPortValue 与 MAX_PORT。
 * clampPort / isPortInputAllowed 是**内部**函数——把它们导出会触发
 * tests/system-language.test.mjs 的「导出了却没人 import」护栏
 * （那条护栏只扫 src/，测试里的引用不算「有人用」）。
 *
 * 但这两道判断必须被真实执行地测到，否则等于没有防线。
 * 这里沿用仓库既有做法（tests/translate-retry.test.mjs、voice-playback.test.mjs）：
 * 用 new Function 把**同一份源码**载入，而不是复刻一份逻辑。
 */
const source = await readFile('src/utils/port.js', 'utf8');
const loadInternals = () => {
    // 剥掉 export 关键字（new Function 里不能出现），其余源码原样执行
    const body = source.replace(/^export\s+/gm, '');
    const factory = new Function(`${body}\nreturn { clampPort, isPortInputAllowed, nextPortValue, MAX_PORT };`);
    return factory();
};
const { clampPort, isPortInputAllowed } = loadInternals();

test('the private helpers are exercised from the same source as the shipped module', async () => {
    // 自检：确保上面确实载入了真实实现（而不是空壳），否则后续断言都是假的
    assert.equal(typeof clampPort, 'function');
    assert.equal(typeof isPortInputAllowed, 'function');
    assert.equal(loadInternals().MAX_PORT, MAX_PORT, 'the loaded copy must agree with the imported module');
    assert.equal(loadInternals().nextPortValue('60828'), nextPortValue('60828'));
});

/**
 * 端口输入框过去用「几个 parseInt 分支 + 最后的 else」来夹紧取值，
 * 漏掉了 parseInt 返回 **NaN** 的情况：
 *
 *   if (v === '')                -> 0
 *   else if (parseInt(v) > 65535) -> 65535
 *   else if (parseInt(v) < 0)     -> 0
 *   else                          -> parseInt(v)   // <-- NaN 掉进这里
 *
 * NaN 与任何值比较都是 false，所以 '-' / '.' / 'e' / 'abc' 全部落到最后的 else，
 * 被原样 `setServerPort(NaN)` 存进配置。而 `JSON.stringify({a:NaN})` 产出
 * `{"a":null}`——磁盘上留下一个 null。
 *
 * 实测后果（不是崩溃，但界面与磁盘不一致）：
 *   · 输入框显示为空（value={NaN}），磁盘上却是 null（下次启动被 Rust 重置为 60828）
 *   · 用户无法判断端口究竟是多少
 *
 * 这些测试直接 import **线上同一份实现**（src/utils/port.js 是 .js，
 * node:test 可以真实执行它，不是复刻逻辑）。
 */

test('any input the user can type yields a real number, never NaN', async () => {
    // 覆盖 type='number' 输入框在逐字输入过程中必然出现的中间态
    const intermediateStates = [
        '',
        ' ',
        '-',
        '+',
        '.',
        'e',
        'E',
        'abc',
        '12abc',
        '1.5',
        '1e5',
        '0x10',
        'Infinity',
        'NaN',
        '   ',
        '١٢٣', // 阿拉伯数字（非 ASCII）
    ];
    for (const raw of intermediateStates) {
        const port = nextPortValue(raw);
        assert.ok(
            port === null || Number.isInteger(port),
            `nextPortValue(${JSON.stringify(raw)}) must be an integer or null, got ${port}`
        );
        assert.ok(!Number.isNaN(port), `nextPortValue(${JSON.stringify(raw)}) must never be NaN`);
    }
});

test('valid ports pass through and are clamped to the u16 range', async () => {
    assert.equal(nextPortValue('60828'), 60828);
    assert.equal(nextPortValue('0'), 0);
    assert.equal(nextPortValue('65535'), MAX_PORT);
    // 超出 u16 上界 -> 夹到 65535（与修复前一致）
    assert.equal(nextPortValue('65536'), MAX_PORT);
    assert.equal(nextPortValue('99999'), MAX_PORT);
    assert.equal(nextPortValue('4294967296'), MAX_PORT);
});

test('an empty input means "not set" and is left to the caller', async () => {
    // 空串是合法的「还没填」状态：helper 返回 null，由调用方决定语义
    // （server_port 记为 0，proxy_port 记为 ''），这样两个输入框可以不同。
    assert.equal(nextPortValue(''), null);
    assert.equal(nextPortValue('   '), null);
});

test('the helper never invents a value for unparseable input', async () => {
    // 关键回归点：修复前这些输入会变成 NaN。
    // 现在必须是 null（= 忽略这次输入、保持原值），而不是 0 或某个占位数字。
    for (const raw of ['-', '.', 'e', 'abc']) {
        assert.equal(
            nextPortValue(raw),
            null,
            `${JSON.stringify(raw)} must be ignored rather than stored as NaN or a placeholder`
        );
    }
});

test('clampPort itself refuses NaN even if the regex gate were loosened', async () => {
    // 为什么单独测 clampPort：nextPortValue 先用正则拦掉非数字输入，
    // 于是 clampPort 的 NaN 分支在正常调用路径上**到不了**。
    // 实测确认过：删掉 clampPort 里的 NaN 检查，其余测试全都仍然通过。
    // 那种「测不到的分支」等于没有防线，所以这里直接调用它，
    // 让这道第二防线真的被锁住——将来谁放宽了正则，也仍然不会漏出 NaN。
    for (const raw of ['abc', 'e', '-', '.', '12abc', 'Infinity']) {
        const out = clampPort(raw);
        assert.equal(out, null, `clampPort(${JSON.stringify(raw)}) must be null, got ${out}`);
        assert.ok(!Number.isNaN(out), 'clampPort must never return NaN');
    }
});

test('clampPort uses strict number parsing, not parseInt tolerance', async () => {
    // parseInt('12abc') === 12（悄悄吞掉垃圾后缀），Number('12abc') === NaN。
    // 这正是本文件与「裸 parseInt 写法」的关键区别。
    assert.equal(clampPort('12abc'), null, 'a trailing garbage suffix must not be silently accepted');
    assert.equal(clampPort('1.5'), null, 'a port must be an integer');
    assert.equal(clampPort('abc'), null);

    // 注意：'0x10' 与 '1e5' 是**合法 JS 数字字面量**（Number() 分别得 16 与 100000），
    // 因此 clampPort 会把后者夹到上界 65535。这不是缺陷——输入端由正则
    // /^\d*$/ 先行拦下，这两个字符串根本到不了这里（下一行即验证）。
    assert.equal(clampPort('0x10'), 16, 'hex is a valid Number() literal; the regex is what rejects it upstream');
    assert.equal(clampPort('1e5'), MAX_PORT, 'exponent parses to 100000 then clamps to the u16 ceiling');
    assert.equal(isPortInputAllowed('0x10'), false, 'the regex is the gate that keeps hex out');
    assert.equal(isPortInputAllowed('1e5'), false);
    // 组合起来的对外行为才是「拒绝」
    assert.equal(nextPortValue('0x10'), null);
    assert.equal(nextPortValue('1e5'), null);
});

test('clampPort clamps the ends of the u16 range', async () => {
    assert.equal(clampPort('65535'), MAX_PORT);
    assert.equal(clampPort('65536'), MAX_PORT);
    assert.equal(clampPort('0'), 0);
    assert.equal(clampPort('-1'), 0, 'a parsed negative clamps to 0');
});

test('the intermediate "-" state must not clamp to 0', async () => {
    // 用户想输入 -5 时，第一下敲的是 '-'。
    // 若此时把他夹到 0，输入框会被立刻改写，用户没法继续打字。
    // nextPortValue 靠正则把它拦成 null（忽略），而不是交给 clampPort 夹成 0。
    assert.equal(nextPortValue('-'), null, 'a lone minus sign is an intermediate state, not a negative port');
    // 而真正解析出负数时才夹到 0（clampPort 的职责）
    assert.equal(clampPort('-5'), 0);
});

test('isPortInputAllowed only admits digits', async () => {
    for (const ok of ['', '0', '60828', '65535']) {
        assert.equal(isPortInputAllowed(ok), true, `${JSON.stringify(ok)} should be admissible`);
    }
    for (const bad of ['-1', '1.5', '1e5', 'abc', '0x10', ' ', '١٢٣']) {
        assert.equal(isPortInputAllowed(bad), false, `${JSON.stringify(bad)} should be rejected`);
    }
    // 非字符串输入不应抛错（事件参数理论上总是字符串，但防御一下）
    assert.equal(isPortInputAllowed(undefined), false);
    assert.equal(isPortInputAllowed(null), false);
    assert.equal(isPortInputAllowed(60828), false);
});

test('a NaN value can never reach the config file', async () => {
    // 这条把「为什么必须避免 NaN」固化下来：NaN 经 JSON 会变成 null。
    // 如果哪天有人删掉校验、直接把 parseInt 结果塞进 setState，
    // 磁盘上就会出现 null，界面显示为空——正是被修掉的那个不一致。
    assert.equal(JSON.stringify({ server_port: NaN }), '{"server_port":null}');
    assert.equal(JSON.parse(JSON.stringify({ server_port: NaN })).server_port, null);

    // 而经过 helper 的值永远能安全序列化
    for (const raw of ['-', '.', 'e', 'abc', '60828', '99999']) {
        const port = nextPortValue(raw);
        const roundTripped = JSON.parse(JSON.stringify({ server_port: port ?? null })).server_port;
        assert.equal(roundTripped, port ?? null, `${JSON.stringify(raw)} should round-trip unchanged`);
        assert.notEqual(roundTripped, undefined);
    }
});

test('both port inputs on the settings page use the shared helper', async () => {
    // 结构性护栏：修复前 server_port 与 proxy_port 各自手写了一份分支逻辑，
    // 两份都有同样的 NaN 漏洞。现在都必须走 nextPortValue。
    const source = await readFile('src/window/Config/pages/General/index.jsx', 'utf8');

    assert.ok(
        source.includes("from '../../../../utils/port'"),
        'the settings page should import the shared port helpers'
    );

    const calls = (source.match(/nextPortValue\(/g) || []).length;
    assert.equal(calls, 2, `expected both port inputs (server + proxy) to use nextPortValue, found ${calls} uses`);

    // 不允许再出现「裸 parseInt 决定写入值」的写法
    const badPatterns = [/else\s*\{\s*setServerPort\(parseInt\(v\)\)/, /else\s*\{\s*setProxyPort\(parseInt\(v\)\)/];
    for (const pattern of badPatterns) {
        assert.ok(
            !pattern.test(source),
            `the settings page must not parse the port inline — it silently stores NaN (matched ${pattern})`
        );
    }
});

test('the backend still guards against a null port', async () => {
    // 双保险：即使前端漏了，后端也不该拿 null 去建代理/监听。
    // 这条同时记录了「为什么这个前端缺陷没造成崩溃」。
    const server = await readFile('src-tauri/src/server.rs', 'utf8');
    assert.ok(
        /\.and_then\(\|value\| u16::try_from\(value\)\.ok\(\)\)/.test(server),
        'server.rs should reject out-of-range ports when reading the config'
    );
    assert.ok(server.includes('.filter(|port| *port != 0)'), 'server.rs should reject port 0 as "unset"');

    const cmd = await readFile('src-tauri/src/cmd.rs', 'utf8');
    assert.ok(
        cmd.includes('.ok_or(())?'),
        'set_proxy should bail out (rather than build a bogus URL) when the port is unusable'
    );
});
