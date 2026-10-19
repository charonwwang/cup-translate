import { createRequestCache } from '../../../utils/requestCache';
import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';

// Google 翻译端点：多镜像、限时请求与有上限的短退避。
// clients5.google.com + client=dict-chrome-ex 是 Google 翻译 Chrome 扩展使用的端点，
// 比 translate.google.com + client=gtx 更不容易被限流（429）
const ENDPOINTS = [
    'https://clients5.google.com',
    'https://translate.google.com',
    'https://translate.googleapis.com',
    'https://translate.google.com.hk',
];

const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 单词直译时 Google 仍会在 result[0][1][3] 返回音标，但没有走词典分支。
// 用一个很小的会话级缓存把音标带给 UI，避免为了显示音标再发一次请求。
const pronunciationCache = new Map();
function rememberPronunciation(text, from, to, symbol) {
    if (typeof symbol !== 'string' || !symbol.trim()) return;
    const key = `${from}|${to}|${text}`;
    pronunciationCache.delete(key);
    pronunciationCache.set(key, symbol.trim());
    if (pronunciationCache.size > 50) pronunciationCache.delete(pronunciationCache.keys().next().value);
}
function pronunciationFor(text, from, to) {
    return pronunciationCache.get(`${from}|${to}|${text}`) || '';
}

