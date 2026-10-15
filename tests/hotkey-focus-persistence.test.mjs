import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * 快捷键设置页的「聚焦即清空」缺陷。
 *
 * 现象：用户只是**点一下**快捷键输入框（想看看当前绑定是什么），
 * onFocus 会把值置空；而 useConfig 的 sync 默认为 true，
 * 这个空串会经 500ms 防抖写进配置并持久化。
 * 用户随后点到别处 / 关掉窗口，没有做任何「修改」动作，
 * 快捷键就已经被永久清掉了——而且**没有任何提示**。
 *
 * 已实测确认后果（不是推理）：
 *   配置里 hotkey_selection_translate 为 'Alt+T' 时，启动日志有
 *     "Registered global shortcut: Alt+T for hotkey_selection_translate"
 *   把它改成 '' 后重启，日志里**一条 shortcut 记录都没有**——
 *   Rust 侧 `if hotkey.is_empty() { return Ok(()) }` 直接跳过注册。
 *
 * 而空串在本项目里是**有语义**的：Rust 的 an_explicitly_empty_config_disables_the_hotkey
 * 明确把 "" 当作「用户想禁用」。所以 onFocus 的隐式清空无法与
 * 「用户主动禁用」区分——两者写进配置的是同一个值。
 *
 * 修复：本页 useConfig 改为 { sync: false }，只在两个**用户明确动作**处落盘：
 *   · keyDown  —— 用户真的按了键（含 Backspace = 显式禁用）
 *   · registerHandler 注册成功后
 * onFocus 仍然清空输入框（为了腾出位置给新键），但不再写配置。
 */

const HOTKEY_PAGE = 'src/window/Config/pages/Hotkey/index.jsx';

const HOTKEY_KEYS = [
    'hotkey_selection_translate',
    'hotkey_clipboard_translate',
    'hotkey_input_translate',
    'hotkey_ocr_recognize',
    'hotkey_ocr_translate',
];

test('every hotkey config on the settings page opts out of automatic syncing', async () => {
    const source = await readFile(HOTKEY_PAGE, 'utf8');
    for (const key of HOTKEY_KEYS) {
        // Prettier 可能把这条语句折成多行，所以取整条语句而不是单行
        const call = source.match(new RegExp(`useConfig\\(\\s*'${key}'[\\s\\S]*?\\);`));
        assert.ok(call, `${key} should be read via useConfig on the hotkey page`);
        assert.ok(
            call[0].includes('sync: false'),
            `${key} must use { sync: false } — otherwise focusing the input persists an empty value. Got: ${call[0].replace(/\s+/g, ' ')}`
        );
    }
});

test('the blur/focus clear does not persist to the config', async () => {
    // onFocus 里的清空必须保持「只在内存里」。
    // 若有人改回默认 sync（或加上 forceSync），这条会失败。
    const source = await readFile(HOTKEY_PAGE, 'utf8');
    const focusBlocks = [...source.matchAll(/onFocus=\{\(\) => \{(.*?)\}\}/gs)].map((m) => m[1]);
    assert.equal(focusBlocks.length, 5, `expected 5 hotkey inputs, found ${focusBlocks.length}`);

    for (const block of focusBlocks) {
        // 清空本身是允许且必要的
        assert.ok(
            /set\w+\(''\)/.test(block),
            `each onFocus should clear the input so the user can press a new key, got: ${block.trim()}`
        );
        // 但**不能**带 forceSync=true（true 会绕过 sync:false 直接落盘）
        assert.ok(
            !/set\w+\('',\s*true\)/.test(block),
            `onFocus must not force-sync an empty value to the config, got: ${block.trim()}`
        );
    }
});

