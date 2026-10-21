import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INVOKE = 'src/utils/invoke_plugin.js';
const VALIDATION = 'src/utils/plugin_validation.js';

/**
 * 把**真实源码**装进受控作用域执行，而不是复刻一份逻辑。
 *
 * 背景（round 60 实测）：`invoke_plugin.js` 第一行就是目录穿越防护——
 * 它把 `pluginType` / `pluginName` 交给 `plugin_validation.js` 校验，
 * 通过后才会 `join(configDir, 'plugins', pluginType, pluginName)` 并
 * `readTextFile` + `eval`。**校验的判据**（`plugin_validation.js`）有测试，
 * 但「调用点是否真的先校验、再碰文件系统」**没有任何测试**：
 * 把整个 `if (!validPluginType(...) || !validPluginName(...))` 块删掉，
 * `pnpm test` 仍然 220 passed / 0 failed——**全绿**。
 *
 * 这正是 rounds 34/45/53 反复踩的「测了助手、没测接线」陷阱。
 * 所以本文件直接执行真实函数体，并注入**记录型**的假依赖，
 * 从而能断言「拒绝发生在任何文件系统调用之前」。
 *
 * 为什么可以执行：所有拒绝路径都在第一个 `appConfigDir()` 之前抛错，
 * 因此不需要真的 Tauri 运行时。`tauri-plugin-sql-api` 等依赖无法在
 * Node 里 import，所以按仓库既有先例（`port-input.test.mjs`、
 * `translate-retry.test.mjs`、`fetch-timeout.test.mjs`）剥掉 import 行，
 * 再把真实依赖名逐个注入。
 */
async function loadRealInvokePlugin({ onCall } = {}) {
    const invokeSource = await readFile(INVOKE, 'utf8');
    const validationSource = await readFile(VALIDATION, 'utf8');

    // 去掉 import 与 export 关键字（new Function 里不能出现），其余原样执行。
    const strip = (source) => source.replace(/^import .*$/gm, '').replace(/^export\s+/gm, '');

    const record = (name, value) =>
        typeof value === 'function'
            ? (...args) => {
                  onCall?.(name, args);
                  return value(...args);
              }
            : value;

    // 注入的假依赖：凡是「碰外面」的一律先记录再放行，
    // 这样测试能观测到真实实现到底调用了什么、按什么顺序。
    const deps = {
        checkPolicy: async () => {},
        appConfigDir: async () => '/home/user/.config/com.cup-translate.app',
        appCacheDir: async () => '/home/user/.cache/com.cup-translate.app',
        join: async (...parts) => parts.join('/'),
        // 真实插件入口的形态（实测确认）：`eval(\`${script} ${pluginType}\`)`。
        // script 里**声明一个与 pluginType 同名的标识符**，末尾追加的
        // `${pluginType}` 本身就是取该标识符的表达式 —— 所以合法 payload 是
        //   script = `const translate = () => ...;`   （**不要**自己再写 translate）
        // 拼出来才是 `const translate = () => ...; translate`。
        // 若 stub 里已经带了结尾的 `translate`，会变成
        // `... ; translate translate` -> 语法错误（实测踩过）。
        readTextFile: async () => 'const translate = () => "stub-entry";',
        readBinaryFile: async () => new Uint8Array(),
        invoke: async () => ({}),
        Database: class Database {},
        http: { fetch: async () => ({}) },
        CryptoJS: { MD5: () => 'x' },
        osType: 'Linux',
    };

    const factory = new Function(
        ...Object.keys(deps),
        `${strip(validationSource)}\n${strip(invokeSource)}\nreturn { invoke_plugin };`
    );
    // 每个依赖都要**包上记录器**再注入 —— 否则 onCall 永远不会被触发
    // （实测踩过：定义了 record 却直接传了 Object.values(deps)，
    //  于是「没有调用文件系统」的断言恒真）。
    return factory(
        ...Object.entries(deps).map(([name, value]) => (name === 'checkPolicy' ? value : record(name, value)))
    );
}

test('a traversal-shaped plugin name is rejected before any filesystem access', async () => {
    // 关键断言不是「返回了错误」，而是「**没有**碰文件系统」——
    // 后者才证明校验真的在路径拼接与 readTextFile/eval 之前。
    const calls = [];
    const { invoke_plugin } = await loadRealInvokePlugin({ onCall: (name) => calls.push(name) });

    await assert.rejects(
        () => invoke_plugin('translate', '../../../../tmp/evil'),
        (e) => String(e.message).includes('Invalid plugin path'),
        'a traversal-shaped plugin name must be rejected'
    );

    assert.deepEqual(
        calls,
        [],
        `the guard must run before any filesystem/config call, but these were reached: ${calls.join(', ')}`
    );
});

