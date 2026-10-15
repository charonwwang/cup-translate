import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { stripComments } from './helpers/source.mjs';

/**
 * 前端与 Rust 之间的**事件名契约**必须两端一致。
 *
 * 为什么需要这条（与 r91~r93 一脉相承）：
 *   `invoke` 契约已有护栏（`tests/invoke-command-contract.test.mjs`），
 *   但事件是**另一条**同样会「静默失效」的通道：
 *   名字对不上时事件永远不会到达，`listen` 的 `.then()` 也照常返回，
 *   不报任何错 —— 表现为「点了托盘菜单但界面没反应」这类难查的问题。
 *
 * 这里覆盖两种命名方式，**两种都必须查**：
 *
 *   A. 显式字面量：`window.emit("new_text", ...)` <-> `listen('new_text', ...)`
 *   B. 派生命名：`useConfig` 内部按配置 key 推导事件名
 *        `translate_auto_copy` -> `translate_auto_copy_changed`
 *      （见 `src/hooks/useConfig.jsx`：`key.replaceAll('.', '_').replaceAll('@', ':')`
 *       再拼 `_changed`；`syncToStore` 里 `emit` 同一个名字）
 *
 *      **B 是最容易被漏掉的一类**：源码里根本搜不到
 *      `listen('translate_auto_copy_changed')` 这个字面量，
 *      所以只做「字面量对字面量」的比对会**误判它是孤儿事件**。
 *      本轮就差点因此得出错误结论，故单独把推导规则钉住。
 */

const HOOK = 'src/hooks/useConfig.jsx';

/** 按 useConfig 的规则，从配置 key 推导变更事件名。 */
function changedEventName(configKey) {
    return `${configKey.replaceAll('.', '_').replaceAll('@', ':')}_changed`;
}

