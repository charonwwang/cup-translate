export function localServiceSummary(key, config, status) {
    if (key.split('@')[0] !== 'local_mt') return { ready: false, family: null, manageId: null };
    const family = config?.model ?? 'opus';
    if (family === 'hymt') {
        const id = config.variant === 'hymt-q8' ? 'hymt-q8' : 'hymt-q4';
        return { family, ready: !!status[id]?.installed, checking: !status[id], manageId: id };
    }
    if (family === 'm2m100')
        return { family, ready: !!status.m2m100?.installed, checking: !status.m2m100, manageId: 'm2m100' };
    return {
        family,
        checking: !status['en-zh'] && !status['zh-en'],
        ready: !!status['en-zh']?.installed || !!status['zh-en']?.installed,
        manageId: status['en-zh']?.installed || !status['zh-en']?.installed ? 'en-zh' : 'zh-en',
    };
}
