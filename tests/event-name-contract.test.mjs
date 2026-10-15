import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const SRC_DIR = 'src';
const RUST_DIR = 'src-tauri/src';
const USE_CONFIG = 'src/hooks/useConfig.jsx';

/**
 * 背景：前后端之间靠**事件名字符串**通信，编译器完全无法检查。
 *
 * 前端 useConfig 的关键约定（src/hooks/useConfig.jsx）：
 *
 *     let eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
 *     emit(`${eventKey}_changed`, v);      // 写盘后广播
 *     listen(`${eventKey}_changed`, ...)   // 其它窗口/实例据此同步
 *
 * 而 Rust 侧唯一的配置广播在 tray.rs：
 *
 *     app.emit_all("translate_auto_copy_changed", mode)
 *
 * 这条链路的作用：用户在**系统托盘**里切换「自动复制」模式时，
 * Rust 改完配置必须通知已打开的前端窗口，否则设置页仍显示旧值。
 * 名字是**运行时拼接**的，写错分隔符（用 `translate.auto_copy_changed`
 * 而非下划线，或漏掉 `_changed` 后缀）会**静默失配**——
 * 不报错、不崩溃，只是托盘改了设置而界面不更新。
 *
 * 另一个方向同理：前端 emit 了事件但没人 listen、或 Rust emit 了
 * 前端从没监听的名字，都属于无声的死链路。
 *
 * 这些测试把当前**已经正确**的契约钉死，防止将来被改坏。
 */

/** useConfig 的事件名派生规则，与 useConfig.jsx 保持一致。 */
function eventNameFor(configKey) {
    return `${configKey.replaceAll('.', '_').replaceAll('@', ':')}_changed`;
}

/** 扫描前端所有 useConfig('key', ...) 的 key。 */
async function configKeys() {
    const keys = new Set();
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(path);
            } else if (/\.(js|jsx)$/.test(entry.name)) {
                const source = await readFile(path, 'utf8');
                for (const m of source.matchAll(/useConfig\(\s*'([^']+)'/g)) {
                    keys.add(m[1]);
                }
            }
        }
    }
    await walk(SRC_DIR);
    return keys;
}

/** 收集 src-tauri/src/*.rs 里 emit(...) / emit_all(...) / emit_to(...) 的字面量事件名。 */
async function rustEmittedEvents() {
    const names = new Set();
    for (const file of (await readdir(RUST_DIR)).filter((f) => f.endsWith('.rs'))) {
        const source = await readFile(`${RUST_DIR}/${file}`, 'utf8');
        for (const m of source.matchAll(/emit(?:_all|_to)?\(\s*"([^"]+)"/g)) {
            names.add(m[1]);
        }
    }
    return names;
}

