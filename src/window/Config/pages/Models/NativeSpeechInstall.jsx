import React, { useEffect, useState } from 'react';
import {
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Button,
    Checkbox,
    Progress,
} from '@nextui-org/react';
import { invoke } from '@tauri-apps/api/tauri';
import { useTranslation } from 'react-i18next';
import ModelWizardSteps from './ModelWizardSteps';

export default function NativeSpeechInstall({ open, family, voice, model, onBack, onClose, onInstalled }) {
    const { t } = useTranslation();
    const [step, setStep] = useState(2);
    const [device, setDevice] = useState(null);
    const [accepted, setAccepted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [task, setTask] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!open) return;
        let live = true;
        setStep(2);
        setDevice(null);
        setAccepted(false);
        setDone(false);
        setError('');
        invoke('native_speech_device_check', { family, voiceId: voice?.id || null })
            .then((value) => live && setDevice(value))
            .catch((failure) => live && setError(String(failure)));
        return () => {
            live = false;
        };
    }, [open, family, voice?.id]);
    useEffect(() => {
        if (!open || !busy) return;
        let live = true;
        const timer = setInterval(async () => {
            try {
                const value = await invoke(family === 'kokoro' ? 'kokoro_model_status' : 'piper_catalog');
                const transfer =
                    family === 'kokoro' ? value.task : value.voices?.find((item) => item.voice.id === voice.id)?.task;
                if (live) setTask(transfer);
            } catch {
                /* Keep the last transfer state. */
            }
        }, 1000);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [open, busy, family, voice?.id]);
    const enough = device?.supported && device.diskAvailable >= device.diskRequired;
    const install = async () => {
        if (step !== 3 || !enough || !accepted || busy) return;
        setBusy(true);
        setError('');
        try {
            if (family === 'kokoro') await invoke('kokoro_download', { accepted });
            else await invoke('piper_download', { id: voice.id, accepted });
            await onInstalled();
            setDone(true);
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal
            disableAnimation
            isOpen={open}
            onClose={onClose}
            size='2xl'
            scrollBehavior='inside'
            classNames={{
                base: 'model-install-dialog',
                header: 'model-install-header',
                body: 'model-install-body',
                footer: 'model-install-footer',
            }}
        >
            <ModalContent>
                <ModalHeader>
                    <div>
                        <span className='model-dialog-eyebrow'>{t('models.install_manager')}</span>
                        <h2>{family === 'kokoro' ? 'Kokoro · 82M · INT8' : `Piper · ${voice?.name || ''}`}</h2>
                        <p>{t('models.native_install_intro')}</p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    <ModelWizardSteps step={step} />
                    {!device && !error && <p role='status'>{t('models.checking')}</p>}
                    {device && (
                        <div className='model-catalog-info'>
                            <div>
                                <small>{t('models.check_runtime')}</small>
                                <p>
                                    {device.platform} / {device.architecture} ·{' '}
                                    {t(device.supported ? 'models.compatible' : 'models.incompatible')}
                                </p>
                            </div>
                            <div>
                                <small>{t('models.qwen_runtime_plan')}</small>
                                <p>{t('models.native_runtime_reuse')}</p>
                            </div>
                            <div>
                                <small>{t('models.download_size')}</small>
                                <p>
                                    {(device.modelBytes / 1e6).toFixed(1)} MB ·{' '}
                                    {t('models.native_dependencies_included')}
                                </p>
                            </div>
                            <div>
                                <small>{t('models.check_disk')}</small>
                                <p>
                                    {(device.diskAvailable / 1e9).toFixed(2)} GB {t('models.available')} ·{' '}
                                    {t('models.qwen_disk_required', {
                                        size: `${(device.diskRequired / 1e9).toFixed(2)} GB`,
                                    })}
                                </p>
                            </div>
                        </div>
                    )}
                    {device?.reason && <p role='alert'>{device.reason}</p>}
                    {device && !enough && <p role='alert'>{t('models.qwen_disk_insufficient')}</p>}
                    {step === 2 && (
                        <>
                            <p>{t(family === 'kokoro' ? 'models.kokoro_license_hint' : 'models.piper_routing')}</p>
                            {model?.archiveSha256 && (
                                <p className='select-text break-all'>SHA256 {model.archiveSha256}</p>
                            )}
                            {(model?.url || voice?.base) && (
                                <a
                                    href={
                                        family === 'kokoro'
                                            ? 'https://huggingface.co/hexgrad/Kokoro-82M'
                                            : `https://huggingface.co/rhasspy/piper-voices/tree/${voice.revision}`
                                    }
                                    target='_blank'
                                    rel='noreferrer'
                                >
                                    {t('models.piper_source')}
                                </a>
                            )}
                            {voice?.modelCard && (
                                <details className='models-details'>
                                    <summary>{t('models.piper_license')}</summary>
                                    <pre className='piper-model-card'>{voice.modelCard}</pre>
                                </details>
                            )}
                            <Checkbox
                                isSelected={accepted}
                                onValueChange={setAccepted}
                            >
                                {t(family === 'kokoro' ? 'models.kokoro_ack' : 'models.piper_ack')}
                            </Checkbox>
                        </>
                    )}
                    {step === 3 && !done && <p>{t('models.native_install_plan')}</p>}
                    {busy && (
                        <>
                            <Progress
                                aria-label={t('models.progress')}
                                isIndeterminate={!task?.total}
                                value={task?.total ? (Number(task.downloaded || 0) / task.total) * 100 : 0}
                            />
                            <p role='status'>
                                {t(task?.state === 'checking' ? 'models.piper_checking' : 'models.piper_downloading')}
                                {task?.total
                                    ? ` · ${(Number(task.downloaded || 0) / 1e6).toFixed(1)} / ${(task.total / 1e6).toFixed(1)} MB`
                                    : ''}
                            </p>
                        </>
                    )}
                    {done && <div className='service-install-success'>{t('models.native_install_done')}</div>}
                    {error && <p role='alert'>{error}</p>}
                </ModalBody>
                <ModalFooter>
                    {step === 2 && (
                        <>
                            <Button
                                variant='light'
                                onPress={onBack}
                            >
                                {t('models.wizard_back')}
                            </Button>
                            <Button
                                className='service-primary-button'
                                isDisabled={!enough || !accepted}
                                onPress={() => setStep(3)}
                            >
                                {t('models.wizard_to_install')}
                            </Button>
                        </>
                    )}
                    {step === 3 && !busy && !done && (
                        <>
                            <Button
                                variant='light'
                                onPress={() => setStep(2)}
                            >
                                {t('models.wizard_back_check')}
                            </Button>
                            <Button
                                className='service-primary-button'
                                isDisabled={!enough || !accepted}
                                onPress={install}
                            >
                                {t('models.begin_install')}
                            </Button>
                        </>
                    )}
                    {busy && (
                        <Button
                            variant='light'
                            onPress={() =>
                                invoke(
                                    family === 'kokoro' ? 'kokoro_cancel' : 'piper_cancel',
                                    family === 'piper' ? { id: voice.id } : {}
                                ).catch((failure) => setError(String(failure)))
                            }
                        >
                            {t('common.cancel')}
                        </Button>
                    )}
                    <Button
                        className={done ? 'service-primary-button' : ''}
                        variant={done ? 'solid' : 'light'}
                        onPress={onClose}
                    >
                        {t(done ? 'models.save_and_close' : busy ? 'models.close_background' : 'common.close')}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
