import { useNavigate } from 'react-router-dom';
import { store } from '../../../utils/store';
import { Button, Input, Select, SelectItem } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/tauri';
import React, { useEffect, useState } from 'react';

import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { useConfig, useToastStyle } from '../../../hooks';

// 本地离线翻译模型管理：按需下载 / 查看状态 / 删除。
// en→zh 派生自 Helsinki-NLP/opus-mt-en-zh（Apache-2.0）
// zh→en 派生自 Helsinki-NLP/opus-mt-zh-en（CC-BY-4.0，译文需署名 Helsinki-NLP / OPUS-MT）
const PAIRS = ['en-zh', 'zh-en'];

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.translate.local_mt.title'),
            threads: '2',
            quality: 'balanced',
        },
        { sync: false }
    );
    const [statusMap, setStatusMap] = useState({});
    const [busy, setBusy] = useState('');
    const toastStyle = useToastStyle();

    const refreshStatus = async () => {
        const next = {};
        for (const pair of config?.model === 'hymt'
            ? [config.variant || 'hymt-q4']
            : config?.model === 'm2m100'
              ? ['m2m100']
              : PAIRS) {
            try {
                next[pair] = await invoke('local_mt_model_status', { pair });
            } catch (e) {
                next[pair] = { installed: false, missing: [String(e)] };
            }
        }
        setStatusMap(next);
    };

    useEffect(() => {
        refreshStatus();
    }, [config?.model]);

    return (
        config !== null && (
            <>
                <Toaster />
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside-left'
                        value={config[INSTANCE_NAME_CONFIG_KEY]}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onValueChange={(value) => {
                            setConfig({
                                ...config,
                                [INSTANCE_NAME_CONFIG_KEY]: value,
                            });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <Input
                        label={t('services.translate.local_mt.threads')}
                        type='number'
                        min={1}
                        max={64}
                        labelPlacement='outside-left'
                        value={config['threads']}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onValueChange={(value) => {
                            setConfig({
                                ...config,
                                threads: value,
                            });
                        }}
                    />
                </div>
                {config.model !== 'hymt' && (
                    <div className='config-item'>
                        <Select
                            aria-label={t('services.translate.local_mt.search_mode')}
                            label={t('services.translate.local_mt.search_mode')}
                            selectedKeys={[config.quality ?? 'balanced']}
                            onSelectionChange={(keys) => setConfig({ ...config, quality: [...keys][0] ?? 'balanced' })}
                        >
                            {['fast', 'balanced', 'thorough'].map((mode) => (
                                <SelectItem key={mode}>{t(`services.translate.local_mt.mode_${mode}`)}</SelectItem>
                            ))}
                        </Select>
                    </div>
                )}
                <p className='text-xs text-default-500'>{t('services.translate.local_mt.memory_hint')}</p>
                {(config?.model === 'hymt'
                    ? [config.variant || 'hymt-q4']
                    : config?.model === 'm2m100'
                      ? ['m2m100']
                      : PAIRS
                ).map((pair) => {
                    const status = statusMap[pair];
                    return (
                        <div
                            className='config-item'
                            key={pair}
                        >
                            <h3 className='my-auto mx-0'>
                                {pair.startsWith('hymt-')
                                    ? `HY-MT1.5 · ${pair === 'hymt-q8' ? 'Q8_0' : 'Q4_K_M'}`
                                    : pair === 'm2m100'
                                      ? 'M2M-100 · MIT'
                                      : `${pair}（${t(`services.translate.local_mt.license_${pair}`)}）`}
                            </h3>
                            <div className='my-auto mx-0'>
                                {status === undefined
                                    ? t('services.translate.local_mt.checking')
                                    : status.supported === false
                                      ? t('services.translate.local_mt.unsupported_arch')
                                      : status.installed
                                        ? t(
                                              status.loaded
                                                  ? 'services.translate.local_mt.loaded'
                                                  : 'services.translate.local_mt.installed'
                                          )
                                        : t('services.translate.local_mt.not_installed')}
                            </div>
                            {status?.loaded && (
                                <Button
                                    size='sm'
                                    isDisabled={busy !== ''}
                                    onPress={async () => {
                                        setBusy(`unload-${pair}`);
                                        try {
                                            await invoke('local_mt_unload_model', { pair });
                                            await refreshStatus();
                                        } catch (error) {
                                            toast.error(String(error), { style: toastStyle });
                                        } finally {
                                            setBusy('');
                                        }
                                    }}
                                >
                                    {t('services.translate.local_mt.unload')}
                                </Button>
                            )}
                            {status !== undefined && status.installed ? (
                                <Button
                                    color='danger'
                                    isDisabled={busy !== ''}
                                    isLoading={busy === `delete-${pair}`}
                                    onPress={async () => {
                                        setBusy(`delete-${pair}`);
                                        try {
                                            await invoke('local_mt_delete_model', { pair });
                                            await refreshStatus();
                                        } catch (e) {
                                            toast.error(e.toString(), { style: toastStyle });
                                        }
                                        setBusy('');
                                    }}
                                >
                                    {t('services.translate.local_mt.delete_model')}
                                </Button>
                            ) : (
                                <Button
                                    color='primary'
                                    isDisabled={busy !== '' || status?.supported === false}
                                    onPress={() => {
                                        onClose();
                                        navigate(`/models?install=${encodeURIComponent(pair)}`);
                                    }}
                                >
                                    {t('models.wizard_next')}
                                </Button>
                            )}
                        </div>
                    );
                })}
                <div className='config-item'>
                    <Button
                        fullWidth
                        color='primary'
                        onPress={async () => {
                            try {
                                await store.set(instanceKey, config);
                                await store.save();
                                updateServiceList(instanceKey);
                                onClose();
                            } catch {
                                toast.error(t('models.save_failed'), { style: toastStyle });
                            }
                        }}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </>
        )
    );
}
