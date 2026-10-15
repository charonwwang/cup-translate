import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * useConfig 的 key 是**动态的**：PluginConfig 用 `serviceInstanceKey` 作为键，
 * 用户在设置页切换服务实例时 key 会变（见 Service/Translate/ConfigModal）。
 *
 * 但三个 useCallback 的依赖数组都写成了 `[]`，于是闭包捕获的 key 被冻结在
 * **首次渲染**的值上：
 *   · syncToStore -> store.set(旧key, v)   新实例的配置写进了旧实例
 *   · syncToState -> store.get(旧key)      打开 B 却显示 A 的配置
 * 而同一个文件的 useEffect 却显式依赖 [key]，注释还写明「serviceInstanceKey
 * 等动态 key 的场景」——一边按「key 会变」写，一边按「key 不变」冻结闭包。
 *
 * 这些测试用**真实源码字符串**断言依赖数组，
 * 并用 new Function 载入 useConfig 验证实际行为（React 用最小替身）。
 */

const SOURCE_PATH = 'src/hooks/useConfig.jsx';

/** 从源码里取出某个 useCallback 调用的依赖数组字面量 */
function depsOf(source, callbackName) {
    const start = source.indexOf(`const ${callbackName} = useCallback(`);
    assert.notEqual(start, -1, `sanity: ${callbackName} should be defined with useCallback`);
    const tail = source.slice(start);
    // 该 useCallback 调用以 `);` 结束（prettier 会把依赖数组放在最后一行的 `]` 上）
    const end = tail.indexOf('\n    );');
    assert.notEqual(end, -1, `sanity: could not find the end of ${callbackName}`);
    const body = tail.slice(0, end);
    const match = body.match(/\[([^\]]*)\]\s*$/m);
    assert.ok(match, `sanity: could not find the dependency array of ${callbackName}`);
    return match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

test('the dynamic-key callbacks are not frozen to the first render', async () => {
    const source = await readFile(SOURCE_PATH, 'utf8');

    // 这两个闭包里直接用了 key，必须随 key 重建
    for (const name of ['syncToStore', 'syncToState']) {
        const deps = depsOf(source, name);
        assert.ok(
            deps.includes('key'),
            `${name} captures \`key\` in its closure, so its dependency array must include key (found: [${deps.join(', ')}])`
        );
    }

    // setProperty 调用 syncToStore；若它不随 syncToStore 重建，
    // 会一直调用**旧的** syncToStore，把上面两处修复一起抵消掉。
    const setPropertyDeps = depsOf(source, 'setProperty');
    assert.ok(
        setPropertyDeps.includes('syncToStore'),
        `setProperty must depend on syncToStore (found: [${setPropertyDeps.join(', ')}])`
    );
    assert.ok(
        setPropertyDeps.includes('sync'),
        `setProperty reads options.sync, so it must depend on it (found: [${setPropertyDeps.join(', ')}])`
    );
});

test('the effect that subscribes also tracks the rebuilt callbacks', async () => {
    const source = await readFile(SOURCE_PATH, 'utf8');
    const start = source.indexOf('useEffect(() => {');
    assert.notEqual(start, -1, 'sanity: the init effect should exist');
    const tail = source.slice(start);
    const end = tail.indexOf('}, [');
    const deps = tail
        .slice(end + 4)
        .split(']')[0]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    assert.ok(deps.includes('key'), 'the init effect re-subscribes when key changes');
    // cleanup 里要 flush 的正是本轮那个 syncToStore；它随 key 重建，
    // 所以 effect 必须跟着它重跑，否则切换实例时旧实例的待写值会随旧 debounce 被丢弃。
    assert.ok(
        deps.includes('syncToStore'),
        `the init effect must re-run when syncToStore is rebuilt (found: [${deps.join(', ')}])`
    );
    assert.ok(deps.includes('syncToState'), `the init effect must depend on syncToState (found: [${deps.join(', ')}])`);
});

test('defaultValue is held in a ref, not a dependency', async () => {
    // 这条是防止「修一个 bug 引入另一个更糟的 bug」。
    // 仓库里有 9 处传**内联字面量**默认值：useConfig(k, {}) / useConfig(k, [])。
    // 每次渲染都是新引用，一旦 defaultValue 进了 syncToState 的依赖数组：
    //   render -> 新引用 -> syncToState 重建 -> effect 重跑
    //   -> syncToState(null) -> setPropertyState -> 再 render -> 无限循环
    const source = await readFile(SOURCE_PATH, 'utf8');

    const deps = depsOf(source, 'syncToState');
    assert.ok(
        !deps.includes('defaultValue'),
        'defaultValue must NOT be a dependency: callers pass inline literals, which would loop forever'
    );
    assert.ok(
        source.includes('const defaultValueRef = useRef(defaultValue)'),
        'defaultValue should be tracked through a ref instead'
    );
});

