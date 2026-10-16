import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
async function setup() {
    const code = (await readFile('src/hooks/useSpeech.js', 'utf8'))
        .replace(/^import .*$/gm, '')
        .replace('export function', 'function');
    const events = [];
    const context = {
        resume: async () => events.push('resume'),
        close: async () => {},
        decodeAudioData: async () => ({}),
        destination: {},
        createBufferSource: () => ({
            connect() {},
            disconnect() {},
            start() {
                events.push('start');
            },
            stop() {
                events.push('stop');
            },
        }),
    };
    const factory = new Function('useEffect', 'useRef', 'useState', 'window', `${code}; return useSpeech;`);
    const hook = factory(
        () => {},
        (value) => ({ current: value }),
        () => ['idle', (state) => events.push(state)],
        {
            AudioContext: function () {
                return context;
            },
        }
    );
    return { hook, events };
}
test('stopping during provider loading discards stale audio without another request', async () => {
    const { hook, events } = await setup();
    const speech = hook();
    let finish;
    let calls = 0;
    const first = speech.toggle(() => {
        calls++;
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    await Promise.resolve();
    await speech.toggle(() => {
        calls++;
    });
    finish([1]);
    await first;
    assert.equal(calls, 1);
    assert.ok(!events.includes('start'));
    assert.equal(events.at(-1), 'idle');
});
test('playing another owner stops prior audio and resumes context before loading', async () => {
    const { hook, events } = await setup();
    const a = hook(),
        b = hook();
    await a.toggle(async () => {
        events.push('load');
        return [1];
    });
    await b.toggle(async () => [1]);
    assert.ok(events.indexOf('resume') < events.indexOf('load'));
    assert.equal(events.filter((value) => value === 'start').length, 2);
    assert.ok(events.includes('stop'));
    b.stop();
});
test('provider failures reset state and propagate actionable errors', async () => {
    const { hook, events } = await setup();
    await assert.rejects(
        hook().toggle(async () => {
            throw new Error('provider unavailable');
        }),
        /provider unavailable/
    );
    assert.equal(events.at(-1), 'idle');
});
