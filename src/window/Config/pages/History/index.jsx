import { invoke } from '@tauri-apps/api/tauri';
import { LuCopy, LuVolume2, LuSquare, LuLoader2 } from 'react-icons/lu';
import { historyResult } from '../../../../utils/historyText';
import { writeClipboardSafely } from '../../../../utils/clipboard';
import { useSpeech } from '../../../../hooks/useSpeech';
import { resolveSpeechService } from '../../../../utils/speechService';
import * as ttsServices from '../../../../services/tts';
import detect from '../../../../utils/lang_detect';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure } from '@nextui-org/react';
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from '@nextui-org/react';
import { readDir, BaseDirectory, readTextFile, exists } from '@tauri-apps/api/fs';
import { Textarea, Button, ButtonGroup } from '@nextui-org/react';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import React, { useEffect, useState } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { Pagination } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import Database from 'tauri-plugin-sql-api';
import { error as logError } from 'tauri-plugin-log-api';

import * as builtinCollectionServices from '../../../../services/collection';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as builtinServices from '../../../../services/translate';
import { useConfig, useToastStyle } from '../../../../hooks';
import { LanguageFlag } from '../../../../utils/language';
import { store } from '../../../../utils/store';
import { osType } from '../../../../utils/env';
import {
    ServiceSourceType,
    ServiceType,
    getServiceName,
    getServiceSouceType,
    whetherAvailableService,
} from '../../../../utils/service_instance';

