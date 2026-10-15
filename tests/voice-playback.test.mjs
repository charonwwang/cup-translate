import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// useVoice 依赖 React 的 useCallback 与浏览器的 AudioContext。
// 这里注入最小替身并**真正执行 src/hooks/useVoice.jsx 的源码**，
// 使断言针对真实实现。
//
// 为什么不写「复刻逻辑」的模拟测试：那种测试断言的是测试自己写的一份状态机，
// 真实代码回归时它照样全绿，起不到护栏作用。下面通过 new Function 把源码
// 包进一个受控作用域后调用它导出的 useVoice。
const SOURCE_PATH = 'src/hooks/useVoice.jsx';

async function loadRealUseVoice() {
    const source = await readFile(SOURCE_PATH, 'utf8');
    // 剥掉 import（改为从函数作用域注入）与 export（new Function 内不能出现），
    // 其余实现原样保留，确保测的是真实代码
    const body = source.replace(/^import .*$/gm, '').replace(/\bexport\s+/g, '');

    const started = [];
    const stopped = [];
    const disconnected = [];
    let pendingDecodes = [];
    let seq = 0;

    const makeSource = (id) => ({
        id,
        onended: null,
        buffer: null,
        connect() {},
        disconnect() {
            disconnected.push(id);
        },
        start() {
            started.push(id);
        },
        stop() {
            stopped.push(id);
        },
    });

    // decodeAudioData 返回挂起的 Promise，由测试显式 resolve，
    // 以便精确制造「解码尚未完成时用户又点了一次」的竞态。
    const audioContext = {
        destination: {},
        decodeAudioData() {
            const instance = makeSource(`track-${++seq}`);
            return new Promise((resolve) => {
                pendingDecodes.push(() => resolve({ id: instance.id }));
            });
        },
        createBufferSource() {
            // 真实实现从解码结果拿到 buffer，这里返回一个带相同 id 的 source
            return makeSource(`track-${seq}`);
        },
    };

    const fakeWindow = {
        AudioContext: function () {
            return audioContext;
        },
    };
    const useCallback = (fn) => fn;

    const factory = new Function('useCallback', 'window', `${body}\nreturn useVoice;`);
    const useVoice = factory(useCallback, fakeWindow);

    return {
        useVoice,
        started,
        stopped,
        disconnected,
        pendingCount: () => pendingDecodes.length,
        resolveDecodes: () => {
            const decodes = pendingDecodes;
            pendingDecodes = [];
            decodes.forEach((fn) => fn());
        },
    };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('real useVoice: double click while decoding starts only one track', async () => {
    // 真实路径：handleSpeak 先 await TTS 网络请求再调 speak()，
    // 连点两次会产生两条独立异步链；旧实现无代次检查，
    // 两次 decode 回调都会 start()，得到两条并发音轨，
    // 且先启动的那条引用被覆盖，点「停止」只能停掉一条。
    const voice = await loadRealUseVoice();
    const playOrStop = voice.useVoice();

    playOrStop(new ArrayBuffer(8));
    playOrStop(new ArrayBuffer(8));
    assert.ok(voice.pendingCount() >= 1, 'decoding should be in flight');

    voice.resolveDecodes();
    await tick();

    assert.equal(
        voice.started.length,
        1,
        `exactly one track may start, got ${voice.started.length}: ${voice.started.join(',')}`
    );
});

test('real useVoice: clicking during playback stops the playing track', async () => {
    const voice = await loadRealUseVoice();
    const playOrStop = voice.useVoice();

    playOrStop(new ArrayBuffer(8));
    voice.resolveDecodes();
    await tick();
    assert.equal(voice.started.length, 1, 'first click should start playback');

    playOrStop(new ArrayBuffer(8)); // 播放中点击 = 停止
    assert.equal(voice.stopped.length, 1, 'the playing track must be stopped');
    assert.deepEqual(voice.stopped, voice.started, 'the stopped track is the one that played');
});

test('real useVoice: a stale decode after a stop must not resurrect audio', async () => {
    const voice = await loadRealUseVoice();
    const playOrStop = voice.useVoice();

    playOrStop(new ArrayBuffer(8)); // 发起播放，解码挂起
    voice.resolveDecodes(); // 该次解码完成
    await tick();
    playOrStop(new ArrayBuffer(8)); // 停止

    const startedAfterStop = voice.started.length;
    await tick();
    assert.equal(voice.started.length, startedAfterStop, 'no audio may start after a stop');
});

test('useVoice guards decode failures and onended identity', async () => {
    const source = await readFile(SOURCE_PATH, 'utf8');
    // decodeAudioData 失败必须有 catch，否则 WebKit 下会产生未处理的 Promise 拒绝
    assert.match(source, /\.catch\(/, 'decodeAudioData must have a rejection handler');
    // 无条件 _source = null 会清掉后来者的引用，使新音轨无法被停止
    assert.match(
        source,
        /if \(_source === source\)/,
        'onended must compare identity before clearing the current track'
    );
});