test('a plugin name outside the charset whitelist is rejected before any filesystem access', async () => {
    const calls = [];
    const { invoke_plugin } = await loadRealInvokePlugin({ onCall: (name) => calls.push(name) });

    // 逐个覆盖 plugin_validation 的判据：前缀、字符集、空串
    for (const bad of ['evil', 'plugin/../../x', 'plugin name', 'plugin..', '', 'plugin\u0000x']) {
        await assert.rejects(
            () => invoke_plugin('translate', bad),
            (e) => String(e.message).includes('Invalid plugin path'),
            `plugin name ${JSON.stringify(bad)} must be rejected`
        );
    }

    assert.deepEqual(calls, [], `no filesystem access may happen for invalid names, got: ${calls.join(', ')}`);
});

test('an unknown plugin type is rejected before any filesystem access', async () => {
    const calls = [];
    const { invoke_plugin } = await loadRealInvokePlugin({ onCall: (name) => calls.push(name) });

    // 类型是白名单判据：只有 4 个合法值，其余一律拒绝。
    // 这一条尤其重要——pluginType 会被拼进 `eval(\`${script} ${pluginType}\`)`。
    for (const bad of ['../../etc', 'Translate', 'TRANSLATE', 'unknown', '', 'recognize ']) {
        await assert.rejects(
            () => invoke_plugin(bad, 'plugin-demo'),
            (e) => String(e.message).includes('Invalid plugin path'),
            `plugin type ${JSON.stringify(bad)} must be rejected`
        );
    }

    assert.deepEqual(calls, [], `no filesystem access may happen for invalid types, got: ${calls.join(', ')}`);
});

test('a valid plugin reaches the filesystem in the expected order', async () => {
    // 反向断言：合法输入必须**放行**，否则上面的拒绝断言可能只是因为函数总是抛错。
    const calls = [];
    const { invoke_plugin } = await loadRealInvokePlugin({
        onCall: (name, args) => calls.push({ name, args }),
    });

    // eval 的是 `module.exports = () => {}` 这个 stub —— 安全且可预测。
    const [plugin] = await invoke_plugin('translate', 'plugin-demo');

    assert.equal(typeof plugin, 'function', 'the plugin entry must be evaluated and returned');

    const names = calls.map((c) => c.name);
    // 顺序必须是：先拿到目录，再拼路径，再读文件。
    assert.ok(names.includes('appConfigDir'), 'a valid plugin must reach appConfigDir');
    assert.ok(names.includes('readTextFile'), 'a valid plugin must read its entry file');
    assert.ok(
        names.indexOf('appConfigDir') < names.indexOf('readTextFile'),
        `config dir must be resolved before reading the entry file, order was: ${names.join(' -> ')}`
    );
});

test('the guard is wired through the shared validators rather than re-implemented', async () => {
    // 结构护栏（与上面几条的真实执行互补）：
    // 校正必须是**委托**给 plugin_validation.js 的共享判据，
    // 而不是在 invoke_plugin.js 里再抄一份正则——两份判据必然漂移。
    const source = await readFile(INVOKE, 'utf8');

    assert.match(source, /import\s*\{[^}]*validPluginName[^}]*\}\s*from\s*'\.\/plugin_validation'/);
    assert.match(source, /import\s*\{[^}]*validPluginType[^}]*\}\s*from\s*'\.\/plugin_validation'/);

    // 守卫必须出现在**第一次路径拼接之前**。
    const guardAt = source.indexOf('validPluginType(pluginType)');
    const joinAt = source.indexOf("join(configDir, 'plugins'");
    assert.notEqual(guardAt, -1, 'the guard must consult validPluginType');
    assert.notEqual(joinAt, -1, 'the plugin directory must be built with join()');
    assert.ok(guardAt < joinAt, 'the guard must run before the plugin path is assembled, not after');

    // 守卫必须在第一个 await（拿配置目录）之前 —— 否则已经碰过 Tauri 了。
    const firstAwaitAt = source.indexOf('await ');
    assert.ok(
        guardAt < firstAwaitAt,
        'the guard must run before the first await, so no Tauri call happens for invalid input'
    );
});
