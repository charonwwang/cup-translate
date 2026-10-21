import { invoke } from '@tauri-apps/api/tauri';
import { store } from '../../../utils/store';
import { preferredPiperVoice } from '../../../utils/piperVoices';
export const info = { name: 'piper_tts', icon: '/logo/local_tts.svg' };
export { Language } from '../local_tts/info';
export async function tts(text, lang) {
    const preferences = (await store.get('piper_voices')) || {};
    return invoke('piper_speak', { text, lang, voiceId: preferredPiperVoice(preferences, lang) });
}

export { Config } from './Config';