/** 扫描 src/ 下所有前端源码，取 `listen('x'` / `emit('x'` 的字面量事件名。 */
async function frontendEventLiterals() {
    const files = [];
    const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) await walk(full);
            else if (/\.(jsx?|ts)$/.test(e.name)) files.push(full);
        }
    };
    await walk('src');

    const listened = new Map();
    const emitted = new Map();
    for (const f of files) {
        const code = stripComments(await readFile(f, 'utf8'));
        for (const m of code.matchAll(/\blisten\(\s*['"]([a-zA-Z0-9_:-]+)['"]/g)) {
            if (!listened.has(m[1])) listened.set(m[1], new Set());
            listened.get(m[1]).add(f);
        }
        for (const m of code.matchAll(/\bemit\(\s*['"]([a-zA-Z0-9_:-]+)['"]/g)) {
            if (!emitted.has(m[1])) emitted.set(m[1], new Set());
            emitted.get(m[1]).add(f);
        }
    }
    return { listened, emitted };
}

/** 扫描 src/ 下所有 `useConfig('<key>', ...)` 的配置 key。 */
async function useConfigKeys() {
    const files = [];
    const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) await walk(full);
            else if (/\.(jsx?|ts)$/.test(e.name)) files.push(full);
        }
    };
    await walk('src');

    const keys = new Set();
    for (const f of files) {
        const code = stripComments(await readFile(f, 'utf8'));
        for (const m of code.matchAll(/useConfig\(\s*['"]([^'"]+)['"]/g)) keys.add(m[1]);
    }
    return keys;
}

test('both the emit and the listen side derive the event name identically', async () => {
    // ⚠️ 这里必须**分别**检查两侧，不能只对文件整体做一次正则匹配。
    //
    // 踩过的坑：`useConfig.jsx` 里有**两处** `eventKey` 定义
    // （广播侧与订阅侧各一处，行号见下方断言）。我最初只写了一条
    // 「文件里存在 `replaceAll('.', '_')`」的断言，结果变异测试时
    // **只改掉广播侧**，订阅侧那处仍满足正则 —— 变异**逃逸**了。
    // 而两侧推导规则一旦不一致，事件名就永远对不上，
    // 正是本文件要防的那类静默失效。所以逐处检查。
    const code = stripComments(await readFile(HOOK, 'utf8'));

    // 两侧的声明关键字**不一样**（广播侧是 `let`、订阅侧是 `const`），
    // 所以这里必须同时接受两者 —— 只匹配 `const` 会只找到一处。
    const derivations = [...code.matchAll(/\b(?:const|let|var) eventKey = ([^;]+);/g)].map((m) => m[1]);
    assert.ok(
        derivations.length >= 2,
        `expected an eventKey derivation on both the emit and the listen side, found ${derivations.length}`
    );

    for (const expr of derivations) {
        assert.match(expr, /replaceAll\(\s*'\.'\s*,\s*'_'\s*\)/, `this derivation must map '.' to '_': ${expr}`);
        assert.match(expr, /replaceAll\(\s*'@'\s*,\s*':'\s*\)/, `this derivation must map '@' to ':': ${expr}`);
    }

    // 两侧必须**逐字相同**：只要有一侧不完全一致，事件名就可能分叉。
    assert.equal(
        new Set(derivations).size,
        1,
        `every eventKey derivation must be identical, got ${JSON.stringify([...new Set(derivations)])}`
    );

    assert.match(code, /`\$\{eventKey\}_changed`/, 'the listen side must append _changed');
    assert.match(code, /emit\(\s*`\$\{eventKey\}_changed`/, 'the emit side must use the same name');
});

test("every config key's derived _changed event is subscribed by useConfig itself", async () => {
    // 这条其实是「同义反复」的护栏：所有 key 走的都是同一个 hook。
    // 它的价值在于**固定住「变更事件是派生的、不需要逐个手写」这个事实**，
    // 避免以后有人以为要手写 listen 而加出不一致的第二套。
    const keys = await useConfigKeys();
    assert.ok(keys.size >= 20, `expected many useConfig keys, found ${keys.size}`);

    const { listened } = await frontendEventLiterals();
    const handWritten = [...listened.keys()].filter((n) => n.endsWith('_changed'));
    assert.deepEqual(
        handWritten,
        [],
        `_changed events are derived inside useConfig and must not be hand-written: ${JSON.stringify(handWritten)}`
    );
});

test('the tray emit uses the exact name useConfig derives for translate_auto_copy', async () => {
    // 真实契约：tray.rs 的 emit_all 名字必须等于 useConfig 对该 key 的推导结果。
    const tray = stripComments(await readFile('src-tauri/src/tray.rs', 'utf8'));
    const m = /emit_all\(\s*"([a-zA-Z0-9_:-]+)"/.exec(tray);
    assert.notEqual(m, null, 'tray.rs must still emit a change event');
    assert.equal(
        m[1],
        changedEventName('translate_auto_copy'),
        'the tray event name must match what useConfig listens for; a mismatch silently drops the update'
    );

    // 同时确认该 key 确实有前端使用点（否则事件没人关心）
    const keys = await useConfigKeys();
    assert.ok(keys.has('translate_auto_copy'), 'translate_auto_copy must still be read via useConfig');
});

test('every event Rust emits has a frontend consumer', async () => {
    const { listened } = await frontendEventLiterals();
    const keys = await useConfigKeys();
    const derived = new Set([...keys].map(changedEventName));

    const rustFiles = (await readdir('src-tauri/src')).filter((f) => f.endsWith('.rs'));
    const orphans = [];
    for (const f of rustFiles) {
        const code = stripComments(await readFile(`src-tauri/src/${f}`, 'utf8'));
        for (const m of code.matchAll(/emit(?:_all|_to)?\(\s*"([a-zA-Z0-9_:-]+)"/g)) {
            const name = m[1];
            if (!listened.has(name) && !derived.has(name)) orphans.push(`${name} (${f})`);
        }
    }
    assert.deepEqual(
        orphans,
        [],
        `these events are emitted by Rust but nobody in the frontend listens for them: ${JSON.stringify(orphans)}`
    );
});

test('every event name is checked against both naming styles (no false orphans)', async () => {
    // 元测试：证明「字面量比对」单独用会误判，必须叠加派生规则。
    // 这是本轮差点踩的坑：只查字面量的话，translate_auto_copy_changed
    // 会被当成孤儿事件（源码里没有对应的 listen 字面量）。
    const { listened } = await frontendEventLiterals();
    assert.ok(
        !listened.has('translate_auto_copy_changed'),
        'precondition: this event has no literal listen() anywhere — that is why style B is needed'
    );

    const keys = await useConfigKeys();
    const derived = new Set([...keys].map(changedEventName));
    assert.ok(
        derived.has('translate_auto_copy_changed'),
        'the derived-name rule is what proves this event is actually consumed'
    );
});

test('a synthetic rename of the config key would break the match (guard is not vacuous)', async () => {
    // 反向自检：确认本契约对「改名」是敏感的。
    const tray = stripComments(await readFile('src-tauri/src/tray.rs', 'utf8'));
    const emitted = /emit_all\(\s*"([a-zA-Z0-9_:-]+)"/.exec(tray)[1];

    // 若配置 key 改成 translate_auto_copy_mode，推导出的名字就对不上了
    assert.notEqual(
        changedEventName('translate_auto_copy_mode'),
        emitted,
        'renaming the config key must change the derived event name, so the guard would fire'
    );
    assert.equal(changedEventName('translate_auto_copy'), emitted, 'the current names must match');
});

/**
 * 以下两条来自更早的一个版本（提交 2a40ee3，本仓库历史中已存在），
 * 本轮改动一度把它们覆盖掉，现按原样恢复。
 *
 * 为什么必须恢复：它们覆盖的能力是**上面几条没有的** ——
 *   · 事件名**形状**约束（不得含 '.'，必须匹配 `..._changed`）；
 *   · 派生必须**单射**（两个不同配置 key 不得映射到同一个事件名，
 *     否则会互相触发对方的更新，这是很难查的一类串扰）；
 *   · `new_text` / `new_image` 这两个**窗口推数据**事件，
 *     Rust 与前端必须在完全相同的名字下收发。
 * 覆盖它们等于降低护栏强度，属于回退。
 */

/** 扫描 Rust 源码，取所有 emit/emit_all 的事件名。 */
async function rustEmittedEvents() {
    const names = new Set();
    for (const f of await readdir('src-tauri/src')) {
        if (!f.endsWith('.rs')) continue;
        const code = stripComments(await readFile(`src-tauri/src/${f}`, 'utf8'));
        for (const m of code.matchAll(/emit(?:_all|_to)?\(\s*"([a-zA-Z0-9_:-]+)"/g)) names.add(m[1]);
    }
    return names;
}

test('every config key round-trips to a stable event name', async () => {
    const keys = await useConfigKeys();
    assert.ok(keys.size >= 20, `expected many configured keys, found ${keys.size}`);

    // 事件名不得含 '.'：带点号的名字在 Tauri 里会被当成命名空间处理，
    // 与 Rust 侧 emit 的字面量对不上。
    for (const key of keys) {
        const name = changedEventName(key);
        assert.ok(!name.includes('.'), `event name for '${key}' must not contain '.', got '${name}'`);
        assert.match(name, /^[a-z0-9_:@-]+_changed$/, `unexpected event name shape for '${key}': ${name}`);
    }

    // 派生必须是**单射**：两个不同的配置 key 不能映射到同一个事件名，
    // 否则会互相触发对方的更新（串扰，且极难排查）。
    const seen = new Map();
    for (const key of keys) {
        const name = changedEventName(key);
        assert.ok(
            !seen.has(name) || seen.get(name) === key,
            `config keys '${seen.get(name)}' and '${key}' collide on event name '${name}'`
        );
        seen.set(name, key);
    }
});

test('well-known window events are emitted and listened under the same names', async () => {
    // new_text / new_image 是 Rust 推给窗口的数据事件，两侧名字必须一致。
    const emitted = await rustEmittedEvents();
    const { listened } = await frontendEventLiterals();
    for (const name of ['new_text', 'new_image']) {
        assert.ok(emitted.has(name), `Rust should emit '${name}'`);
        assert.ok(
            listened.has(name),
            `the frontend must listen for '${name}' under exactly that name; a mismatch silently drops the data`
        );
    }
});
