import React from 'react';
import { Button } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
export function Config({ instanceKey, updateServiceList, onClose }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    return (
        <>
            <p>{t('models.piper_routing')}</p>
            <Button
                size='sm'
                variant='bordered'
                onPress={() => {
                    onClose();
                    navigate('/models');
                }}
            >
                {t(instanceKey?.startsWith('kokoro_tts') ? 'models.kokoro_title' : 'models.piper_title')}
            </Button>
            <Button
                size='sm'
                color='primary'
                onPress={() => {
                    updateServiceList(instanceKey);
                    onClose();
                }}
            >
                {t('common.save')}
            </Button>
        </>
    );
}
