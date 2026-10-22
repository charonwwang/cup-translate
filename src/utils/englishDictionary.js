// Preserve source pronunciations and examples; never manufacture IPA or sample sentences.
export function parseEnglishDictionary(entries) {
    const pronunciations = [];
    const sentence = [];
    const list = (value) => (Array.isArray(value) ? value : []);
    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, 4)) {
        if (!entry || typeof entry !== 'object') continue;
        for (const item of list(entry.phonetics).slice(0, 8)) {
            const symbol = typeof item?.text === 'string' ? item.text.trim() : '';
            if (!symbol) continue;
            const region = /[-_]us[_.-]/i.test(item?.audio ?? '')
                ? 'US'
                : /[-_]uk[_.-]|[-_]gb[_.-]/i.test(item?.audio ?? '')
                  ? 'UK'
                  : '';
            if (pronunciations.some((value) => value.symbol === symbol && (!region || value.region === region)))
                continue;
            const unknown = pronunciations.findIndex((value) => value.symbol === symbol && !value.region);
            if (unknown >= 0) pronunciations.splice(unknown, 1);
            pronunciations.push({ symbol, region, voice: '' });
        }
        if (!pronunciations.length && typeof entry.phonetic === 'string' && entry.phonetic.trim())
            pronunciations.push({ symbol: entry.phonetic.trim(), region: '', voice: '' });
        for (const meaning of list(entry.meanings).slice(0, 12)) {
            for (const definition of list(meaning?.definitions).slice(0, 12)) {
                const source = typeof definition?.example === 'string' ? definition.example.trim() : '';
                if (source && !sentence.some((value) => value.source === source)) sentence.push({ source, target: '' });
            }
        }
    }
    return { pronunciations: pronunciations.slice(0, 4), sentence: sentence.slice(0, 2) };
}
