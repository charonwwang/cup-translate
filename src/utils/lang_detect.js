import { fetchWithTimeout as fetch, Body } from './fetchWithTimeout';
import { invoke } from '@tauri-apps/api';
import { store } from './store';
import { v4 as uuidv4 } from 'uuid';
import { error as logError } from 'tauri-plugin-log-api';

// https://fanyi-api.baidu.com/product/113
async function baidu_detect(text) {
    const lang_map = {
        zh: 'zh_cn',
        cht: 'zh_tw',
        en: 'en',
        jp: 'ja',
        kor: 'ko',
        fra: 'fr',
        spa: 'es',
        ru: 'ru',
        de: 'de',
        it: 'it',
        tr: 'tr',
        pt: 'pt_pt',
        vie: 'vi',
        id: 'id',
        th: 'th',
        may: 'ms',
        ar: 'ar',
        hi: 'hi',
        nob: 'nb_no',
        nno: 'nn_no',
        per: 'fa',
        ukr: 'uk',
    };
    let res = await fetch('https://fanyi.baidu.com/langdetect', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: Body.form({
            query: text,
        }),
    });
    if (res.ok) {
        let result = res.data;
        if (result.lan && result.lan in lang_map) {
            return lang_map[result.lan];
        }
    }
    return 'en';
}
// 腾讯只支持这么多语言
// https://cloud.tencent.com/document/product/551/15619
async function tencent_detect(text) {
    const lang_map = {
        zh: 'zh_cn',
        en: 'en',
        ja: 'ja',
        ko: 'ko',
        fr: 'fr',
        es: 'es',
        ru: 'ru',
        de: 'de',
        it: 'it',
        tr: 'tr',
        pt: 'pt_pt',
        vi: 'vi',
        id: 'id',
        th: 'th',
        ms: 'ms',
        ar: 'ar',
        hi: 'hi',
    };
    let res = await fetch('https://fanyi.qq.com/api/translate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: Body.form({
            sourceText: text,
        }),
    });
    if (res.ok) {
        let result = res.data;
        if (result.translate && result.translate.source && result.translate.source in lang_map) {
            return lang_map[result.translate.source];
        }
    }
    return 'en';
}
// https://cloud.google.com/translate/docs/languages?hl=zh-cn
async function google_detect(text) {
    const lang_map = {
        'zh-CN': 'zh_cn',
        'zh-TW': 'zh_tw',
        ja: 'ja',
        en: 'en',
        ko: 'ko',
        fr: 'fr',
        es: 'es',
        ru: 'ru',
        de: 'de',
        it: 'it',
        tr: 'tr',
        pt: 'pt_pt',
        vi: 'vi',
        id: 'id',
        th: 'th',
        ms: 'ms',
        ar: 'ar',
        hi: 'hi',
        mn: 'mn_cy',
        km: 'km',
        fa: 'fa',
        no: 'nb_no',
        uk: 'uk',
    };
    let res = await fetch(
        `https://translate.google.com/translate_a/single?dt=at&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=t`,
        {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
            query: {
                client: 'gtx',
                sl: 'auto',
                tl: 'zh-CN',
                hl: 'zh-CN',
                ie: 'UTF-8',
                oe: 'UTF-8',
                otf: '1',
                ssel: '0',
                tsel: '0',
                kc: '7',
                q: text,
            },
        }
    );
    if (res.ok) {
        const result = res.data;
        if (result[2] && result[2] in lang_map) {
            return lang_map[result[2]];
        }
    }
    return 'en';
}
// https://niutrans.com/documents/contents/trans_text#languageList
async function niutrans_detect(text) {
    const lang_map = {
        zh: 'zh_cn',
        cht: 'zh_cn',
        en: 'en',
        ja: 'ja',
        ko: 'ko',
        fr: 'fr',
        es: 'es',
        ru: 'ru',
        de: 'de',
        it: 'it',
        tr: 'tr',
        pt: 'pt_pt',
        vi: 'vi',
        id: 'id',
        th: 'th',
        ms: 'ms',
        ar: 'ar',
        hi: 'hi',
        mn: 'mn_cy',
        mo: 'mn_mo',
        km: 'km',
        nb: 'nb_no',
        nn: 'nn_no',
        fa: 'fa',
        uk: 'uk',
    };
    let res = await fetch('https://test.niutrans.com/NiuTransServer/language', {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        query: {
            src_text: text,
            source: 'text',
            time: new String(new Date().getTime()),
        },
    });
    if (res.ok) {
        const result = res.data;
        if (result['language'] && result['language'] in lang_map) {
            return lang_map[result['language']];
        }
    }
    return 'en';
}
// https://yandex.com/dev/translate/doc/en/concepts/api-overview
async function yandex_detect(text) {
    const lang_map = {
        zh: 'zh_cn',
        en: 'en',
        ja: 'ja',
        ko: 'ko',
        fr: 'fr',
        es: 'es',
        ru: 'ru',
        de: 'de',
        it: 'it',
        tr: 'tr',
        pt: 'pt_pt',
        vi: 'vi',
        id: 'id',
        th: 'th',
        ms: 'ms',
        ar: 'ar',
        hi: 'hi',
        no: 'nb_no',
        fa: 'fa',
        uk: 'uk',
    };

    let res = await fetch('https://translate.yandex.net/api/v1/tr.json/detect', {
        method: 'GET',
        query: {
            id: uuidv4().replaceAll('-', '') + '-0-0',
            srv: 'android',
            text: text,
        },
    });
    if (res.ok) {
        const result = res.data;
        if (result['lang'] && result['lang'] in lang_map) {
            return lang_map[result['lang']];
        }
    }
    return 'en';
}
// 原先此处有 `bing_detect`，已于本轮**删除**。
//
// 依据（与 `translate/bing` 的处置完全同源）：
//   · `bing_detect` 的第一步是取 token：`https://edge.microsoft.com/translate/auth`
//   · 该端点**实测返回 HTTP 404**（2026-10，带完整 Edge UA 复测仍 404）
//   · 已删除的 `src/services/translate/bing/index.jsx`（见提交 a4d58de）
//     用的**正是同一个端点**，当时判定为「上游全死且无自建入口」而移除
//   · 即检测侧留下的是同一条死链路，属漏网
//
// 危害不只是「多一次失败请求」：`token.ok` 为 false 时该函数**静默落到末尾
// 的 `return 'en'`**，于是中文被判定为英文 —— 界面上会显示「英语」语言标签
// （SourceArea 的 detectLanguage chip），并把错误的源语言传给翻译引擎。
// 已用受控执行复现：喂 "你好世界" 得到 'en'。
//
// 因此删除比保留更诚实：用户不会再选到一个必然误判的引擎，
// 老配置里残留的 'bing' 会落到 `detect()` 的 default 分支改走本地检测
// （离线、零配置），行为优于原先的静默退化。

