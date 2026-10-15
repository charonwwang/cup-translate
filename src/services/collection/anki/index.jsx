import { fetchWithTimeout as fetch, Body } from '../../../utils/fetchWithTimeout';
import { store } from '../../../utils/store';
import { resolveAnkiPort } from './port';

export async function collection(source, target, options = {}) {
    const { config } = options;

    let ankiConfig = (await store.get('anki')) ?? {};
    if (config !== undefined) {
        ankiConfig = config;
    }
    // 用 resolveAnkiPort 而不是 `?? 8765`：`??` 只挡 null/undefined，
    // 用户清空输入框得到的空串会穿过去，拼出 `http://127.0.0.1:`（详见 port.js）。
    const port = resolveAnkiPort(ankiConfig['port']);

    async function ankiConnect(action, version, params = {}) {
        let res = await fetch(`http://127.0.0.1:${port}`, {
            method: 'POST',
            body: Body.json({ action, version, params }),
        });
        if (!res.ok) {
            throw `Anki Connect Failed: HTTP ${res.status}`;
        }
        return res.data;
    }

    function ankiText(target) {
        let result = '';
        if (typeof target === 'object') {
            for (let explanation of target.explanations) {
                result += explanation.trait + '. ';
                let index = 0;
                for (let explain of explanation.explains) {
                    index++;
                    if (index !== explanation.explains.length) {
                        result += explain + '; ';
                    } else {
                        result += explain + '<br>';
                    }
                }
            }
        } else {
            return target;
        }

        return result;
    }

    function ankiPronunciation(target) {
        let results = [];
        if (typeof target !== 'object' || target.pronunciations === undefined) {
            return results;
        }
        for (let i = 0; i < target.pronunciations.length; i++) {
            let pronunciation = target.pronunciations[i];

            let region = pronunciation.region;
            let symbol = pronunciation.symbol;

            // make pronunciation symbol readable
            region = region ? `[${region}]` : '';
            // symbol 可能是 undefined（第三方插件/上游引擎只给了 region 或只给了音标），
            // `symbol[0]` 会抛 `TypeError: Cannot read properties of undefined
            // (reading '0')`，让整次「添加到生词本」失败。缺失时退化成空字符串。
            symbol = typeof symbol === 'string' && symbol.startsWith('/') ? symbol : `/${symbol ?? ''}/`;
            let regionSymbol = `${region} ${symbol}`;

            let audio;
            // AnkiConnect 的契约（API_LEGACY.md）：
            //   "Each object needs filename and a nonempty data, path, or url."
            // 即 audio 数组里的**每一项都必须是对象**。没有语音时必须
            // **不产出这一项**，而不是产出一个 undefined 再被 JSON.stringify
            // 变成 null —— 数组里的 undefined 不会被省略（只有对象属性才会），
            // 所以会真的发出 `"audio":[null]`，Anki 侧报错导致整条卡片加不进去。
            // google/bing_dict 恒设 voice: ''，正好命中这条。
            //
            // 另外 voice 只接受**字节数组**（引擎用 responseType: 3 取回）。
            // cambridge_dict 在音频下载失败时会**保留 URL 字符串**，
            // 此时 String.fromCharCode(...urlString) 不会抛错，而是把
            // URL 文本本身 base64 后当成 mp3 发给 Anki —— 音频是坏的。
            // 所以这里要求 voice 必须是数组，否则视为没有语音。
            if (Array.isArray(pronunciation.voice) && pronunciation.voice.length > 0) {
                // step1: convert number array to Char String
                // step2: convert Char String to base64
                // 分块拼接而不是展开：String.fromCharCode(...bigArray) 在参数很多时
                // 会抛 `RangeError: Maximum call stack size exceeded`
                // （实测 50 万元素即触发），而一整段语音可能到这个量级。
                let voiceString = '';
                const CHUNK = 0x8000;
                for (let offset = 0; offset < pronunciation.voice.length; offset += CHUNK) {
                    voiceString += String.fromCharCode(...pronunciation.voice.slice(offset, offset + CHUNK));
                }
                let voice = btoa(voiceString);

                let filename = `${region}_${source}.mp3`;
                let fields = [`Voice${i + 1}`];

                audio = { data: voice, filename, fields };
            }
            results.push({ regionSymbol, audio });
        }
        return results;
    }

    await ankiConnect('createDeck', 6, { deck: 'cup-translate' });

    await ankiConnect('createModel', 6, {
        modelName: 'cup-translate Card',
        inOrderFields: ['Front', 'Back', 'Symbol1', 'Voice1', 'Symbol2', 'Voice2'],
        isCloze: false,
        cardTemplates: [
            {
                Name: 'cup-translate Card',
                Front: '{{Front}}',
                Back: '{{FrontSide}}<br>{{Symbol1}} {{Voice1}}<br>{{Symbol2}} {{Voice2}}<hr id=answer>{{Back}}',
            },
        ],
    });

    let pronunciations = ankiPronunciation(target);
    await ankiConnect('addNote', 6, {
        note: {
            deckName: 'cup-translate',
            modelName: 'cup-translate Card',
            fields: {
                Front: source,
                Back: ankiText(target),
                Symbol1: pronunciations[0] && pronunciations[0].regionSymbol,
                Symbol2: pronunciations[1] && pronunciations[1].regionSymbol,
            },
            // 过滤掉没有语音的项：AnkiConnect 要求 audio 数组里每项都是
            // {data, filename, fields} 对象，`[null]` 会让 addNote 报错。
            // 没有任何语音时传空数组（空数组是合法的，null 项不是）。
            audio: pronunciations.map((pronunciation) => pronunciation.audio).filter(Boolean),
        },
    });
}

export * from './Config';
export * from './info';
