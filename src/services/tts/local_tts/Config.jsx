import { Button, Input } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import React, { useEffect, useState } from 'react';

import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { store } from '../../../utils/store';

// 本地 TTS 无需任何密钥/地址配置：直接使用系统安装的
// espeak-ng / espeak / speech-dispatcher 合成语音（离线、零配置）。
export function Config(props) {
    const { updateServiceList, onClose } = props;
    const { instanceKey } = props;
    const { t } = useTranslation();
    const [config, setConfig] = useState(null);
    const [error, setError] = useState('');
    const [readAttempt, setReadAttempt] = useState(0);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        let live = true;
        setConfig(null);
        setError('');
        store
            .get(instanceKey)
            .then((value) => {
                if (live) setConfig(value || { [INSTANCE_NAME_CONFIG_KEY]: t('services.tts.local_tts.title') });
            })
            .catch((failure) => live && setError(String(failure)));
        return () => {
            live = false;
        };
    }, [instanceKey, readAttempt]);

    if (config === null) {
        return error ? (
            <div role='alert'>
                <p>{t('models.speech_action_failed')}</p>
                <pre className='whitespace-pre-wrap break-all select-text'>{error}</pre>
                <Button onPress={() => setReadAttempt((attempt) => attempt + 1)}>{t('translate.retry')}</Button>
                <Button
                    variant='light'
                    onPress={onClose}
                >
                    {t('common.close')}
                </Button>
            </div>
        ) : (
            <p role='status'>{t('models.checking')}</p>
        );
    }

    return (
        config !== null && (
            <>
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside-left'
                        isDisabled={saving}
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
                    <h3 className='my-auto mx-0'>{t('services.tts.local_tts.help')}</h3>
                </div>
                {error && (
                    <p
                        role='alert'
                        className='break-all'
                    >
                        {t('models.speech_action_failed')} {error}
                    </p>
                )}
                <div className='config-item'>
                    <Button
                        fullWidth
                        color='primary'
                        isLoading={saving}
                        onPress={async () => {
                            setSaving(true);
                            setError('');
                            try {
                                await updateServiceList(instanceKey, config);
                                onClose();
                            } catch (failure) {
                                setError(String(failure));
                            } finally {
                                setSaving(false);
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
