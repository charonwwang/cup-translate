import ModelWizardSteps from './ModelWizardSteps';
import React, { useEffect, useRef, useState } from 'react';
import {
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Button,
    Select,
    SelectItem,
    Checkbox,
    Progress,
} from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/tauri';
import { emit } from '@tauri-apps/api/event';
import { saveQwenSettings } from '../../../../utils/qwenConfig.js';
import { store } from '../../../../utils/store';
import { useSpeech } from '../../../../hooks/useSpeech';

const voices = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'];
const active = (state) => ['checking', 'runtime', 'dependencies', 'model', 'verifying', 'warming'].includes(state);
const gb = (value) => `${(Number(value || 0) / 1e9).toFixed(2)} GB`;
export default function QwenSpeech({ open, onClose, mode = 'models' }) {
    const { t } = useTranslation();
    const [step, setStep] = useState(1);
    const [voice, setVoice] = useState('Vivian');
    const [variant, setVariant] = useState('0.6B');
    const [status, setStatus] = useState(null);
    const [device, setDevice] = useState(null);
    const [environment, setEnvironment] = useState('');
    const [accepted, setAccepted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const original = useRef({ variant: '0.6B', voice: 'Vivian' });
    const [discarding, setDiscarding] = useState(false);
    const [saving, setSaving] = useState(false);
    const [ready, setReady] = useState(false);
    const [enableAfterSave, setEnableAfterSave] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [notice, setNotice] = useState('');
    const [previewStarted, setPreviewStarted] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const speech = useSpeech('qwen-settings');
    const installed = status?.models?.[variant];
    const task = status?.task?.variant === variant ? status.task : {};
    const running = active(task?.state);
    const chosen = device?.environments?.find((entry) => entry.python === environment);
    const required = Number(device?.modelBytes || 0) + (chosen?.ready ? 1e9 : 5e9);
    const checksPassed = device?.supported && device.diskAvailable >= required && accepted;
    useEffect(() => {
        if (!open) return;
        const id = ++generation.current;
        setError('');
        setReady(false);
        setDiscarding(false);
        setStatus(null);
        setBusy(false);
        setDevice(null);
        setAccepted(false);
        setEnableAfterSave(false);
        setRemoving(false);
        setNotice('');
        setPreviewStarted(0);
        Promise.all([store.get('qwen_tts'), invoke('qwen_status')])
            .then(([config, value]) => {
                if (id !== generation.current) return;
                const selection = config?.variant || '0.6B';
                original.current = { variant: selection, voice: config?.voice || 'Vivian' };
                setReady(true);
                setVariant(selection);
                setVoice(config?.voice || 'Vivian');
                setStatus(value);
                setStep(active(value?.task?.state) || value?.models?.[selection] ? 3 : 1);
            })
            .catch((failure) => id === generation.current && setError(`${t('models.qwen_failed')} ${String(failure)}`));
        return () => {
            generation.current++;
            speech.stop();
        };
    }, [open]);
    useEffect(() => {
        if (!open) return;
        let live = true;
        let pending = false;
        const timer = setInterval(async () => {
            if (pending) return;
            pending = true;
            try {
                const value = await invoke('qwen_status');
                if (live) {
                    setStatus(value);
                    if (previewStarted) setElapsed(Math.floor((Date.now() - previewStarted) / 1000));
                }
            } catch {
                /* Preserve status during a transient IPC failure. */
            } finally {
                pending = false;
            }
        }, 1000);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [open, previewStarted]);
    const stopPreview = async () => {
        const loading = speech.status === 'loading';
        speech.stop();
        setPreviewStarted(0);
        if (loading) await invoke('qwen_stop');
    };
    const check = async () => {
        setStep(2);
        setBusy(true);
        setDevice(null);
        setError('');
        setAccepted(false);
        const id = generation.current;
        try {
            const result = await invoke('qwen_device_check', { variant });
            if (generation.current !== id) return;
            setDevice(result);
            setEnvironment(result.environments[0]?.python || '');
        } catch (failure) {
            if (generation.current === id) setError(String(failure));
        } finally {
            if (generation.current === id) setBusy(false);
        }
    };
    const close = () => {
        if (saving || busy) return;
        void stopPreview().catch((failure) => setError(String(failure)));
        if (ready && (voice !== original.current.voice || variant !== original.current.variant || enableAfterSave)) {
            setDiscarding(true);
            return;
        }
        generation.current++;
        onClose();
    };
    const install = async () => {
        const id = generation.current;
        setBusy(true);
        setError('');
        try {
            await invoke('qwen_install', { variant, environment: environment || null });
            const value = await invoke('qwen_status');
            if (id === generation.current) setStatus(value);
        } catch (failure) {
            if (id === generation.current) setError(String(failure));
        } finally {
            if (id === generation.current) setBusy(false);
        }
    };
    const test = async (live = false) => {
        const id = generation.current;
        setError('');
        setNotice('');
        try {
            if (speech.status !== 'idle') {
                await stopPreview();
                return;
            }
            setPreviewStarted(Date.now());
            setElapsed(0);
            await speech.toggle(() =>
                live
                    ? invoke('qwen_tts_request', { variant, text: '你好。', language: 'Chinese', voice })
                    : invoke('qwen_preview', { variant, voice })
            );
        } catch (failure) {
            if (id === generation.current) setError(String(failure));
        }
    };
    const release = async () => {
        const id = generation.current;
        speech.stop();
        setBusy(true);
        setError('');
        setNotice('');
        setPreviewStarted(0);
        try {
            await invoke('qwen_stop');
            const value = await invoke('qwen_status');
            if (id === generation.current) {
                setStatus(value);
                setNotice(t('models.qwen_released'));
            }
        } catch (failure) {
            if (id === generation.current) setError(String(failure));
        } finally {
            if (id === generation.current) setBusy(false);
        }
    };
    const remove = async () => {
        const id = generation.current;
        speech.stop();
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await invoke('qwen_remove', { variant });
            const value = await invoke('qwen_status');
            if (id !== generation.current) return;
            setStatus(value);
            setRemoving(false);
            setDevice(null);
            setAccepted(false);
            setStep(1);
            setNotice(t('models.qwen_removed'));
        } catch (failure) {
            if (id === generation.current) setError(String(failure));
        } finally {
            if (id === generation.current) setBusy(false);
        }
    };
    const save = async (enable = false) => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            await stopPreview();
            await saveQwenSettings(store, emit, { variant, voice }, { register: mode === 'service', enable });
            generation.current++;
            onClose();
        } catch (failure) {
            setError(String(failure));
        } finally {
            setSaving(false);
        }
    };
    return (
        <Modal
            disableAnimation
            isOpen={open}
            onClose={close}
            isDismissable={!saving && !busy}
            isKeyboardDismissDisabled={saving || busy}
            hideCloseButton={saving || busy}
            size='3xl'
            scrollBehavior='inside'
            classNames={{
                base: 'model-install-dialog',
                header: 'model-install-header',
                body: 'model-install-body',
                footer: 'model-install-footer qwen-ready-footer',
            }}
        >
            <ModalContent>
                <ModalHeader>
                    <div>
                        <span className='model-dialog-eyebrow'>{t('models.install_manager')}</span>
                        <h2>
                            Qwen3-TTS <span className='models-badge'>{variant} · CustomVoice</span>
                        </h2>
                        <p>{t('models.qwen_intro')}</p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    <ModelWizardSteps step={step} />
                    {active(status?.task?.state) && status.task.variant !== variant && (
                        <p role='status'>
                            {status.task.variant} · {t(`models.qwen_stage_${status.task.state}`)}
                        </p>
                    )}
                    {step === 1 && (
                        <>
                            <Select
                                label={t('models.qwen_variant')}
                                selectedKeys={[variant]}
                                onSelectionChange={(keys) => {
                                    speech.stop();
                                    setVariant([...keys][0] || '0.6B');
                                    setDevice(null);
                                }}
                            >
                                <SelectItem key='0.6B'>0.6B CustomVoice · 2.50 GB</SelectItem>
                                <SelectItem key='1.7B'>1.7B CustomVoice · 4.52 GB</SelectItem>
                            </Select>
                            <p>{t('models.qwen_languages')}</p>
                            <p>{t('models.qwen_dependencies_detail')}</p>
                            <p>{t('models.qwen_memory', { size: variant === '0.6B' ? 8 : 16 })}</p>
                            <p>Qwen · Apache-2.0 · huggingface.co/Qwen</p>
                        </>
                    )}
                    {step === 2 && (
                        <>
                            {busy && <p role='status'>{t('models.qwen_checking_environment')}</p>}
                            {device && (
                                <>
                                    <div className='model-catalog-info'>
                                        <div>
                                            <small>{t('models.download_size')}</small>
                                            <p>{t('models.qwen_model_download', { size: gb(device.modelBytes) })}</p>
                                        </div>
                                        <div>
                                            <small>{t('models.qwen_runtime_plan')}</small>
                                            <p>
                                                {t(
                                                    chosen?.ready
                                                        ? 'models.qwen_reuse_full'
                                                        : device.downloadPython
                                                          ? 'models.qwen_download_python'
                                                          : 'models.qwen_reuse_python'
                                                )}
                                            </p>
                                        </div>
                                        <div>
                                            <small>{t('models.qwen_dependency_download')}</small>
                                            <p>
                                                {chosen?.ready
                                                    ? t('models.qwen_no_dependency_download')
                                                    : t('models.qwen_dependency_estimate')}
                                            </p>
                                        </div>
                                        <div>
                                            <small>{t('models.check_disk')}</small>
                                            <p>
                                                {gb(device.diskAvailable)} {t('models.available')} ·{' '}
                                                {t('models.qwen_disk_required', { size: gb(required) })}
                                            </p>
                                        </div>
                                    </div>
                                    {!!device.environments.length && (
                                        <Select
                                            label={t('models.qwen_detected_environment')}
                                            selectedKeys={environment ? [environment] : []}
                                            onSelectionChange={(keys) => setEnvironment([...keys][0] || '')}
                                        >
                                            {device.environments.map((entry) => (
                                                <SelectItem
                                                    key={entry.python}
                                                    textValue={`Python ${entry.version} · ${entry.python}`}
                                                >
                                                    <span>
                                                        Python {entry.version} ·{' '}
                                                        {t(
                                                            entry.ready
                                                                ? 'models.qwen_reusable'
                                                                : 'models.qwen_needs_dependencies'
                                                        )}
                                                    </span>
                                                    <small className='block break-all'>{entry.python}</small>
                                                </SelectItem>
                                            ))}
                                        </Select>
                                    )}
                                    <p>{t('models.qwen_reuse_safety')}</p>
                                    <p>{t('models.qwen_dependencies_detail')}</p>
                                    {!device.supported && <p role='alert'>{t('models.qwen_platform_unsupported')}</p>}
                                    {device.diskAvailable < required && (
                                        <p role='alert'>{t('models.qwen_disk_insufficient')}</p>
                                    )}
                                    <Checkbox
                                        isSelected={accepted}
                                        onValueChange={setAccepted}
                                    >
                                        {t('models.qwen_download_ack')}
                                    </Checkbox>
                                </>
                            )}
                        </>
                    )}
                    {step === 3 && (
                        <>
                            {installed && (
                                <div className='qwen-ready-card'>
                                    <strong>{t('models.qwen_files_ready')}</strong>
                                    <p>{t('models.qwen_already_downloaded', { size: gb(installed.modelBytes) })}</p>
                                    <p>
                                        {t(
                                            `models.qwen_runtime_${status?.runtime?.variant && status.runtime.variant !== variant ? 'unloaded' : status?.runtime?.state || 'unloaded'}`
                                        )}
                                    </p>
                                </div>
                            )}
                            {!installed && <p>{t('models.qwen_install_plan')}</p>}
                            {(running || ['failed', 'cancelled'].includes(task?.state)) && (
                                <div className='models-transfer'>
                                    {!task.total && (
                                        <Progress
                                            aria-label={t('models.progress')}
                                            isIndeterminate
                                        />
                                    )}
                                    <p role='status'>
                                        {t(`models.qwen_stage_${task.state}`)}
                                        {task.fallback === 'cpu' && ` · ${t('models.qwen_cpu_fallback')}`}
                                        {task.file ? ` · ${task.file}` : ''}
                                    </p>
                                    {task.total > 0 && (
                                        <>
                                            <Progress
                                                aria-label={t('models.progress')}
                                                value={(Number(task.bytes || 0) / task.total) * 100}
                                            />
                                            <p>
                                                {gb(task.bytes)} / {gb(task.total)}
                                            </p>
                                        </>
                                    )}
                                    {task.error && <p role='alert'>{task.error}</p>}
                                </div>
                            )}
                            {installed && (
                                <>
                                    <div className='qwen-preview-row'>
                                        <Select
                                            label={t('models.qwen_voice')}
                                            selectedKeys={[voice]}
                                            isDisabled={busy || saving || !ready}
                                            onSelectionChange={(keys) => {
                                                void stopPreview().catch((failure) => setError(String(failure)));
                                                setVoice([...keys][0] || 'Vivian');
                                            }}
                                        >
                                            {voices.map((name) => (
                                                <SelectItem key={name}>{name}</SelectItem>
                                            ))}
                                        </Select>
                                        <Button
                                            isDisabled={busy || saving || !ready}
                                            onPress={() => test(false)}
                                        >
                                            {t(
                                                speech.status === 'idle'
                                                    ? 'models.qwen_test'
                                                    : 'models.qwen_preview_stop'
                                            )}
                                        </Button>
                                    </div>
                                    <p className='qwen-state-note'>{t('models.qwen_preview_cache_hint')}</p>
                                </>
                            )}
                            <details className='models-details'>
                                <summary>{t('models.qwen_storage_settings')}</summary>
                                {installed && (
                                    <>
                                        <p>{t('models.qwen_autostart_hint')}</p>
                                        <p>{t('models.qwen_save_hint')}</p>
                                        <div className='qwen-resource-actions'>
                                            <Button
                                                isDisabled={busy || saving || !ready || speech.status !== 'idle'}
                                                onPress={() => test(true)}
                                            >
                                                {t('models.qwen_live_test')}
                                            </Button>
                                            <Button
                                                isDisabled={busy || saving || !ready}
                                                onPress={release}
                                            >
                                                {t('models.catalog_unload')}
                                            </Button>
                                            <Button
                                                isDisabled={busy || saving || !ready}
                                                onPress={() => {
                                                    void stopPreview().catch((failure) => setError(String(failure)));
                                                    setStep(1);
                                                }}
                                            >
                                                {t('models.qwen_other_variant')}
                                            </Button>
                                            <Button
                                                className='qwen-danger'
                                                isDisabled={busy || saving || !ready || active(status?.task?.state)}
                                                onPress={() => setRemoving(true)}
                                            >
                                                {t('models.qwen_remove_model')}
                                            </Button>
                                        </div>
                                        {removing && (
                                            <div
                                                className='qwen-remove-confirm'
                                                role='alert'
                                            >
                                                <p>
                                                    {t(
                                                        installed.managedFiles
                                                            ? 'models.qwen_remove_confirm'
                                                            : 'models.qwen_detach_confirm',
                                                        { size: gb(installed.modelBytes) }
                                                    )}
                                                </p>
                                                <div className='qwen-resource-actions'>
                                                    <Button
                                                        isDisabled={busy}
                                                        onPress={() => setRemoving(false)}
                                                    >
                                                        {t('common.cancel')}
                                                    </Button>
                                                    <Button
                                                        className='qwen-danger'
                                                        isDisabled={busy}
                                                        onPress={remove}
                                                    >
                                                        {t('models.qwen_remove_confirm_button')}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )}
                                <p>{t('models.qwen_dependencies_detail')}</p>
                                <p>
                                    {t('models.qwen_actual_device')}: {installed?.device}
                                </p>
                                {installed?.device === 'cpu' && <p>{t('models.qwen_cpu_compat_hint')}</p>}
                                <p>{installed?.python}</p>
                                <p>{installed?.model}</p>
                                <p>{status?.logPath}</p>
                                <p>{status?.installLogPath}</p>
                            </details>
                        </>
                    )}
                    {speech.status !== 'idle' && (
                        <p
                            className='qwen-preview-status'
                            role='status'
                        >
                            {t(`models.qwen_preview_${speech.status}`, { seconds: elapsed })}
                        </p>
                    )}
                    {notice && (
                        <p
                            className='qwen-preview-status'
                            role='status'
                        >
                            {notice}
                        </p>
                    )}
                    {error && (
                        <div role='alert'>
                            <p>{t('models.qwen_action_failed')}</p>
                            <details>
                                <summary>{t('models.version_details')}</summary>
                                <pre className='whitespace-pre-wrap break-all select-text'>{error}</pre>
                                <p>{status?.logPath}</p>
                            </details>
                        </div>
                    )}
                    {discarding && (
                        <div role='alert'>
                            <p>{t('models.qwen_discard_prompt')}</p>
                            <Button
                                onPress={() => {
                                    speech.stop();
                                    generation.current++;
                                    onClose();
                                }}
                            >
                                {t('models.qwen_discard')}
                            </Button>
                            <Button onPress={() => setDiscarding(false)}>{t('models.qwen_keep_editing')}</Button>
                        </div>
                    )}
                </ModalBody>
                <ModalFooter>
                    {step === 1 && (
                        <Button
                            className='service-primary-button'
                            isDisabled={!ready || saving}
                            onPress={installed ? () => setStep(3) : check}
                        >
                            {t(installed ? 'models.manage_install' : 'models.wizard_next')}
                        </Button>
                    )}
                    {step === 2 && (
                        <>
                            <Button
                                variant='light'
                                isDisabled={busy || saving || !ready}
                                onPress={() => setStep(1)}
                            >
                                {t('models.wizard_back')}
                            </Button>
                            <Button
                                className='service-primary-button'
                                isDisabled={!checksPassed || busy}
                                onPress={() => setStep(3)}
                            >
                                {t('models.wizard_to_install')}
                            </Button>
                        </>
                    )}
                    {step === 3 && !installed && !running && (
                        <>
                            <Button
                                variant='light'
                                isDisabled={busy || saving || !ready}
                                onPress={check}
                            >
                                {t('models.wizard_back_check')}
                            </Button>
                            <Button
                                className='service-primary-button'
                                isDisabled={busy || !checksPassed}
                                onPress={install}
                            >
                                {t(
                                    task.state === 'failed' || task.state === 'cancelled'
                                        ? 'models.resume'
                                        : 'models.begin_install'
                                )}
                            </Button>
                        </>
                    )}
                    {running && (
                        <Button
                            variant='light'
                            onPress={() => invoke('qwen_cancel').catch((failure) => setError(String(failure)))}
                        >
                            {t('common.cancel')}
                        </Button>
                    )}
                    {step === 3 && installed && (
                        <>
                            <Checkbox
                                isSelected={enableAfterSave}
                                isDisabled={busy || saving || !ready}
                                onValueChange={setEnableAfterSave}
                            >
                                {t('models.qwen_enable_after_save')}
                            </Checkbox>
                        </>
                    )}
                    <div className='qwen-footer-actions'>
                        <Button
                            variant='light'
                            isDisabled={saving || busy}
                            onPress={close}
                        >
                            {t(active(status?.task?.state) ? 'models.close_background' : 'common.close')}
                        </Button>
                        {step === 3 && installed && (
                            <Button
                                className='service-primary-button'
                                isDisabled={busy || saving || !ready}
                                onPress={() => save(enableAfterSave)}
                            >
                                {t('common.save')}
                            </Button>
                        )}
                    </div>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
