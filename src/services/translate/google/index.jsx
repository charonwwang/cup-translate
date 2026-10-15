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
    return await fetch(
        `${customUrl}/translate_a/single?dt=at&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=t`,
        {
            method: 'GET',
            headers: {
                'content-type': 'application/json',
                'User-Agent': BROWSER_UA,
                'Referer': 'https://translate.google.com/',
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
        }
    );
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function translate(text, from, to, options = {}) {
    const { config } = options;

    let { custom_url } = config;

    if (custom_url === undefined || custom_url === '') {
        custom_url = ENDPOINTS[0];
    }
    if (!custom_url.startsWith('http')) {
        custom_url = 'https://' + custom_url;
    }

    // 多端点轮换 + 429 限流重试（最多 5 次，退避 2s/4s/8s/16s/32s）
    const urls = custom_url !== ENDPOINTS[0] ? [custom_url, ...ENDPOINTS] : ENDPOINTS;
    let res = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 5; attempt++) {
        const url = urls[attempt % urls.length];
        try {
            res = await tryTranslate(url, text, from, to);
            if (res.ok) break;
            lastErr = `HTTP ${res.status}`;
            if (res.status === 429) {
                // 429 限流：指数退避后重试
                await sleep(2000 * Math.pow(2, Math.min(attempt, 4)));
                continue;
            }
            break;
        } catch (e) {
            lastErr = String(e);
            await sleep(2000 * Math.pow(2, Math.min(attempt, 4)));
        }
    }

    if (!res || !res.ok) {
        throw `Google 翻译请求失败\n${lastErr}\n\n提示：429 = 请求频率受限，请稍后再试或在设置中配置自定义翻译服务`;
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
