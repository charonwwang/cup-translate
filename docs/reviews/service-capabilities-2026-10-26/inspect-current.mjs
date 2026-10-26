// Read-only audit of current source. Does not load or execute third-party plugins.
// Run from the repository root; output describes observations, not passing acceptance tests.
import { readFile } from 'node:fs/promises';
import { validPluginName } from '../../../src/utils/plugin_validation.js';
import { createAnkiClient } from '../../../src/services/collection/anki/client.js';
import { collectAnki } from '../../../src/services/collection/anki/collect.js';
import { classifySourceText } from '../../../src/window/Translate/resultView.js';

const read = (path) => readFile(path, 'utf8');
const upstreamIds = ['plugin.com.pot-app.lingva_tts', 'plugin.com.pot-app.ecdict', 'plugin.com.pot-app.anki'];
const requests = [];
const requestAnki = createAnkiClient(async (_url, options) => {
    requests.push(options.body.action);
    return { ok: true, status: 200, data: { result: null, error: 'controlled business error' } };
});
let rejected = false;
try {
    await collectAnki(requestAnki, 'audit', '释义');
} catch {
    rejected = true;
}
console.log(
    JSON.stringify(
        {
            upstreamPluginNames: upstreamIds.map((id) => ({ id, accepted: validPluginName(id) })),
            ankiBusinessError: { requests, rejected },
            sourceClassification: [
                ['hello', 'en'],
                ['卸载向导', 'zh_cn'],
                ['uninstall wizard', 'en'],
            ].map(([text, language]) => ({
                text,
                language,
                mode: classifySourceText(text, language),
            })),
            qwenConfigEmbedsModalOwner: (await read('src/services/tts/qwen_tts/Config.jsx')).includes('<QwenSpeech'),
            qwenCloseButtonSaves: (await read('src/window/Config/pages/Models/QwenSpeech.jsx')).includes(
                'onPress={installed && !running ? save : onClose}'
            ),
        },
        null,
        2
    )
);
