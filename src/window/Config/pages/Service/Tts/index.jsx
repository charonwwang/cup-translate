import { DragDropContext, Draggable, Droppable } from 'react-beautiful-dnd';
import { Card, Spacer, Button, useDisclosure, Select, SelectItem } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';

import { useToastStyle } from '../../../../../hooks';
import SelectPluginModal from '../SelectPluginModal';
import { useConfig, deleteKey } from '../../../../../hooks';
import ServiceItem from './ServiceItem';
import SelectModal from './SelectModal';
import ConfigModal from './ConfigModal';

export default function Tts(props) {
    const { pluginList } = props;
    const {
        isOpen: isSelectPluginOpen,
        onOpen: onSelectPluginOpen,
        onOpenChange: onSelectPluginOpenChange,
    } = useDisclosure();
    const { isOpen: isSelectOpen, onOpen: onSelectOpen, onOpenChange: onSelectOpenChange } = useDisclosure();
    const { isOpen: isConfigOpen, onOpen: onConfigOpen, onOpenChange: onConfigOpenChange } = useDisclosure();
    const [currentConfigKey, setCurrentConfigKey] = useState('google_tts');
    // now it's service instance list
    const [ttsServiceInstanceList, setTtsServiceInstanceList] = useConfig('tts_service_list', ['google_tts']);

    const { t } = useTranslation();
    const [speechPolicy, setSpeechPolicy] = useConfig('speech_policy', 'engine');
    const toastStyle = useToastStyle();

    const reorder = (list, startIndex, endIndex) => {
        const result = Array.from(list);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        return result;
    };
    const onDragEnd = async (result) => {
        if (!result.destination) return;
        const items = reorder(ttsServiceInstanceList, result.source.index, result.destination.index);
        setTtsServiceInstanceList(items);
    };

    // 返回 true 表示确实删除了；false 表示被拒（例如「至少保留一个服务」）。
    // 调用方（SelectPluginModal 卸载插件）必须据此决定是否删除磁盘上的插件文件，
    // 否则会出现「文件已删但配置仍在」的不一致状态。
    const deleteServiceInstance = (instanceKey) => {
        if (ttsServiceInstanceList.length === 1) {
            toast.error(t('config.service.least'), { style: toastStyle });
            return false;
        }
        setTtsServiceInstanceList(ttsServiceInstanceList.filter((x) => x !== instanceKey));
        deleteKey(instanceKey);
        return true;
    };
    const updateServiceInstanceList = (instanceKey) => {
        if (ttsServiceInstanceList.includes(instanceKey)) {
            return;
        } else {
            const newList = [...ttsServiceInstanceList, instanceKey];
            setTtsServiceInstanceList(newList);
        }
    };

    return (
        <>
            <Toaster />
            <Card
                data-cup-card
                className='speech-policy-card'
            >
                <div className='speech-policy-heading'>
                    <h3>{t('translate.speech_service')}</h3>
                    <p>{t('translate.speech_policy_hint')}</p>
                </div>
                <Select
                    aria-label={t('translate.speech_service')}
                    selectedKeys={[speechPolicy || 'engine']}
                    variant='bordered'
                    size='sm'
                    className='speech-policy-control'
                    onSelectionChange={(keys) => {
                        const key = [...keys][0];
                        if (key) setSpeechPolicy(key);
                    }}
                >
                    <SelectItem key='engine'>{t('translate.follow_engine')}</SelectItem>
                    <SelectItem key='google'>Google</SelectItem>
                    <SelectItem key='local'>{t('translate.local_speech')}</SelectItem>
                    <SelectItem key='configured'>{t('translate.configured_speech')}</SelectItem>
                </Select>
            </Card>
            <Card
                data-cup-card
                className='config-service-list p-5'
            >
                <DragDropContext onDragEnd={onDragEnd}>
                    <Droppable
                        droppableId='droppable'
                        direction='vertical'
                    >
                        {(provided) => (
                            <div
                                className='min-h-[64px]'
                                ref={provided.innerRef}
                                {...provided.droppableProps}
                            >
                                {ttsServiceInstanceList !== null &&
                                    ttsServiceInstanceList.map((x, i) => {
                                        return (
                                            <Draggable
                                                key={x}
                                                draggableId={x}
                                                index={i}
                                            >
                                                {(provided) => {
                                                    return (
                                                        <div
                                                            ref={provided.innerRef}
                                                            {...provided.draggableProps}
                                                        >
                                                            <ServiceItem
                                                                {...provided.dragHandleProps}
                                                                serviceInstanceKey={x}
                                                                key={x}
                                                                pluginList={pluginList}
                                                                deleteServiceInstance={deleteServiceInstance}
                                                                setCurrentConfigKey={setCurrentConfigKey}
                                                                onConfigOpen={onConfigOpen}
                                                            />
                                                            <Spacer y={2} />
                                                        </div>
                                                    );
                                                }}
                                            </Draggable>
                                        );
                                    })}
                            </div>
                        )}
                    </Droppable>
                </DragDropContext>
                <Spacer y={2} />
                <div className='flex'>
                    <Button
                        fullWidth
                        variant='flat'
                        color='primary'
                        onPress={onSelectOpen}
                    >
                        {t('config.service.add_builtin_service')}
                    </Button>
                    <Spacer x={2} />
                    <Button
                        fullWidth
                        variant='bordered'
                        onPress={onSelectPluginOpen}
                    >
                        {t('config.service.add_external_service')}
                    </Button>
                </div>
            </Card>
            <SelectPluginModal
                isOpen={isSelectPluginOpen}
                onOpenChange={onSelectPluginOpenChange}
                setCurrentConfigKey={setCurrentConfigKey}
                onConfigOpen={onConfigOpen}
                pluginType='tts'
                pluginList={pluginList}
                deleteService={deleteServiceInstance}
            />
            <SelectModal
                isOpen={isSelectOpen}
                onOpenChange={onSelectOpenChange}
                setCurrentConfigKey={setCurrentConfigKey}
                onConfigOpen={onConfigOpen}
            />
            <ConfigModal
                serviceInstanceKey={currentConfigKey}
                isOpen={isConfigOpen}
                pluginList={pluginList}
                onOpenChange={onConfigOpenChange}
                updateServiceInstanceList={updateServiceInstanceList}
            />
        </>
    );
}
