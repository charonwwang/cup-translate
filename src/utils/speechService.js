// Translation and speech providers have different capabilities; never invent a provider API.
export function resolveSpeechService(engine, policy, configured = []) {
    configured = configured || [];
    if (policy === 'off') return null;
    if (policy === 'google') return 'google_tts';
    if (policy === 'kokoro') return 'kokoro_tts';
    if (policy === 'piper') return 'piper_tts';
    if (policy === 'local') return 'local_tts';
    if (policy === 'configured') return configured[0] || null;
    if (engine === 'google') return 'google_tts';
    if (engine === 'lingva') return 'lingva_tts';
    if (engine === 'local_mt')
        return configured.find((key) => key === 'local_tts' || key.startsWith('local_tts@')) || null;
    return configured.find((key) => key === 'local_tts' || key.startsWith('local_tts@')) || null;
}
export function speechText(result) {
    if (typeof result === 'string') return result.trim();
    return (result?.explanations ?? [])
        .flatMap((entry) => entry.explains ?? [])
        .filter((value) => typeof value === 'string' && value.trim())
        .join('；');
}
