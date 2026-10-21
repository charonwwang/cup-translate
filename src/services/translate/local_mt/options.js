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

// M2M has one token for Chinese / Portuguese / Norwegian, not separate scripts or dialects.
export const MULTILINGUAL_LANGUAGES = {
    en: 'en',
    zh_cn: 'zh',
    zh: 'zh',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    es: 'es',
    ru: 'ru',
    de: 'de',
    it: 'it',
    tr: 'tr',
    pt_pt: 'pt',
    pt_br: 'pt',
    pt: 'pt',
    vi: 'vi',
    id: 'id',
    th: 'th',
    ms: 'ms',
    ar: 'ar',
    hi: 'hi',
    km: 'km',
    mn_cy: 'mn',
    mn: 'mn',
    nb_no: 'no',
    no: 'no',
    fa: 'fa',
    sv: 'sv',
    pl: 'pl',
    nl: 'nl',
    uk: 'uk',
    he: 'he',
};
export function multilingualLanguage(value) {
    return (
        MULTILINGUAL_LANGUAGES[
            String(value ?? '')
                .toLowerCase()
                .replaceAll('-', '_')
        ] ?? null
    );
}
export const HY_LANGUAGES = new Set([
    'zh',
    'zh_cn',
    'zh_tw',
    'en',
    'fr',
    'pt',
    'pt_br',
    'pt_pt',
    'es',
    'ja',
    'tr',
    'ru',
    'ar',
    'ko',
    'th',
    'it',
    'de',
    'vi',
    'ms',
    'id',
    'tl',
    'hi',
    'pl',
    'cs',
    'nl',
    'km',
    'my',
    'fa',
    'gu',
    'ur',
    'te',
    'mr',
    'he',
    'bn',
    'ta',
    'uk',
    'bo',
    'kk',
    'mn',
    'mn_cy',
    'ug',
]);
export function hyLanguage(value) {
    const code = String(value ?? '')
        .toLowerCase()
        .replaceAll('-', '_');
    return HY_LANGUAGES.has(code) ? code : null;
}
export function resolveLocalModel(config, from, to) {
    if (config?.model === 'hymt') {
        const source = hyLanguage(from),
            target = hyLanguage(to);
        return source && target && source !== target ? (config.variant === 'hymt-q8' ? 'hymt-q8' : 'hymt-q4') : null;
    }
    if (config?.model === 'm2m100') {
        const source = multilingualLanguage(from === 'zh_tw' ? 'zh' : from),
            target = multilingualLanguage(to);
        return source && target && source !== target ? 'm2m100' : null;
    }
    if (config?.model && config.model !== 'opus') return null;
    if (String(to).replaceAll('-', '_').toLowerCase() === 'zh_tw') return null;
    return resolveLocalPair(from, to);
}
