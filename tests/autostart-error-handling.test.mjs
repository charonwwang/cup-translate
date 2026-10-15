import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GENERAL = 'src/window/Config/pages/General/index.jsx';

/**
 * 开机自启的三个调用（`isEnabled` / `enable` / `disable`）都必须处理**拒绝**。
 *
 * 背景：
 *   它们不是本地函数，而是 `tauri-plugin-autostart-api` 的
 *   `await invoke('plugin:autostart|...')`（真实 IPC），**会 reject**
 *   （插件未注册 / 平台不支持 / 系统调用失败）。
 *
 *   修复前这三处都只有一个 `.then()`，没有 `.catch`：
 *
 *     isEnabled().then((v) => { setAutoStart(v); });
 *     enable().then(() => { info('Auto start enabled'); });
 *     disable().then(() => { info('Auto start disabled'); });
 *
 *   后果分两类：
 *   1. `isEnabled` 失败 -> `setAutoStart` 从不执行 -> 开关停在初始值，
 *      可能与系统实际状态**相反**，且用户看不到任何提示；
 *   2. `enable` / `disable` 失败 -> **静默的假成功**：
 *      `onValueChange` 里先执行了 `setAutoStart(v)`，开关已经拨到用户点的位置，
 *      但系统层面根本没写进去 —— 界面显示「已开启」，用户重启后才发现开机自启
 *      没生效。这类「界面说成功、实际没做」是最难被发现的一种。
 *   另外三处都留下**未处理的 Promise 拒绝**（仓库里没有任何
 *   `window.unhandledrejection` 兜底，已 grep 确认为空）。
 *
 *   同一个文件里、就在上面几行，`invoke('font_list')` 已经是
 *   `.then(...).catch(...)` 的正确写法（那处是之前修过的），
 *   所以这里是**同文件内的不一致**，不是风格分歧。
 *
 * 这里从真实源码里抽出这三段链并**实际执行**，注入会拒绝的替身，
 * 验证「失败时界面状态被纠正」，而不是只对源码做正则断言。
 */

/** 从源码里抽取指定调用开始的整条语句链（按括号配平到分号）。 */
function extractChain(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `could not find '${marker}' in the source`);
    let depth = 0;
    let sawParen = false;
    for (let i = start; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(') {
            depth += 1;
            sawParen = true;
        } else if (ch === ')') {
            depth -= 1;
        } else if (ch === ';' && depth === 0 && sawParen && source[i - 1] === ')') {
            const chain = source.slice(start, i + 1);
            assert.ok(chain.includes('.catch('), `'${marker}' chain must include a .catch`);
            return chain;
        }
    }
    throw new Error(`unterminated chain for '${marker}'`);
}

/** 把抽出的链包成一个可执行函数并注入替身。 */
function buildRunner(chain, { onRejectRender }) {
    const state = { autoStart: 'INITIAL', logs: [] };
    const factory = new Function(
        'isEnabled',
        'enable',
        'disable',
        'setAutoStart',
        'info',
        `return async () => { ${chain} };`
    );
    const run = factory(
        onRejectRender.isEnabled,
        onRejectRender.enable,
        onRejectRender.disable,
        (v) => {
            state.autoStart = v;
        },
        (m) => state.logs.push(m)
    );
    return { run, state };
}

const source = await readFile(GENERAL, 'utf8');

test('a failing isEnabled logs instead of leaving the switch on a wrong value', async () => {
    const chain = extractChain(source, 'isEnabled()');
    const { run, state } = buildRunner(chain, {
        onRejectRender: {
            isEnabled: () => Promise.reject(new Error('autostart plugin unavailable')),
            enable: () => Promise.resolve(),
            disable: () => Promise.resolve(),
        },
    });

    await run();
    await new Promise((r) => setImmediate(r));

    assert.equal(state.autoStart, 'INITIAL', 'a failed read must not invent a value');
    assert.ok(
        state.logs.some((l) => l.includes('autostart plugin unavailable')),
        `the failure must be logged with its cause; got ${JSON.stringify(state.logs)}`
    );
});

test('a failing enable reverts the switch so the UI stops claiming success', async () => {
    const chain = extractChain(source, 'enable()');
    const { run, state } = buildRunner(chain, {
        onRejectRender: {
            isEnabled: () => Promise.resolve(false),
            enable: () => Promise.reject(new Error('EACCES writing autostart entry')),
            disable: () => Promise.resolve(),
        },
    });

    // 模拟 onValueChange：先乐观地把开关拨到 true（真实代码就是这样）
    state.autoStart = true;
    await run();
    await new Promise((r) => setImmediate(r));

    assert.equal(
        state.autoStart,
        false,
        'a failed enable must revert the switch; otherwise the UI silently lies about autostart'
    );
    assert.ok(
        state.logs.some((l) => l.includes('EACCES writing autostart entry')),
        `the failure must be logged; got ${JSON.stringify(state.logs)}`
    );
    assert.ok(
        !state.logs.some((l) => l.includes('Auto start enabled')),
        'the success log must not fire when the call failed'
    );
});

test('a failing disable reverts the switch back to on', async () => {
    const chain = extractChain(source, 'disable()');
    const { run, state } = buildRunner(chain, {
        onRejectRender: {
            isEnabled: () => Promise.resolve(true),
            enable: () => Promise.resolve(),
            disable: () => Promise.reject(new Error('cannot remove autostart entry')),
        },
    });

    state.autoStart = false; // onValueChange 乐观地拨到 false
    await run();
    await new Promise((r) => setImmediate(r));

    assert.equal(state.autoStart, true, 'a failed disable must revert the switch to on');
    assert.ok(!state.logs.some((l) => l.includes('Auto start disabled')), 'no success log on failure');
});

test('the success paths still log their message', async () => {
    // 对照组：成功时行为不能改坏
    for (const [marker, message, initial] of [
        ['enable()', 'Auto start enabled', false],
        ['disable()', 'Auto start disabled', true],
    ]) {
        const chain = extractChain(source, marker);
        const { run, state } = buildRunner(chain, {
            onRejectRender: {
                isEnabled: () => Promise.resolve(false),
                enable: () => Promise.resolve(),
                disable: () => Promise.resolve(),
            },
        });
        state.autoStart = initial;
        await run();
        await new Promise((r) => setImmediate(r));
        assert.ok(
            state.logs.some((l) => l.includes(message)),
            `'${marker}' must still log '${message}' on success; got ${JSON.stringify(state.logs)}`
        );
        assert.equal(state.autoStart, initial, 'a successful call must leave the switch where the user put it');
    }
});

test('no autostart call is left without a rejection handler', async () => {
    // 结构性兜底：逐个调用点确认链上确有 .catch（防止将来又漏掉一处）
    for (const marker of ['isEnabled()', 'enable()', 'disable()']) {
        const chain = extractChain(source, marker); // 内部断言含 .catch
        assert.match(chain, /\.catch\(/, `${marker} must handle rejection`);
    }
});
