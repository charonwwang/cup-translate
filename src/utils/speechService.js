// Translation and speech providers have different capabilities; never invent a provider API.
export function resolveSpeechService(engine, policy, configured = []) {
    configured = configured || [];
    if (policy === 'google') return 'google_tts';
    if (policy === 'local') return 'local_tts';
    if (policy === 'configured') return configured[0] || 'google_tts';
    if (engine === 'google') return 'google_tts';
    if (engine === 'lingva') return 'lingva_tts';
    if (engine === 'local_mt')
        return configured.find((key) => key === 'local_tts' || key.startsWith('local_tts@')) || null;
    return 'google_tts';
}
export function speechText(result) {
    if (typeof result === 'string') return result.trim();
    return (result?.explanations ?? [])
        .flatMap((entry) => entry.explains ?? [])
        .filter((value) => typeof value === 'string' && value.trim())
        .join('；');
}
