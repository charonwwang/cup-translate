import { findLocalInstance } from '../../../../utils/localModelInstance';
import { emit } from '@tauri-apps/api/event';
import React, { useState } from 'react';
import { Button, Card, CardBody, Progress } from '@nextui-org/react';
import { LuLanguages, LuCheck, LuSettings2 } from 'react-icons/lu';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/tauri';
import { store } from '../../../../utils/store';
import { createServiceInstanceKey } from '../../../../utils/service_instance';
import { Config as LocalConfig } from '../../../../services/translate/local_mt/Config';
import ModelInstallDialog from './ModelInstallDialog';

const pair = 'm2m100';
export default function MultilingualModelCard({ status, refresh, act }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [device, setDevice] = useState(null);
    const [license, setLicense] = useState(false);
    const [enable, setEnable] = useState(true);
    const [busy, setBusy] = useState(false);
    const [advanced, setAdvanced] = useState('');
    const item = status[pair],
        task = item?.task;
    const running = busy || ['queued', 'downloading', 'verifying', 'warming'].includes(task?.state);
    const findInstance = () => findLocalInstance(store, pair);
    const saveInstance = async () => {
        const { key: existing, list } = await findInstance();
        const key = existing ?? createServiceInstanceKey('local_mt');
        const previous = existing ? await store.get(key) : null;
        await store.set(key, {
            instanceName: 'M2M-100',
            threads: String(device?.threads ?? 2),
            quality: 'balanced',
            ...previous,
            model: pair,
            enable,
        });
        if (!existing) await store.set('translate_service_list', [...list, key]);
        await store.save();
        await emit('translate_service_list_changed', await store.get('translate_service_list'));
    };
    const install = async () => {
        if (running || !license) return;
        setBusy(true);
        try {
            await invoke('local_mt_download_model', { pair });
            await saveInstance();
        } catch (error) {
            const current = await invoke('local_mt_model_status', { pair }).catch(() => null);
            if (!['paused', 'cancelled'].includes(current?.task?.state)) throw error;
        } finally {
            setBusy(false);
            await refresh();
        }
    };
    const manage = () =>
        act(async () => {
            setDevice(null);
            setOpen(true);
            const { key } = await findInstance();
            setEnable(key ? (await store.get(key))?.enable ?? true : true);
            setDevice(await invoke('local_mt_device_check', { model: pair }));
        });
    return (
        <Card
            data-cup-card
            className='models-card models-multilingual-card'
        >
            <CardBody className='models-card-body'>
                <div className='models-product-head'>
                    <span className='models-product-icon'>
                        <LuLanguages size={20} />
                    </span>
                    <div>
                        <h2>
                            M2M-100 <span className='models-badge'>418M · int8</span>
                        </h2>
                        <p>{t('models.multi_summary')}</p>
                    </div>
                    <span className={`models-status ${item?.installed ? 'ready' : ''}`}>
                        {item?.installed && <LuCheck size={12} />}
                        {t(
                            !item
                                ? 'models.checking'
                                : item.installed
                                  ? 'models.ready'
                                  : running
                                    ? 'models.state_downloading'
                                    : 'models.not_ready'
                        )}
                    </span>
                </div>
                <p className='models-language-scope'>{t('models.multi_scope_hint')}</p>
                <div className='models-row-actions'>
                    <Button
                        size='sm'
                        isDisabled={!item || item.supported === false}
                        onPress={manage}
                    >
                        {t(item?.installed || running ? 'models.manage_install' : 'models.add_model_short')}
                    </Button>
                    {item?.installed && (
                        <Button
                            size='sm'
                            variant='light'
                            onPress={() =>
                                act(async () => {
                                    const { key } = await findInstance();
                                    if (key) setAdvanced(key);
                                    else {
                                        await saveInstance();
                                        setAdvanced((await findInstance()).key);
                                    }
                                })
                            }
                        >
                            <LuSettings2 size={12} />
                            {t('models.advanced_short')}
                        </Button>
                    )}
                </div>
                {item?.supported === false && <p role='alert'>{item.reason}</p>}
                {task && task.state !== 'ready' && (
                    <div className='models-transfer'>
                        <Progress
                            size='sm'
                            aria-label={t('models.progress')}
                            value={task.total ? (task.bytes / task.total) * 100 : 0}
                        />
                        <p>
                            {t(`models.state_${task.state}`)} · {task.file} · {(task.bytes / 1e6).toFixed(1)} /{' '}
                            {(task.total / 1e6).toFixed(1)} MB
                        </p>
                        {task.error && <p role='alert'>{task.error}</p>}
                        <div className='models-row-actions'>
                            {running ? (
                                <>
                                    <Button
                                        size='sm'
                                        variant='light'
                                        onPress={() =>
                                            act(() => invoke('local_mt_install_control', { pair, action: 'paused' }))
                                        }
                                    >
                                        {t('models.pause')}
                                    </Button>
                                    <Button
                                        size='sm'
                                        variant='light'
                                        onPress={() =>
                                            act(() => invoke('local_mt_install_control', { pair, action: 'cancelled' }))
                                        }
                                    >
                                        {t('common.cancel')}
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    size='sm'
                                    variant='flat'
                                    onPress={manage}
                                >
                                    {t('models.resume')}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
                <details className='models-details'>
                    <summary>{t('models.version_details')}</summary>
                    <dl>
                        <dt>{t('models.source_label')}</dt>
                        <dd>{item?.source}</dd>
                        <dt>Revision</dt>
                        <dd>{item?.revision}</dd>
                        <dt>License</dt>
                        <dd>{item?.license}</dd>
                    </dl>
                    <p>{t('models.multi_memory')}</p>
                </details>
                {advanced && (
                    <LocalConfig
                        instanceKey={advanced}
                        updateServiceList={() => {}}
                        onClose={() => setAdvanced('')}
                    />
                )}
                <ModelInstallDialog
                    model={pair}
                    open={open}
                    onClose={() => setOpen(false)}
                    device={device}
                    status={status}
                    license={license}
                    setLicense={setLicense}
                    enable={enable}
                    setEnable={setEnable}
                    busy={busy}
                    onInstall={() => act(install)}
                    onSave={() =>
                        act(async () => {
                            await saveInstance();
                            setOpen(false);
                        })
                    }
                />
            </CardBody>
        </Card>
    );
}
