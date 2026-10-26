import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';

export async function tts(text, lang, options = {}) {
    const { config = {} } = options;

    let { requestPath = 'lingva.pot-app.com' } = config;

    if (requestPath.length === 0) {
        requestPath = 'lingva.pot-app.com';
    }

    if (!requestPath.startsWith('http')) {
        requestPath = 'https://' + requestPath;
    }
    const res = await fetch(`${requestPath}/api/v1/audio/${lang}/${encodeURIComponent(text)}`);

    if (!res.ok) throw new Error(`Lingva speech request failed: HTTP ${res.status}`);
    const audio = res.data?.audio;
    if (
        !Array.isArray(audio) ||
        !audio.length ||
        !audio.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
        throw new Error('Lingva returned invalid or empty audio');
    }
    return audio;
}

export * from './Config';
export * from './info';
