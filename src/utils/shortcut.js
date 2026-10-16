const specialKeys = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Space: 'Space',
    Escape: 'Esc',
};

export function shortcutFromEvent(event, platform) {
    if (event.isComposing || /^(Control|Shift|Alt|Meta)/.test(event.code)) return null;
    if (event.code === 'Backspace' || event.code === 'Delete') return '';
    let code = specialKeys[event.code] ?? event.code;
    code = code.replace(/^Key|^Digit|^Arrow|^Intl/, '').replace(/^Numpad/, 'Num');
    if (!code || code === 'Unidentified') return null;
    return [
        event.ctrlKey && 'Ctrl',
        event.shiftKey && 'Shift',
        event.metaKey && (platform === 'Darwin' ? 'Command' : 'Super'),
        event.altKey && 'Alt',
        code,
    ]
        .filter(Boolean)
        .join('+');
}

// Commit only after the native registration succeeds. Empty is an explicit disable.
export async function saveShortcut(name, shortcut, { register, persist }) {
    await register(name, shortcut);
    persist(shortcut, true);
}

export function normalizeShortcut(shortcut = '') {
    return String(shortcut || '')
        .toLowerCase()
        .replace(/commandorcontrol|cmdorctrl/g, 'ctrl')
        .replace(/command|cmd|super|meta/g, 'meta')
        .replace(/control/g, 'ctrl')
        .replace(/option/g, 'alt')
        .split('+')
        .map((key) => key.trim())
        .sort()
        .join('+');
}
