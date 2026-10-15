import { useCallback, useRef } from 'react';

// AudioContext 延迟创建：现代浏览器（含 WebKit）在用户手势前创建 AudioContext
// 会抛自动播放策略错误。延迟到首次播放时创建，且用 useRef 保持跨渲染稳定。
let _audioContext = null;
let _source = null;

function getAudioContext() {
    if (!_audioContext) {
        _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _audioContext;
}

export const useVoice = () => {
    const playOrStop = useCallback((data) => {
        if (_source) {
            // 如果正在播放，停止播放
            try {
                _source.stop();
                _source.disconnect();
            } catch {
                // stop() 在已结束的 source 上会抛异常，忽略即可
            }
            _source = null;
        } else {
            // 如果没在播放，开始播放
            const audioContext = getAudioContext();
            audioContext.decodeAudioData(new Uint8Array(data).buffer).then((buffer) => {
                _source = audioContext.createBufferSource();
                _source.buffer = buffer;
                _source.connect(audioContext.destination);
                _source.start();
                _source.onended = () => {
                    _source.disconnect();
                    _source = null;
                };
            });
        }
    }, []);

    return playOrStop;
};
