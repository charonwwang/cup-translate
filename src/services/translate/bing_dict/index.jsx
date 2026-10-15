import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
const DISPLAY_FORMAT_DEFAULT = '发音, 快速释义, 变形';

export async function translate(text, from, to) {
    if (from == 'auto') {
        if (/^[\u4e00-\u9fff]/.test(text)) {
            from = 'zh-cn';
        } else if (/^[A-Za-z]/.test(text)) {
            from = 'en-us';
        }
    }
    if (from == to) {
        return text;
    }
    // only supports word translation
    // if (text.split(/[\s,，]/).length > 1) {
    //     return '';
    // }

    const res = await fetch(
        `https://www.bing.com/api/v6/dictionarywords/search?q=${text}&appid=371E7B2AF0F9B84EC491D731DF90A55719C7D209&mkt=zh-cn&pname=bingdict`
    );
    if (res.ok) {
        const result = res.data;
        // 必须先确认 value[0] 存在再取 meaningGroups：
        // 服务端在查不到词等情况下会回 **HTTP 200 + 没有 value（或 value 为空）** 的响应体，
        // 此时 `result.value[0]` 会先抛
        // `TypeError: Cannot read properties of undefined (reading '0')`，
        // 把下面那句本意要给的「Words not yet included」友好提示顶掉。
        // 实测三种形态：无 value / value: [] / value: null 全都崩在这里。
        const meaningGroups = result.value?.[0]?.meaningGroups;
        if (!Array.isArray(meaningGroups) || meaningGroups.length === 0) {
            throw `Words not yet included: ${text}`;
        }
        const formats = DISPLAY_FORMAT_DEFAULT.trim().split(/,\s*/);
        const formatGroups = meaningGroups.reduce(
            (acc, cur) => {
                const group = acc[cur.partsOfSpeech?.[0]?.description || cur.partsOfSpeech?.[0]?.name];
                if (Array.isArray(group)) {
                    group.push(cur);
                }
                return acc;
            },
            formats.reduce((acc, cur) => {
                acc[cur] = [];
                return acc;
            }, {})
        );
        let target = { pronunciations: [], explanations: [], associations: [], sentence: [] };
        // 下面几处都改成可选链：字典接口的深层字段（richDefinitions / fragments 等）
        // 并非每条词条都齐全，缺字段时应当**跳过该条**而不是让整次查询崩掉——
        // 用户看到的是「查不到」，比一个内建 TypeError 有用得多。
        for (const pronunciation of formatGroups['发音']) {
            const symbol = pronunciation.meanings?.[0]?.richDefinitions?.[0]?.fragments?.[0]?.text;
            const region = pronunciation.partsOfSpeech?.[0]?.name;
            if (typeof symbol !== 'string' || typeof region !== 'string') {
                continue;
            }
            target.pronunciations.push({ region, symbol, voice: '' });
        }
        for (const explanation of formatGroups['快速释义']) {
            const trait = explanation.partsOfSpeech?.[0]?.name;
            const fragments = explanation.meanings?.[0]?.richDefinitions?.[0]?.fragments;
            if (typeof trait !== 'string' || !Array.isArray(fragments)) {
                continue;
            }
            target.explanations.push({
                trait,
                explains: fragments.map((x) => x.text),
            });
        }
        const inflections = formatGroups['变形'][0]?.meanings?.[0]?.richDefinitions?.[0]?.fragments;
        if (Array.isArray(inflections)) {
            for (const association of inflections) {
                target.associations.push(association.text);
            }
        }
        return target;
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './Config';
export * from './info';
