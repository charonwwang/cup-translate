import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const HOTKEY = 'src/window/Config/pages/Hotkey/index.jsx';

/**
 * `registerHandler` 里 `isRegistered(key)` 失败时，必须**给出提示**，
 * 而不是静默什么都不发生。
 *
 * 背景：
 *   `isRegistered` 是 `@tauri-apps/api/globalShortcut` 的
 *   `invokeTauriCommand({ __tauriModule: 'GlobalShortcut', ... })`
 *   （node_modules/@tauri-apps/api/globalShortcut.js:89），**会 reject**。
 *
 *   修复前只有 `.then()`、没有 `.catch`：
 *
 *     isRegistered(key).then((res) => { ... });
 *
 *   一旦它失败，回调**从不执行**，于是用户按下组合键后：
 *     · 界面**毫无反应**（既没有「已被占用」的错误提示，也没有成功提示）
 *     · 配置确实没被写入（`persist` 没被调用 —— 这点是对的，不能改坏）
 *     · 用户无法区分「失败了」和「没按上」，只能反复重试
 *     · 同时留下一个未处理的 Promise 拒绝
 *
 *   **同一个函数内层**的 `invoke('register_shortcut_by_frontend')` 本来就带了
 *   两参数形式的失败回调，所以这是外层漏了一处，属疏漏而非设计。
 *
 * 这里从真实源码抽出 `registerHandler` 并**实际执行**，注入会拒绝的替身，
 * 验证「失败时用户确实收到了提示」。
 */

/** 抽出 registerHandler 的函数体（跳过参数括号后按花括号配平）。 */
function extractRegisterHandler(source) {
    const sig = source.indexOf('function registerHandler(');
    assert.notEqual(sig, -1, 'registerHandler must still exist');
    const parenStart = source.indexOf('(', sig);
    let depthParen = 0;
    let bodyStart = -1;
    for (let i = parenStart; i < source.length; i += 1) {
        if (source[i] === '(') depthParen += 1;
        else if (source[i] === ')') {
            depthParen -= 1;
            if (depthParen === 0) {
                bodyStart = source.indexOf('{', i);
                break;
            }
        }
    }
    assert.notEqual(bodyStart, -1, 'could not locate the registerHandler body');
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = source.slice(bodyStart + 1, i);
                assert.ok(body.trim().length > 0, 'extracted body must not be empty');
                return body;
            }
        }
    }
    throw new Error('unbalanced braces while extracting registerHandler()');
}

/** 构造可执行的 registerHandler，注入替身并记录副作用。 */
function build(source, { isRegistered, invoke }) {
    const body = extractRegisterHandler(source);
    const log = { errors: [], success: [], persisted: [], invoked: [] };
    const fn = new Function(
        'isRegistered',
        'invoke',
        'toast',
        't',
        'toastStyle',
        `return function registerHandler(name, key, persist) { ${body} };`
    )(
        isRegistered,
        (cmd, args) => {
            log.invoked.push([cmd, args]);
            return invoke(cmd, args);
        },
        {
            error: (m) => log.errors.push(String(m)),
            success: (m) => log.success.push(String(m)),
        },
        (k) => `T:${k}`,
        {}
    );
    return {
        run: (name, key, persist) => fn(name, key, persist),
        log,
        persist: (k, sync) => log.persisted.push([k, sync]),
    };
}

const source = await readFile(HOTKEY, 'utf8');

test('a failing isRegistered surfaces an error instead of doing nothing', async () => {
    const { run, log, persist } = build(source, {
        isRegistered: () => Promise.reject(new Error('GlobalShortcut IPC unavailable')),
        invoke: () => Promise.resolve(),
    });

    await run('selection_translate', 'Alt+T', persist);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(
        log.errors.length > 0,
        'a failed isRegistered must show an error; silence leaves the user with no feedback at all'
    );
    assert.match(
        log.errors.join(' | '),
        /GlobalShortcut IPC unavailable/,
        'the error must carry the real cause so it can be acted on'
    );
    assert.deepEqual(log.persisted, [], 'a failed check must not persist anything');
    assert.deepEqual(log.invoked, [], 'must not attempt registration when the check itself failed');
});

test('a failing isRegistered does not report success', async () => {
    const { run, log, persist } = build(source, {
        isRegistered: () => Promise.reject(new Error('boom')),
        invoke: () => Promise.resolve(),
    });

    await run('selection_translate', 'Alt+T', persist);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(log.success, [], 'a failure must never be reported as success');
});

test('an already-registered hotkey still shows the dedicated message', async () => {
    // 对照组：原有行为不能改坏
    const { run, log, persist } = build(source, {
        isRegistered: () => Promise.resolve(true),
        invoke: () => Promise.resolve(),
    });

    await run('selection_translate', 'Alt+T', persist);
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(log.errors, ['T:config.hotkey.is_register'], 'must show the already-registered message');
    assert.deepEqual(log.persisted, [], 'must not persist a hotkey that is taken');
    assert.deepEqual(log.invoked, [], 'must not attempt to register a taken hotkey');
});

test('the success path still persists and reports success', async () => {
    // 对照组：成功路径必须保持不变
    const { run, log, persist } = build(source, {
        isRegistered: () => Promise.resolve(false),
        invoke: () => Promise.resolve(),
    });

    await run('selection_translate', 'Alt+T', persist);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(log.persisted, [['Alt+T', true]], 'a successful registration must persist the key');
    assert.deepEqual(log.success, ['T:config.hotkey.success'], 'must report success');
    assert.deepEqual(log.invoked, [
        ['register_shortcut_by_frontend', { name: 'selection_translate', shortcut: 'Alt+T' }],
    ]);
});

test('a failing register_shortcut_by_frontend still reports its own error', async () => {
    // 对照组：内层失败回调（原有行为）必须保持
    const { run, log, persist } = build(source, {
        isRegistered: () => Promise.resolve(false),
        invoke: () => Promise.reject(new Error('shortcut already taken by the OS')),
    });

    await run('selection_translate', 'Alt+T', persist);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(log.errors.length, 1, 'the inner failure must surface exactly one error');
    assert.match(log.errors[0], /already taken by the OS/);
    assert.deepEqual(log.persisted, [], 'a failed registration must not persist');
    assert.deepEqual(log.success, [], 'a failed registration must not report success');
});
