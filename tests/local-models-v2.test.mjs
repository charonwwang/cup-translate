import { wordDetailsPrompt, parseWordDetails } from '../src/utils/wordDetails.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    parseGlossary,
    previewGlossary,
    commitGlossary,
    matchGlossary,
    checkGlossary,
    glossaryHint,
    persistGlossary,
} from '../src/utils/glossary.js';
import { serviceEligibility } from '../src/utils/serviceEligibility.js';
import { assertPolicy, RequestScope } from '../src/utils/requestPolicy.js';
import { connectionUrl } from '../src/utils/connection.js';
const json = (entries) =>
    JSON.stringify({
        schemaVersion: 2,
        id: 'library',
        name: 'Test',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        entries,
    });
const term = (source = 'memory leak', target = '内存泄漏', extra = {}) => ({ id: source, source, target, ...extra });
const library = (...entries) => ({ ...parseGlossary(json(entries), 'json'), enabled: true, revision: 3 });

test('privacy trusts application identities; loopback and plugin capability claims do not grant offline status', () => {
    for (const name of ['google', 'openai', 'ollama', 'plugin-offline', 'http://localhost:1234', 'local_mt@forged'])
        assert.throws(() => assertPolicy('device_only', 'translate', name));
    assert.doesNotThrow(() => assertPolicy('device_only', 'translate', 'local_mt'));
    assert.doesNotThrow(() => assertPolicy('device_only', 'recognize', 'system'));
    assert.throws(() => assertPolicy('device_only', 'recognize', 'tesseract'));
    assert.throws(() => assertPolicy('device_only', 'tts', 'google_tts'));
});
test('eligibility filters before execution and chooses the first eligible primary', () => {
    const provider = { Language: { auto: 'auto', en: 'en', zh_cn: 'zh' } };
    const keys = ['openai@missing', 'local_mt@a', 'google'];
    const status = { 'en-zh': { installed: false }, 'zh-en': { installed: true } };
    let effective = keys.filter((key) => !serviceEligibility(key, {}, 'en', 'zh_cn', 'standard', provider, status));
    assert.deepEqual(effective, ['google']);
    effective = keys.filter((key) => !serviceEligibility(key, {}, 'en', 'zh_cn', 'device_only', provider, status));
    assert.deepEqual(effective, []);
    assert.equal(serviceEligibility('local_mt', {}, 'zh_cn', 'en', 'device_only', provider, status), null);
    assert.equal(serviceEligibility('local_mt', {}, 'en', 'en', 'standard', provider, status), 'direction');
    assert.equal(serviceEligibility('google', { enable: 'false' }, 'en', 'zh_cn', 'standard', provider), 'disabled');
    assert.equal(
        serviceEligibility(
            'openai',
            { requestPath: 'https://example.org', secretRefs: { apiKey: 'cup:fake' } },
            'en',
            'zh_cn',
            'standard',
            provider
        ),
        null
    );
});
test('request snapshots cannot be mutated by caller and cancelled requests cannot commit', () => {
    const input = { config: { name: 'before' }, revision: 2 };
    const scope = new RequestScope(input);
    input.config.name = 'after';
    assert.equal(scope.snapshot.config.name, 'before');
    scope.cancel();
    assert.throws(() => scope.assertActive(), { name: 'AbortError' });
});
test('guard cancels transport and isolates streaming/final results on revision invalidation', async () => {
    const source = await readFile('src/utils/requestRuntime.js', 'utf8');
    const code = source.replace(/^import .*;\n/gm, '').replaceAll('export ', '');
    const { guardService, invalidateRequests } = new Function(
        'store',
        'assertPolicy',
        'RequestScope',
        `${code};return {guardService,invalidateRequests}`
    )({ get: async () => 'standard' }, assertPolicy, RequestScope);
    let finish,
        receivedSignal,
        updates = [];
    const provider = guardService('translate', 'openai', {
        translate: (_t, _f, _to, options) => {
            receivedSignal = options.signal;
            options.setResult('temporary');
            return new Promise((resolve) => {
                finish = () => {
                    options.setResult('stale');
                    resolve('stale');
                };
            });
        },
    });
    const promise = provider.translate('text', 'en', 'zh_cn', {
        config: {},
        setResult: (v) => updates.push(v),
        signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    invalidateRequests();
    assert.equal(receivedSignal.aborted, true);
    finish();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.deepEqual(updates, ['temporary']);
});
test('connection URLs handle /v1 and full endpoints exactly once, enforce TLS and reject URL secrets', () => {
    assert.equal(connectionUrl('http://localhost:1234/v1', 'openai'), 'http://localhost:1234/v1/chat/completions');
    assert.equal(
        connectionUrl('https://api.example.org/v1/chat/completions', 'openai'),
        'https://api.example.org/v1/chat/completions'
    );
    assert.equal(connectionUrl('http://localhost:11434/api/chat', 'ollama'), 'http://localhost:11434/api/chat');
    for (const value of ['http://example.org', 'https://key:secret@example.org', 'https://example.org?token=fake'])
        assert.throws(() => connectionUrl(value, 'openai'));
});
test('CSV BOM, embedded quotes/newlines, literal formulas, defaults and language normalization', () => {
    const csv =
        '\uFEFFsource,target,case_sensitive,comment\r\n"memory leak","内存泄漏",FALSE,"quote ""x""\nnext"\r\n=SUM(A1),literal,true,plain';
    const data = parseGlossary(csv, 'csv', { sourceLanguage: 'en', targetLanguage: 'zh-CN' });
    assert.equal(data.targetLanguage, 'zh_cn');
    assert.equal(data.entries[0].comment, 'quote "x"\nnext');
    assert.equal(data.entries[0].priority, 50);
    assert.equal(data.entries[1].source, '=SUM(A1)');
    assert.throws(
        () => parseGlossary('source,target\nx,y,z', 'csv', { sourceLanguage: 'en', targetLanguage: 'zh-CN' }),
        /row 2/
    );
    assert.throws(
        () => parseGlossary('source,target\n"x,y', 'csv', { sourceLanguage: 'en', targetLanguage: 'zh-CN' }),
        /unclosed/
    );
});
test('imports reject unknown versions, malformed booleans, priorities and bounded fields without mutation', () => {
    for (const change of [
        { schemaVersion: 9 },
        { entries: [term('x', 'y', { caseSensitive: 'false' })] },
        { entries: [term('x', 'y', { priority: 1.5 })] },
        { entries: [term('x', 'y', { priority: 1001 })] },
        { entries: [term('x'.repeat(513), 'y')] },
        { entries: [term('x', 'y', { comment: 'x'.repeat(4097) })] },
    ])
        assert.throws(() => parseGlossary(JSON.stringify({ ...JSON.parse(json([])), ...change }), 'json'));
    assert.throws(() => parseGlossary('x'.repeat(10 * 1024 * 1024 + 1), 'json'), /10 MB/);
    assert.throws(() => parseGlossary(json(Array(50001).fill(term())), 'json'), /50000/);
    assert.throws(
        () =>
            parseGlossary('source,target,case_sensitive\nx,y,1', 'csv', {
                sourceLanguage: 'en',
                targetLanguage: 'zh_cn',
            }),
        /Entry 1/
    );
});
test('legacy locked intention is preserved and never reported as hard constraint success', () => {
    const legacy = JSON.parse(json([term('x', '译', { mode: 'locked' })]));
    legacy.schemaVersion = 1;
    const data = { ...parseGlossary(JSON.stringify(legacy), 'json'), enabled: true };
    const matches = matchGlossary('x', 'en', 'zh_cn', data);
    const check = checkGlossary('other', matches)[0];
    assert.equal(check.unsupportedConstraint, true);
    assert.equal(check.status, 'missing');
    assert.equal(checkGlossary('译', matches)[0].status, 'present');
});
test('duplicates and contradictory IDs require explicit resolution; failed transaction preserves previous revision', () => {
    const current = library(term());
    const incoming = parseGlossary(json([term('x', 'a', { id: 'same' }), term('y', 'b', { id: 'same' })]), 'json');
    const preview = previewGlossary(current, incoming);
    assert.ok(preview.rows.some((r) => r.status === 'conflict'));
    const snapshot = JSON.stringify(current);
    assert.throws(() => commitGlossary(current, preview, 'merge'));
    assert.equal(JSON.stringify(current), snapshot);
    const update = parseGlossary(json([term('memory leak', '泄漏', { id: 'memory leak' })]), 'json');
    const next = commitGlossary(current, previewGlossary(current, update), 'merge');
    assert.equal(next.entries.length, 1);
    assert.equal(next.entries[0].target, '泄漏');
    assert.equal(next.entries[0].id, current.entries[0].id);
    assert.equal(next.revision, 4);
    assert.equal(commitGlossary(current, previewGlossary(current, update), 'skip').entries[0].target, '内存泄漏');
});
test('matching uses Unicode normalization, English boundaries, longest match, and protects code/URL/email', () => {
    const data = library(term(), term('leak', '泄漏'), term('CUP', '杯'));
    const hits = matchGlossary(
        'memory leaks memory leak `memory leak` ```memory leak``` https://a/memory-leak test@leak.org ＣＵＰ',
        'en',
        'zh-CN',
        data
    );
    assert.deepEqual(hits.map((h) => h.source).sort(), ['CUP', 'memory leak']);
    assert.deepEqual(matchGlossary('memory leak', 'zh_cn', 'en', data), []);
    assert.deepEqual(matchGlossary('memory leak', 'en', 'zh_cn', { ...data, enabled: false }), []);
});
test('equal-priority conflicting terms do not enter prompts; checks never replace raw text', () => {
    const data = library(term('request', '请求', { id: 'one' }), term('request', '申请', { id: 'two' }));
    const hits = matchGlossary('request', 'en', 'zh_cn', data);
    assert.equal(hits[0].conflict, true);
    assert.equal(glossaryHint(hits).message, null);
    assert.equal(checkGlossary('申请', hits)[0].status, 'conflict');
    const terms = matchGlossary('memory leak', 'en', 'zh_cn', library(term()));
    const raw = 'Some different translation';
    assert.equal(checkGlossary(raw, terms)[0].status, 'missing');
    assert.equal(raw, 'Some different translation');
});
test('prompt preferences include only matched entries, JSON data at user privilege, with explicit limits', () => {
    const hits = Array.from({ length: 40 }, (_, i) => ({ ...term(`term${i}`, `译${i}`), conflict: false }));
    const hint = glossaryHint(hits, 'formal');
    assert.equal(hint.truncated, true);
    assert.equal(hint.message.role, 'user');
    assert.equal(JSON.parse(hint.message.content.split('\n')[1]).terms.length, 32);
    const data = library(term(), term('unused', '未用'));
    const matched = matchGlossary('memory leak', 'en', 'zh_cn', data);
    assert.doesNotMatch(glossaryHint(matched).message.content, /unused/);
});

test('real OpenAI/Ollama adapters: mock HTTP, term hints, redirects, abort and strict zero-request gate', async () => {
    const { createServer } = await import('node:http');
    const requests = [];
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        if (req.url.startsWith('/redirect')) {
            res.writeHead(307, { Location: 'http://127.0.0.1:1/elsewhere' });
            res.end();
            return;
        }
        if (req.url.startsWith('/slow')) {
            req.on('close', () => res.destroy());
            return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/api/chat')) res.end(JSON.stringify({ message: { content: '关闭窗口' } }));
        else res.end(JSON.stringify({ choices: [{ message: { content: '关闭窗口' } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const previousWindow = globalThis.window;
    globalThis.window = { fetch: globalThis.fetch };
    let privacy = 'standard';
    const policy = async (kind, name) => assertPolicy(privacy, kind, name);
    const load = async (name) => {
        const source = await readFile(`src/services/translate/${name}/index.jsx`, 'utf8');
        const stripped = source
            .replace(/^import .*?;\n/gm, '')
            .replace(/^export \*.*?;\n/gm, '')
            .replaceAll('export ', '');
        return new Function(
            'connectionUrl',
            'checkPolicy',
            'resolveSecrets',
            'glossaryHint',
            'Language',
            'defaultRequestArguments',
            'wordDetailsPrompt',
            'parseWordDetails',
            `${stripped};return translate`
        )(
            connectionUrl,
            policy,
            async (value) => structuredClone(value),
            glossaryHint,
            { en: 'English' },
            '{}',
            wordDetailsPrompt,
            parseWordDetails
        );
    };
    try {
        const openai = await load('openai');
        const ollama = await load('ollama');
        const matched = matchGlossary('close the window', 'en', 'zh_cn', library(term('window', '窗口')));
        const config = {
            service: 'openai',
            requestPath: `${base}/v1`,
            model: 'fixture',
            apiKey: 'FAKE-TEST-ONLY',
            stream: false,
        };
        assert.equal(
            await openai('close the window', 'English', 'Chinese', { config, matches: matched, style: 'formal' }),
            '关闭窗口'
        );
        assert.equal(requests[0].url, '/v1/chat/completions');
        assert.equal(requests[0].headers.authorization, 'Bearer FAKE-TEST-ONLY');
        const preferences = requests[0].body.messages.at(-1);
        assert.equal(preferences.role, 'user');
        assert.match(preferences.content, /窗口/);
        assert.equal(
            await ollama('close the window', 'English', 'Chinese', {
                config: { requestPath: base, model: 'fixture', stream: false },
            }),
            '关闭窗口'
        );
        const before = requests.length;
        privacy = 'device_only';
        await assert.rejects(() => openai('private', 'English', 'Chinese', { config }), /device-only/);
        await assert.rejects(
            () => ollama('private', 'English', 'Chinese', { config: { requestPath: base, model: 'fixture' } }),
            /device-only/
        );
        assert.equal(requests.length, before);
        privacy = 'standard';
        await assert.rejects(() =>
            openai('text', 'English', 'Chinese', { config: { ...config, requestPath: `${base}/redirect` } })
        );
        const controller = new AbortController();
        const pending = openai('text', 'English', 'Chinese', {
            config: { ...config, requestPath: `${base}/slow` },
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(pending, { name: 'AbortError' });
    } finally {
        globalThis.window = previousWindow;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('glossary persistence failure rolls shared memory back as well as leaving disk unchanged', async () => {
    const previous = library(term());
    let memory = previous;
    let disk = previous;
    const store = {
        get: async () => memory,
        set: async (_key, value) => {
            memory = value;
        },
        save: async () => {
            throw new Error('disk full');
        },
    };
    await assert.rejects(() => persistGlossary(store, { ...previous, revision: 4, entries: [] }), /disk full/);
    assert.equal(memory, previous);
    assert.equal(disk, previous);
});
