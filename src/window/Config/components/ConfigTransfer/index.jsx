import React, { useState } from 'react';
import { Button, Checkbox, Card, CardBody, CardHeader } from '@nextui-org/react';
import { LuDownload, LuUpload } from 'react-icons/lu';
import { open, save } from '@tauri-apps/api/dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/api/fs';
import { relaunch } from '@tauri-apps/api/process';
import { useTranslation } from 'react-i18next';
import { store } from '../../../../utils/store';
import { createConfigTransfer, parseConfigTransfer, applyConfigTransfer } from '../../../../utils/configTransfer';
export default function ConfigTransfer() {
    const { t } = useTranslation();
    const [includeSecrets, setIncludeSecrets] = useState(false);
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [failed, setFailed] = useState(false);
    const [restart, setRestart] = useState(false);
    const run = async (action) => {
        setBusy(true);
        setFailed(false);
        setStatus('');
        try {
            await action();
        } catch {
            setFailed(true);
            setStatus(t('config.transfer.failed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card
            data-cup-card
            className='config-transfer'
        >
            <CardHeader data-cup-header>{t('config.transfer.title')}</CardHeader>
            <CardBody data-cup-body>
                <p className='settings-description'>{t('config.transfer.description')}</p>
                <Checkbox
                    size='sm'
                    isSelected={includeSecrets}
                    onValueChange={setIncludeSecrets}
                >
                    {t('config.transfer.secrets')}
                </Checkbox>
                <div className='settings-actions'>
                    <Button
                        variant='bordered'
                        startContent={<LuDownload size={15} />}
                        isDisabled={busy}
                        onPress={() =>
                            run(async () => {
                                const path = await save({
                                    defaultPath: 'cup-translate-settings.json',
                                    filters: [{ name: 'JSON', extensions: ['json'] }],
                                });
                                if (!path) return;
                                await writeTextFile(
                                    path,
                                    createConfigTransfer(Object.fromEntries(await store.entries()), includeSecrets)
                                );
                                setStatus(t('config.transfer.exported'));
                            })
                        }
                    >
                        {t('config.transfer.export')}
                    </Button>
                    <Button
                        variant='bordered'
                        startContent={<LuUpload size={15} />}
                        isDisabled={busy}
                        onPress={() =>
                            run(async () => {
                                const path = await open({
                                    multiple: false,
                                    filters: [{ name: 'JSON', extensions: ['json'] }],
                                });
                                if (!path || Array.isArray(path)) return;
                                setPending(parseConfigTransfer(await readTextFile(path)));
                            })
                        }
                    >
                        {t('config.transfer.import')}
                    </Button>
                </div>
                {pending && (
                    <div className='settings-import-preview'>
                        <p>{t('config.transfer.preview', { count: Object.keys(pending).length })}</p>
                        <div className='settings-actions'>
                            <Button
                                size='sm'
                                color='primary'
                                isLoading={busy}
                                onPress={() =>
                                    run(async () => {
                                        await applyConfigTransfer(store, pending);
                                        setPending(null);
                                        setRestart(true);
                                        setStatus(t('config.transfer.imported'));
                                    })
                                }
                            >
                                {t('config.transfer.apply')}
                            </Button>
                            <Button
                                size='sm'
                                variant='light'
                                isDisabled={busy}
                                onPress={() => setPending(null)}
                            >
                                {t('common.cancel')}
                            </Button>
                        </div>
                    </div>
                )}
                {status && (
                    <p
                        role={failed ? 'alert' : 'status'}
                        className={failed ? 'settings-error' : 'settings-description'}
                    >
                        {status}
                    </p>
                )}
                {restart && (
                    <Button
                        variant='light'
                        onPress={relaunch}
                    >
                        {t('config.transfer.restart')}
                    </Button>
                )}
            </CardBody>
        </Card>
    );
}
