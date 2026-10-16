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
    // 键必须覆盖 `src/services/tts/*/info.ts` 的 Language 枚举（那是「项目支持的
    // TTS 语言」权威清单），否则会落到下面的 `|| 'en'` 而**静默说英文**。
    // 此前漏了 sv / pl / nl / nb_no / nn_no / km 六项，正是这个后果；
    // `tests/google-tts-language-map.test.mjs` 现在守着「枚举 ⊆ map」这条契约。
    //
    // ⚠️ 两种**不同**的失败模式，不要混为一谈（2026-10 实测复核）：
    //
    //   1. `mn_cy`（蒙古语，来自 lingva 的枚举）**不在本表**，故回退 `tl=en`，
    //      请求成功返回音频 —— 用户选蒙古语却听到**英文发音**，界面上没有任何提示。
    //      实测 tl=mn / mn-Cyrl / mn-MN 均为 HTTP 400，即 Google 确实不支持，回退是
    //      当前唯一可行选择，但它是「静默错误」而非「报错」。
    //   2. `fa`（波斯语）**在本表**、代码正确（`fa` 就是 Google 的波斯语代码），
    //      但 Google 的 translate_tts 端点对 `tl=fa` **稳定返回 HTTP 400**
    //      —— 实测 referer / client=tw-ob|gtx|t 四种组合全为 400，且连试两次一致；
    //      同一端点 tl=en / zh-CN 均 200，故不是网络或参数问题。
    //      （对照：Google 的**翻译**端点 tl=fa 正常返回「سلام」，说明是 TTS 端点的
    //      语言覆盖问题，与本项目无关。）此时会抛
    //      `Google TTS request failed: HTTP 400`，用户看到明确的失败提示。
    //      本表**不再**收录所谓「唯一不支持」的说法 —— 那种表述已两次被实测推翻。
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
        nn_no: 'no', // 书面语 nb 与新挪威语 nn 共用 Google 的 'no'，与 lingva 的映射一致
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