test('useConfig derives listen and emit names identically', async () => {
    // 若这两处派生规则被改得不一致，自己的状态就同步不了（改动只改一处时尤其危险）
    const source = await readFile(USE_CONFIG, 'utf8');
    // 必须比对**完整事件名**（`${eventKey}_changed`），不能只比对 eventKey 的派生规则：
    // 两处 eventKey 派生相同、但后缀不同（emit 用 `_updated`、listen 用 `_changed`）时，
    // 只比派生会完全漏掉——而那种改动恰恰会让多个窗口之间失去同步。
    const emitted = [...source.matchAll(/emit\(\s*`([^`]+)`/g)].map((m) => m[1]);
    const listened = [...source.matchAll(/listen\(\s*`([^`]+)`/g)].map((m) => m[1]);

    assert.ok(emitted.length >= 1, 'useConfig should emit an event after persisting a value');
    assert.ok(listened.length >= 1, 'useConfig should listen for changes made by other instances');
    assert.deepEqual(
        new Set(emitted),
        new Set(listened),
        `useConfig must emit and listen on the exact same event name, got emit=${JSON.stringify(emitted)} listen=${JSON.stringify(listened)}`
    );

    const derived = [...source.matchAll(/eventKey\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(derived.length >= 2, `expected the event key to be derived in both directions, found ${derived.length}`);
    assert.equal(new Set(derived).size, 1, `derivations disagree: ${[...new Set(derived)].join(' | ')}`);

    // 后缀固定为 _changed（Rust 侧 tray.rs 的 emit_all 依赖这一约定）
    for (const name of listened) {
        assert.match(name, /_changed$/, `the config event suffix must stay '_changed', got '${name}'`);
    }
});

test('every config key round-trips to a stable event name', async () => {
    const keys = await configKeys();
    assert.ok(keys.size >= 30, `expected many configured keys, found ${keys.size}`);

    // 事件名不得含 '.' 或 '@'：带点号的名字在 Tauri 里会被当成命名空间处理，
    // 与 Rust 侧 emit 的字面量对不上
    for (const key of keys) {
        const name = eventNameFor(key);
        assert.ok(!name.includes('.'), `event name for '${key}' must not contain '.', got '${name}'`);
        assert.match(name, /^[a-z0-9_:@-]+_changed$/, `unexpected event name shape for '${key}': ${name}`);
    }

    // 派生必须是单射：两个不同的配置 key 不能映射到同一个事件名，
    // 否则会互相触发对方的更新
    const seen = new Map();
    for (const key of keys) {
        const name = eventNameFor(key);
        assert.ok(
            !seen.has(name) || seen.get(name) === key,
            `config keys '${seen.get(name)}' and '${key}' collide on event name '${name}'`
        );
        seen.set(name, key);
    }
});

test('every config event Rust emits has a matching frontend listener', async () => {
    // Rust 侧广播配置变更时，事件名必须能被前端 useConfig 的监听命中，
    // 否则「托盘改了设置、界面不更新」这种无声失配就会复现。
    const emitted = await rustEmittedEvents();
    const configEvents = [...emitted].filter((e) => e.endsWith('_changed'));
    assert.ok(configEvents.length >= 1, 'expected at least one config change event from Rust');

    const listeners = new Set([...(await configKeys())].map(eventNameFor));
    const orphans = configEvents.filter((e) => !listeners.has(e));
    assert.deepEqual(
        orphans,
        [],
        `Rust emits these *_changed events but no useConfig listener exists (the UI would not update): ${orphans.join(', ')}`
    );
});

test('the tray auto-copy setting keeps its cross-boundary event name', async () => {
    // 逐个点名：托盘菜单切「自动复制」后靠这条事件让前端跟上。
    // 键名（Rust 配置键 / 前端 useConfig 参数）与事件名任何一处改动都会断链。
    const emitted = await rustEmittedEvents();
    assert.ok(
        emitted.has('translate_auto_copy_changed'),
        'tray.rs must emit translate_auto_copy_changed after changing the auto-copy mode'
    );

    const keys = await configKeys();
    assert.ok(keys.has('translate_auto_copy'), "useConfig must be called with the key 'translate_auto_copy'");
    assert.equal(eventNameFor('translate_auto_copy'), 'translate_auto_copy_changed');
});

test('well-known window events are emitted and listened under the same names', async () => {
    // new_text / new_image 是 Rust 推给窗口的数据事件，两侧名字必须一致
    const emitted = await rustEmittedEvents();
    for (const name of ['new_text', 'new_image']) {
        assert.ok(emitted.has(name), `Rust should emit '${name}'`);

        let listened = false;
        async function walk(dir) {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = `${dir}/${entry.name}`;
                if (entry.isDirectory()) {
                    await walk(path);
                } else if (/\.(js|jsx)$/.test(entry.name)) {
                    const source = await readFile(path, 'utf8');
                    if (source.includes(`listen('${name}'`)) listened = true;
                }
            }
        }
        await walk(SRC_DIR);
        assert.ok(listened, `the frontend must listen for '${name}' under exactly that name`);
    }
});
