export function resolveLocalPair(from, to) {
    const normalize = (lang) => {
        const value = String(lang ?? '').toLowerCase();
        if (value.startsWith('en')) return 'en';
        if (value.startsWith('zh') || value === 'cmn') return 'zh';
        return null;
    };
    const source = normalize(from);
    const target = normalize(to);
    return source && target && source !== target ? `${source}-${target}` : null;
}

export function localThreadCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(64, Math.max(1, Math.trunc(number))) : 2;
}
