import { invoke } from '@tauri-apps/api/tauri';

// 本地 TTS（开箱即用、零配置、离线）：
// 由 Rust 侧调用系统安装的 espeak-ng / espeak（合成 WAV 返回前端播放），
// 若只有 speech-dispatcher（spd-say）则由其直接播报；找不到引擎时抛出可操作的错误提示。
export async function tts(text, lang, options = {}) {
    return await invoke('tts_speak', { text, lang });
}

export * from './Config';
export * from './info';
