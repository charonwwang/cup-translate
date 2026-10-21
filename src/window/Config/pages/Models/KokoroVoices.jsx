import React, { useState, useEffect } from 'react';
import {
    Button,
    Checkbox,
    Select,
    SelectItem,
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Progress,
} from '@nextui-org/react';
import { invoke } from '@tauri-apps/api/tauri';
import { emit } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { useSpeech } from '../../../../hooks/useSpeech';
import { store } from '../../../../utils/store';
import { filterKokoroVoices, isKokoroBusy } from '../../../../utils/multilingualVoices';
export default function KokoroVoices({ open, onClose, onBack, onChange, onSpeechPolicy }) {
    const { t } = useTranslation();
    const [data, setData] = useState(null);
    const [language, setLanguage] = useState('zh');
    const [preferences, setPreferences] = useState({});
    const [accepted, setAccepted] = useState(false);
    const [enable, setEnable] = useState(true);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [playing, setPlaying] = useState(null);
    const [previewBusy, setPreviewBusy] = useState(false);
    const speech = useSpeech(open);
    const update = async () => {
        const value = await invoke('kokoro_model_status');
        setData(value);
        onChange(value);
        setPreferences((await store.get('kokoro_voices')) || {});
    };
    useEffect(() => {
        if (!open) {
            speech.stop();
            return;
        }
        let live = true;
        const read = async () => {
            try {
                const value = await invoke('kokoro_model_status');
                if (!live) return;
                setData(value);
                onChange(value);
                setPreferences((await store.get('kokoro_voices')) || {});
            } catch {
                if (live) setError(t('models.kokoro_unavailable'));
            }
        };
        read();
        const timer = setInterval(read, 1500);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [open]);
    const run = async (action) => {
        setError('');
        setBusy(true);
        try {
            await action();
            await update();
        } catch (e) {
            if (!String(e).toLowerCase().includes('cancelled')) setError(String(e));
        } finally {
            setBusy(false);
        }
    };
    const choose = async (v) => {
        const before = (await store.get('kokoro_voices')) || {};
        const next = { ...before, [v.language]: v.sid };
        await store.set('kokoro_voices', next);
        try {
            await store.save();
        } catch (e) {
            await store.set('kokoro_voices', before);
            throw e;
        }
        setPreferences(next);
        await emit('kokoro_voices_changed', next);
    };
    const active = isKokoroBusy(data);
    const languages = [...new Set((data?.voices || []).map((v) => v.language))];
    return (
        <Modal
            isOpen={open}
            onClose={onClose}
            size='3xl'
            scrollBehavior='inside'
            classNames={{
                base: 'model-install-dialog piper-voice-dialog',
                header: 'model-install-header',
                body: 'model-install-body',
                footer: 'model-install-footer',
            }}
        >
            <ModalContent>
                <ModalHeader>
                    <div>
                        <h2>{t('models.kokoro_title')}</h2>
                        <p>{t('models.kokoro_intro')}</p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    {error && (
                        <p
                            role='alert'
                            className='model-catalog-error'
                        >
                            {error}
                        </p>
                    )}
                    <section className='kokoro-package'>
                        <div>
                            <strong>Kokoro v1.0 · 82M · INT8</strong>
                            <p>
                                {t('models.kokoro_shared')} ·{' '}
                                {data?.model ? `${(data.model.archiveBytes / 1e6).toFixed(1)} MB` : '…'}
                            </p>
                            <small>Apache-2.0 · hexgrad / sherpa-onnx · CPU</small>
                        </div>
                        {data?.installed ? (
                            <div className='piper-voice-actions'>
                                <span className='models-status ready'>{t('models.ready')}</span>
                                <Button
                                    size='sm'
                                    color='danger'
                                    variant='light'
                                    isDisabled={busy || active}
                                    onPress={() => {
                                        speech.stop();
                                        setConfirm(true);
                                    }}
                                >
                                    {t('models.piper_remove')}
                                </Button>
                            </div>
                        ) : (
                            <>
                                <Checkbox
                                    size='sm'
                                    isSelected={accepted}
                                    onValueChange={setAccepted}
                                >
                                    {t('models.kokoro_ack')}
                                </Checkbox>
                                <Checkbox
                                    size='sm'
                                    isSelected={enable}
                                    onValueChange={setEnable}
                                >
                                    {t('models.kokoro_enable_after')}
                                </Checkbox>
                                <Button
                                    size='sm'
                                    className='service-primary-button'
                                    isLoading={busy || active}
                                    isDisabled={!accepted || data?.supported === false || !data || busy || active}
                                    onPress={() =>
                                        run(async () => {
                                            await invoke('kokoro_download', { accepted });
                                            if (enable) await onSpeechPolicy('kokoro');
                                        })
                                    }
                                >
                                    {t('models.kokoro_download')}
                                </Button>
                            </>
                        )}
                        <details className='models-details'>
                            <summary>{t('models.piper_license')}</summary>
                            <p>{t('models.kokoro_license_hint')}</p>
                            <a
                                href='https://huggingface.co/hexgrad/Kokoro-82M'
                                target='_blank'
                                rel='noreferrer'
                            >
                                hexgrad / Kokoro-82M
                            </a>
                            <p className='select-text'>{data?.model?.archiveSha256}</p>
                        </details>
                        {data?.supported === false && <p role='alert'>{data.reason}</p>}
                        {active && (
                            <div className='piper-progress'>
                                <Progress
                                    size='sm'
                                    aria-label={t('models.kokoro_download')}
                                    value={data.task.total ? (100 * data.task.downloaded) / data.task.total : 0}
                                />
                                <span>
                                    {(data.task.downloaded / 1e6).toFixed(1)} / {(data.task.total / 1e6).toFixed(1)} MB
                                    ·{' '}
                                    {t(
                                        data.task.state === 'checking'
                                            ? 'models.piper_checking'
                                            : 'models.piper_downloading'
                                    )}
                                </span>
                                {data.task.state === 'downloading' && (
                                    <Button
                                        size='sm'
                                        variant='light'
                                        onPress={() =>
                                            invoke('kokoro_cancel')
                                                .then(update)
                                                .catch(() => setError(t('models.kokoro_unavailable')))
                                        }
                                    >
                                        {t('common.cancel')}
                                    </Button>
                                )}
                            </div>
                        )}
                        {data?.task?.error && (
                            <p
                                role='alert'
                                className='model-catalog-error'
                            >
                                {data.task.error}
                            </p>
                        )}
                        {confirm && (
                            <div className='piper-remove-confirm'>
                                <p>{t('models.kokoro_remove_confirm')}</p>
                                <Button
                                    size='sm'
                                    color='danger'
                                    onPress={() =>
                                        run(async () => {
                                            await invoke('kokoro_uninstall');
                                            setConfirm(false);
                                        })
                                    }
                                >
                                    {t('models.piper_confirm_remove')}
                                </Button>
                                <Button
                                    size='sm'
                                    variant='light'
                                    onPress={() => setConfirm(false)}
                                >
                                    {t('common.cancel')}
                                </Button>
                            </div>
                        )}
                    </section>
                    <div className='kokoro-language-row'>
                        <div>
                            <h3>{t('models.kokoro_choose_voice')}</h3>
                            <p className='piper-hint'>{t('models.kokoro_routing')}</p>
                        </div>
                        <Select
                            size='sm'
                            aria-label={t('models.kokoro_voice_language')}
                            selectedKeys={[language]}
                            onSelectionChange={(keys) => {
                                speech.stop();
                                setLanguage([...keys][0] || 'zh');
                            }}
                        >
                            {languages.map((lang) => (
                                <SelectItem key={lang}>
                                    {t(`languages.${lang === 'zh' ? 'zh_cn' : lang === 'pt' ? 'pt_br' : lang}`)}
                                </SelectItem>
                            ))}
                        </Select>
                    </div>
                    <div className='piper-voice-list'>
                        {filterKokoroVoices(data?.voices, language).map((v) => (
                            <article
                                className={`piper-voice-card ${preferences[v.language] === v.sid ? 'selected' : ''}`}
                                key={v.sid}
                            >
                                <div className='piper-voice-heading'>
                                    <div>
                                        <strong>{v.name}</strong>
                                        <span>
                                            {t(
                                                `languages.${v.language === 'zh' ? 'zh_cn' : v.language === 'pt' ? 'pt_br' : v.language}`
                                            )}{' '}
                                            · {t('models.kokoro_shared_voice')}
                                        </span>
                                    </div>
                                </div>
                                <div className='piper-voice-actions'>
                                    <Button
                                        size='sm'
                                        variant='bordered'
                                        isDisabled={previewBusy && (playing !== v.sid || speech.status === 'idle')}
                                        onPress={() => {
                                            if (playing === v.sid && speech.status !== 'idle') {
                                                speech.stop();
                                                return;
                                            }
                                            setError('');
                                            speech.stop();
                                            setPlaying(v.sid);
                                            speech
                                                .toggle(async () => {
                                                    setPreviewBusy(true);
                                                    try {
                                                        return await invoke('kokoro_preview', { sid: v.sid });
                                                    } finally {
                                                        setPreviewBusy(false);
                                                    }
                                                })
                                                .catch((e) =>
                                                    setError(`${t('models.piper_preview_failed')} ${String(e)}`)
                                                );
                                        }}
                                    >
                                        {playing === v.sid && speech.status !== 'idle'
                                            ? t(
                                                  speech.status === 'loading'
                                                      ? 'models.piper_preview_loading'
                                                      : 'models.piper_stop'
                                              )
                                            : t(
                                                  data?.installed
                                                      ? 'models.piper_preview_local'
                                                      : 'models.piper_preview_online'
                                              )}
                                    </Button>
                                    <Button
                                        size='sm'
                                        className='service-secondary-button'
                                        isDisabled={preferences[v.language] === v.sid || busy}
                                        onPress={() => run(() => choose(v))}
                                    >
                                        {t(
                                            preferences[v.language] === v.sid
                                                ? 'models.piper_selected'
                                                : 'models.piper_use'
                                        )}
                                    </Button>
                                </div>
                            </article>
                        ))}
                    </div>
                </ModalBody>
                <ModalFooter>
                    <span>{t('models.kokoro_footer')}</span>
                    <Button
                        size='sm'
                        variant='light'
                        onPress={onBack}
                    >
                        {t('models.speech_back_families')}
                    </Button>
                    <Button
                        size='sm'
                        onPress={onClose}
                    >
                        {t('models.piper_close')}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
