import { invoke } from '@tauri-apps/api/tauri';

// 本地离线翻译（可选，默认不启用）：CTranslate2 跑 OPUS-MT en↔zh 的 CT2 int8 模型，
// 模型在 设置 → 翻译服务 → 本地离线翻译 中按需下载（每方向约 82MB，不随包分发）。
// 基准（docs/research/translation-engine-benchmark-2026.md）：158MB 内存 / 106ms@4 线程 / BLEU 53.8

import { resolveLocalModel, multilingualLanguage, hyLanguage, localThreadCount } from './options';

export async function translate(text, from, to, options = {}) {
    const { config, detect } = options;
    const threads = localThreadCount(config?.threads);
    const source = from === 'auto' ? detect : from;
    const pair = resolveLocalModel(config, source, to);
    if (!pair) throw new Error('The selected local model does not support this language direction');
    const signal = options.signal;
    if (signal?.aborted) throw new DOMException('Request expired', 'AbortError');
    const args = {
        pair,
        text,
        threads,
        source: pair.startsWith('hymt-')
            ? hyLanguage(source)
            : pair === 'm2m100'
              ? multilingualLanguage(source === 'zh_tw' ? 'zh' : source)
              : null,
        target: pair.startsWith('hymt-') ? hyLanguage(to) : pair === 'm2m100' ? multilingualLanguage(to) : null,
        quality: ['fast', 'thorough'].includes(config?.quality) ? config.quality : 'balanced',
    };
    if (!signal) return invoke('local_mt_translate', args);
    const requestId = await invoke('local_mt_prepare_request');
    let cancellation;
    const cancel = () => (cancellation ??= invoke('local_mt_cancel_request', { requestId }).catch(() => {}));
    let abort;
    try {
        if (signal.aborted) throw new DOMException('Request expired', 'AbortError');
        return await new Promise((resolve, reject) => {
            abort = () => {
                void cancel();
                reject(new DOMException('Request expired', 'AbortError'));
            };
            signal.addEventListener('abort', abort, { once: true });
            invoke('local_mt_translate', { ...args, requestId }).then(resolve, reject);
        });
    } finally {
        signal.removeEventListener('abort', abort);
        await cancel();
    }
}

export * from './Config';
export * from './info';
