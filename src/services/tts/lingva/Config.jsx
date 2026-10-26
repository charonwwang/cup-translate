import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { Button, Input } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/api/shell';
import React, { useEffect, useRef, useState } from 'react';

import { store } from '../../../utils/store';
import { Language } from './index';
import { tts } from './index';

export function Config(props) {
    const [isLoading, setIsLoading] = useState(false);
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [lingvaConfig, setLingvaConfig] = useState(null);
    const [error, setError] = useState('');
    const [tested, setTested] = useState(false);
    const revision = useRef(0);
    useEffect(() => {
        let live = true;
        store
            .get(instanceKey)
            .then((value) => {
                if (live)
                    setLingvaConfig(
                        value || {
                            [INSTANCE_NAME_CONFIG_KEY]: t('services.tts.lingva_tts.title'),
                            requestPath: 'lingva.pot-app.com',
                        }
                    );
            })
            .catch((failure) => live && setError(String(failure)));
        return () => {
            live = false;
            revision.current++;
        };
    }, [instanceKey]);
    const edit = (value) => {
        revision.current++;
        setTested(false);
        setLingvaConfig(value);
    };
    const act = async (test) => {
        const id = revision.current;
        setIsLoading(true);
        setError('');
        try {
            if (test) {
                await tts('hello', Language.en, { config: lingvaConfig });
                if (id === revision.current) setTested(true);
            } else {
                await updateServiceList(instanceKey, lingvaConfig);
                if (id === revision.current) onClose();
            }
        } catch (failure) {
            if (id === revision.current) setError(String(failure));
        } finally {
            if (id === revision.current) setIsLoading(false);
        }
    };

    return (
        lingvaConfig !== null && (
            <>
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside-left'
                        isDisabled={isLoading}
                        value={lingvaConfig[INSTANCE_NAME_CONFIG_KEY]}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onValueChange={(value) => {
                            edit({
                                ...lingvaConfig,
                                [INSTANCE_NAME_CONFIG_KEY]: value,
                            });
                        }}
                    />
                </div>
                <div className={'config-item'}>
                    <h3 className='my-auto'>{t('services.help')}</h3>
                    <Button
                        onPress={() => {
                            open('https://pot-app.com/docs/api/tts/lingva.html');
                        }}
                    >
                        {t('services.help')}
                    </Button>
                </div>
                <div className={'config-item'}>
                    <h3 className='my-auto'>{t('services.tts.lingva_tts.request_path')}</h3>
                    <Input
                        isDisabled={isLoading}
                        value={lingvaConfig['requestPath']}
                        variant='bordered'
                        className='max-w-[50%]'
                        onValueChange={(value) => {
                            edit({
                                ...lingvaConfig,
                                requestPath: value,
                            });
                        }}
                    />
                </div>
                <div>
                    <Button
                        isDisabled={isLoading}
                        onPress={() => act(true)}
                    >
                        {t('models.speech_test')}
                    </Button>
                    {tested && <p role='status'>{t('models.speech_test_ok')}</p>}
                    {error && (
                        <div role='alert'>
                            <p>{t('models.speech_action_failed')}</p>
                            <details>
                                <summary>{t('models.version_details')}</summary>
                                <pre className='whitespace-pre-wrap break-all select-text'>{error}</pre>
                            </details>
                        </div>
                    )}
                    <Button
                        isLoading={isLoading}
                        fullWidth
                        color='primary'
                        onPress={() => act(false)}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </>
        )
    );
}
