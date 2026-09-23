import { Button, Input } from '@nextui-org/react';
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
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.translate.local_mt.title'),
            threads: '4',
        },
        { sync: false }
    );
    const [statusMap, setStatusMap] = useState({});
    const [busy, setBusy] = useState('');
    const toastStyle = useToastStyle();

    const refreshStatus = async () => {
        const next = {};
        for (const pair of PAIRS) {
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
    }, []);

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
                {PAIRS.map((pair) => {
                    const status = statusMap[pair];
                    return (
                        <div
                            className='config-item'
                            key={pair}
                        >
                            <h3 className='my-auto mx-0'>
                                {pair}（{t(`services.translate.local_mt.license_${pair}`)}）
                            </h3>
                            <div className='my-auto mx-0'>
                                {status === undefined
                                    ? t('services.translate.local_mt.checking')
                                    : status.installed
                                      ? t('services.translate.local_mt.installed')
                                      : t('services.translate.local_mt.not_installed')}
                            </div>
                            {status !== undefined && status.installed ? (
                                <Button
                                    color='danger'
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
                                    isLoading={busy === `download-${pair}`}
                                    onPress={async () => {
                                        setBusy(`download-${pair}`);
                                        try {
                                            await invoke('local_mt_download_model', { pair });
                                            await refreshStatus();
                                            toast.success(t('services.translate.local_mt.download_done'), {
                                                style: toastStyle,
                                            });
                                        } catch (e) {
                                            toast.error(e.toString(), { style: toastStyle });
                                        }
                                        setBusy('');
                                    }}
                                >
                                    {t('services.translate.local_mt.download_model')}
                                </Button>
                            )}
                        </div>
                    );
                })}
                <div className='config-item'>
                    <Button
                        fullWidth
                        color='primary'
                        onPress={() => {
                            updateServiceList(instanceKey);
                            onClose();
                        }}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </>
        )
    );
}
