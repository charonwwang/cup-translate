// Read-only audit of current source. Does not load or execute third-party plugins.
// Run from the repository root; output describes observations, not passing acceptance tests.
import { readFile } from 'node:fs/promises';
import { validPluginName } from '../../../src/utils/plugin_validation.js';
import { resolveAnkiPort } from '../../../src/services/collection/anki/port.js';
import { classifySourceText } from '../../../src/window/Translate/resultView.js';

const read = (path) => readFile(path, 'utf8');
const upstreamIds = [
    'plugin.com.pot-app.lingva_tts',
    'plugin.com.pot-app.ecdict',
    'plugin.com.pot-app.anki',
];
const raw = await read('src/services/collection/anki/index.jsx');
const executable = raw
    .replace(/^import .*;\n/gm, '')
    .replace('export async function collection', 'async function collection')
    .replace(/^export \* from .*;\n?/gm, '');
const requests = [];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const invokeCollection = new AsyncFunction(
    'fetch', 'Body', 'store', 'resolveAnkiPort',
    `${executable}\nreturn collection('audit', '释义', {config:{port:8765}});`
);
let rejected = false;
try {
    await invokeCollection(
        async (_url, options) => {
            requests.push(options.body.action);
            return { ok: true, data: { result: null, error: 'controlled business error' } };
        },
        { json: (value) => value },
        { get: async () => ({}) },
        resolveAnkiPort
    );
} catch {
    rejected = true;
}
console.log(JSON.stringify({
    upstreamPluginNames: upstreamIds.map((id) => ({ id, accepted: validPluginName(id) })),
    ankiBusinessError: { requests, rejected },
    sourceClassification: ['hello', '卸载向导', 'uninstall wizard'].map((text) => ({
        text, mode: classifySourceText(text),
    })),
    qwenConfigEmbedsModalOwner: (await read('src/services/tts/qwen_tts/Config.jsx')).includes('<QwenSpeech'),
    qwenCloseButtonSaves: (await read('src/window/Config/pages/Models/QwenSpeech.jsx'))
        .includes('onPress={installed && !running ? save : onClose}'),
}, null, 2));