test('callers really do pass inline literal defaults (so the ref is load-bearing)', async () => {
    // 支撑上一条的**事实依据**：如果没人传内联字面量，那个 ref 就是多余设计。
    // 这里直接扫源码确认这种情况真实存在，避免护栏断言的是一个假想风险。
    const files = [
        'src/window/Config/pages/Service/Translate/ServiceItem/index.jsx',
        'src/window/Config/pages/Service/PluginConfig/index.jsx',
        'src/window/Translate/index.jsx',
    ];
    let inlineLiterals = 0;
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/useConfig\([^,]+,\s*(\{\}|\[\])/.test(source)) inlineLiterals++;
    }
    assert.ok(
        inlineLiterals >= 3,
        `expected inline literal defaults to exist in the codebase, found ${inlineLiterals} files`
    );
});

test('a stale key would really write to the wrong config key', async () => {
    // 用最小替身载入 useConfig 的真实源码，验证修复后的行为：
    // key 变化后，setProperty 必须写到**新** key。
    // 这不是复刻逻辑——载入的就是线上那份源码。
    const source = await readFile(SOURCE_PATH, 'utf8');
    const body = source
        .replace(/^import .*$/gm, '')
        .replace('export const useConfig', 'const useConfig')
        .replace('export const deleteKey', 'const deleteKey');

    // 极简 React 替身：只保证 useCallback/useRef/useEffect 的语义与依赖重建一致
    // 极简 React 替身。关键是**忠实还原 useCallback 的语义**：
    // 返回值必须仍是可调用的函数，且只在 deps 变化时才换成新实例。
    // （若这里简单地每次返回新函数，就测不出「依赖数组写错导致闭包被冻结」这件事。）
    const makeReact = () => {
        const refs = [];
        const effects = [];
        let refIndex = 0;
        // 每个 hook 槽位记住上一次的 deps，用来决定是否沿用旧函数
        const callbackSlots = [];
        let callbackIndex = 0;
        return {
            useCallback: (fn, deps) => {
                const slot = callbackIndex++;
                const prev = callbackSlots[slot];
                const same =
                    prev && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]));
                if (same) return prev.fn;
                callbackSlots[slot] = { fn, deps };
                return fn;
            },
            useRef: (init) => {
                // ref 按槽位持久化，跨渲染保持同一个对象
                if (!refs[refIndex]) refs[refIndex] = { current: init };
                return refs[refIndex++];
            },
            useEffect: (fn, deps) => {
                effects.push({ fn, deps });
            },
            // 每轮渲染前重置「本次渲染的槽位游标」，持久状态留在一个闭包外的数组里
            reset: () => {
                refIndex = 0;
                callbackIndex = 0;
                effects.length = 0;
            },
            effects,
        };
    };

    const React = makeReact();
    const written = [];
    const store = {
        set: (k, v) => written.push([k, v]),
        save: () => {},
        get: async () => null,
    };
    // 源码里的 import 已被剥掉，因此这里要注入**裸名**（useCallback/useRef/...），
    // 而不是一个 React 对象——源码写的是 `useRef(defaultValue)` 这种裸名调用。
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
        store,
        () => Promise.resolve(() => {}),
        () => {},
        // debounce 替身：立即执行，去掉时序干扰
        (fn) => Object.assign((...a) => fn(...a), { flush: () => {} }),
        (init) => [init, () => {}, () => init]
    );

    // 第一轮：key = 实例 A
    React.reset();
    const [, setPropertyA] = useConfig('alpha@deepl', {}, { sync: false });

    // 第二轮：key 变为实例 B（同一组件实例、未重挂载）——reset 只重置槽位游标，
    // refs / callbackSlots 都留在 makeReact 的闭包里，模拟「同一组件实例再渲染一次」
    React.reset();
    const [, setPropertyB] = useConfig('beta@deepl', {}, { sync: false });

    // 两次渲染必须拿到**不同的** setProperty（它依赖 syncToStore，而 key 变了）
    assert.notEqual(setPropertyA, setPropertyB, 'setProperty must be rebuilt when the key changes');

    // 模拟用户在 B 的界面里点保存（forceSync = true）
    setPropertyB('B 的值', true);

    assert.equal(written.length, 1, 'exactly one write should happen');
    assert.equal(
        written[0][0],
        'beta@deepl',
        `the write must target the CURRENT key, not the first render's key (got ${written[0][0]})`
    );
    assert.equal(written[0][1], 'B 的值');
});
