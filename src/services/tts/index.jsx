import { guardService } from '../../utils/requestRuntime';
import * as _google_tts from './google_tts';
import * as _lingva_tts from './lingva';
import * as _local_tts from './local_tts';

export const google_tts = guardService('tts', 'google_tts', _google_tts);
export const lingva_tts = guardService('tts', 'lingva_tts', _lingva_tts);
export const local_tts = guardService('tts', 'local_tts', _local_tts);

import * as _piper_tts from './piper_tts';
export const piper_tts = guardService('tts', 'piper_tts', _piper_tts);

import * as _kokoro_tts from './kokoro_tts';
export const kokoro_tts = guardService('tts', 'kokoro_tts', _kokoro_tts);

import * as _qwen_tts from './qwen_tts';
export const qwen_tts = guardService('tts', 'qwen_tts', _qwen_tts);
