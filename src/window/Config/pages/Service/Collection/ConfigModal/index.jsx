import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Spacer } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import React, { useEffect, useState } from 'react';

import {
    ServiceSourceType,
    getServiceName,
    getServiceSouceType,
    whetherPluginService,
} from '../../../../../../utils/service_instance';
import * as builtinServices from '../../../../../../services/collection';
import { PluginConfig } from '../../PluginConfig';

export default function ConfigModal(props) {
    const { serviceInstanceKey, pluginList, isOpen, onOpenChange, updateServiceInstanceList } = props;

    const [editorState, setEditorState] = useState({ dirty: false, saving: false });
    const [discardPrompt, setDiscardPrompt] = useState(false);
    useEffect(() => {
        setEditorState({ dirty: false, saving: false });
        setDiscardPrompt(false);
    }, [isOpen, serviceInstanceKey]);
    const requestClose = () => {
        if (editorState.saving) return;
        if (editorState.dirty) setDiscardPrompt(true);
        else onOpenChange(false);
    };

    const serviceSourceType = getServiceSouceType(serviceInstanceKey);
    const pluginServiceFlag = whetherPluginService(serviceInstanceKey);
    const serviceName = getServiceName(serviceInstanceKey);
    const { t } = useTranslation();
    const ConfigComponent = pluginServiceFlag ? PluginConfig : builtinServices[serviceName].Config;

    return pluginServiceFlag && !(serviceName in pluginList) ? (
        <></>
    ) : (
        <Modal
            isOpen={isOpen}
            onOpenChange={(open) => (open ? onOpenChange(true) : requestClose())}
            scrollBehavior='inside'
        >
            <ModalContent className='max-h-[75vh]'>
                {(onClose) => (
                    <>
                        <ModalHeader>
                            {serviceSourceType === ServiceSourceType.BUILDIN && (
                                <>
                                    <img
                                        src={builtinServices[serviceName].info.icon}
                                        className='h-[24px] w-[24px] my-auto'
                                        draggable={false}
                                    />
                                    <Spacer x={2} />
                                    {t(`services.collection.${serviceName}.title`)}
                                </>
                            )}
                            {pluginServiceFlag && (
                                <>
                                    <img
                                        src={pluginList[serviceName].icon}
                                        className='h-[24px] w-[24px] my-auto'
                                        draggable={false}
                                    />

                                    <Spacer x={2} />
                                    {`${pluginList[serviceName].display} [${t('common.plugin')}]`}
                                </>
                            )}
                        </ModalHeader>
                        <ModalBody>
                            <ConfigComponent
                                name={serviceName}
                                instanceKey={serviceInstanceKey}
                                pluginType='collection'
                                pluginList={pluginList}
                                updateServiceList={updateServiceInstanceList}
                                onClose={requestClose}
                                onEditorStateChange={(state) => {
                                    setEditorState(state);
                                    if (!state.dirty) setDiscardPrompt(false);
                                }}
                            />
                        </ModalBody>
                        {discardPrompt && (
                            <p
                                role='alert'
                                className='px-6 text-sm'
                            >
                                {t('services.collection.discard_prompt')}
                            </p>
                        )}
                        <ModalFooter>
                            {discardPrompt ? (
                                <>
                                    <Button
                                        variant='light'
                                        onPress={() => setDiscardPrompt(false)}
                                    >
                                        {t('services.collection.keep_editing')}
                                    </Button>
                                    <Button
                                        color='danger'
                                        isDisabled={editorState.saving}
                                        onPress={() => {
                                            if (!editorState.saving) onOpenChange(false);
                                        }}
                                    >
                                        {t('services.collection.discard')}
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    color='danger'
                                    variant='light'
                                    isDisabled={editorState.saving}
                                    onPress={requestClose}
                                >
                                    {t('common.cancel')}
                                </Button>
                            )}
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
