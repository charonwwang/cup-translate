import React, { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { emit } from '@tauri-apps/api/event';
import { store } from '../../utils/store';
import { createCollectionDraft, persistCollectionConfig } from './draft';

export function ConfigEditor({ instanceKey, defaults, fields, guide, testConnection, normalize, onEditorStateChange }) {
    const { t } = useTranslation();
    const [state, setState] = useState(null);
    const controller = useRef(null);
    useEffect(() => {
        let disposed = false;
        setState(null);
        store
            .get(instanceKey)
            .then((saved) => {
                if (disposed) return;
                const config = { ...defaults, ...saved };
                controller.current = createCollectionDraft(config, {
                    testConnection,
                    persist: async (draft) => {
                        const list = await persistCollectionConfig(store, instanceKey, draft);
                        // Notifications cannot turn a completed disk save into a reported failure.
                        await Promise.allSettled([
                            store
                                .get(instanceKey)
                                .then((safe) =>
                                    emit(`${instanceKey.replaceAll('.', '_').replaceAll('@', ':')}_changed`, safe)
                                ),
                            emit('collection_service_list_changed', list),
                        ]);
                    },
                    onChange: (next) => {
                        setState(next);
                        onEditorStateChange?.({ dirty: next.dirty, saving: next.saving });
                    },
                });
                setState({ config, status: 'untested', error: null, saving: false });
            })
            .catch(() => {
                if (!disposed) setState({ status: 'load_failed' });
            });
        return () => {
            disposed = true;
            controller.current?.dispose();
            controller.current = null;
        };
    }, [instanceKey]);
    if (!state) return null;
    if (!state.config) return <p role='alert'>{t('services.collection.status.load_failed')}</p>;
    const { config, status, saving, error } = state;
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                controller.current.save();
            }}
        >
            <p className='text-sm mb-3'>{t(guide)}</p>
            {fields.map(({ key, label, secret, type }) => (
                <div
                    className='config-item'
                    key={key}
                >
                    <Input
                        label={t(label)}
                        labelPlacement='outside-left'
                        variant='bordered'
                        classNames={{ base: 'justify-between', mainWrapper: 'max-w-[55%]' }}
                        type={secret ? 'password' : type ?? 'text'}
                        isDisabled={saving}
                        value={String(config[key] ?? '')}
                        placeholder={
                            secret && config.secretRefs?.[key] ? t('services.collection.secret_saved') : undefined
                        }
                        onValueChange={(value) => {
                            const next = normalize ? normalize(key, value) : value;
                            if (next !== null) controller.current.change(key, next);
                        }}
                    />
                    {secret && config.secretRefs?.[key] && (
                        <Button
                            type='button'
                            size='sm'
                            variant='light'
                            isDisabled={saving}
                            onPress={() => controller.current.change(key, '')}
                        >
                            {t('services.collection.remove_secret')}
                        </Button>
                    )}
                </div>
            ))}
            <p
                role={error || status.endsWith('failed') ? 'alert' : 'status'}
                aria-live='polite'
                className='text-sm my-3'
            >
                {error
                    ? t(`services.collection.errors.${error.code ?? 'COLLECTION_FAILED'}`)
                    : t(`services.collection.status.${status}`)}
            </p>
            <div className='flex gap-2'>
                <Button
                    type='button'
                    isDisabled={saving || status === 'checking'}
                    isLoading={status === 'checking'}
                    onPress={() => controller.current.test()}
                >
                    {t('services.collection.test')}
                </Button>
                <Button
                    type='submit'
                    color='primary'
                    isLoading={saving}
                >
                    {t('services.collection.save')}
                </Button>
            </div>
        </form>
    );
}
