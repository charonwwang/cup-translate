import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
import { chunkText } from './chunkText';

// Google TTS（免费、无需 API key、开箱即用）：
// 使用 Google 翻译的 TTS 端点，返回 MP3 音频，无需本地安装任何 TTS 引擎。
// 短文本（<200 字符）直接合成；长文本分段合成后拼接。
export async function tts(text, lang, options = {}) {
    if (!text || text.trim() === '') {
        return new Uint8Array(0);
    }
    // Google TTS 语言代码映射
    const langMap = {
        zh_cn: 'zh-CN',
        zh_tw: 'zh-TW',
        en: 'en',
        ja: 'ja',
        ko: 'ko',
        fr: 'fr',
        de: 'de',
        es: 'es',
        ru: 'ru',
        it: 'it',
        tr: 'tr',
        pt_pt: 'pt-PT',
        pt_br: 'pt-BR',
        ar: 'ar',
        hi: 'hi',
        th: 'th',
        vi: 'vi',
        id: 'id',
        ms: 'ms',
        uk: 'uk',
        fa: 'fa',
        he: 'he',
    };
    const googleLang = langMap[lang] || 'en';

    const chunks = chunkText(text);

    // 逐段合成并拼接 MP3（MP3 帧可直接拼接）
    const parts = [];
    for (const chunk of chunks) {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${googleLang}&q=${encodeURIComponent(chunk)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                Referer: 'https://translate.google.com/',
            },
            responseType: 3, // Binary
        });
        if (!res.ok) {
            // 与其余服务层错误保持一致，用英文（服务层拿不到 t，回退语言即英文）
            throw `Google TTS request failed: HTTP ${res.status}`;
        }
        parts.push(new Uint8Array(res.data));
    }

    // 拼接所有 MP3 分段
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export const info = {
    display: 'Google TTS',
    server: 'translate.google.com',
};
