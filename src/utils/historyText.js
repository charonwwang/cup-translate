import { translationResultToText } from './translationResult';
export function historyResult(value) {
    if (typeof value !== 'string') return translationResultToText(value);
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.explanations)
            ? translationResultToText(parsed)
            : value;
    } catch {
        return value;
    }
}
