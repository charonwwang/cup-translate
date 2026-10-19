import { translationResultToText } from '../../utils/translationResult.js';

export function classifySourceText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return 'phrase';

    const sentences = splitSentences(text);
    if (text.includes('\n') || sentences.length >= 2 || text.length > 180) {
        return 'paragraph';
    }
    if (!/\s/.test(text) && text.length <= 48) {
        return 'word';
    }
    return 'phrase';
}

export function splitSentences(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return [];

    return text
        .split(/\n+/)
        .flatMap((line) => line.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g) ?? [line])
        .map((line) => line.trim())
        .filter(Boolean);
}

export function buildSentencePairs(source, target) {
    const sourceSentences = splitSentences(source);
    const targetSentences = splitSentences(target);
    if (sourceSentences.length > 1 && sourceSentences.length === targetSentences.length) {
        return sourceSentences.map((sourceSentence, index) => ({
            source: sourceSentence,
            target: targetSentences[index],
        }));
    }
    return [{ source: String(source || '').trim(), target: String(target || '').trim() }];
}

function dictionaryExamples(result) {
    return (result?.sentence ?? [])
        .map((sentence) => ({
            source: String(sentence?.source ?? '').trim(),
            target: String(sentence?.target ?? '').trim(),
        }))
        .filter((sentence) => sentence.source || sentence.target);
}

export function buildWordEntry(result, sourceText, fallbackPronunciation = '') {
    const pronunciations = (result?.pronunciations ?? [])
        .map((pronunciation) => ({
            region: String(pronunciation?.region ?? '').trim(),
            symbol: String(pronunciation?.symbol ?? '').trim(),
            voice: pronunciation?.voice ?? '',
        }))
        .filter((pronunciation) => pronunciation.symbol || pronunciation.voice);

    if (!pronunciations.length && String(fallbackPronunciation || '').trim()) {
        pronunciations.push({
            region: '',
            symbol: String(fallbackPronunciation).trim(),
            voice: '',
        });
    }

    const senses = (result?.explanations ?? [])
        .map((entry) => ({
            pos: String(entry?.trait ?? '').trim(),
            meanings: (entry?.explains ?? []).map((meaning) => String(meaning ?? '').trim()).filter(Boolean),
        }))
        .filter((entry) => entry.meanings.length);

    if (!senses.length && typeof result === 'string' && result.trim()) {
        senses.push({ pos: '', meanings: [result.trim()] });
    }

    return {
        word: String(sourceText || '').trim(),
        pronunciations,
        senses,
        examples: dictionaryExamples(result),
    };
}

export function buildPhraseEntry(result) {
    const explanationGroups = (result?.explanations ?? [])
        .map((entry) => ({
            pos: String(entry?.trait ?? '').trim(),
            meanings: (entry?.explains ?? []).map((meaning) => String(meaning ?? '').trim()).filter(Boolean),
        }))
        .filter((entry) => entry.meanings.length);

    const translation = typeof result === 'string' ? result.trim() : explanationGroups[0]?.meanings.join('；') || '';
    const alternatives = explanationGroups
        .slice(1)
        .map((entry) => ({
            tag: entry.pos,
            text: entry.meanings.join('；'),
        }))
        .filter((entry) => entry.text && entry.text !== translation);

    return {
        translation,
        alternatives,
        usage: (result?.associations ?? []).map((item) => String(item ?? '').trim()).filter(Boolean),
        examples: dictionaryExamples(result),
    };
}

export function buildParagraphEntry(result) {
    const translation =
        typeof result === 'string' ? result.trim() : translationResultToText(result).replace(/\n+/g, ' ').trim();
    return { translation };
}
