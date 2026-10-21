import { invoke } from '@tauri-apps/api/tauri';
import { store } from '../../../utils/store';
import { speechLanguageKey } from '../../../utils/multilingualVoices';
export const info = { name: 'kokoro_tts', icon: '/logo/local_tts.svg' };
export const Language = {
    zh_cn: 'zh',
    zh_tw: 'zh',
    en: 'en',
    fr: 'fr',
    es: 'es',
    it: 'it',
    pt_br: 'pt',
    pt_pt: 'pt',
    hi: 'hi',
};
export async function tts(text, lang) {
    const preferences = (await store.get('kokoro_voices')) || {};
    return invoke('kokoro_speak', { text, lang, sid: preferences[speechLanguageKey(lang)] ?? null });
}
export { Config } from '../piper_tts/Config';
