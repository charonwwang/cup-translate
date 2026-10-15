import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const STORE = 'src/utils/store.js';
const PLUGIN = 'node_modules/tauri-plugin-fs-watch-api/dist-js/index.mjs';

test('store reload does not stack a second debounce on top of the plugin one', async () => {
    // fs-watch 的 watch() 自身就是去抖的（插件默认 delayMs=2000）。
    // 旧实现又在回调里套了一层 100ms setTimeout，并在注释里声称那是「100ms 去抖」，
    // 而真实生效的窗口是插件的 2000ms —— 注释与行为相差 20 倍，
    // 会让人在排查「改了配置为何没立刻同步」时找错方向。
    const source = await readFile(STORE, 'utf8');
    assert.doesNotMatch(
        source,
        /setTimeout/,
        'store.js must not add its own timer; the fs-watch plugin already debounces'
    );
    assert.match(source, /delayMs/, 'the debounce window must be stated explicitly on the watch call');
});

test('the debounce window passed to watch matches what the plugin accepts', async () => {
    // 锁住插件的参数名与默认值：若上游把 delayMs 改名或去掉去抖，
    // store.js 里显式传入的 delayMs 会静默失效，这条断言会先失败。
    const plugin = await readFile(PLUGIN, 'utf8');
    assert.match(plugin, /delayMs/, 'plugin options must still be called delayMs');
    assert.match(plugin, /options: opts/, 'plugin must forward options to the Rust side');
});

test('watch is called with a real callback that reloads the store', async () => {
    const source = await readFile(STORE, 'utf8');
    const call = source.slice(source.indexOf('await watch('));
    assert.match(call, /appConfigPath/, 'must watch the config file path');
    assert.match(call, /store\.load\(\)/, 'must reload the in-memory store');
    assert.match(call, /reload_store/, 'must notify the Rust side to reload');
});
