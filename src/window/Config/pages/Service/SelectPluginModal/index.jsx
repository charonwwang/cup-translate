import { uninstallPlugin, installPlugins } from '../../../../../utils/plugin_lifecycle';
import { store } from '../../../../../utils/store';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@nextui-org/react';
import { open as openInBrowser } from '@tauri-apps/api/shell';
import toast, { Toaster } from 'react-hot-toast';
import { MdDeleteOutline } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api';
import React, { useState } from 'react';

import { createServiceInstanceKey } from '../../../../../utils/service_instance';
import { useToastStyle } from '../../../../../hooks';
import { emit } from '@tauri-apps/api/event';

export default function SelectPluginModal(props) {
    const { isOpen, onOpenChange, setCurrentConfigKey, onConfigOpen, pluginType, pluginList } = props;
    const [installing, setInstalling] = useState(false);
    const [installResults, setInstallResults] = useState([]);
    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            scrollBehavior='inside'
        >
            <Toaster />
            <ModalContent className='max-h-[80vh]'>
                {(onClose) => (
                    <>
                        <ModalHeader>{t('config.service.add_service')}</ModalHeader>
                        <ModalBody>
                            <p className='text-sm'>{t('config.service.plugin_notice')}</p>
                            {installResults.map((result, index) => (
                                <p
                                    key={index}
                                    role='status'
                                    className='text-sm break-all'
                                >
                                    {result.path}: {result.success ? t('config.service.install_success') : result.error}
                                </p>
                            ))}
                            {Object.keys(pluginList).length === 0 && (
                                <Button
                                    fullWidth
                                    variant='flat'
                                    onPress={() => {
                                        openInBrowser('https://pot-app.com/plugin.html');
                                    }}
                                >
                                    <div className='w-full'>{t('config.service.view_plugin_list')}</div>
                                </Button>
                            )}

                            {Object.keys(pluginList).map((x) => {
                                return (
                                    <div
                                        className='flex justify-between'
                                        key={x}
                                    >
                                        <Button
                                            fullWidth
                                            className='mr-[8px]'
                                            onPress={() => {
                                                onClose();
                                                setCurrentConfigKey(createServiceInstanceKey(x));
                                                onConfigOpen();
                                            }}
                                            startContent={
                                                <img
                                                    src={pluginList[x].icon}
                                                    className='h-[24px] w-[24px] my-auto'
                                                />
                                            }
                                        >
                                            <div className='w-full'>{pluginList[x].display}</div>
                                        </Button>
                                        <Button
                                            isIconOnly
                                            color='danger'
                                            variant='flat'
                                            onPress={async () => {
                                                try {
                                                    await uninstallPlugin({
                                                        store,
                                                        emit,
                                                        kind: pluginType,
                                                        name: x,
                                                        removePackage: () =>
                                                            invoke('uninstall_plugin', { pluginType, pluginName: x }),
                                                    });
                                                    toast.success(t('config.service.uninstall_success'), {
                                                        style: toastStyle,
                                                    });
                                                } catch (error) {
                                                    toast.error(
                                                        error.message === 'PLUGIN_LAST_SERVICE'
                                                            ? t('config.service.least')
                                                            : String(error),
                                                        { style: toastStyle }
                                                    );
                                                }
                                            }}
                                        >
                                            <MdDeleteOutline className='text-xl' />
                                        </Button>
                                    </div>
                                );
                            })}
                            <div>
                                <Button
                                    fullWidth
                                    isLoading={installing}
                                    color='secondary'
                                    variant='flat'
                                    onPress={async () => {
                                        setInstalling(true);
                                        setInstallResults([]);
                                        try {
                                            const selected = await open({
                                                multiple: true,
                                                directory: false,
                                                filters: [{ name: '*.potext', extensions: ['potext'] }],
                                            });
                                            if (selected !== null) {
                                                const results = await installPlugins({
                                                    invoke,
                                                    paths: Array.isArray(selected) ? selected : [selected],
                                                });
                                                setInstallResults(results);
                                                if (results.some((result) => result.success))
                                                    await emit('reload_plugin_list');
                                            }
                                        } catch (error) {
                                            toast.error(String(error), { style: toastStyle });
                                        } finally {
                                            setInstalling(false);
                                        }
                                    }}
                                >
                                    <div className='w-full'>{t('config.service.install_plugin')}</div>
                                </Button>
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <Button
                                color='danger'
                                variant='light'
                                onPress={onClose}
                            >
                                {t('common.cancel')}
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
