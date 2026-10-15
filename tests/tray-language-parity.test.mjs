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
