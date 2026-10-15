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
            symbol = symbol[0] === '/' ? symbol : `/${symbol}/`;
            let regionSymbol = `${region} ${symbol}`;

            let audio;
            if (pronunciation.voice) {
                // step1: convert number array to Char String
                // step2: convert Char String to base64
                let voiceString = String.fromCharCode(...pronunciation.voice);
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
            audio: pronunciations.map((pronunciation) => {
                return pronunciation.audio;
            }),
        },
    });
}

export * from './Config';
export * from './info';