export default function History() {
    const [collectionServiceList] = useConfig('collection_service_list', []);
    const { isOpen, onOpen, onOpenChange } = useDisclosure();
    const [pluginList, setPluginList] = useState(null);
    const [selectedItem, setSelectItem] = useState(null);
    const [editing, setEditing] = useState(false);
    const [reading, setReading] = useState('');
    const [speechPolicy] = useConfig('speech_policy', 'engine');
    const [ttsList] = useConfig('tts_service_list', ['google_tts']);
    const speech = useSpeech(isOpen ? `${selectedItem?.id}:${selectedItem?.text}:${selectedItem?.result}` : null);
    const copy = async (text) => {
        if (await writeClipboardSafely(text)) toast.success(t('common.copied'), { style: toastStyle });
        else toast.error(t('config.history.copy_failed'), { style: toastStyle });
    };
    const read = async (part) => {
        if (reading !== part) speech.stop();
        setReading(part);
        try {
            await speech.toggle(async () => {
                const text = part === 'source' ? selectedItem.text : historyResult(selectedItem.result);
                let language = part === 'source' ? selectedItem.source : selectedItem.target;
                if (!language || language === 'auto') language = await detect(text);
                const key = resolveSpeechService(getServiceName(selectedItem.service), speechPolicy, ttsList);
                if (!key) throw new Error('Select a speech service in settings');
                if (getServiceSouceType(key) === ServiceSourceType.PLUGIN) {
                    const config = (await store.get(key)) || {};
                    const metadata = JSON.parse(
                        await readTextFile(`plugins/tts/${getServiceName(key)}/info.json`, {
                            dir: BaseDirectory.AppConfig,
                        })
                    );
                    const [func, utils] = await invoke_plugin('tts', getServiceName(key));
                    if (!(language in metadata.language)) throw new Error('Unsupported speech language');
                    return func(text, metadata.language[language], { config, utils });
                }
                const provider = ttsServices[getServiceName(key)];
                if (!(language in provider.Language)) throw new Error('Unsupported speech language');
                return provider.tts(text, provider.Language[language], { config: (await store.get(key)) || {} });
            });
        } catch {
            toast.error(t('translate.speech_failed'), { style: toastStyle });
        }
    };
    const actions = (part, text) => (
        <div className='history-text-actions'>
            <Button
                size='sm'
                variant='light'
                startContent={<LuCopy size={14} />}
                onPress={() => copy(text)}
            >
                {t('translate.copy')}
            </Button>
            <Button
                size='sm'
                variant='light'
                startContent={
                    reading === part && speech.status === 'loading' ? (
                        <LuLoader2
                            className='animate-spin'
                            size={14}
                        />
                    ) : reading === part && speech.status === 'playing' ? (
                        <LuSquare size={14} />
                    ) : (
                        <LuVolume2 size={14} />
                    )
                }
                onPress={() => read(part)}
            >
                {t(reading === part && speech.status !== 'idle' ? 'translate.stop_speaking' : 'translate.speak')}
            </Button>
        </div>
    );

    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [items, setItems] = useState([]);
    const toastStyle = useToastStyle();
    const { t } = useTranslation();
    useEffect(() => {
        init();
        loadPluginList();
    }, []);

    useEffect(() => {
        getData();
    }, [total, page]);

    const init = async () => {
        try {
            const db = await Database.load('sqlite:history.db');
            const result = await db.select('SELECT COUNT(*) FROM history');
            if (result[0] && result[0]['COUNT(*)']) {
                setTotal(result[0]['COUNT(*)']);
            }
        } catch (e) {
            // 表尚不存在（从未翻译过 / 刚被清空）或 sqlite 插件未就绪时，
            // 视为「0 条历史」即可，不应让异常逃逸中断页面加载。
            logError('[history] init failed: ' + e);
            setTotal(0);
            setItems([]);
        }
    };
    const getData = async () => {
        try {
            const db = await Database.load('sqlite:history.db');
            let result = await db.select('SELECT * FROM history ORDER BY id DESC LIMIT 20 OFFSET $1', [
                20 * (page - 1),
            ]);
            setItems(result);
        } catch (e) {
            // getData 由 useEffect 以裸调用触发（未 await、未 catch），
            // 因此必须在此吞掉异常，否则会变成未处理的 promise rejection。
            logError('[history] load failed: ' + e);
            setItems([]);
        }
    };

    const getSelectedData = async (id) => {
        try {
            const db = await Database.load('sqlite:history.db');
            let result = await db.select('SELECT * FROM history WHERE id=$1', [id]);
            setSelectItem(result[0]);
            setEditing(false);
        } catch (e) {
            logError('[history] load record failed: ' + e);
        }
    };
    const clearData = async () => {
        try {
            const db = await Database.load('sqlite:history.db');
            // 用 DELETE 清空行而不是 DROP TABLE：全项目只有
            // TargetArea.addToHistory 的失败重试会重建该表，
            // 一旦把表删掉，历史页会持续报 "no such table"，
            // 直到用户再翻译一次为止。清空数据不应破坏表结构。
            await db.execute('DELETE FROM history');
            await db.execute('VACUUM');
            setItems([]);
            setTotal(0);
            setPage(1);
        } catch (e) {
            // 日志保留原始错误（诊断用），但**给用户看的是本地化文案**。
            // 修复前直接 toast 出 '[history] clear failed: ...'：
            // 那是英文 + 内部标签，非英语用户看不懂，也泄露了实现细节。
            logError('[history] clear failed: ' + e);
            toast.error(`${t('config.history.clear_failed')}: ${e}`, { style: toastStyle });
        }
    };
    const updateData = async () => {
        try {
            const db = await Database.load('sqlite:history.db');
            await db.execute('UPDATE history SET text=$1, result=$2 WHERE id=$3', [
                selectedItem.text,
                selectedItem.result,
                selectedItem.id,
            ]);
            await getData();
        } catch (e) {
            logError('[history] update failed: ' + e);
            toast.error(`${t('config.history.update_failed')}: ${e}`, { style: toastStyle });
        }
    };

    const formatDate = (date) => {
        function padTo2Digits(num) {
            return num.toString().padStart(2, '0');
        }
        const year = date.getFullYear().toString().slice(2, 4);
        const month = padTo2Digits(date.getMonth() + 1);
        const day = padTo2Digits(date.getDate());
        const hour = padTo2Digits(date.getHours());
        const minute = padTo2Digits(date.getMinutes());
        const second = padTo2Digits(date.getSeconds());
        return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
    };
    const loadPluginList = async () => {
        const serviceTypeList = ['translate', 'collection'];
        let temp = {};
        for (const serviceType of serviceTypeList) {
            temp[serviceType] = {};
            if (await exists(`plugins/${serviceType}`, { dir: BaseDirectory.AppConfig })) {
                const plugins = await readDir(`plugins/${serviceType}`, { dir: BaseDirectory.AppConfig });
                for (const plugin of plugins) {
                    let pluginInfo;
                    try {
                        pluginInfo = await invoke('plugin_info', { pluginType: serviceType, pluginName: plugin.name });
                    } catch (e) {
                        console.error(`[plugin] skip broken plugin ${plugin.name}:`, e);
                        continue;
                    }
                    if ('icon' in pluginInfo) {
                        const appConfigDirPath = await appConfigDir();
                        const iconPath = await join(
                            appConfigDirPath,
                            `plugins/${serviceType}/${plugin.name}/${pluginInfo.icon}`
                        );
                        pluginInfo.icon = convertFileSrc(iconPath);
                    }
                    temp[serviceType][plugin.name] = pluginInfo;
                }
            }
        }
        setPluginList({ ...temp });
    };

    return (
        pluginList !== null && (
            <>
                <Toaster />
                <Table
                    fullWidth
                    hideHeader
                    selectionMode='single'
                    selectionBehavior='toggle'
                    aria-label='History Table'
                    classNames={{
                        base: 'history-table',
                        table: 'table-fixed',
                        td: 'px-0',
                    }}
                    onRowAction={(id) => {
                        getSelectedData(id);
                        onOpen();
                    }}
                >
                    <TableHeader>
                        <TableColumn key='service' />
                        <TableColumn key='text' />
                        <TableColumn key='source' />
                        <TableColumn key='target' />
                        <TableColumn key='result' />
                        <TableColumn key='timestamp' />
                    </TableHeader>
                    <TableBody
                        emptyContent={'No History to display.'}
                        items={items}
                    >
                        {(item) =>
                            whetherAvailableService(item.service, {
                                [ServiceSourceType.BUILDIN]: builtinServices,
                                [ServiceSourceType.PLUGIN]: pluginList[ServiceType.TRANSLATE],
                            }) && (
                                <TableRow key={item.id}>
                                    <TableCell>
                                        {getServiceSouceType(item.service) === ServiceSourceType.PLUGIN ? (
                                            <img
                                                src={pluginList['translate'][getServiceName(item.service)].icon}
                                                className='h-[18px] w-[18px] my-auto mr-[8px]'
                                                draggable={false}
                                            />
                                        ) : (
                                            <img
                                                src={`${builtinServices[getServiceName(item.service)].info.icon}`}
                                                className='h-[18px] w-[18px] my-auto mr-[8px]'
                                                draggable={false}
                                            />
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <p className='history-preview'>{item.text}</p>
                                    </TableCell>
                                    <TableCell>
                                        <span className={`w-[30px] fi fi-${LanguageFlag[item.source]}`} />
                                    </TableCell>
                                    <TableCell>
                                        <span className={`w-[30px] fi fi-${LanguageFlag[item.target]}`} />
                                    </TableCell>
                                    <TableCell>
                                        <p className='history-preview'>{historyResult(item.result)}</p>
                                    </TableCell>
                                    <TableCell>
                                        <p className='history-time'>{formatDate(new Date(item.timestamp))}</p>
                                    </TableCell>
                                </TableRow>
                            )
                        }
                    </TableBody>
                </Table>
                <div className='mt-[8px] flex justify-around'>
                    <Pagination
                        showControls
                        isCompact
                        total={Math.max(1, Math.ceil(total / 20))}
                        page={page}
                        onChange={setPage}
                    />
                    <Button
                        size='sm'
                        className='my-auto'
                        onPress={clearData}
                    >
                        {t('common.clear')}
                    </Button>
                </div>

                <Modal
                    aria-label={t('config.history.detail')}
                    placement='center'
                    isOpen={isOpen}
                    onOpenChange={onOpenChange}
                    scrollBehavior='inside'
                >
                    <ModalContent className='history-detail max-h-[85vh]'>
                        {(onClose) =>
                            selectedItem && (
                                <>
                                    <ModalHeader>
                                        <div className='history-detail-heading'>
                                            {getServiceSouceType(selectedItem.service) === ServiceSourceType.PLUGIN ? (
                                                <img
                                                    src={
                                                        pluginList['translate'][getServiceName(selectedItem.service)]
                                                            .icon
                                                    }
                                                    className='h-[24px] w-[24px] my-auto'
                                                    draggable={false}
                                                />
                                            ) : (
                                                <img
                                                    src={`${builtinServices[getServiceName(selectedItem.service)].info.icon}`}
                                                    className='h-[24px] w-[24px] m-auto mr-[8px]'
                                                    draggable={false}
                                                />
                                            )}
                                            <span>{t('config.history.detail')}</span>
                                        </div>
                                    </ModalHeader>
                                    <ModalBody>
                                        <section className='history-text-section'>
                                            <div className='history-section-heading'>
                                                <h3>{t('config.history.source_text')}</h3>
                                                {actions('source', selectedItem.text)}
                                            </div>
                                            <Textarea
                                                aria-label={t('config.history.source_text')}
                                                variant='bordered'
                                                isReadOnly={!editing}
                                                value={selectedItem.text}
                                                minRows={2}
                                                maxRows={8}
                                                onValueChange={(text) => setSelectItem({ ...selectedItem, text })}
                                            />
                                        </section>
                                        <section className='history-text-section'>
                                            <div className='history-section-heading'>
                                                <h3>{t('config.history.translated_text')}</h3>
                                                {actions('target', historyResult(selectedItem.result))}
                                            </div>
                                            <Textarea
                                                aria-label={t('config.history.translated_text')}
                                                variant='bordered'
                                                isReadOnly={!editing}
                                                value={
                                                    editing ? selectedItem.result : historyResult(selectedItem.result)
                                                }
                                                minRows={2}
                                                maxRows={10}
                                                onValueChange={(result) => setSelectItem({ ...selectedItem, result })}
                                            />
                                        </section>
                                    </ModalBody>
                                    <ModalFooter className='flex justify-between'>
                                        <div className='settings-actions'>
                                            <Button
                                                variant='light'
                                                onPress={onClose}
                                            >
                                                {t('common.close', { defaultValue: 'Close' })}
                                            </Button>
                                            {historyResult(selectedItem.result) === selectedItem.result && (
                                                <Button
                                                    color={editing ? 'primary' : 'default'}
                                                    variant={editing ? 'solid' : 'light'}
                                                    onPress={async () => {
                                                        if (editing) {
                                                            await updateData();
                                                            setEditing(false);
                                                        } else setEditing(true);
                                                    }}
                                                >
                                                    {t(editing ? 'common.save' : 'config.history.edit')}
                                                </Button>
                                            )}
                                        </div>
                                        <ButtonGroup>
                                            {collectionServiceList &&
                                                collectionServiceList.map((instanceKey) => {
                                                    return (
                                                        <Button
                                                            key={instanceKey}
                                                            isIconOnly
                                                            variant='light'
                                                            onPress={async () => {
                                                                if (
                                                                    getServiceSouceType(instanceKey) ===
                                                                    ServiceSourceType.PLUGIN
                                                                ) {
                                                                    const pluginConfig =
                                                                        (await store.get(instanceKey)) ?? {};
                                                                    let func, utils;
                                                                    try {
                                                                        [func, utils] = await invoke_plugin(
                                                                            'collection',
                                                                            getServiceName(instanceKey)
                                                                        );
                                                                    } catch (e) {
                                                                        toast.error(e.toString(), {
                                                                            style: toastStyle,
                                                                        });
                                                                        return;
                                                                    }
                                                                    func(selectedItem.text, selectedItem.result, {
                                                                        config: pluginConfig,
                                                                        utils,
                                                                    }).then(
                                                                        (_) => {
                                                                            toast.success(
                                                                                t('translate.add_collection_success'),
                                                                                {
                                                                                    style: toastStyle,
                                                                                }
                                                                            );
                                                                        },
                                                                        (e) => {
                                                                            toast.error(e.toString(), {
                                                                                style: toastStyle,
                                                                            });
                                                                        }
                                                                    );
                                                                } else {
                                                                    const instanceConfig =
                                                                        (await store.get(instanceKey)) ?? {};
                                                                    builtinCollectionServices[
                                                                        getServiceName(instanceKey)
                                                                    ]
                                                                        .collection(
                                                                            selectedItem.text,
                                                                            selectedItem.result,
                                                                            {
                                                                                config: instanceConfig,
                                                                            }
                                                                        )
                                                                        .then(
                                                                            (_) => {
                                                                                toast.success(
                                                                                    t(
                                                                                        'translate.add_collection_success'
                                                                                    ),
                                                                                    {
                                                                                        style: toastStyle,
                                                                                    }
                                                                                );
                                                                            },
                                                                            (e) => {
                                                                                toast.error(e.toString(), {
                                                                                    style: toastStyle,
                                                                                });
                                                                            }
                                                                        );
                                                                }
                                                            }}
                                                        >
                                                            <img
                                                                src={
                                                                    getServiceSouceType(instanceKey) ===
                                                                    ServiceSourceType.PLUGIN
                                                                        ? pluginList['collection'][
                                                                              getServiceName(instanceKey)
                                                                          ].icon
                                                                        : builtinCollectionServices[
                                                                              getServiceName(instanceKey)
                                                                          ].info.icon
                                                                }
                                                                className='h-[24px] w-[24px]'
                                                            />
                                                        </Button>
                                                    );
                                                })}
                                        </ButtonGroup>
                                    </ModalFooter>
                                </>
                            )
                        }
                    </ModalContent>
                </Modal>
            </>
        )
    );
}
