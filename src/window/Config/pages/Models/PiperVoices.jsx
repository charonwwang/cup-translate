import React, { useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    Input,
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
import { piperTaskActive, voiceBytes } from '../../../../utils/piperVoices';

export default function PiperVoices({ open, onClose, onChange }) {
    const { t } = useTranslation();
    const [catalog, setCatalog] = useState([]);
    const [preferences, setPreferences] = useState({});
    const [search, setSearch] = useState('');
    const [accepted, setAccepted] = useState({});
    const [removing, setRemoving] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [playing, setPlaying] = useState('');
    const speech = useSpeech(open);
    const refresh = async () => {
        const data = await invoke('piper_catalog');
        setCatalog(data.voices || []);
        if (data.supported === false) setError(data.reason || t('models.piper_unavailable'));
        setPreferences((await store.get('piper_voices')) || {});
        onChange(data);
    };
    useEffect(() => {
        if (!open) {
            speech.stop();
            return;
        }
        let live = true;
        const load = async () => {
            try {
                const data = await invoke('piper_catalog');
                if (!live) return;
                setCatalog(data.voices || []);
                if (data.supported === false) setError(data.reason || t('models.piper_unavailable'));
                onChange(data);
                setPreferences((await store.get('piper_voices')) || {});
            } catch {
                if (live) setError(t('models.piper_unavailable'));
            }
        };
        load();
        const timer = setInterval(load, 1500);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [open]);
    const run = async (id, action) => {
        setError('');
        setBusy(id);
        try {
            await action();
            await refresh();
        } catch (e) {
            if (!String(e).toLowerCase().includes('cancelled')) setError(String(e));
        } finally {
            setBusy('');
        }
    };
    const select = async (voice) => {
        const previous = (await store.get('piper_voices')) || {};
        const next = { ...previous, [voice.language]: voice.id };
        await store.set('piper_voices', next);
        try {
            await store.save();
        } catch (e) {
            await store.set('piper_voices', previous);
            throw e;
        }
        await emit('piper_voices_changed', next);
        setPreferences(next);
    };
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
                        <h2>{t('models.piper_title')}</h2>
                        <p>{t('models.piper_intro')}</p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    <Input
                        size='sm'
                        variant='bordered'
                        aria-label={t('models.piper_search')}
                        placeholder={t('models.piper_search')}
                        value={search}
                        onValueChange={setSearch}
                    />
                    <p className='piper-hint'>{t('models.piper_routing')}</p>
                    {error && (
                        <p
                            role='alert'
                            className='model-catalog-error'
                        >
                            {error}
                        </p>
                    )}
                    {!catalog.length && <p>{t('models.piper_loading')}</p>}
                    <div className='piper-voice-list'>
                        {catalog
                            .filter(({ voice: v }) =>
                                `${v.name} ${v.locale} ${t(`languages.${v.language === 'zh' ? 'zh_cn' : v.language}`)}`
                                    .toLowerCase()
                                    .includes(search.toLowerCase())
                            )
                            .map(({ voice: v, installed, task }) => {
                                const active = piperTaskActive(task);
                                const selected = preferences[v.language] === v.id;
                                return (
                                    <article
                                        className={`piper-voice-card ${selected && installed ? 'selected' : ''}`}
                                        key={v.id}
                                    >
                                        <div className='piper-voice-heading'>
                                            <div>
                                                <strong>{v.name}</strong>
                                                <span>
                                                    {v.locale.replace('_', '-')} · {v.quality} ·{' '}
                                                    {(voiceBytes(v) / 1e6).toFixed(1)} MB
                                                </span>
                                            </div>
                                            <span className='models-status ready'>
                                                {installed ? t('models.ready') : ''}
                                            </span>
                                        </div>
                                        <div className='piper-voice-actions'>
                                            <Button
                                                size='sm'
                                                variant='bordered'
                                                isDisabled={!!busy || active}
                                                onPress={() => {
                                                    if (playing === v.id && speech.status !== 'idle') {
                                                        speech.stop();
                                                        return;
                                                    }
                                                    speech.stop();
                                                    setPlaying(v.id);
                                                    speech
                                                        .toggle(() => invoke('piper_preview', { id: v.id }))
                                                        .catch(() => setError(t('models.piper_preview_failed')));
                                                }}
                                            >
                                                {playing === v.id && speech.status !== 'idle'
                                                    ? t(
                                                          speech.status === 'loading'
                                                              ? 'models.piper_preview_loading'
                                                              : 'models.piper_stop'
                                                      )
                                                    : t(
                                                          installed
                                                              ? 'models.piper_preview_local'
                                                              : 'models.piper_preview_online'
                                                      )}
                                            </Button>
                                            {installed ? (
                                                <>
                                                    <Button
                                                        size='sm'
                                                        className={
                                                            selected
                                                                ? 'service-secondary-button'
                                                                : 'service-primary-button'
                                                        }
                                                        isDisabled={!!busy || selected}
                                                        onPress={() => run(v.id, () => select(v))}
                                                    >
                                                        {t(selected ? 'models.piper_selected' : 'models.piper_use')}
                                                    </Button>
                                                    <Button
                                                        size='sm'
                                                        variant='light'
                                                        color='danger'
                                                        isDisabled={!!busy || active}
                                                        onPress={() => {
                                                            speech.stop();
                                                            setRemoving(v.id);
                                                        }}
                                                    >
                                                        {t('models.piper_remove')}
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button
                                                    size='sm'
                                                    className='service-primary-button'
                                                    isLoading={busy === v.id || active}
                                                    isDisabled={!!busy || active || !accepted[v.id]}
                                                    onPress={() =>
                                                        run(v.id, async () => {
                                                            await invoke('piper_download', {
                                                                id: v.id,
                                                                accepted: !!accepted[v.id],
                                                            });
                                                            if (!preferences[v.language]) await select(v);
                                                        })
                                                    }
                                                >
                                                    {t('models.piper_download')}
                                                </Button>
                                            )}
                                            {active && task.state === 'downloading' && (
                                                <Button
                                                    size='sm'
                                                    variant='light'
                                                    onPress={() =>
                                                        invoke('piper_cancel', { id: v.id })
                                                            .then(refresh)
                                                            .catch(() => setError(t('models.piper_unavailable')))
                                                    }
                                                >
                                                    {t('common.cancel')}
                                                </Button>
                                            )}
                                        </div>
                                        {active && (
                                            <div className='piper-progress'>
                                                <Progress
                                                    size='sm'
                                                    aria-label={t('models.piper_download')}
                                                    value={task.total ? (100 * task.downloaded) / task.total : 0}
                                                />
                                                <span>
                                                    {(task.downloaded / 1e6).toFixed(1)} /{' '}
                                                    {(task.total / 1e6).toFixed(1)} MB ·{' '}
                                                    {t(
                                                        task.state === 'checking'
                                                            ? 'models.piper_checking'
                                                            : 'models.piper_downloading'
                                                    )}
                                                </span>
                                            </div>
                                        )}
                                        {task.error && (
                                            <p
                                                role='alert'
                                                className='model-catalog-error'
                                            >
                                                {task.error}
                                            </p>
                                        )}
                                        {task.state === 'cancelled' && (
                                            <p className='piper-hint'>{t('models.piper_cancelled')}</p>
                                        )}
                                        <details className='models-details'>
                                            <summary>{t('models.piper_license')}</summary>
                                            <p className='piper-hint'>
                                                rhasspy/piper-voices · {v.revision.slice(0, 12)} · ONNX / CPU
                                            </p>
                                            <pre className='piper-model-card'>{v.modelCard}</pre>
                                            <a
                                                href={`https://huggingface.co/rhasspy/piper-voices/blob/${v.revision}/${v.base.split('/').slice(-4).join('/')}/MODEL_CARD`}
                                                target='_blank'
                                                rel='noreferrer'
                                            >
                                                {t('models.piper_source')}
                                            </a>
                                        </details>
                                        {!installed && (
                                            <Checkbox
                                                size='sm'
                                                isSelected={!!accepted[v.id]}
                                                onValueChange={(value) => setAccepted({ ...accepted, [v.id]: value })}
                                            >
                                                {t('models.piper_ack')}
                                            </Checkbox>
                                        )}
                                        {removing === v.id && (
                                            <div className='piper-remove-confirm'>
                                                <p>{t('models.piper_remove_confirm')}</p>
                                                <Button
                                                    size='sm'
                                                    color='danger'
                                                    onPress={() =>
                                                        run(v.id, async () => {
                                                            await invoke('piper_uninstall', { id: v.id });
                                                            const previous = (await store.get('piper_voices')) || {};
                                                            if (previous[v.language] === v.id) {
                                                                const next = { ...previous };
                                                                delete next[v.language];
                                                                await store.set('piper_voices', next);
                                                                await store.save();
                                                                await emit('piper_voices_changed', next);
                                                            }
                                                            setRemoving('');
                                                        })
                                                    }
                                                >
                                                    {t('models.piper_confirm_remove')}
                                                </Button>
                                                <Button
                                                    size='sm'
                                                    variant='light'
                                                    onPress={() => setRemoving('')}
                                                >
                                                    {t('common.cancel')}
                                                </Button>
                                            </div>
                                        )}
                                    </article>
                                );
                            })}
                    </div>
                </ModalBody>
                <ModalFooter>
                    <span>{t('models.piper_footer')}</span>
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
