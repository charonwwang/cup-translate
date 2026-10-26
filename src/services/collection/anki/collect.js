import { CollectionError } from '../errors.js';
import { ANKI_DECK, ANKI_MODEL, ANKI_FIELDS, buildAnkiNote } from './note.js';

export async function collectAnki(request, source, target) {
    if (typeof source !== 'string' || !source.trim()) throw new CollectionError('COLLECTION_EMPTY');
    const note = buildAnkiNote(source, target);
    await request('version');
    const decks = await request('deckNames');
    const models = await request('modelNames');
    // Validate an existing model before any write; never overwrite a user's template.
    if (models.includes(ANKI_MODEL)) {
        const fields = await request('modelFieldNames', { modelName: ANKI_MODEL });
        if (!ANKI_FIELDS.every((field) => fields.includes(field))) throw new CollectionError('ANKI_MODEL');
    } else {
        await request('createModel', {
            modelName: ANKI_MODEL,
            inOrderFields: ANKI_FIELDS,
            isCloze: false,
            cardTemplates: [
                {
                    Name: ANKI_MODEL,
                    Front: '{{Front}}',
                    Back: '{{FrontSide}}<br>{{Symbol1}} {{Voice1}}<br>{{Symbol2}} {{Voice2}}<hr id=answer>{{Back}}',
                },
            ],
        });
        const fields = await request('modelFieldNames', { modelName: ANKI_MODEL });
        if (!ANKI_FIELDS.every((field) => fields.includes(field))) throw new CollectionError('ANKI_MODEL');
    }
    if (!decks.includes(ANKI_DECK)) await request('createDeck', { deck: ANKI_DECK });
    return request('addNote', { note });
}
