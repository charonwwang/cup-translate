import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const HOOK = 'src/hooks/useConfig.jsx';

/**
 * `useConfig` 读 Store 失败时，必须**退回到默认值**，而不是让配置项永远停在 `null`。
 *
 * 背景：
 *   `store.get(key)` 不是本地读，它是 `tauri-plugin-store-api` 的
 *   `await invoke('plugin:store|get')`（见 node_modules/.../dist-js/index.mjs:34），
 *   **会 reject**（插件未注册 / IPC 失败 / 配置路径不可读）。
 *   `src/utils/lang_detect.js:317` 已经把这个事实写在注释里。
 *
 *   而修复前 `syncToState` 是：
 *
 *     store.get(key).then((v) => { ... });     // 没有 .catch
 *
 *   读失败时回调**从不执行**，于是：
 *     · `setPropertyState` 一次都没被调用 -> 本 hook 返回的 property **永远是 null**
 *     · 同时留下一个**未处理的 Promise 拒绝**（仓库里没有任何
 *       `window.unhandledrejection` 兜底，已 grep 确认为空）
 *   本 hook 有 **140 处调用点**，全部拿这个返回值渲染控件。
 *
 * 这里用最小 React 替身 + `new Function` **执行真实的 useConfig**，
 * 而不是只对源码做正则断言。
 */

/** 剥掉 import，留下可直接 new Function 的函数体（与 useconfig-dynamic-key 同一套做法）。 */
function extractBody(source) {
    return source
        .split('\n')
        .filter((l) => !/^\s*import\s/.test(l))
        .join('\n')
        .replace(/export const useConfig =/, 'const useConfig =')
        .replace(/export const deleteKey =[\s\S]*$/, '');
}

/** 最小 React 替身：useState 槽位 + ref 槽位 + effect 立即执行。 */
function makeReact() {
    const states = [];
    const refs = [];
    let cursor = 0;
    const effects = [];
    return {
        useGetState: (init) => {
            const i = cursor++;
            if (states[i] === undefined) states[i] = init;
            return [states[i], (v) => (states[i] = v), () => states[i]];
        },
        useRef: (init) => {
            const i = cursor++;
            if (refs[i] === undefined) refs[i] = { current: init };
            return refs[i];
        },
        useCallback: (fn) => fn,
        useEffect: (fn) => {
            effects.push(fn);
        },
        reset: () => {
            cursor = 0;
        },
        states,
        effects,
    };
}

/**
 * 载入真实 useConfig。
 * @param {object} storeStub 注入的 store 替身
 */
async function loadHook(storeStub) {
    const source = await readFile(HOOK, 'utf8');
    const body = extractBody(source);
    const React = makeReact();
    const factory = new Function(
        'useCallback',
        'useEffect',
        'useRef',
        'store',
        'listen',
        'emit',
        'debounce',
        'useGetState',
        `${body}\nreturn { useConfig };`
    );
    const { useConfig } = factory(
        React.useCallback,
        React.useEffect,
        React.useRef,
        storeStub,
        () => Promise.resolve(() => {}),
        () => {},
        (fn) => Object.assign((...a) => fn(...a), { flush: () => {} }),
        React.useGetState
    );
    return { useConfig, React };
}

test('a rejecting store.get falls back to the default instead of leaving null', async () => {
    const written = [];
    const store = {
        get: () => Promise.reject(new Error('IPC failed')),
        set: (k, v) => written.push([k, v]),
        save: () => {},
    };
    const { useConfig, React } = await loadHook(store);

    React.reset();
    const [, , getProperty] = useConfig('check_update', true);
    // 初始化 effect 会调用 syncToState(null) -> store.get 拒绝
    React.effects.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // 必须用 getProperty() 读**当前**槽位值：useConfig 返回的第一个元素是
    // 调用当时的状态快照，之后 setPropertyState 改的是内部槽位，
    // 快照不会跟着变（第一版就是读快照，导致断言永远看到 null）。
    assert.equal(
        getProperty(),
        true,
        'a failed read must fall back to the default value; null leaves the control in a broken state'
    );
});

test('a failed read never overwrites the stored config with the default', async () => {
    // 读失败 != 用户没配过。此时若照 `v === null` 分支去 set + save，
    // 等于用默认值**覆盖用户真实配置** —— 那是数据丢失，比显示默认值严重得多。
    const written = [];
    const store = {
        get: () => Promise.reject(new Error('IPC failed')),
        set: (k, v) => written.push([k, v]),
        save: () => written.push(['__save__']),
    };
    const { useConfig, React } = await loadHook(store);

    React.reset();
    useConfig('check_update', true);
    React.effects.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(
        written,
        [],
        'the failure path must not persist anything; writing the default would clobber real config'
    );
});

test('a successful read still stores the default when the key is genuinely absent', async () => {
    // 对照组：读成功且键不存在时，**应当**把默认值落盘（原有行为不能改坏）
    const written = [];
    const store = {
        get: () => Promise.resolve(null),
        set: (k, v) => written.push([k, v]),
        save: () => written.push(['__save__']),
    };
    const { useConfig, React } = await loadHook(store);

    React.reset();
    useConfig('check_update', true);
    React.effects.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(written, [['check_update', true], ['__save__']], 'an absent key must be seeded');
});

test('a successful read returns the stored value untouched', async () => {
    const store = {
        get: () => Promise.resolve(false),
        set: () => {},
        save: () => {},
    };
    const { useConfig, React } = await loadHook(store);

    React.reset();
    const [, , getProperty] = useConfig('check_update', true);
    React.effects.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(getProperty(), false, 'a stored value must win over the default');
});

test('the rejection is logged so the failure is not silent', async () => {
    const store = { get: () => Promise.reject(new Error('boom')), set: () => {}, save: () => {} };
    const { useConfig, React } = await loadHook(store);

    const seen = [];
    const original = console.error;
    console.error = (...args) => seen.push(args.join(' '));
    try {
        React.reset();
        useConfig('check_update', true);
        React.effects.forEach((fn) => fn());
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
    } finally {
        console.error = original;
    }

    assert.ok(seen.length > 0, 'the failure must be logged; a silent null is what caused the bug');
    assert.ok(
        seen.some((line) => line.includes('check_update')),
        `the log must name the offending key so it can be debugged; got: ${JSON.stringify(seen)}`
    );
});