async function local_detect(text) {
    return await invoke('lang_detect', { text: text });
}

/**
 * 检测文本语言，**保证 resolve 成一个语言码、永不 reject**。
 *
 * 各引擎末尾的 `return 'en'` 只兜住「响应格式异常」，兜不住「抛出的异常」：
 *   · `store.get('translate_detect_engine')` 读取失败会 reject
 *   · local 引擎走 invoke('lang_detect')，Rust 侧出错即 reject
 *   · baidu/google/tencent/niutrans/yandex 是网络请求，离线必 reject
 *     （`bing` 检测已删除，见文件上方说明 —— 它的死端点甚至走不到「reject」，
 *      而是静默返回 'en'，比 reject 更隐蔽）
 *
 * 调用方（SourceArea 的动态翻译）只在 .then 里做后续同步，
 * 一旦这里 reject，后续同步就被静默跳过 —— 表现为翻译结果停留在上一段文本。
 * 所以入口处统一兜底：检测失败退化为 'en'，与各引擎既有的兜底语义一致。
 */
export default async function detect(text) {
    try {
        // 默认走本地（lingua）检测：零网络、零隐私风险、零配置
        let langDetectEngine = (await store.get('translate_detect_engine')) ?? 'local';

        switch (langDetectEngine) {
            case 'baidu':
                return await baidu_detect(text);
            case 'google':
                return await google_detect(text);
            case 'local':
                return await local_detect(text);
            case 'tencent':
                return await tencent_detect(text);
            case 'niutrans':
                return await niutrans_detect(text);
            case 'yandex':
                return await yandex_detect(text);
            // `bing` 检测已移除（见下方 bing_detect 处的说明）。
            // 老配置里若仍存着 'bing'，会落到 default -> local_detect，
            // 行为**优于**原先的「静默退化为 en」，因此这里不需要特判迁移。
            default:
                return await local_detect(text);
        }
    } catch (error) {
        // 语言检测失败不应阻断翻译流程：退化为英文（与各引擎的既有兜底一致），
        // 但要留下日志，避免问题被完全静默。
        logError(`Language detection failed, falling back to 'en': ${error}`);
        return 'en';
    }
}