test('the two explicit user actions still persist the new binding', async () => {
    const source = await readFile(HOTKEY_PAGE, 'utf8');

    // keyDown：用户按了键（含 Backspace 禁用）——两处都必须 forceSync=true
    assert.ok(
        /setKey\('',\s*true\)/.test(source),
        'pressing Backspace to disable a hotkey must persist (forceSync=true)'
    );
    assert.ok(
        /setKey\(`\$\{newValue\}.*`,\s*true\)/.test(source),
        'pressing a new combination must persist (forceSync=true)'
    );

    // registerHandler：注册成功后才落盘，且必须真的调用了 persist
    const registerFn = source.slice(source.indexOf('function registerHandler'));
    const body = registerFn.slice(0, registerFn.indexOf('\n    }'));
    assert.ok(body.length > 50, 'sanity: registerHandler body should be found');
    assert.ok(
        /persist\(key,\s*true\)/.test(body),
        'registerHandler must persist the binding after a successful registration'
    );
    // 落盘必须紧跟在 invoke(...).then( 的成功回调里，
    // 即位于 register_shortcut_by_frontend 与成功 toast 之间。
    // （不能简单地跟“第一个 toast.error”比：那句是「该组合键已被占用」，
    //   本来就在 invoke 之前，比顺序会得到错误结论。）
    const invokeIdx = body.indexOf('register_shortcut_by_frontend');
    const persistIdx = body.indexOf('persist(key, true)');
    const successToastIdx = body.indexOf('config.hotkey.success');
    assert.ok(invokeIdx !== -1 && persistIdx !== -1 && successToastIdx !== -1, 'sanity: all three anchors found');
    assert.ok(
        invokeIdx < persistIdx && persistIdx < successToastIdx,
        'persist() must sit in the success callback, between the invoke and the success toast'
    );
});

test('all five register handlers pass their matching setter', async () => {
    // 修复后 registerHandler 需要第三个参数。漏传会让 persist 变成 undefined，
    // 注册成功时抛 TypeError——用户点了「确定」反而报错。
    const source = await readFile(HOTKEY_PAGE, 'utf8');
    const expected = {
        hotkey_selection_translate: 'setSelectionTranslate',
        hotkey_clipboard_translate: 'setClipboardTranslate',
        hotkey_input_translate: 'setInputTranslate',
        hotkey_ocr_recognize: 'setOcrRecognize',
        hotkey_ocr_translate: 'setOcrTranslate',
    };
    for (const [key, setter] of Object.entries(expected)) {
        const call = [...source.matchAll(new RegExp(`registerHandler\\(\\s*'${key}',[\\s\\S]*?\\)`, 'g'))];
        assert.equal(call.length, 1, `expected exactly one registerHandler call for ${key}, found ${call.length}`);
        assert.ok(
            call[0][0].includes(setter),
            `registerHandler('${key}', ...) must pass ${setter} so the value can be persisted. Got: ${call[0][0].replace(/\s+/g, ' ')}`
        );
    }
});

test('an empty hotkey really is treated as "disabled" by the backend', async () => {
    // 这条测试解释「为什么 onFocus 的隐式清空是缺陷」：
    // 空串不是「没设置」，而是「用户想禁用」。两者写进配置后无法区分，
    // 所以只有用户明确动作才允许产生空串。
    const source = await readFile('src-tauri/src/hotkey.rs', 'utf8');

    assert.ok(source.includes('if hotkey.is_empty()'), 'the backend should skip registration for an empty hotkey');
    assert.ok(
        source.includes('an_explicitly_empty_config_disables_the_hotkey'),
        'Rust should keep the test documenting that "" means "disabled by the user"'
    );
    // 默认值只在配置里**没有**该键时才生效——所以一旦被写成 ""，
    // 默认值再也回不来，这正是「永久失效」的原因。
    const resolveIdx = source.indexOf('fn resolve_hotkey');
    assert.ok(resolveIdx !== -1, 'resolve_hotkey should exist');
    const resolveFn = source.slice(resolveIdx, resolveIdx + 200);
    assert.ok(
        resolveFn.includes('stored.unwrap_or_else'),
        'resolve_hotkey must only apply the default when the key is absent, not when it is empty'
    );
});

test('the settings page only persists hotkeys through explicit actions', async () => {
    // 汇总式护栏：统计 useConfig({sync:false}) 与 forceSync 落盘点，
    // 防止将来有人新增一个「顺手就落盘」的路径。
    const source = await readFile(HOTKEY_PAGE, 'utf8');
    const optOuts = (source.match(/useConfig\([^)]*sync: false[^)]*\)/g) || []).length;
    assert.equal(optOuts, 5, `all 5 hotkey configs should opt out of syncing, found ${optOuts}`);

    // 允许的持久化落盘点恰好这 3 类：Backspace 禁用、按下新组合键、注册成功
    assert.ok(/setKey\('',\s*true\)/.test(source), 'Backspace disable should persist');
    assert.ok(/setKey\(`\$\{newValue\}.*`,\s*true\)/.test(source), 'a new combination should persist');
    const persistCalls = (source.match(/persist\(key,\s*true\)/g) || []).length;
    assert.equal(persistCalls, 1, `expected exactly one persist call site, found ${persistCalls}`);
});
