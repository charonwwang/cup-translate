import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/tauri';
import { useConfig } from '../../hooks';
import './speechPreference.css';

export default function SpeechPreference({ compact = false }) {
    const { t } = useTranslation();
    const [policy, setPolicy] = useConfig('speech_policy', 'engine');
    const [privacy] = useConfig('privacy_mode', 'standard');
    const [kokoroReady, setKokoroReady] = useState(false);
    const [piperReady, setPiperReady] = useState(false);
    const [inventory, setInventory] = useState(null);
    useEffect(() => {
        let live = true;
        invoke('kokoro_model_status')
            .then((value) => live && setKokoroReady(value.supported && value.installed))
            .catch(() => {});
        invoke('piper_catalog')
            .then((value) => live && setPiperReady(value.voices?.some((entry) => entry.installed)))
            .catch(() => {});
        invoke('tts_inventory')
            .then((value) => live && setInventory(value))
            .catch(() => live && setInventory({ supported: false }));
        return () => {
            live = false;
        };
    }, []);
    const localAllowed = inventory?.supported && (privacy !== 'device_only' || inventory.offline);
    return (
        <div className={`cup-speech-choice ${compact ? 'compact' : ''}`}>
            <p>{policy === 'off' ? t('models.speech_off') : t('models.choose_speech')}</p>
            <div
                role='group'
                aria-label={t('models.choose_speech')}
            >
                <button
                    type='button'
                    disabled={privacy === 'device_only'}
                    title={privacy === 'device_only' ? t('models.google_blocked') : t('models.google_network')}
                    onClick={() => setPolicy('google')}
                >
                    Google <small>{t('models.online_short')}</small>
                </button>
                <button
                    type='button'
                    disabled={!localAllowed}
                    title={localAllowed ? t('models.system_installed') : t('models.voice_unavailable')}
                    onClick={() => setPolicy('local')}
                >
                    {t('models.local_speech_short')}{' '}
                    <small>{t(inventory?.offline ? 'models.offline_short' : 'models.unverified')}</small>
                </button>
                <button
                    type='button'
                    disabled={!piperReady}
                    aria-pressed={policy === 'piper'}
                    onClick={() => setPolicy('piper')}
                >
                    Piper <small>{t('models.offline_short')}</small>
                </button>
                <button
                    type='button'
                    disabled={!kokoroReady}
                    aria-pressed={policy === 'kokoro'}
                    onClick={() => setPolicy('kokoro')}
                >
                    Kokoro <small>{t('models.offline_short')}</small>
                </button>
                <button
                    type='button'
                    aria-pressed={policy === 'off'}
                    onClick={() => setPolicy('off')}
                >
                    {t('models.no_speech')}
                </button>
            </div>
            {!compact && (
                <small>{privacy === 'device_only' ? t('models.google_blocked') : t('models.speech_choice_hint')}</small>
            )}
        </div>
    );
}
