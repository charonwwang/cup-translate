import { createCollectionTransport } from '../src/services/collection/transport.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createAnkiClient, testAnkiConnection } from '../src/services/collection/anki/client.js';
import { collectAnki } from '../src/services/collection/anki/collect.js';
import { ANKI_FIELDS, ANKI_DECK, ANKI_MODEL } from '../src/services/collection/anki/note.js';
import { createEudicClient } from '../src/services/collection/eudic/client.js';

// Real HTTP/JSON boundary, including non-JSON and transport failure, without external accounts.
async function fixture(t, handler) {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const call = { path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null, headers: req.headers };
        calls.push(call);
        const reply = handler(call, calls.length);
        if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay));
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(reply.raw ?? JSON.stringify(reply.data));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const port = server.address().port;
    const rawFetch = async (url, options) => {
        assert.equal(options.responseType, 2);
        const endpoint = new URL(url);
        // Route Eudic's fixed production origin to this controlled local fixture only in tests.
        if (endpoint.hostname === 'api.frdic.com') {
            endpoint.hostname = '127.0.0.1';
            endpoint.protocol = 'http:';
            endpoint.port = port;
        }
        for (const [key, value] of Object.entries(options.query ?? {})) endpoint.searchParams.set(key, value);
        const res = await fetch(endpoint, {
            method: options.method,
            headers: options.headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(Math.max(100, options.timeout * 1000)),
        });
        return { ok: res.ok, status: res.status, data: await res.text() };
    };
    const transport = createCollectionTransport(rawFetch, { json: (value) => value }, { Text: 2 });
    return { port, transport, calls };
}
const envelope = (result, error = null) => ({ data: { result, error } });
const errorCode = (code) => (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
};

test('A05: connection test only requests version and carries optional key', async (t) => {
    const f = await fixture(t, () => envelope(6));
    assert.equal(
        await testAnkiConnection(createAnkiClient(f.transport, { port: String(f.port), apiKey: 'fake-only' })),
        6
    );
    assert.deepEqual(
        f.calls.map((call) => call.body.action),
        ['version']
    );
    assert.equal(f.calls[0].body.key, 'fake-only');
    assert.equal(f.calls[0].body.version, 6);
});

test('A02–04: HTTP, protocol, non-JSON, version and business errors reject over real HTTP', async (t) => {
    for (const [reply, code] of [
        [{ status: 500, raw: '{}' }, 'ANKI_HTTP'],
        [{ status: 401, raw: '{}' }, 'ANKI_AUTH'],
        [{ status: 403, raw: '{}' }, 'ANKI_AUTH'],
        [{ raw: '<html>not JSON</html>' }, 'ANKI_PROTOCOL'],
        [{ data: { result: 6 } }, 'ANKI_PROTOCOL'],
        [{ data: [] }, 'ANKI_PROTOCOL'],
        [envelope(5), 'ANKI_PROTOCOL'],
        [envelope('6'), 'ANKI_PROTOCOL'],
        [envelope(null, 'invalid API key fake-only'), 'ANKI_AUTH'],
        [envelope(null, 'cannot execute action'), 'ANKI_WRITE_FAILED'],
        [envelope(6, ''), 'ANKI_WRITE_FAILED'],
    ]) {
        const f = await fixture(t, () => reply);
        await assert.rejects(testAnkiConnection(createAnkiClient(f.transport, { port: f.port })), errorCode(code));
        assert.equal(f.calls.length, 1);
    }
    const client = createAnkiClient(async () => {
        throw new Error('credential must not leak');
    });
    await assert.rejects(testAnkiConnection(client), errorCode('ANKI_UNREACHABLE'));
});

test('each action validates its result; addNote requires a positive safe numeric ID', async (t) => {
    for (const [action, invalid] of [
        ['deckNames', {}],
        ['modelNames', [1]],
        ['modelFieldNames', null],
        ['createDeck', '12'],
        ['createModel', {}],
        ...[null, 0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1].map((value) => ['addNote', value]),
    ]) {
        const f = await fixture(t, () => envelope(invalid));
        await assert.rejects(
            createAnkiClient(f.transport, { port: f.port })(action),
            errorCode(action === 'addNote' ? 'ANKI_WRITE_UNKNOWN' : 'ANKI_PROTOCOL')
        );
    }
});

test('A06: first collection prepares resources; second reuses model and validates fields', async (t) => {
    let deck = false,
        model = false,
        noteId = 100;
    const notes = [];
    const f = await fixture(t, ({ body }) => {
        switch (body.action) {
            case 'version':
                return envelope(6);
            case 'deckNames':
                return envelope(deck ? [ANKI_DECK] : []);
            case 'modelNames':
                return envelope(model ? [ANKI_MODEL] : []);
            case 'createModel':
                model = true;
                return envelope({ id: 50 });
            case 'createDeck':
                deck = true;
                return envelope(60);
            case 'modelFieldNames':
                return envelope(ANKI_FIELDS);
            case 'addNote':
                notes.push(body.params.note);
                return envelope(++noteId);
            default:
                throw new Error('unexpected request');
        }
    });
    const request = createAnkiClient(f.transport, { port: f.port });
    assert.equal(await collectAnki(request, '<one>', '一'), 101);
    assert.equal(await collectAnki(request, 'two', { explanations: [{ trait: 'n', explains: ['二'] }] }), 102);
    for (const action of ['createModel', 'createDeck'])
        assert.equal(f.calls.filter((call) => call.body.action === action).length, 1);
    assert.equal(f.calls.filter((call) => call.body.action === 'modelFieldNames').length, 2);
    assert.equal(notes[0].fields.Front, '&lt;one&gt;');
    assert.equal(notes[1].fields.Back, 'n. 二');
});

