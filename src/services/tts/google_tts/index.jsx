import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
import { chunkText } from './chunkText';

// Google TTS（免费、无需 API key、开箱即用）：
// 使用 Google 翻译的 TTS 端点，返回 MP3 音频，无需本地安装任何 TTS 引擎。
// 短文本（<200 字符）直接合成；长文本分段合成后拼接。
export async function tts(text, lang, options = {}) {
    if (!text || text.trim() === '') {
        return new Uint8Array(0);
    }
    // Google TTS 语言代码映射。
    // 键必须与 src/services/tts/*/info.ts 的 Language 枚举一致（它们是同一份
    // 「项目支持的 TTS 语言」清单）。此前漏了 sv / pl / nl / nb_no / nn_no / km
    // 六项，它们全部落到下面的 `|| 'en'`，于是**用户选这些语言却听到英文发音**。
    // 实测 Google 的 translate_tts 对这六个代码均返回 HTTP 200：
    //     tl=sv / pl / nl / no / km  -> 200
    // 唯一**确实**不被支持的是蒙古语 mn_cy，实测 mn / mn-Cyrl / mn-MN 全为
    // HTTP 400，因此它继续回退英文（唯一不可避免的一项）。
    // 挪威语两个变体（书面语 nb / 新挪威语 nn）都用 Google 的 'no'，
    // 与 lingva 的映射保持一致。
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
        sv: 'sv',
        pl: 'pl',
        nl: 'nl',
        nb_no: 'no',
        nn_no: 'no',
        km: 'km',
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
