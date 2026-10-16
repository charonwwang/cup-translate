import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile('src/window/Translate/index.jsx', 'utf8');
const effects = source.slice(source.indexOf('    // Reconcile both directions'), source.indexOf('    // 保存窗口位置'));
function reconcile(closeOnBlur, pined, alwaysOnTop) {
    const native = [],
        pins = [],
        cleanups = [];
    let listens = 0,
        stops = 0;
    new Function(
        'useEffect',
        'closeOnBlur',
        'pined',
        'alwaysOnTop',
        'setPined',
        'appWindow',
        'unlistenBlur',
        'listenBlur',
        'info',
        `let unlisten;${effects}`
    )(
        (fn) => {
            const cleanup = fn();
            if (cleanup) cleanups.push(cleanup);
        },
        closeOnBlur,
        pined,
        alwaysOnTop,
        (value) => pins.push(value),
        { setAlwaysOnTop: async (value) => native.push(value) },
        () => stops++,
        () => {
            listens++;
            return Promise.resolve(() => {});
        },
        () => {}
    );
    return { native, pins, listens, cleanups, stops: () => stops };
}
test('turning always-on-top off explicitly unpins the native window', () => {
    assert.deepEqual(reconcile(true, true, true).native, [true]);
    const off = reconcile(true, false, false);
    assert.deepEqual(off.native, [false]);
    assert.deepEqual(off.pins, [false]);
    assert.equal(off.listens, 1);
});
test('blur closing re-subscribes when enabled and is suppressed while pinned', () => {
    assert.equal(reconcile(false, false, false).listens, 0);
    assert.equal(reconcile(true, false, false).listens, 1);
    const pinned = reconcile(true, true, true);
    assert.equal(pinned.listens, 0);
    pinned.cleanups.forEach((cleanup) => cleanup());
    assert.equal(pinned.stops(), 2);
});
