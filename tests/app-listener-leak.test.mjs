/**
 * App.jsx 顶层监听器泄漏（回归护栏）
 *
 * 根因：
 *   `devMode` / `appTheme` 来自 `useConfig`，而它的 state 初值是 **null**，
 *   磁盘值要等 `store.get()` 异步返回后才写入（见 useConfig 的 syncToState）。
 *   于是依赖 `[devMode]` 的 effect 会经历 null -> false 的变化，
 *   `Object.is(null, false) === false` 使 effect **每次挂载都重跑一次**。
 *
 *   原实现用**匿名**函数 addEventListener 且**没有** cleanup：
 *     - document 上会残留一个无人移除的 keydown 监听器
 *       -> 按一次 Escape 调用两次 appWindow.close()
 *     - matchMedia 的 change 监听器同样每挂载一次多留一个
 *
 * 这里断言的是「注册与注销必须成对」，并把真实源码结构抽出来执行，
 * 而不是在测试里复刻生产逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = 'src/App.jsx';

test('App.jsx: 每个 addEventListener 都必须在 cleanup 中 removeEventListener', async () => {
    const source = await readFile(SOURCE, 'utf8');

    const adds = source.match(/addEventListener\(/g) ?? [];
    const removes = source.match(/removeEventListener\(/g) ?? [];
    assert.ok(adds.length > 0, 'App.jsx 应当有 addEventListener');
    assert.equal(
        removes.length,
        adds.length,
        `addEventListener(${adds.length}) 与 removeEventListener(${removes.length}) 必须成对——` +
            '只注册不注销会让 effect 重跑时残留监听器'
    );

    // 监听器必须是**具名**引用，否则无法在 cleanup 里移除。
    // 匿名箭头函数写法一旦回归，这里立刻失败。
    const anonymous = source.match(/addEventListener\('[^']+',\s*(async\s*)?\(/g) ?? [];
    assert.deepEqual(anonymous, [], `不得用匿名函数注册监听器（无法注销），发现 ${anonymous.length} 处`);
});

test('真实执行：effect 重跑后监听器必须仍然只有一个', async () => {
    const source = await readFile(SOURCE, 'utf8');

    // 从真实源码里取出 effect 的 body（注册点 + cleanup），注入受控 document。
    const start = source.indexOf('const onKeyDown = async (e) => {');
    const end = source.indexOf('}, [devMode]);');
    assert.notEqual(start, -1, 'App.jsx 必须有具名的 onKeyDown');
    assert.notEqual(end, -1, '必须能界定 [devMode] 的 effect');
    const body = source.slice(start, end);

    // 受控 document：记录当前挂着的监听器集合
    const attached = new Set();
    const document_ = {
        addEventListener: (_t, h) => attached.add(h),
        removeEventListener: (_t, h) => attached.delete(h),
    };
    let closeCalls = 0;
    const appWindow = { close: async () => void (closeCalls += 1) };
    const invoke = async () => {};

    // 只执行真实源码里的 onKeyDown 定义与注册/注销两行，其余依赖由参数注入
    const regLine = "document.addEventListener('keydown', onKeyDown);";
    const unregLine = "return () => document.removeEventListener('keydown', onKeyDown);";
    assert.ok(body.includes(regLine), 'effect 必须注册具名 handler');
    assert.ok(body.includes(unregLine), 'effect 必须返回注销 function');

    const factory = new Function(
        'document',
        'appWindow',
        'invoke',
        'devMode',
        `${body.replace(/return \(\) =>[^;]+;/, '')}
         return { onKeyDown, attach: () => document.addEventListener('keydown', onKeyDown),
                  detach: () => document.removeEventListener('keydown', onKeyDown) };`
    );
    const ctx = factory(document_, appWindow, invoke, false);

    // 模拟 React：挂载时 effect 跑两次（devMode: null -> false），中间先 cleanup
    ctx.attach();
    ctx.detach(); // cleanup（React 在依赖变化时先跑）
    ctx.attach();

    assert.equal(attached.size, 1, `effect 重跑后应当只有 1 个监听器，实际 ${attached.size}`);

    // 按一次 Escape：只应触发一次 close
    await Promise.all([...attached].map((h) => h({ key: 'Escape', ctrlKey: false })));
    assert.equal(closeCalls, 1, `按一次 Escape 只应调用一次 close()，实际 ${closeCalls} 次`);

    // 卸载后必须干净
    ctx.detach();
    assert.equal(attached.size, 0, '卸载后不得残留监听器');
});