async function tryTranslate(customUrl, text, from, to) {
    return await fetch(`${customUrl}/translate_a/single?dt=at&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=t`, {
        method: 'GET',
        timeout: 6,
        headers: {
            'content-type': 'application/json',
            'User-Agent': BROWSER_UA,
            Referer: 'https://translate.google.com/',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        query: {
            client: 'dict-chrome-ex',
            sl: from,
            tl: to,
            hl: to,
            ie: 'UTF-8',
            oe: 'UTF-8',
            otf: '1',
            ssel: '0',
            tsel: '0',
            kc: '7',
            q: text,
        },
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// Total retry budget is bounded: at most 3 × 6 seconds plus 750ms backoff.
const MAX_ATTEMPTS = 3;
const backoffMs = (attempt) => 250 * Math.pow(2, Math.min(attempt, 2));

async function translateExamples(rawExamples, detected, to, options) {
    const examples = Array.isArray(rawExamples) ? rawExamples.slice(0, 4) : [];
    const translated = [];
    for (let i = 0; i < examples.length; i += 2) {
        const chunk = examples.slice(i, i + 2);
        translated.push(
            ...(await Promise.all(
                chunk.map(async (example) => {
                    const source = String(example[0] || '')
                        .replace(/<[^>]+>/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (!source) return '';
                    try {
                        const value = await requestTranslation(source, detected, to, options);
                        return typeof value === 'string' ? value.trim() : '';
                    } catch {
                        return '';
                    }
                })
            ))
        );
    }
    return examples.map((example, index) => ({
        source: example[0],
        target: translated[index] || '',
    }));
}

/**
 * 是否值得**换一个镜像**再试。
 *
 * 4xx 与 5xx 的语义完全不同，不能同等对待：
 *   · 4xx（400/401/403/404）＝ 请求本身有问题，换哪个镜像都一样，重试纯浪费
 *     —— 立即失败是对的（`translate-retry.test.mjs` 有一条断言守着这一点）；
 *   · 5xx（500/502/503/504）＝ 镜像端的**瞬时**故障，换一个镜像很可能直接成功。
 *
 * 本函数存在的原因：原先的分支只对 429 走 `continue`，其余（含全部 5xx）
 * 一律 `break`，于是 `ENDPOINTS` 那 4 个镜像**只对 429 生效**。
 * 而这条多镜像链路的意义恰恰是「某个镜像不可用时换下一个」——
 * 对 5xx 不轮换等于把这个兜底废掉一半。
 *
 * 严重性说明：这是**健壮性缺口**，未能证明已有用户因此受损
 * （本机实测 4 个镜像当下均返回 200，无法诱发 5xx）。
 * 改动保持最小：只把 5xx 从「立即放弃」挪到「换镜像重试」，4xx 行为不变。
 */
const isRetryableStatus = (status) => status === 429 || (status >= 500 && status <= 599);

async function requestTranslation(text, from, to, options = {}) {
    const { config = {} } = options;

    let { custom_url } = config;

    if (custom_url === undefined || custom_url === '') {
        custom_url = ENDPOINTS[0];
    }
    if (!custom_url.startsWith('http')) {
        custom_url = 'https://' + custom_url;
    }

    // 多端点轮换 + 短退避（最多 3 次，每次请求 6 秒，退避 250 / 500ms）
    const urls = custom_url !== ENDPOINTS[0] ? [custom_url, ...ENDPOINTS] : ENDPOINTS;
    let res = null;
    let lastErr = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const url = urls[attempt % urls.length];
        // 仅当后面还有重试时才退避等待
        const willRetry = attempt < MAX_ATTEMPTS - 1;
        try {
            res = await tryTranslate(url, text, from, to);
            if (res.ok) break;
            lastErr = `HTTP ${res.status}`;
            if (isRetryableStatus(res.status)) {
                // 429 限流 / 5xx 镜像故障：退避后换下一个镜像重试
                if (willRetry) {
                    await sleep(backoffMs(attempt));
                }
                continue;
            }
            break;
        } catch (e) {
            lastErr = String(e);
            if (willRetry) {
                await sleep(backoffMs(attempt));
            }
        }
    }

    if (!res || !res.ok) {
        // 服务层的错误文案统一用**英文**：全部 86 处 throw 里其余 85 处都是英文，
        // 只有这里（以及 local_mt / google_tts）是中文，属例外。
        // 服务层拿不到 `t`（不是 React 组件），而 i18next 的回退语言就是英文，
        // 所以「英文原文 + 关键诊断信息」是这个项目里正确的约定；
        // 需要本地化的用户可见文案放在 UI 层（见 TargetArea 的 language_not_supported）。
        throw `Google translate request failed\n${lastErr}\n\nHint: HTTP 429 = rate limited. Please retry later, or configure a custom translate endpoint in Settings.`;
    }

    {
        let result = res.data;
        // 词典模式
        if (result[1]) {
            let target = { pronunciations: [], explanations: [], associations: [], sentence: [] };
            // 发音
            if (result[0][1][3]) {
                target.pronunciations.push({ symbol: result[0][1][3], voice: '' });
            }
            // 释义
            for (let i of result[1]) {
                target.explanations.push({
                    trait: i[0],
                    explains: i[2].map((x) => {
                        return x[0];
                    }),
                });
            }
            // 例句
            if (result[13]) {
                const detected = result[2] || from;
                // Google 词典的 ex 通道只返回例句原文。用户查词时需要能对照目标语言，
                // 因此这里只为少量例句补一次翻译；失败时保留原文，不阻断整个词条。
                target.sentence = await translateExamples(result[13][0], detected, to, options);
            }
            return target;
        } else {
            // 翻译模式
            rememberPronunciation(text, from, to, result[0]?.[1]?.[3]);
            let target = '';
            for (let r of result[0]) {
                if (r[0]) {
                    target = target + r[0];
                }
            }
            target = target.trim();

            // 部分单词（例如 modality）不会返回 result[1] 词典分支，但可能仍带
            // 音标和 result[13] 例句。单字请求仍归一成词条对象，避免 UI 把同一个
            // 单词错误地渲染成短语结果，也避免丢掉已有例句。
            if (!/\s/.test(text.trim())) {
                const wordResult = { pronunciations: [], explanations: [], associations: [], sentence: [] };
                if (result[0]?.[1]?.[3]) {
                    wordResult.pronunciations.push({ symbol: result[0][1][3], voice: '' });
                }
                if (target) {
                    wordResult.explanations.push({ trait: '', explains: [target] });
                }
                if (result[13]) {
                    const detected = result[2] || from;
                    wordResult.sentence = await translateExamples(result[13][0], detected, to, options);
                }
                return wordResult;
            }
            return target.trim();
        }
    }
}

const cachedRequest = createRequestCache();

export async function translate(text, from, to, options = {}) {
    const key = JSON.stringify([text, from, to, options.config?.custom_url ?? '']);
    return cachedRequest(key, () => requestTranslation(text, from, to, options));
}
translate.pronunciationFor = pronunciationFor;

export * from './Config';
export * from './info';
