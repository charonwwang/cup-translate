import React, { useState, useEffect } from 'react';
import ModelWizardSteps from './ModelWizardSteps';
import {
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Button,
    Switch,
    Checkbox,
    Progress,
} from '@nextui-org/react';
import { LuCpu, LuCheck, LuHardDrive, LuShieldCheck, LuInfo, LuArrowRight } from 'react-icons/lu';
import { useTranslation } from 'react-i18next';

export default function ModelInstallDialog({
    model = 'opus',
    open,
    onClose,
    device,
    status,
    license,
    setLicense,
    enable,
    setEnable,
    busy,
    onInstall,
    onSave,
}) {
    const { t } = useTranslation();
    const multi = model === 'm2m100';
    const modelPairs = multi ? ['m2m100'] : ['en-zh', 'zh-en'];
    const ready = modelPairs.every((pair) => status[pair]?.installed);
    const running =
        busy ||
        modelPairs
            .map((pair) => status[pair])
            .some((item) => ['queued', 'downloading', 'verifying', 'warming'].includes(item?.task?.state));
    const [step, setStep] = useState(2);
    useEffect(() => {
        if (open) setStep(ready || running ? 3 : 2);
    }, [open]);
    const close = () => (ready && !running ? onSave() : onClose());
    const enough = device?.diskAvailable >= device?.diskRequired;
    const compatible = device?.supported;
    const checks = [
        {
            icon: LuCpu,
            title: t('models.check_runtime'),
            detail: device
                ? `${device.platform === 'macos' ? 'macOS' : device.platform} · ${device.architecture}`
                : t('models.checking'),
            value: device ? (compatible ? t('models.compatible') : t('models.incompatible')) : '—',
            ok: compatible,
        },
        {
            icon: LuHardDrive,
            title: t('models.check_disk'),
            detail: t(multi ? 'models.multi_disk' : 'models.disk_reserve'),
            value: device?.diskAvailable
                ? `${(device.diskAvailable / 1e9).toFixed(1)} GB ${t('models.available')}`
                : '—',
            ok: enough,
        },
        {
            icon: LuInfo,
            title: t('models.check_memory'),
            detail: t(multi ? 'models.multi_memory' : 'models.memory_estimate_short'),
            value: t('models.unknown'),
            ok: null,
        },
        {
            icon: LuShieldCheck,
            title: t('models.check_license'),
            detail: multi ? 'Meta / M2M-100' : 'Helsinki-NLP / OPUS-MT',
            value: multi ? 'MIT' : 'Apache-2.0 / CC-BY-4.0',
            ok: true,
        },
    ];
    return (
        <Modal
            disableAnimation
            isOpen={open}
            onClose={close}
            onOpenChange={(isOpen) => {
                if (!isOpen) close();
            }}
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
                        <h2>
                            {ready
                                ? t('models.installed_heading')
                                : t(multi ? 'models.multi_install_heading' : 'models.install_heading')}
                        </h2>
                        <p>
                            {t(
                                ready
                                    ? 'models.installed_subtitle'
                                    : multi
                                      ? 'models.multi_install_subtitle'
                                      : 'models.install_subtitle'
                            )}
                        </p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    <ModelWizardSteps step={step} />
                    <div className='model-check-layout'>
                        <section className='model-check-card'>
                            <h3>{t('models.device_checks')}</h3>
                            {checks.map(({ icon: Icon, title, detail, value, ok }, index) => (
                                <div
                                    className='model-check-row'
                                    key={index}
                                >
                                    <span className={`model-check-icon ${ok ? 'ok' : ''}`}>
                                        <Icon size={14} />
                                    </span>
                                    <div>
                                        <strong>{title}</strong>
                                        <small>{detail}</small>
                                    </div>
                                    <span className='model-check-value'>{value}</span>
                                </div>
                            ))}
                            {device?.supported === false && <p role='alert'>{device.reason}</p>}
                        </section>
                        <section className='model-summary-card'>
                            <div className='model-summary-heading'>
                                <span>
                                    <LuCpu size={20} />
                                </span>
                                <div>
                                    <strong>{multi ? 'M2M-100 · 418M' : 'OPUS-MT'}</strong>
                                    <small>
                                        {t(multi ? 'models.multi_scope_short' : 'models.opus_language_scope')}
                                    </small>
                                </div>
                            </div>
                            <dl>
                                <dt>{t('models.download_size')}</dt>
                                <dd>{multi ? '496 MB' : '165 MB'}</dd>
                                <dt>{t('models.storage_label')}</dt>
                                <dd>{t('models.model_storage')}</dd>
                            </dl>
                            <div className='model-pair-status'>
                                {modelPairs.map((pair) => (
                                    <div key={pair}>
                                        <span>
                                            {multi ? (
                                                t('models.multi_one_download')
                                            ) : (
                                                <>
                                                    {pair === 'en-zh' ? 'English' : '简体中文'}{' '}
                                                    <LuArrowRight size={10} />{' '}
                                                    {pair === 'en-zh' ? '简体中文' : 'English'}
                                                </>
                                            )}
                                        </span>
                                        <b>
                                            {status[pair]?.installed ? (
                                                <>
                                                    <LuCheck size={11} />
                                                    {t('models.ready')}
                                                </>
                                            ) : (
                                                t('models.not_ready')
                                            )}
                                        </b>
                                    </div>
                                ))}
                            </div>
                            <div className='model-enable-row'>
                                <div>
                                    <strong>{t('models.service_enabled')}</strong>
                                    <small>{t('models.enable_scope_hint')}</small>
                                </div>
                                <Switch
                                    size='sm'
                                    aria-label={t('models.service_enabled')}
                                    isSelected={enable}
                                    onValueChange={setEnable}
                                />
                            </div>
                        </section>
                    </div>
                    {!ready && (
                        <div className='model-license-row'>
                            <Checkbox
                                size='sm'
                                isSelected={license}
                                onValueChange={setLicense}
                            >
                                {t(multi ? 'models.multi_license_ack' : 'models.license_ack_short')}
                            </Checkbox>
                            <span>
                                {multi ? 'Meta / facebook/m2m100_418M · MIT' : 'en→zh: Apache-2.0 · zh→en: CC-BY-4.0'}
                            </span>
                        </div>
                    )}
                    {running && (
                        <div className='model-running-tasks'>
                            {Object.entries(status)
                                .filter(
                                    ([pair, item]) =>
                                        modelPairs.includes(pair) && item?.task && item.task.state !== 'ready'
                                )
                                .map(([pair, item]) => (
                                    <div key={pair}>
                                        <div>
                                            <strong>
                                                {pair} · {t(`models.state_${item.task.state}`)}
                                            </strong>
                                            <span>
                                                {(item.task.bytes / 1e6).toFixed(1)} /{' '}
                                                {(item.task.total / 1e6).toFixed(1)} MB
                                            </span>
                                        </div>
                                        <Progress
                                            size='sm'
                                            aria-label={t('models.progress')}
                                            value={item.task.total ? (item.task.bytes / item.task.total) * 100 : 0}
                                        />
                                    </div>
                                ))}
                        </div>
                    )}
                    <div className='model-dialog-note'>
                        <LuShieldCheck size={14} />
                        <p>{t('models.manager_privacy_note')}</p>
                    </div>
                    <details className='models-details'>
                        <summary>{t('models.resource_details')}</summary>
                        <p>{t(multi ? 'models.multi_memory' : 'models.memory_unknown')}</p>
                        <p>{t('models.cancel_retains')}</p>
                    </details>
                </ModalBody>
                <ModalFooter>
                    <span>{running ? t('models.background_hint') : t('models.settings_languages_hint')}</span>
                    <Button
                        size='sm'
                        variant='light'
                        onPress={close}
                    >
                        {t(running ? 'models.close_background' : 'common.close')}
                    </Button>
                    {ready ? (
                        <Button
                            size='sm'
                            color='primary'
                            isDisabled={busy}
                            onPress={onSave}
                        >
                            {t('models.save_and_close')}
                        </Button>
                    ) : step === 2 ? (
                        <Button
                            size='sm'
                            color='primary'
                            isDisabled={!compatible || !enough || !license || running}
                            onPress={() => setStep(3)}
                        >
                            {t('models.wizard_to_install')}
                        </Button>
                    ) : (
                        <Button
                            size='sm'
                            color='primary'
                            isDisabled={!compatible || !enough || !license || running}
                            onPress={onInstall}
                        >
                            {t('models.begin_install')}
                        </Button>
                    )}
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
