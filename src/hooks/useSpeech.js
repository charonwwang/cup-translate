import { useEffect, useRef, useState } from 'react';

// One audible owner per window; pending provider responses cannot restart stopped speech.
let cancelCurrent = null;
export function useSpeech(contentKey) {
    const [status, setStatus] = useState('idle');
    const session = useRef(null);
    const stop = () => {
        const current = session.current;
        session.current = null;
        if (current) {
            current.cancelled = true;
            try {
                current.source?.stop();
            } catch {
                /* already ended */
            }
            current.source?.disconnect();
            current.context?.close().catch(() => {});
            if (cancelCurrent === current.stop) cancelCurrent = null;
        }
        setStatus('idle');
    };
    useEffect(() => () => session.current?.stop(), [contentKey]);
    const toggle = async (load) => {
        if (session.current) {
            stop();
            return;
        }
        cancelCurrent?.();
        const current = { cancelled: false, stop };
        session.current = current;
        cancelCurrent = stop;
        setStatus('loading');
        try {
            // Resume during the click gesture, before awaiting network/synthesis.
            current.context = new (window.AudioContext || window.webkitAudioContext)();
            await current.context.resume();
            const data = await load();
            if (current.cancelled) return;
            if (!data?.length) {
                stop();
                return;
            } // speech-dispatcher plays itself
            const buffer = await current.context.decodeAudioData(new Uint8Array(data).buffer);
            if (current.cancelled) return;
            // A long local synthesis may outlive the WebView's active audio session.
            await current.context.resume();
            if (current.cancelled) return;
            const source = current.context.createBufferSource();
            current.source = source;
            source.buffer = buffer;
            source.connect(current.context.destination);
            source.onended = () => {
                if (session.current === current) stop();
            };
            source.start();
            setStatus('playing');
        } catch (error) {
            if (!current.cancelled) {
                stop();
                throw error;
            }
        }
    };
    return { status, toggle, stop };
}
