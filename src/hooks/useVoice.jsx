import { useCallback } from 'react';

// AudioContext 延迟创建：现代浏览器（含 WebKit）在用户手势前创建 AudioContext
// 会抛自动播放策略错误。延迟到首次播放时创建，且用模块级变量保持跨渲染稳定。
let _audioContext = null;
// 当前应正在播放的 source。同一时刻只允许存在一条音轨，
// 否则会出现「两条音轨同时响、且只能停掉其中一条」。
let _source = null;
// 递增的播放代次。decodeAudioData 是异步的，回调返回时用户可能已经点了停止
// 或又点了另一次朗读；用代次判断回调是否已经过期，避免它把已作废的 source
// 写回 _source（那会导致音轨失去引用、再也停不掉）。
let _playToken = 0;

function getAudioContext() {
    if (!_audioContext) {
        _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _audioContext;
}

/** 停掉当前音轨（若有）。无论 stop() 是否抛异常，都把引用清空。 */
function stopCurrentSource() {
    if (!_source) {
        return;
    }
    const source = _source;
    _source = null;
    try {
        source.stop();
        source.disconnect();
    } catch {
        // stop() 在已结束的 source 上会抛异常，忽略即可
    }
}

export const useVoice = () => {
    const playOrStop = useCallback((data) => {
        // 只要当前有音轨在播，本次点击就是「停止」：
        // 同时作废所有在途的解码回调，防止它们稍后把声音又放出来。
        if (_source) {
            _playToken += 1;
            stopCurrentSource();
            return;
        }

        // 没有音轨在播：开始一次新的播放。
        // 这里同样先作废在途回调——用户连点两次时，第二次点击发生在第一次
        // 尚未解码完成期间（_source 仍为 null），若不递增代次，
        // 两个回调都会成功 start()，产生两条并发音轨。
        _playToken += 1;
        const token = _playToken;
        const audioContext = getAudioContext();
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
        audioContext
            .decodeAudioData(new Uint8Array(data).buffer)
            .then((buffer) => {
                // 过期回调直接丢弃：期间用户已点了停止，或已发起更新的一次播放
                if (token !== _playToken) {
                    return;
                }
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start();
                _source = source;
                source.onended = () => {
                    source.disconnect();
                    // 仅当自己仍是「当前音轨」时才清空，
                    // 否则会把后来者的引用误清掉
                    if (_source === source) {
                        _source = null;
                    }
                };
            })
            .catch(() => {
                // 解码失败（音频数据损坏/格式不支持）不应产生未捕获的 Promise 拒绝。
                // 仅作废本次播放，不影响后续点击。
                if (token === _playToken) {
                    _playToken += 1;
                }
            });
    }, []);

    return playOrStop;
};
