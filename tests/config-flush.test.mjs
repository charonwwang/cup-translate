import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// 直接导入被测实现（纯函数，无 React/DOM 依赖）
const { debounce } = await import('../src/utils/index.js');

test('debounce delays the call and collapses a burst into one', async () => {
    const seen = [];
    const fn = debounce((v) => seen.push(v), 20);
    fn(1);
    fn(2);
    fn(3);
    assert.deepEqual(seen, [], 'must not fire synchronously');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(seen, [3], 'a burst must collapse to the last call');
});

test('flush runs a pending call immediately and only once', async () => {
    // 关键场景：组件卸载时把待写盘的防抖调用落地。
    // 没有 flush，翻译窗口失焦关闭（约 100ms）会早于 500ms 防抖，
    // 用户刚改的设置会被静默丢弃。
    const seen = [];
    const fn = debounce((v) => seen.push(v), 5000);
    fn('remembered-language');
    assert.deepEqual(seen, [], 'still pending before flush');

    fn.flush();
    assert.deepEqual(seen, ['remembered-language'], 'flush must run the pending call');

    // flush 之后定时器必须被取消，否则会在延迟到达时重复执行
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(seen, ['remembered-language'], 'flush must not cause a duplicate call');
});

test('flush and cancel are safe when nothing is pending', () => {
    const seen = [];
    const fn = debounce((v) => seen.push(v), 10);
    // 从未调用过
    fn.flush();
    fn.cancel();
    assert.deepEqual(seen, []);

    // flush 之后再次 flush 不应重复执行
    fn(1);
    fn.flush();
    fn.flush();
    assert.deepEqual(seen, [1]);
});

test('cancel drops a pending call', async () => {
    const seen = [];
    const fn = debounce((v) => seen.push(v), 20);
    fn('x');
    fn.cancel();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(seen, [], 'a cancelled call must never run');
});

test('useConfig flushes pending writes when the component unmounts', async () => {
    // 断言接线本身：useConfig 的清理函数必须调用 flush，
    // 否则上面的 debounce.flush 再好也不会被触发。
    const source = await readFile('src/hooks/useConfig.jsx', 'utf8');
    const effect = source.slice(source.indexOf('const unlisten = listen('));
    const cleanup = effect.slice(effect.indexOf('return () => {'), effect.indexOf('}, [key]);'));
    assert.match(cleanup, /syncToStore\.flush\(\)/, 'cleanup must flush the debounced store write');
});
