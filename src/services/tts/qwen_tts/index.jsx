import { invoke } from '@tauri-apps/api/tauri';
import { store } from '../../../utils/store';
export const info = { name: 'qwen_tts', icon: '/logo/local_tts.svg' };
export const Language = {
    zh_cn: 'Chinese',
    zh_tw: 'Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    de: 'German',
    fr: 'French',
    ru: 'Russian',
    pt_pt: 'Portuguese',
    pt_br: 'Portuguese',
    es: 'Spanish',
    it: 'Italian',
};
export async function tts(text, language) {
    const config = (await store.get('qwen_tts')) ?? {};
    return invoke('qwen_tts_request', {
        variant: config.variant || '0.6B',
        text,
        language,
        voice: config.voice || 'Vivian',
    });
}

export { Config } from './Config';
