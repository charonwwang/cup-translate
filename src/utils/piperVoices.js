function voiceLanguage(lang) {
    const normalized = String(lang || '')
        .trim()
        .toLowerCase()
        .replaceAll('_', '-');
    return normalized === 'cmn' ? 'zh' : normalized.split('-')[0];
}
// Preferences are keyed by spoken language, never by translation provider or pane.
export function preferredPiperVoice(preferences, lang) {
    return preferences?.[voiceLanguage(lang)] || null;
}
export function piperTaskActive(task) {
    return ['downloading', 'checking'].includes(task?.state);
}
export function voiceBytes(voice) {
    return (voice?.files || [])
        .filter((file) => !file.name.startsWith('samples/'))
        .reduce((sum, file) => sum + file.bytes, 0);
}
