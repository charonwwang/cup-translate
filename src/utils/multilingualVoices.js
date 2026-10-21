export function speechLanguageKey(value) {
    const key = String(value || '')
        .toLowerCase()
        .replaceAll('_', '-')
        .split('-')[0];
    return key === 'cmn' ? 'zh' : key;
}
export function filterKokoroVoices(voices, language, query = '') {
    return (voices || []).filter(
        (v) =>
            (!language || v.language === speechLanguageKey(language)) &&
            `${v.name} ${v.language}`.toLowerCase().includes(query.toLowerCase())
    );
}
export function isKokoroBusy(value) {
    return ['downloading', 'checking'].includes(value?.task?.state);
}
