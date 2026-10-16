// Preserve every dictionary definition when copying, including collapsed entries.
export function translationResultToText(result) {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return '';
    return (result.explanations ?? [])
        .map((entry) => {
            const definitions = (entry.explains ?? []).filter((value) => typeof value === 'string' && value.trim());
            if (!definitions.length) return '';
            return [entry.trait, definitions.join('；')].filter(Boolean).join(' ');
        })
        .filter(Boolean)
        .join('\n');
}