test('A03/A07: existing incompatible model and business failures stop subsequent writes', async (t) => {
    const f = await fixture(
        t,
        ({ body }) =>
            ({
                version: envelope(6),
                deckNames: envelope([]),
                modelNames: envelope([ANKI_MODEL]),
                modelFieldNames: envelope(['Front']),
            })[body.action]
    );
    await assert.rejects(
        collectAnki(createAnkiClient(f.transport, { port: f.port }), 'word', '译文'),
        errorCode('ANKI_MODEL')
    );
    assert.ok(f.calls.every((call) => !['createModel', 'createDeck', 'addNote'].includes(call.body.action)));
    for (const [message, code] of [
        ['cannot create note because it is a duplicate', 'ANKI_DUPLICATE'],
        ['field not found', 'ANKI_MODEL'],
        ['invalid api key', 'ANKI_AUTH'],
    ]) {
        const g = await fixture(t, () => envelope(null, message));
        await assert.rejects(createAnkiClient(g.transport, { port: g.port })('addNote', {}), errorCode(code));
        assert.equal(g.calls.length, 1);
    }
    const g = await fixture(
        t,
        ({ body }) =>
            ({
                version: envelope(6),
                deckNames: envelope([]),
                modelNames: envelope([]),
                createModel: envelope(null, 'invalid field'),
            })[body.action]
    );
    await assert.rejects(
        collectAnki(createAnkiClient(g.transport, { port: g.port }), 'word', ''),
        errorCode('ANKI_MODEL')
    );
    assert.equal(g.calls.at(-1).body.action, 'createModel');
});

test('A08: slow write result remains unknown, no resend; read deadline is a connection timeout', async (t) => {
    const f = await fixture(t, () => ({ ...envelope(123), delay: 100 }));
    const request = createAnkiClient(f.transport, { port: f.port }, { timeoutMs: 20 });
    await assert.rejects(request('addNote'), errorCode('ANKI_WRITE_UNKNOWN'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(f.calls.length, 1);
    await assert.rejects(request('version'), errorCode('ANKI_TIMEOUT'));
});

test('Eudic test reads categories only; actual export reuses the category and confirms HTTP 201', async (t) => {
    const f = await fixture(t, ({ method, path, body, headers }) => {
        assert.equal(headers.authorization, 'NIS fake-only');
        if (method === 'GET') {
            assert.match(path, /category\?language=en$/);
            return { data: { data: [{ id: '0', name: 'pot' }], message: '' } };
        }
        assert.deepEqual(body, { category_id: '0', language: 'en', words: ['hello'] });
        return { status: 201, data: { message: '单词导入成功,导入数量 : 1' } };
    });
    const client = createEudicClient(f.transport, { token: 'fake-only' });
    await client.testConnection();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(await client.collect(' hello '), true);
    assert.deepEqual(
        f.calls.map((c) => c.method),
        ['GET', 'GET', 'POST']
    );
});

test('Eudic creates missing study list only during export and preserves string IDs', async (t) => {
    const f = await fixture(t, ({ method, path, body }) => {
        if (method === 'GET') return { data: { data: [], message: '' } };
        if (path.endsWith('category')) {
            assert.equal(body.name, 'Cup');
            return { status: 201, data: { data: { id: '132314173819830130' }, message: '' } };
        }
        assert.equal(body.category_id, '132314173819830130');
        return { status: 201, data: { message: 'imported' } };
    });
    await createEudicClient(f.transport, { token: 'NIS fake', name: 'Cup' }).collect('word');
    assert.equal(f.calls.length, 3);
});

test('Eudic rejects bad responses, missing credentials, authorization, throttling and uncertain writes', async (t) => {
    for (const [reply, code] of [
        [{ status: 401 }, 'EUDIC_AUTH'],
        [{ status: 403 }, 'EUDIC_LIMIT'],
        [{ status: 429 }, 'EUDIC_LIMIT'],
        [{ status: 500 }, 'EUDIC_HTTP'],
        [{ raw: 'not json' }, 'EUDIC_PROTOCOL'],
        [{ data: { message: 'denied' } }, 'EUDIC_PROTOCOL'],
        [{ data: { data: [{ id: {}, name: 'bad' }], message: '' } }, 'EUDIC_PROTOCOL'],
    ]) {
        const f = await fixture(t, () => reply);
        await assert.rejects(createEudicClient(f.transport, { token: 'fake' }).testConnection(), errorCode(code));
    }
    let calls = 0;
    await assert.rejects(
        createEudicClient(() => {
            calls++;
        }).testConnection(),
        errorCode('EUDIC_AUTH')
    );
    assert.equal(calls, 0);
    const f = await fixture(t, ({ method }) =>
        method === 'GET'
            ? { data: { data: [{ id: '0', name: 'pot' }], message: '' } }
            : { data: { message: 'not confirmed' } }
    );
    await assert.rejects(
        createEudicClient(f.transport, { token: 'fake' }).collect('word'),
        errorCode('EUDIC_WRITE_UNKNOWN')
    );
});

test('Eudic timeout during export is unknown and is never retried', async (t) => {
    const f = await fixture(t, ({ method }) =>
        method === 'GET'
            ? { data: { data: [{ id: '0', name: 'pot' }], message: '' } }
            : { status: 201, data: { message: 'imported' }, delay: 100 }
    );
    await assert.rejects(
        createEudicClient(f.transport, { token: 'fake' }, { timeoutMs: 20 }).collect('word'),
        errorCode('EUDIC_WRITE_UNKNOWN')
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});
