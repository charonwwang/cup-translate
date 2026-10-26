import React, { useState } from 'react';
import { Button } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
export function Config({ instanceKey, updateServiceList, onClose }) {
    const { t } = useTranslation();
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const navigate = useNavigate();
    return (
        <>
            <p>{t('models.piper_routing')}</p>
            {error && (
                <p
                    role='alert'
                    className='break-all'
                >
                    {t('models.speech_action_failed')} {error}
                </p>
            )}
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
                isLoading={saving}
                onPress={async () => {
                    setSaving(true);
                    setError('');
                    try {
                        await updateServiceList(instanceKey);
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
        </>
    );
}
