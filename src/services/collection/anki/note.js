import { nanoid } from 'nanoid';

export const ANKI_DECK = 'cup-translate';
export const ANKI_MODEL = 'cup-translate Card';
export const ANKI_FIELDS = ['Front', 'Back', 'Symbol1', 'Voice1', 'Symbol2', 'Voice2'];
const escape = (value) =>
    String(value ?? '')
        .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
        .replace(/\r?\n/g, '<br>');

export function buildAnkiNote(source, target) {
    const back =
        typeof target === 'string'
            ? escape(target)
            : (target?.explanations ?? [])
                  .map((item) => `${escape(item.trait)}. ${(item.explains ?? []).map(escape).join('; ')}`)
                  .join('<br>');
    const fields = { Front: escape(source), Back: back, Symbol1: '', Voice1: '', Symbol2: '', Voice2: '' };
    const audio = [];
    for (const [index, pronunciation] of (target?.pronunciations ?? []).slice(0, 2).entries()) {
        if (!pronunciation) continue;
        const symbol = typeof pronunciation.symbol === 'string' ? pronunciation.symbol : '';
        fields[`Symbol${index + 1}`] = escape(
            `${pronunciation.region ? `[${pronunciation.region}]` : ''} ${symbol ? (symbol.startsWith('/') ? symbol : `/${symbol}/`) : ''}`
        );
        const bytes = pronunciation.voice;
        // Preserve large audio support while bounding memory and accepting only bytes.
        if (
            !Array.isArray(bytes) ||
            !bytes.length ||
            bytes.length > 10 * 1024 * 1024 ||
            !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        )
            continue;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
        }
        // Unique safe filenames prevent path injection and overwriting other notes' media.
        audio.push({
            data: btoa(binary),
            filename: `cup-${nanoid()}-${index + 1}.mp3`,
            fields: [`Voice${index + 1}`],
        });
    }
    return {
        deckName: ANKI_DECK,
        modelName: ANKI_MODEL,
        fields,
        audio,
        options: { allowDuplicate: false },
        tags: ['cup-translate'],
    };
}
