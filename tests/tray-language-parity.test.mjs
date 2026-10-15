import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readTraySource = () => readFile('src-tauri/src/tray.rs', 'utf8');
const readLanguageMenu = () => readFile('src/window/Config/pages/General/index.jsx', 'utf8');

/** 取出 update_tray 里 set_menu(match ...) 的真实分支语言码。 */
function trayDispatchLanguages(source) {
    const body = source.slice(source.indexOf('tray_handle.set_menu(match language.as_str()'));
    const end = body.indexOf('}) {');
    const dispatch = body.slice(0, end === -1 ? body.length : end);
    return [...dispatch.matchAll(/"([a-z_]+)"\s*=>\s*tray_menu_[a-z_]+\(\)/g)].map((m) => m[1]);
}

/** 取出语言选择器里所有 DropdownItem 的 key（会原样写入 app_language）。 */
function uiLanguages(source) {
    const start = source.indexOf("aria-label='app language'");
    assert.notEqual(start, -1, 'language dropdown not found');
    // 必须切到 </DropdownMenu> 为止：再往后还有主题/引擎等无关的 key='...'，
    // 不设边界会把 'system'、'disable' 这类误当成语言码（实测踩过）。
    const end = source.indexOf('</DropdownMenu>', start);
    assert.notEqual(end, -1, 'language dropdown has no closing tag');
    const menu = source.slice(start, end);
    return [...menu.matchAll(/key='([a-z_]+)'/g)].map((m) => m[1]);
}

test('every language offered by the UI has a dedicated tray menu', async () => {
    // 缺陷背景：语言选择器提供 18 种语言，但托盘只实现了 11 种，
    // es / it / ar / pt_pt 会落到 `_ => tray_menu_en()`，用户把界面切成
    // 西班牙语/意大利语/阿拉伯语/葡葡后，系统托盘仍然是英文。
    const tray = await readTraySource();
    const ui = await readLanguageMenu();

    const dispatched = new Set(trayDispatchLanguages(tray));
    const offered = uiLanguages(ui);

    assert.ok(offered.length >= 18, `expected the UI to offer >=18 languages, got ${offered.length}`);

    // locale 只有 2 个 key 的占位语言：全站文案本就回退英文，
    // 托盘回退英文与之一致，属有意为之而非缺陷。
    // tk 有 68 个 key，远少于完整语言的 342，同样不足以支撑托盘翻译
    const placeholderLocales = new Set(['tr', 'nb_no', 'nn_no', 'tk']);

    const missing = offered.filter((lang) => !placeholderLocales.has(lang) && !dispatched.has(lang));
    assert.deepEqual(missing, [], `these UI languages fall back to an English tray: ${missing.join(', ')}`);
});

test('the four languages that were previously English-only stay covered', async () => {
    // 点名护栏：防止将来有人「精简」掉其中任一分支
    const dispatched = new Set(trayDispatchLanguages(await readTraySource()));
    for (const lang of ['es', 'it', 'ar', 'pt_pt', 'he', 'ta']) {
        assert.ok(dispatched.has(lang), `${lang} must keep a dedicated tray menu`);
    }
});

test('pt_pt and pt_br are handled as distinct languages', async () => {
    const source = await readTraySource();
    const dispatched = new Set(trayDispatchLanguages(source));
    assert.ok(dispatched.has('pt_pt'), 'pt_pt must have its own tray menu');
    assert.ok(dispatched.has('pt_br'), 'pt_br must have its own tray menu');
    // 两者必须是不同的函数，不能共用
    assert.match(source, /fn tray_menu_pt_pt\(\)/);
    assert.match(source, /fn tray_menu_pt_br\(\)/);
});

test('tray menu functions exist for every dispatched language', async () => {
    // 分发里引用了 tray_menu_x()，就一定要有这个函数，否则编译不过；
    // 反过来也检查一遍，避免留下没人调用的死菜单。
    const source = await readTraySource();
    const dispatched = trayDispatchLanguages(source);
    for (const lang of dispatched) {
        assert.match(
            source,
            new RegExp(`fn tray_menu_${lang}\\(\\)`),
            `tray_menu_${lang} is dispatched but not defined`
        );
    }
});

test('a placeholder locale is never silently promoted to a real menu', async () => {
    // 反向护栏：nb_no / nn_no / tr 没有翻译来源，
    // 如果哪天有人给它们加了菜单，应当同时补齐 locale，而不是只加菜单。
    const dispatched = new Set(trayDispatchLanguages(await readTraySource()));
    for (const lang of ['nb_no', 'nn_no', 'tr', 'tk']) {
        assert.ok(
            !dispatched.has(lang),
            `${lang} has an incomplete placeholder locale; adding a tray menu means inventing translations`
        );
    }
});

/**
 * 每个托盘菜单项都必须有对应的点击处理分支。
 *
 * 背景（本轮实测）：现有的托盘测试只覆盖了**语言分发**
 * （`tray_menu_xx` 是否被 dispatch、各语言菜单项是否一致），
 * 而「菜单项 ID 与 `tray_event_handler` 里 `MenuItemClick` 分支是否一一对应」
 * **无人守护**。实测把 `"view_log" => on_view_log_click(app),` 这一行删掉，
 * `cargo test` 的 10 条 tray 测试**仍然全绿**，Node 侧 5 条也全绿 ——
 * 结果是「查看日志」这一项照常显示，但用户点了**毫无反应**，且没有任何报错。
 *
 * 这与托盘历史上漏掉 `he` / `ta` 是同一类问题：断言的是「清单内部一致」，
 * 而不是「清单与它的真实消费者一致」。
 *
 * 这里把两侧都从**真实源码**解析出来做交叉比对：
 *   · 定义侧 = 所有 `CustomMenuItem::new("<id>", ...)` 的 id
 *   · 消费侧 = `SystemTrayEvent::MenuItemClick` 那个 match 里的 `"<id>" =>`
 */
function trayMenuIds(source) {
    const ids = new Set();
    for (const m of source.matchAll(/CustomMenuItem::new\(\s*"([a-z_]+)"/g)) {
        ids.add(m[1]);
    }
    return ids;
}

function trayHandledIds(source) {
    const start = source.indexOf('SystemTrayEvent::MenuItemClick');
    assert.notEqual(start, -1, 'the tray handler must still match on MenuItemClick');
    const end = source.indexOf('_ => {}', start);
    assert.notEqual(end, -1, 'the MenuItemClick match must keep a catch-all arm');
    const ids = new Set();
    for (const m of source.slice(start, end).matchAll(/"([a-z_]+)"\s*=>/g)) {
        ids.add(m[1]);
    }
    return ids;
}

test('every tray menu item has a click handler', async () => {
    const source = await readTraySource();
    const defined = trayMenuIds(source);
    const handled = trayHandledIds(source);

    // 先确认解析到了合理规模，避免正则失配后「两边都是空集」而误判通过
    assert.ok(defined.size >= 13, `expected at least 13 tray menu ids, parsed ${defined.size}`);
    assert.ok(handled.size >= 13, `expected at least 13 handled tray ids, parsed ${handled.size}`);

    const unhandled = [...defined].filter((id) => !handled.has(id)).sort();
    assert.deepEqual(unhandled, [], `these tray items render but do nothing when clicked: ${unhandled.join(', ')}`);

    // 反向：handler 里不应留下对应不到任何菜单项的死分支
    const orphaned = [...handled].filter((id) => !defined.has(id)).sort();
    assert.deepEqual(orphaned, [], `these handled ids have no matching menu item: ${orphaned.join(', ')}`);
});
