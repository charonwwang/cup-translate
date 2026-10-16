import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';

// Google 翻译端点：gtx 客户端会被限流（429），多端点 + User-Agent 伪装 + 长退避
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

async function tryTranslate(customUrl, text, from, to) {
    return await fetch(`${customUrl}/translate_a/single?dt=at&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=t`, {
        method: 'GET',
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

// 429/异常后的指数退避：2s / 4s / 8s / 16s。
// 注意：这只应在**后面还有重试**时等待。旧实现放在循环体末尾无条件等待，
// 最后一次尝试也会先睡 32 秒再抛错——那 32 秒占全部等待（约 62s）的一半以上，
// 且明知不会再有重试，纯粹让用户多等。
const MAX_ATTEMPTS = 5;
const backoffMs = (attempt) => 2000 * Math.pow(2, Math.min(attempt, 4));

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

export async function translate(text, from, to, options = {}) {
    const { config } = options;

    let { custom_url } = config;

    if (custom_url === undefined || custom_url === '') {
        custom_url = ENDPOINTS[0];
    }
    if (!custom_url.startsWith('http')) {
        custom_url = 'https://' + custom_url;
    }

    // 多端点轮换 + 429 限流重试（最多 5 次，退避 2s/4s/8s/16s）
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
                for (let i of result[13][0]) {
                    target.sentence.push({ source: i[0] });
                }
            }
            return target;
        } else {
            // 翻译模式
            let target = '';
            for (let r of result[0]) {
                if (r[0]) {
                    target = target + r[0];
                }
            }
            return target.trim();
        }
    }
}

export * from './Config';
export * from './info';
