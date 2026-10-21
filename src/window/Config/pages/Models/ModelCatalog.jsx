import React, { useEffect, useState } from 'react';
import {
    Button,
    Card,
    CardBody,
    Checkbox,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
    Progress,
    Select,
    SelectItem,
    Switch,
} from '@nextui-org/react';
import { LuCpu, LuLanguages, LuDownload, LuFolderInput, LuTrash2, LuCheck } from 'react-icons/lu';
import { invoke } from '@tauri-apps/api/tauri';
import { open as pickDirectory } from '@tauri-apps/api/dialog';
import { emit } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
    LOCAL_MODEL_CATALOG,
    filterLocalCatalog,
    localTaskRunning,
    resumableModelBase,
} from '../../../../utils/localModelCatalog';
import { findLocalInstance } from '../../../../utils/localModelInstance';
import { createServiceInstanceKey } from '../../../../utils/service_instance';
import { store } from '../../../../utils/store';
import { Config as LocalConfig } from '../../../../services/translate/local_mt/Config';

export default function ModelCatalog({
    status,
    refresh,
    act: parentAct,
    browseOpen = false,
    onBrowseClose = () => {},
    manageModelId,
    onManageHandled = () => {},
}) {
    const { t } = useTranslation();
    const [error, setError] = useState('');
    const act = (action) =>
        parentAct(async () => {
            setError('');
            try {
                return await action();
            } catch (failure) {
                setError(failure?.message ?? String(failure));
                throw failure;
            }
        });
    const [selected, setSelected] = useState(null);
    const [candidate, setCandidate] = useState('hymt-q4');
    const [family, setFamily] = useState(null);
    useEffect(() => {
        if (browseOpen) setFamily(null);
    }, [browseOpen]);
    const [installFinished, setInstallFinished] = useState(false);
    const [installedOnly, setInstalledOnly] = useState(false);
    const [device, setDevice] = useState(null);
    const [accepted, setAccepted] = useState(false);
    const [enabled, setEnabled] = useState(true);
    const [source, setSource] = useState('official');
    const [address, setAddress] = useState('');
    const [busyId, setBusyId] = useState('');
    const [instances, setInstances] = useState({});
    const [confirmRemoval, setConfirmRemoval] = useState(false);
    const [advanced, setAdvanced] = useState('');
    const refreshInstances = async () => {
        const opus = await findLocalInstance(store, 'opus');
        const multi = await findLocalInstance(store, 'm2m100');
        const hymt = await findLocalInstance(store, 'hymt');
        setInstances({ opus, m2m100: multi, hymt });
    };
    useEffect(() => {
        refreshInstances().catch(() => {});
    }, []);
    const item = selected ? status[selected.id] : null;
    const running = !!busyId || localTaskRunning(item);
    const canInstall =
        selected &&
        item &&
        item.supported !== false &&
        device?.supported &&
        device.diskAvailable >= selected.disk &&
        (accepted || item.installed) &&
        !running;
    const notify = async () => {
        await emit('request_context_invalidated', {});
        await emit('translate_service_list_changed', await store.get('translate_service_list'));
        await refreshInstances();
    };
    const saveService = async (model, enable) => {
        const { key: existing, list, config } = await findLocalInstance(store, model.family);
        const key = existing ?? createServiceInstanceKey('local_mt');
        await store.set(key, {
            instanceName: model.name,
            threads: String(device?.threads ?? 2),
            quality: 'balanced',
            ...config,
            model: model.family,
            ...(model.family === 'hymt' ? { variant: model.id } : {}),
            enable,
        });
        if (!existing) await store.set('translate_service_list', [...list, key]);
        await store.save();
        await notify();
        return key;
    };
    const manage = (model) =>
        act(async () => {
            setSelected(model);
            setInstallFinished(false);
            setDevice(null);
            setAccepted(false);
            setAddress('');
            const previousBase = resumableModelBase(status[model.id]);
            setSource(previousBase ? 'custom' : 'official');
            setAddress(previousBase);
            setConfirmRemoval(false);
            setAdvanced('');
            const { config } = await findLocalInstance(store, model.family);
            setEnabled(config?.enable !== false && config?.enable !== 'false');
            const result = await invoke('local_mt_device_check', { model: model.id });
            setDevice({ ...result, diskRequired: model.disk });
            await refresh();
        });
    const job = (fn) =>
        act(async () => {
            if (busyId) return;
            const model = selected;
            setBusyId(model.id);
            try {
                await fn(model);
            } catch (error) {
                const next = await invoke('local_mt_model_status', { pair: model.id }).catch(() => null);
                if (!['paused', 'cancelled'].includes(next?.task?.state)) throw error;
            } finally {
                setBusyId('');
                await refresh();
                await refreshInstances();
            }
        });
    const download = () =>
        job(async (model) => {
            await invoke('local_mt_download_model', {
                pair: model.id,
                downloadBase: source === 'custom' ? address.trim() : null,
            });
            await saveService(model, enabled);
            setInstallFinished(true);
        });
    const importModel = () =>
        act(async () => {
            const directory = await pickDirectory({
                directory: true,
                multiple: false,
                title: t('models.catalog_pick_folder'),
            });
            if (!directory || typeof directory !== 'string') return;
            await job(async (model) => {
                await invoke('local_mt_import_model', { pair: model.id, sourceDir: directory });
                await saveService(model, enabled);
                setInstallFinished(true);
            });
        });
    const closeManager = () => {
        setSelected(null);
        setConfirmRemoval(false);
        onBrowseClose();
    };
    useEffect(() => {
        if (!manageModelId) return;
        const model = LOCAL_MODEL_CATALOG.find((entry) => entry.id === manageModelId);
        if (model) manage(model);
        onManageHandled();
    }, [manageModelId]);
    return (
        <>
            <Modal
                disableAnimation
                isOpen={browseOpen && !selected}
                onClose={onBrowseClose}
                size='4xl'
                scrollBehavior='inside'
                classNames={{
                    base: 'model-choice-dialog',
                    header: 'model-choice-header',
                    body: 'model-choice-body',
                    footer: 'model-choice-footer',
                }}
            >
                <ModalContent>
                    <ModalHeader>
                        <div>
                            <h2>{t('models.home_add_local')}</h2>
                            <p>{t('models.wizard_subtitle')}</p>
                        </div>
                        <WizardSteps
                            step={1}
                            t={t}
                        />
                    </ModalHeader>
                    <ModalBody>
                        <div
                            className='model-family-grid'
                            role='group'
                            aria-label={t('models.family_choose')}
                        >
                            {['hymt', 'm2m100', 'opus'].map((key) => (
                                <button
                                    type='button'
                                    className={`model-family-card ${family === key ? 'selected' : ''}`}
                                    key={key}
                                    onClick={() => {
                                        setFamily(key);
                                        setCandidate(
                                            key === 'hymt' ? 'hymt-q4' : key === 'm2m100' ? 'm2m100' : 'en-zh'
                                        );
                                    }}
                                >
                                    <strong>
                                        {key === 'hymt' ? 'HY-MT1.5' : key === 'm2m100' ? 'M2M-100' : 'OPUS-MT'}
                                    </strong>
                                    <span>{t(`models.family_${key}`)}</span>
                                </button>
                            ))}
                        </div>
                        {family && (
                            <div className='model-choice-intro'>
                                <div>
                                    <h3>{t('models.wizard_choose')}</h3>
                                    <p>{t('models.catalog_intro')}</p>
                                </div>
                                <Switch
                                    size='sm'
                                    isSelected={installedOnly}
                                    onValueChange={setInstalledOnly}
                                >
                                    {t('models.catalog_installed_only')}
                                </Switch>
                            </div>
                        )}
                        <div
                            className='model-choice-grid'
                            role='radiogroup'
                            aria-label={t('models.catalog_title')}
                        >
                            {filterLocalCatalog(
                                LOCAL_MODEL_CATALOG.filter((model) => model.family === family),
                                status,
                                installedOnly
                            ).map((model) => {
                                const current = status[model.id];
                                return (
                                    <button
                                        key={model.id}
                                        type='button'
                                        role='radio'
                                        aria-checked={candidate === model.id}
                                        className={`model-choice-card ${candidate === model.id ? 'selected' : ''}`}
                                        onClick={() => setCandidate(model.id)}
                                    >
                                        <span className='model-choice-radio' />
                                        <div className='model-choice-top'>
                                            <span
                                                className={`model-choice-icon ${model.family === 'm2m100' ? 'multi' : ''}`}
                                            >
                                                {model.family === 'm2m100' ? (
                                                    <LuLanguages size={18} />
                                                ) : (
                                                    <LuCpu size={18} />
                                                )}
                                            </span>
                                            <span className='service-mini-badge'>
                                                {t(
                                                    model.family !== 'opus'
                                                        ? 'models.wizard_multi_fit'
                                                        : 'models.wizard_light_fit'
                                                )}
                                            </span>
                                        </div>
                                        <h3>
                                            {t(
                                                model.id === 'hymt-q4'
                                                    ? 'models.hy_q4'
                                                    : model.id === 'hymt-q8'
                                                      ? 'models.hy_q8'
                                                      : model.id === 'en-zh'
                                                        ? 'models.wizard_en_zh'
                                                        : model.id === 'zh-en'
                                                          ? 'models.wizard_zh_en'
                                                          : 'models.wizard_multi'
                                            )}
                                        </h3>
                                        <small>
                                            {model.name} · {model.tag}
                                        </small>
                                        <p>{t(`models.${model.scenario}`)}</p>
                                        <div className='model-choice-specs'>
                                            <span>{(model.bytes / 1e6).toFixed(1)} MB</span>
                                            <span>{t(`models.${model.memory}`)}</span>
                                            <span>{t(`models.${model.scope}`)}</span>
                                        </div>
                                        <div className='model-choice-bottom'>
                                            <span>{model.license}</span>
                                            {current?.installed && <span>{t('models.catalog_installed')}</span>}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                        {installedOnly &&
                            !LOCAL_MODEL_CATALOG.some(
                                (model) => model.family === family && status[model.id]?.installed
                            ) && <p>{t('models.catalog_no_installed')}</p>}
                        <p className='model-choice-note'>{t('models.wizard_selection_note')}</p>
                    </ModalBody>
                    <ModalFooter>
                        <span>{t('models.wizard_source_note')}</span>
                        <Button
                            size='sm'
                            variant='light'
                            onPress={onBrowseClose}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            size='sm'
                            className='service-primary-button'
                            isDisabled={
                                !family ||
                                !LOCAL_MODEL_CATALOG.some(
                                    (model) =>
                                        model.family === family &&
                                        model.id === candidate &&
                                        (!installedOnly || status[model.id]?.installed)
                                )
                            }
                            onPress={() =>
                                family && manage(LOCAL_MODEL_CATALOG.find((model) => model.id === candidate))
                            }
                        >
                            {t('models.wizard_next')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
            <Modal
                disableAnimation
                isOpen={!!selected}
                onOpenChange={(open) => {
                    if (!open) {
                        closeManager();
                    }
                }}
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
                    {selected && (
                        <>
                            <ModalHeader>
                                <div>
                                    <span className='model-dialog-eyebrow'>{t('models.install_manager')}</span>
                                    <h2>
                                        {selected.name} <span className='models-badge'>{selected.tag}</span>
                                    </h2>
                                    <p>{t(`models.${selected.scenario}`)}</p>
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                {browseOpen && (
                                    <WizardSteps
                                        step={localTaskRunning(item) || busyId || installFinished ? 3 : 2}
                                        t={t}
                                    />
                                )}
                                {installFinished && (
                                    <div className='service-install-success'>
                                        <LuCheck size={16} />
                                        <span>{t('models.wizard_done')}</span>
                                    </div>
                                )}
                                {error && (
                                    <p
                                        role='alert'
                                        className='model-catalog-error'
                                    >
                                        {error}
                                    </p>
                                )}
                                <div className='model-catalog-info'>
                                    <div>
                                        <small>{t('models.catalog_languages')}</small>
                                        <p>{t(`models.${selected.languages}`)}</p>
                                    </div>
                                    <div>
                                        <small>{t('models.check_memory')}</small>
                                        <p>
                                            {t(`models.${selected.memory}`)} · {t('models.catalog_cpu')}
                                        </p>
                                    </div>
                                    <div>
                                        <small>{t('models.download_size')}</small>
                                        <p>
                                            {(selected.bytes / 1e6).toFixed(1)} MB ·{' '}
                                            {t('models.catalog_disk', { size: (selected.disk / 1e9).toFixed(1) })}
                                        </p>
                                    </div>
                                    <div>
                                        <small>{t('models.check_license')}</small>
                                        <p>
                                            {selected.author} · {selected.license}
                                        </p>
                                    </div>
                                </div>
                                <p>
                                    {device
                                        ? `${device.platform} / ${device.architecture} · ${device.supported ? t('models.compatible') : device.reason} · ${((device.diskAvailable ?? 0) / 1e9).toFixed(1)} GB ${t('models.available')}`
                                        : t('models.checking')}
                                </p>
                                <div className='model-enable-row'>
                                    <div>
                                        <strong>
                                            {t(
                                                item?.installed
                                                    ? 'models.service_enabled'
                                                    : 'models.catalog_enable_after'
                                            )}
                                        </strong>
                                        <small>
                                            {t(
                                                selected.family === 'opus'
                                                    ? 'models.catalog_shared_opus'
                                                    : 'models.enable_scope_hint'
                                            )}
                                        </small>
                                    </div>
                                    <Switch
                                        size='sm'
                                        aria-label={t('models.service_enabled')}
                                        isSelected={enabled}
                                        isDisabled={running}
                                        onValueChange={setEnabled}
                                    />
                                </div>
                                {!item?.installed && (
                                    <Checkbox
                                        size='sm'
                                        isSelected={accepted}
                                        onValueChange={setAccepted}
                                    >
                                        {t('models.catalog_license_ack', { license: selected.license })}
                                    </Checkbox>
                                )}
                                {item?.task && item.task.state !== 'ready' && (
                                    <div className='models-transfer'>
                                        <p>
                                            {t(`models.state_${item.task.state}`)} · {item.task.file} ·{' '}
                                            {(item.task.bytes / 1e6).toFixed(1)} / {(item.task.total / 1e6).toFixed(1)}{' '}
                                            MB
                                        </p>
                                        <Progress
                                            size='sm'
                                            aria-label={t('models.progress')}
                                            value={item.task.total ? (item.task.bytes / item.task.total) * 100 : 0}
                                        />
                                        {item.task.error && <p role='alert'>{item.task.error}</p>}
                                    </div>
                                )}
                                <details className='models-details'>
                                    <summary>{t('models.catalog_sources')}</summary>
                                    <p>{t('models.catalog_source_hint')}</p>
                                    <Select
                                        size='sm'
                                        label={t('models.source_label')}
                                        selectedKeys={[source]}
                                        isDisabled={running}
                                        onSelectionChange={(keys) => setSource([...keys][0] ?? 'official')}
                                    >
                                        <SelectItem key='official'>{t('models.catalog_official')}</SelectItem>
                                        <SelectItem key='custom'>{t('models.catalog_custom')}</SelectItem>
                                    </Select>
                                    {source === 'custom' && (
                                        <Input
                                            size='sm'
                                            type='url'
                                            label={t('models.catalog_address')}
                                            placeholder={item?.downloadBase ?? 'https://example.org/model-files'}
                                            value={address}
                                            isDisabled={running}
                                            onValueChange={setAddress}
                                        />
                                    )}
                                    <p>{t('models.catalog_import_hint')}</p>
                                    <div className='models-row-actions'>
                                        <Button
                                            size='sm'
                                            isDisabled={!canInstall || (source === 'custom' && !address.trim())}
                                            onPress={download}
                                        >
                                            <LuDownload size={12} />
                                            {t(
                                                item?.installed
                                                    ? 'models.catalog_repair'
                                                    : 'models.catalog_download_selected'
                                            )}
                                        </Button>
                                        <Button
                                            size='sm'
                                            variant='flat'
                                            isDisabled={!canInstall}
                                            onPress={importModel}
                                        >
                                            <LuFolderInput size={12} />
                                            {t('models.catalog_import')}
                                        </Button>
                                    </div>
                                </details>
                                <details className='models-details'>
                                    <summary>{t('models.version_details')}</summary>
                                    <dl>
                                        <dt>{t('models.source_label')}</dt>
                                        <dd>{item?.source}</dd>
                                        <dt>Revision</dt>
                                        <dd>{item?.revision}</dd>
                                        <dt>Runtime</dt>
                                        <dd>{item?.runtime}</dd>
                                        <dt>{t('models.catalog_location')}</dt>
                                        <dd>{item?.dir}</dd>
                                    </dl>
                                    <p>{t('models.catalog_required_files')}</p>
                                    <ul className='model-file-list'>
                                        {item?.files?.map((file) => (
                                            <li key={file.name}>
                                                <span>
                                                    {file.name} · {(file.bytes / 1e6).toFixed(2)} MB
                                                </span>
                                                <code>SHA256 {file.sha256}</code>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                                {advanced && (
                                    <LocalConfig
                                        instanceKey={advanced}
                                        updateServiceList={() => {}}
                                        onClose={() => {
                                            setAdvanced('');
                                            act(async () => {
                                                await refresh();
                                                await refreshInstances();
                                            });
                                        }}
                                    />
                                )}
                            </ModalBody>
                            <ModalFooter>
                                {confirmRemoval ? (
                                    <div
                                        className='model-remove-confirm'
                                        role='alert'
                                    >
                                        <p>{t('models.catalog_remove_hint')}</p>
                                        <div className='models-row-actions'>
                                            <Button
                                                size='sm'
                                                color='danger'
                                                isDisabled={running}
                                                onPress={() =>
                                                    job(async (model) => {
                                                        await invoke('local_mt_delete_model', { pair: model.id });
                                                        setConfirmRemoval(false);
                                                        await notify();
                                                    })
                                                }
                                            >
                                                {t('models.catalog_confirm_remove')}
                                            </Button>
                                            <Button
                                                size='sm'
                                                variant='light'
                                                onPress={() => setConfirmRemoval(false)}
                                            >
                                                {t('common.cancel')}
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className='models-row-actions model-catalog-actions'>
                                        {!item?.installed && !localTaskRunning(item) && (
                                            <Button
                                                size='sm'
                                                className='service-primary-button'
                                                isDisabled={!canInstall || (source === 'custom' && !address.trim())}
                                                onPress={download}
                                            >
                                                {t('models.begin_install')}
                                            </Button>
                                        )}
                                        {browseOpen && !running && (
                                            <Button
                                                size='sm'
                                                variant='light'
                                                onPress={() => setSelected(null)}
                                            >
                                                {t('models.wizard_back')}
                                            </Button>
                                        )}
                                        {localTaskRunning(item) && (
                                            <>
                                                <Button
                                                    size='sm'
                                                    variant='flat'
                                                    onPress={() =>
                                                        act(() =>
                                                            invoke('local_mt_install_control', {
                                                                pair: selected.id,
                                                                action: 'paused',
                                                            })
                                                        )
                                                    }
                                                >
                                                    {t('models.pause')}
                                                </Button>
                                                <Button
                                                    size='sm'
                                                    variant='light'
                                                    onPress={() =>
                                                        act(() =>
                                                            invoke('local_mt_install_control', {
                                                                pair: selected.id,
                                                                action: 'cancelled',
                                                            })
                                                        )
                                                    }
                                                >
                                                    {t('common.cancel')}
                                                </Button>
                                            </>
                                        )}
                                        {item?.installed && (
                                            <>
                                                <Button
                                                    size='sm'
                                                    className='service-primary-button'
                                                    isDisabled={running}
                                                    onPress={() =>
                                                        job(async (model) => {
                                                            await saveService(model, enabled);
                                                        })
                                                    }
                                                >
                                                    {t('common.save')}
                                                </Button>
                                                {item.loaded && (
                                                    <Button
                                                        size='sm'
                                                        variant='flat'
                                                        isDisabled={running}
                                                        onPress={() =>
                                                            job((model) =>
                                                                invoke('local_mt_unload_model', { pair: model.id })
                                                            )
                                                        }
                                                    >
                                                        {t('models.catalog_unload')}
                                                    </Button>
                                                )}
                                                <Button
                                                    size='sm'
                                                    variant='light'
                                                    isDisabled={running}
                                                    onPress={() =>
                                                        act(async () => {
                                                            setAdvanced(await saveService(selected, enabled));
                                                        })
                                                    }
                                                >
                                                    {t('models.advanced_short')}
                                                </Button>
                                            </>
                                        )}
                                        {(item?.installed || item?.hasFiles || item?.task) && (
                                            <Button
                                                size='sm'
                                                variant='light'
                                                color='danger'
                                                isDisabled={running}
                                                onPress={() => setConfirmRemoval(true)}
                                            >
                                                <LuTrash2 size={12} />
                                                {t('models.catalog_uninstall')}
                                            </Button>
                                        )}
                                        <Button
                                            size='sm'
                                            variant='light'
                                            onPress={closeManager}
                                        >
                                            {t(running ? 'models.close_background' : 'common.close')}
                                        </Button>
                                    </div>
                                )}
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </>
    );
}

function WizardSteps({ step, t }) {
    return (
        <div
            className='model-wizard-steps'
            aria-label={t('models.wizard_steps')}
        >
            {['wizard_step_choose', 'wizard_step_check', 'wizard_step_install'].map((key, index) => (
                <span
                    key={key}
                    className={step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}
                >
                    <i>{index + 1}</i>
                    {t(`models.${key}`)}
                </span>
            ))}
        </div>
    );
}
