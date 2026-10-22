// Translation and speech providers have different capabilities; never invent a provider API.
export function resolveSpeechService(engine, policy, configured = []) {
    configured = configured || [];
    if (policy === 'off') return null;
    // A provider's own speech stays independent of the fallback preference.
    if (engine === 'google') return 'google_tts';
    if (engine === 'lingva') return 'lingva_tts';
    if (policy === 'google') return 'google_tts';
    if (policy === 'kokoro') return 'kokoro_tts';
    if (policy === 'piper') return 'piper_tts';
    if (policy === 'qwen') return 'qwen_tts';
    if (policy === 'local') return 'local_tts';
    return configured[0] || null;
}
export function speechText(result) {
    if (typeof result === 'string') return result.trim();
    return (result?.explanations ?? [])
        .flatMap((entry) => entry.explains ?? [])
        .filter((value) => typeof value === 'string' && value.trim())
        .join('；');
}
