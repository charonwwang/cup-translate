import { invoke } from '@tauri-apps/api/tauri';

// 本地离线翻译（可选，默认不启用）：CTranslate2 跑 OPUS-MT en↔zh 的 CT2 int8 模型，
// 模型在 设置 → 翻译服务 → 本地离线翻译 中按需下载（每方向约 82MB，不随包分发）。
// 基准（docs/research/translation-engine-benchmark-2026.md）：158MB 内存 / 106ms@4 线程 / BLEU 53.8

// 应用语言键 → 简单语向代码（本地模型只区分中/英）
function normLang(lang) {
    const l = String(lang ?? '').toLowerCase();
    if (l.startsWith('en')) {
        return 'en';
    }
    if (l.startsWith('zh') || l === 'cmn') {
        return 'zh';
    }
    return null;
}

export async function translate(text, from, to, options = {}) {
    const { config, detect } = options;
    const threads = config && config['threads'] ? parseInt(config['threads'], 10) : 4;

    const fromCode = from === 'auto' ? normLang(detect) : from;
    const toCode = to;
    const pair = `${fromCode}-${toCode}`;
    if (pair !== 'en-zh' && pair !== 'zh-en') {
        // 与其余 85 处服务层错误保持一致，用英文（服务层拿不到 t，回退语言即英文）
        throw `Local offline translation only supports English <-> Chinese (en-zh / zh-en), got ${pair}`;
    }
    return await invoke('local_mt_translate', {
        pair,
        text,
        threads: isNaN(threads) ? 4 : threads,
    });
}

export * from './Config';
export * from './info';
