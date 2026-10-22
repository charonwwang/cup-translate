import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('all model families use the shared three-step installation indicator', async () => {
    for (const name of [
        'ModelCatalog',
        'QwenSpeech',
        'PiperVoices',
        'KokoroVoices',
        'NativeSpeechInstall',
        'ModelInstallDialog',
    ]) {
        const source = await readFile(`src/window/Config/pages/Models/${name}.jsx`, 'utf8');
        assert.match(source, /import ModelWizardSteps from '\.\/ModelWizardSteps'/, name);
        assert.match(source, /<ModelWizardSteps/, name);
    }
});

test('voice selection and advanced translation settings cannot directly download model weights', async () => {
    for (const path of [
        'src/window/Config/pages/Models/PiperVoices.jsx',
        'src/window/Config/pages/Models/KokoroVoices.jsx',
        'src/services/translate/local_mt/Config.jsx',
    ]) {
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(source, /invoke\('(piper_download|kokoro_download|local_mt_download_model)'/, path);
    }
    const source = await readFile('src/window/Config/pages/Models/NativeSpeechInstall.jsx', 'utf8');
    assert.match(source, /if \(step !== 3 \|\| !enough \|\| !accepted \|\| busy\) return/);
});
