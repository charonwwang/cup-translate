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
import { store } from '../../../../utils/store';
import { useSpeech } from '../../../../hooks/useSpeech';

const voices = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'];
const active = (state) => ['checking', 'runtime', 'dependencies', 'model', 'verifying', 'warming'].includes(state);
const gb = (value) => `${(Number(value || 0) / 1e9).toFixed(2)} GB`;
export default function QwenSpeech({ open, onClose, onSaved }) {
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
        setBusy(false);
        setDevice(null);
        setAccepted(false);
        Promise.all([store.get('qwen_tts'), invoke('qwen_status')])
            .then(([config, value]) => {
                if (id !== generation.current) return;
                const selection = active(value?.task?.state) ? value.task.variant : config?.variant || '0.6B';
                setVariant(selection);
                setVoice(config?.voice || 'Vivian');
                setStatus(value);
                setStep(active(value?.task?.state) || value?.models?.[selection] ? 3 : 1);
            })
            .catch(() => id === generation.current && setError(t('models.qwen_failed')));
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
                if (live) setStatus(value);
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
    }, [open]);
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
    const install = async () => {
        setBusy(true);
        setError('');
        try {
            await invoke('qwen_install', { variant, environment: environment || null });
            setStatus(await invoke('qwen_status'));
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(false);
        }
    };
    const test = async () => {
        setBusy(true);
        setError('');
        try {
            await speech.toggle(() =>
                invoke('qwen_tts_request', { variant, text: '你好，这是语音测试。 Hello.', language: 'Chinese', voice })
            );
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(false);
        }
    };
    const save = async () => {
        setBusy(true);
        try {
            const config = { variant, voice, configured: true };
            await store.set('qwen_tts', config);
            await store.save();
            await emit('qwen_tts_changed', config);
            await onSaved();
            onClose();
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
            size='3xl'
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
                        <h2>
                            Qwen3-TTS <span className='models-badge'>{variant} · CustomVoice</span>
                        </h2>
                        <p>{t('models.qwen_intro')}</p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    <ModelWizardSteps step={step} />
                    {step === 1 && (
                        <>
                            <Select
                                label={t('models.qwen_variant')}
                                selectedKeys={[variant]}
                                onSelectionChange={(keys) => {
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
                                <div className='service-install-success'>{t('models.qwen_install_verified')}</div>
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
                                    <Select
                                        label={t('models.qwen_voice')}
                                        selectedKeys={[voice]}
                                        isDisabled={busy}
                                        onSelectionChange={(keys) => setVoice([...keys][0] || 'Vivian')}
                                    >
                                        {voices.map((name) => (
                                            <SelectItem key={name}>{name}</SelectItem>
                                        ))}
                                    </Select>
                                    <p>{t('models.qwen_autostart_hint')}</p>
                                </>
                            )}
                            <details className='models-details'>
                                <summary>{t('models.version_details')}</summary>
                                <p>{t('models.qwen_dependencies_detail')}</p>
                                <p>
                                    {t('models.qwen_actual_device')}: {installed?.device}
                                </p>
                                <p>{installed?.python}</p>
                                <p>{installed?.model}</p>
                                <p>{status?.logPath}</p>
                            </details>
                        </>
                    )}
                    {error && <p role='alert'>{error}</p>}
                </ModalBody>
                <ModalFooter>
                    {step === 1 && (
                        <Button
                            className='service-primary-button'
                            onPress={installed ? () => setStep(3) : check}
                        >
                            {t(installed ? 'models.manage_install' : 'models.wizard_next')}
                        </Button>
                    )}
                    {step === 2 && (
                        <>
                            <Button
                                variant='light'
                                isDisabled={busy}
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
                                isDisabled={busy}
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
                            <Button
                                variant='light'
                                isDisabled={busy}
                                onPress={() => setStep(1)}
                            >
                                {t('models.qwen_other_variant')}
                            </Button>
                            <Button
                                isDisabled={busy}
                                isLoading={busy}
                                onPress={test}
                            >
                                {t('models.qwen_test')}
                            </Button>
                            <Button
                                variant='light'
                                isDisabled={busy}
                                onPress={() => invoke('qwen_stop').catch((failure) => setError(String(failure)))}
                            >
                                {t('models.catalog_unload')}
                            </Button>
                            <Button
                                className='service-primary-button'
                                isDisabled={busy}
                                onPress={save}
                            >
                                {t('models.save_and_close')}
                            </Button>
                        </>
                    )}
                    <Button
                        variant='light'
                        isDisabled={busy}
                        onPress={installed && !running ? save : onClose}
                    >
                        {t(running ? 'models.close_background' : 'common.close')}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
