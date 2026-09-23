import { Button, Input } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import React from 'react';

import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { useConfig } from '../../../hooks';

// 本地 TTS 无需任何密钥/地址配置：直接使用系统安装的
// espeak-ng / espeak / speech-dispatcher 合成语音（离线、零配置）。
export function Config(props) {
    const { updateServiceList, onClose } = props;
    const { instanceKey } = props;
    const { t } = useTranslation();
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.tts.local_tts.title'),
        },
        { sync: false }
    );

    return (
        config !== null && (
            <>
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
                    <h3 className='my-auto mx-0'>{t('services.tts.local_tts.help')}</h3>
                </div>
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
