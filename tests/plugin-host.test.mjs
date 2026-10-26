import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { validPluginName, validPluginType } from '../src/utils/plugin_validation.js';
import { getServiceSouceType, createServiceInstanceKey, getServiceName } from '../src/utils/service_instance_core.js';
import { assertPolicy } from '../src/utils/requestPolicy.js';

const fixtures = 'tests/fixtures/plugins';
async function host(folder, type, name, overrides = {}) {
    const source = (await readFile('src/utils/invoke_plugin.js', 'utf8'))
        .replace(/^import .*$/gm, '')
        .replace(/^export\s+/gm, '');
    let mode = 'online';
    const calls = [];
    const deps = {
        validPluginName,
        validPluginType,
        checkPolicy: async (kind, id) => assertPolicy(mode, kind, id),
        appConfigDir: async () => '/config',
        appCacheDir: async () => '/cache',
        join: async (...parts) => path.posix.join(...parts),
        readTextFile: async () => {
            throw new Error('unvalidated read');
        },
        readBinaryFile: async () => new Uint8Array(),
        Database: {},
        CryptoJS: {},
        osType: 'Darwin',
        invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === 'load_plugin') return readFile(`${folder}/main.js`, 'utf8');
            if (command === 'run_binary') return { status: 0, stdout: args.args.join('\n'), stderr: '' };
            throw new Error(`Unexpected command ${command}`);
        },
        http: {
            fetch: async () => {
                throw new Error('External HTTP forbidden in fixture tests');
            },
        },
        ...overrides,
    };
    const invokePlugin = new Function(...Object.keys(deps), `${source}; return invoke_plugin;`)(...Object.values(deps));
    const [entry, utils] = await invokePlugin(type, name);
    return {
        entry,
        utils,
        calls,
        setMode: (next) => {
            mode = next;
        },
    };
}

for (const kind of ['translate', 'tts', 'recognize', 'collection']) {
    test(`real host invokes deterministic ${kind} entry with saved instance config`, async () => {
        const folder = `${fixtures}/deterministic/${kind}`;
        const info = JSON.parse(await readFile(`${folder}/info.json`, 'utf8'));
        const key = createServiceInstanceKey(info.id);
        assert.equal(getServiceSouceType(key), 'plugin');
        assert.equal(getServiceName(key), info.id);
        // Simulate a persisted/reloaded instance without replacing service-key semantics.
        const saved = JSON.parse(JSON.stringify({ [key]: { prefix: 'saved' } }));
        const runtime = await host(folder, kind, getServiceName(key));
        const options = { config: saved[key], utils: runtime.utils };
        if (kind === 'translate') assert.equal(await runtime.entry('hello', 'en', 'zh', options), 'saved:en:zh:hello');
        if (kind === 'tts')
            assert.equal(
                new TextDecoder().decode(Uint8Array.from(await runtime.entry('hello', 'en', options))),
                'saved:en:hello'
            );
        if (kind === 'recognize') assert.equal(await runtime.entry([1, 2], 'en', options), 'saved:en:2');
        if (kind === 'collection') {
            assert.equal((await runtime.entry('hello', '你好', options)).stdout, 'saved\nhello\n你好');
            assert.deepEqual(runtime.calls.at(-1).args, {
                pluginType: kind,
                pluginName: info.id,
                cmdName: 'bin/record',
                args: ['saved', 'hello', '你好'],
            });
        }
        runtime.setMode('device_only');
        await assert.rejects(() => runtime.entry('hello', 'en', options), /device-only/);
    });
}

test('pinned upstream Lingva host call uses controlled HTTP; returns audio bytes', async () => {
    const requests = [];
    const runtime = await host(
        `${fixtures}/upstream/pot-app-tts-plugin-template`,
        'tts',
        'plugin.com.pot-app.lingva_tts',
        {
            http: {
                fetch: async (url) => {
                    requests.push(url);
                    return { ok: true, data: { audio: [82, 73, 70, 70] } };
                },
            },
        }
    );
    assert.deepEqual(
        await runtime.entry('hello world', 'en', {
            config: { requestPath: 'https://fixture.invalid' },
            utils: runtime.utils,
        }),
        [82, 73, 70, 70]
    );
    assert.deepEqual(requests, ['https://fixture.invalid/api/v1/audio/en/hello%20world']);
});

test('pinned ECDICT parser uses controlled SQL rows; does not claim dataset validation', async () => {
    const calls = [];
    const runtime = await host(
        `${fixtures}/upstream/pot-app-translate-plugin-ecdict`,
        'translate',
        'plugin.com.pot-app.ecdict',
        {
            Database: {
                load: async (url) => {
                    calls.push(url);
                    return {
                        select: async (query, params) => {
                            calls.push({ query, params });
                            return [{ phonetic: 'həˈləʊ', translation: 'int. 你好', tag: '', exchange: '' }];
                        },
                        close: async () => calls.push('closed'),
                    };
                },
            },
        }
    );
    const result = await runtime.entry('hello', 'en', 'zh', { utils: runtime.utils });
    assert.equal(result.pronunciations[0].symbol, '/həˈləʊ/');
    assert.deepEqual(calls[1].params, ['hello']);
    assert.equal(calls[0], 'sqlite:plugins/translate/plugin.com.pot-app.ecdict/stardict.db');
    assert.equal(calls.at(-1), 'closed');
});

test('pinned Anki template is explicitly incompatible: undefined Body before HTTP', async () => {
    let requests = 0;
    const runtime = await host(
        `${fixtures}/upstream/pot-app-collection-plugin-template`,
        'collection',
        'plugin.com.pot-app.anki',
        {
            http: {
                fetch: async () => {
                    requests++;
                    return { data: {} };
                },
            },
        }
    );
    await assert.rejects(
        () => runtime.entry('hello', '你好', { config: {}, utils: runtime.utils }),
        /Body is not defined/
    );
    assert.equal(requests, 0);
});

test('source and package checksums match the compatibility evidence', async () => {
    const digest = async (file) =>
        createHash('sha256')
            .update(await readFile(file))
            .digest('hex');
    const sources = JSON.parse(await readFile(`${fixtures}/upstream/sources.json`, 'utf8'));
    for (const source of sources) {
        const repo = source.repository.split('/').at(-1);
        assert.match(source.commit, /^[a-f0-9]{40}$/);
        for (const file of source.files)
            assert.equal(await digest(`${fixtures}/upstream/${repo}/${file.path}`), file.sha256);
    }
    for (const pkg of JSON.parse(await readFile(`${fixtures}/packages.json`, 'utf8'))) {
        assert.equal(await digest(`${fixtures}/packages/${pkg.package}`), pkg.sha256);
        assert.equal(validPluginName(pkg.id), true);
    }
});
