import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shortcutFromEvent } from '../src/utils/shortcut.js';

const PAGE = 'src/window/Config/pages/Hotkey/index.jsx';

test('all five shortcuts keep unsaved edits out of persistent configuration', async () => {
    const source = await readFile(PAGE, 'utf8');
    for (const action of [
        'selection_translate',
        'clipboard_translate',
        'input_translate',
        'ocr_recognize',
        'ocr_translate',
    ]) {
        const call = source.match(new RegExp(`useConfig\\(\\s*'hotkey_${action}'[\\s\\S]*?\\);`));
        assert.ok(call?.[0].includes('sync: false'), action);
    }
    assert.doesNotMatch(source, /unregister\(/, 'focus must not release a working shortcut');
    assert.doesNotMatch(source, /onFocus=/, 'focusing must not clear the saved binding');
});

test('selection and clipboard have separate defaults and descriptions', async () => {
    const source = await readFile(PAGE, 'utf8');
    assert.match(source, /'hotkey_selection_translate',\s*'Alt\+T'/);
    assert.match(source, /'hotkey_clipboard_translate',\s*'Alt\+Shift\+T'/);
    for (const name of ['en_US', 'zh_CN']) {
        const locale = JSON.parse(await readFile(`src/i18n/locales/${name}.json`, 'utf8')).translation.config.hotkey;
        assert.notEqual(locale.selection_translate_description, locale.clipboard_translate_description);
    }
});

test('recording uses physical keys and keeps selection and clipboard combinations distinct', () => {
    assert.equal(shortcutFromEvent({ code: 'KeyT', altKey: true }, 'Darwin'), 'Alt+T');
    assert.equal(shortcutFromEvent({ code: 'KeyT', altKey: true, shiftKey: true }, 'Darwin'), 'Shift+Alt+T');
    assert.equal(shortcutFromEvent({ code: 'KeyT', metaKey: true }, 'Darwin'), 'Command+T');
    assert.equal(shortcutFromEvent({ code: 'KeyT', metaKey: true }, 'Linux'), 'Super+T');
});

test('modifier-only keys and IME composition never create partial shortcuts', () => {
    for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaRight'])
        assert.equal(shortcutFromEvent({ code }), null);
    assert.equal(shortcutFromEvent({ code: 'KeyT', isComposing: true }), null);
});

test('explicit deletion produces a disable draft, rather than writing configuration', () => {
    assert.equal(shortcutFromEvent({ code: 'Backspace' }), '');
    assert.equal(shortcutFromEvent({ code: 'Delete' }), '');
});

test('saved empty values still disable the backend shortcut', async () => {
    const source = await readFile('src-tauri/src/hotkey.rs', 'utf8');
    assert.match(source, /if hotkey.is_empty\(\)/);
    assert.match(source, /stored.unwrap_or_else/);
    assert.match(source, /requested\s*\.map\(str::to_owned\)/, 'a submitted new key must override the stored old key');
});
