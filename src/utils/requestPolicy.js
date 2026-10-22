// Trust is assigned by the application, never by provider metadata or a hostname.
export function isDeviceAllowed(kind, name) {
    return (
        (kind === 'translate' && name === 'local_mt') ||
        (kind === 'recognize' && ['system', 'qrcode'].includes(name)) ||
        (kind === 'tts' && ['local_tts', 'piper_tts', 'kokoro_tts', 'qwen_tts'].includes(name))
    );
}
export function assertPolicy(mode, kind, name) {
    if (mode === 'device_only' && !isDeviceAllowed(kind, name)) {
        throw new Error('Blocked by device-only policy');
    }
}
export class RequestScope {
    constructor(snapshot) {
        this.snapshot = structuredClone(snapshot);
        this.controller = new AbortController();
        this.signal = this.controller.signal;
    }
    cancel() {
        this.controller.abort();
    }
    get active() {
        return !this.signal.aborted;
    }
    assertActive() {
        if (!this.active) throw new DOMException('Request expired', 'AbortError');
    }
}
