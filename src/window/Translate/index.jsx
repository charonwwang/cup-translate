import { resolveLocalModel } from '../../services/translate/local_mt/options';
import { translationLanguages } from '../../utils/sourceLanguage';
import { useAtomValue } from 'jotai';
import { sourceTextAtom, sourceLanguageAtom, targetLanguageAtom, detectLanguageAtom } from './atoms';
import { serviceEligibility } from '../../utils/serviceEligibility';
import * as providers from '../../services/translate';
import { invoke } from '@tauri-apps/api/tauri';
import { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { readDir, BaseDirectory, readTextFile, exists } from '@tauri-apps/api/fs';
import { DragDropContext, Draggable, Droppable } from 'react-beautiful-dnd';
import { appWindow, currentMonitor } from '@tauri-apps/api/window';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { Spacer, Button } from '@nextui-org/react';
import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LuPin, LuX } from 'react-icons/lu';

import './translate.css';
import LanguageArea from './components/LanguageArea';
import SourceArea from './components/SourceArea';
import TargetArea from './components/TargetArea';
import { DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST } from '../../services/translate/defaults';
import { osType } from '../../utils/env';
import { useConfig } from '../../hooks';
import { store } from '../../utils/store';
import { info } from 'tauri-plugin-log-api';

let blurTimeout = null;
let resizeTimeout = null;
let moveTimeout = null;

const listenBlur = () => {
    return listen('tauri://blur', () => {
        if (appWindow.label === 'translate') {
            if (blurTimeout) {
                clearTimeout(blurTimeout);
            }
            info('Blur');
            // 100ms后关闭窗口，因为在 windows 下拖动窗口时会先切换成 blur 再立即切换成 focus
            // 如果直接关闭将导致窗口无法拖动
            blurTimeout = setTimeout(async () => {
                info('Confirm Blur');
                await appWindow.close();
            }, 100);
        }
    });
};

let unlisten = null;
// 取消 blur 监听
const unlistenBlur = () => {
    const pending = unlisten;
    unlisten = null;
    if (blurTimeout) {
        clearTimeout(blurTimeout);
        blurTimeout = null;
    }
    pending?.then((stop) => stop()).catch((error) => info(`Blur listener cleanup failed: ${error}`));
};

// 插件列表变更监听（独立变量）。
// 注意：listen() 返回 Promise（恒为真值），**不能**用 `if (!unlisten)` 之类
// 的判空来防重复订阅——那条件永远为假，会导致订阅从未建立。
// 这里用独立的模块级变量保存，卸载时显式取消。
let unlistenReloadPluginList = null;
const unlistenReloadPluginListEvent = () => {
    const pending = unlistenReloadPluginList;
    unlistenReloadPluginList = null;
    if (pending) {
        pending.then((f) => {
            f();
        });
    }
};

// 监听 focus 事件取消 blurTimeout 时间之内的关闭窗口
void listen('tauri://focus', () => {
    info('Focus');
    if (blurTimeout) {
        info('Cancel Close');
        clearTimeout(blurTimeout);
    }
});
// 监听 move 事件取消 blurTimeout 时间之内的关闭窗口
void listen('tauri://move', () => {
    info('Move');
    if (blurTimeout) {
        info('Cancel Close');
        clearTimeout(blurTimeout);
    }
});

export default function Translate() {
    const { t } = useTranslation();
    const [closeOnBlur] = useConfig('translate_close_on_blur', true);
    const [alwaysOnTop] = useConfig('translate_always_on_top', false);
    const [windowPosition] = useConfig('translate_window_position', 'mouse');
    const [rememberWindowSize] = useConfig('translate_remember_window_size', false);
    // deepl 需 API key；lingva / bing / ecdict 上游已停服且无自建入口，代码已删除（2026 实测）。
    const [translateServiceInstanceList, setTranslateServiceInstanceList] = useConfig(
        'translate_service_list',
        DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST
    );
    const [recognizeServiceInstanceList] = useConfig('recognize_service_list', ['system', 'tesseract']);
    const [ttsServiceInstanceList] = useConfig('tts_service_list', ['google_tts']);
    const [collectionServiceInstanceList] = useConfig('collection_service_list', []);
    const [hideLanguage] = useConfig('hide_language', false);
    const sourceText = useAtomValue(sourceTextAtom);
    const from = useAtomValue(sourceLanguageAtom);
    const detected = useAtomValue(detectLanguageAtom);
    const to = useAtomValue(targetLanguageAtom);
    const [secondLanguage] = useConfig('translate_second_language', 'en');
    const [privacyMode] = useConfig('privacy_mode', 'standard');
    const [glossary] = useConfig('glossary_v2', { enabled: false, entries: [], revision: 0 });
    const [revision, setRevision] = useState(0);
    const [eligible, setEligible] = useState([]);
    const [checkingServices, setCheckingServices] = useState(true);
    const [pined, setPined] = useState(false);
    const [pluginList, setPluginList] = useState(null);
    const [serviceInstanceConfigMap, setServiceInstanceConfigMap] = useState(null);
    const reorder = (list, startIndex, endIndex) => {
        const result = Array.from(list);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        return result;
    };

    const onDragEnd = async (result) => {
        if (!result.destination) return;
        const items = reorder(
            translateServiceInstanceList,
            translateServiceInstanceList.indexOf(eligible[result.source.index]),
            translateServiceInstanceList.indexOf(eligible[result.destination.index])
        );
        setTranslateServiceInstanceList(items);
    };
    // Reconcile both directions when a preference changes, including manual pinning.
    useEffect(() => {
        if (alwaysOnTop !== null) setPined(Boolean(alwaysOnTop));
    }, [alwaysOnTop]);
    useEffect(() => {
        appWindow.setAlwaysOnTop(pined).catch((error) => info(`Window pin failed: ${error}`));
        unlistenBlur();
        if (closeOnBlur === true && !pined) unlisten = listenBlur();
        return unlistenBlur;
    }, [closeOnBlur, pined]);
    // 保存窗口位置
    useEffect(() => {
        if (windowPosition !== null && windowPosition === 'pre_state') {
            const unlistenMove = listen('tauri://move', async () => {
                if (moveTimeout) {
                    clearTimeout(moveTimeout);
                }
                moveTimeout = setTimeout(async () => {
                    if (appWindow.label === 'translate') {
                        let position = await appWindow.outerPosition();
                        const monitor = await currentMonitor();
                        const factor = monitor.scaleFactor;
                        position = position.toLogical(factor);
                        await store.set('translate_window_position_x', parseInt(position.x));
                        await store.set('translate_window_position_y', parseInt(position.y));
                        await store.save();
                    }
                }, 100);
            });
            return () => {
                // 组件卸载时清理未触发的 debounce 定时器，防止对已卸载组件
                // 调用 appWindow/store 操作
                if (moveTimeout) {
                    clearTimeout(moveTimeout);
                    moveTimeout = null;
                }
                unlistenMove.then((f) => {
                    f();
                });
            };
        }
    }, [windowPosition]);
    // 保存窗口大小
    useEffect(() => {
        if (rememberWindowSize !== null && rememberWindowSize) {
            const unlistenResize = listen('tauri://resize', async () => {
                if (resizeTimeout) {
                    clearTimeout(resizeTimeout);
                }
                resizeTimeout = setTimeout(async () => {
                    if (appWindow.label === 'translate') {
                        let size = await appWindow.outerSize();
                        const monitor = await currentMonitor();
                        const factor = monitor.scaleFactor;
                        size = size.toLogical(factor);
                        await store.set('translate_window_height', parseInt(size.height));
                        await store.set('translate_window_width', parseInt(size.width));
                        await store.save();
                    }
                }, 100);
            });
            return () => {
                // 组件卸载时清理未触发的 debounce 定时器
                if (resizeTimeout) {
                    clearTimeout(resizeTimeout);
                    resizeTimeout = null;
                }
                unlistenResize.then((f) => {
                    f();
                });
            };
        }
    }, [rememberWindowSize]);

    const loadPluginList = async () => {
        const serviceTypeList = ['translate', 'tts', 'recognize', 'collection'];
        let temp = {};
        for (const serviceType of serviceTypeList) {
            temp[serviceType] = {};
            if (await exists(`plugins/${serviceType}`, { dir: BaseDirectory.AppConfig })) {
                const plugins = await readDir(`plugins/${serviceType}`, { dir: BaseDirectory.AppConfig });
                for (const plugin of plugins) {
                    let pluginInfo;
                    try {
                        const infoStr = await readTextFile(`plugins/${serviceType}/${plugin.name}/info.json`, {
                            dir: BaseDirectory.AppConfig,
                        });
                        pluginInfo = JSON.parse(infoStr);
                    } catch (e) {
                        console.error(`[plugin] skip broken plugin ${plugin.name}:`, e);
                        continue;
                    }
                    if ('icon' in pluginInfo) {
                        const appConfigDirPath = await appConfigDir();
                        const iconPath = await join(
                            appConfigDirPath,
                            `/plugins/${serviceType}/${plugin.name}/${pluginInfo.icon}`
                        );
                        pluginInfo.icon = convertFileSrc(iconPath);
                    }
                    temp[serviceType][plugin.name] = pluginInfo;
                }
            }
        }
        setPluginList({ ...temp });
    };

    useEffect(() => {
        loadPluginList();
        // 每次挂载都重新订阅：listen() 返回 Promise（恒真值），
        // 旧写法 `if (!unlisten)` 永远不成立，导致插件安装/卸载后
        // 翻译窗口的 pluginList 一直停留在旧数据。
        unlistenReloadPluginList = listen('reload_plugin_list', loadPluginList);
        return () => {
            unlistenReloadPluginListEvent();
        };
    }, []);

    const loadServiceInstanceConfigMap = async () => {
        const config = {};
        for (const serviceInstanceKey of translateServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        for (const serviceInstanceKey of recognizeServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        for (const serviceInstanceKey of ttsServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        for (const serviceInstanceKey of collectionServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        setServiceInstanceConfigMap({ ...config });
    };
    useEffect(() => {
        if (
            translateServiceInstanceList !== null &&
            recognizeServiceInstanceList !== null &&
            ttsServiceInstanceList !== null &&
            collectionServiceInstanceList !== null
        ) {
            loadServiceInstanceConfigMap();
        }
    }, [
        translateServiceInstanceList,
        recognizeServiceInstanceList,
        ttsServiceInstanceList,
        collectionServiceInstanceList,
    ]);

    useEffect(() => {
        let live = true;
        const pending = listen('request_context_invalidated', () => {
            if (live) {
                setRevision((v) => v + 1);
                loadServiceInstanceConfigMap();
            }
        });
        return () => {
            live = false;
            pending.then((stop) => stop());
        };
    }, [translateServiceInstanceList]);
    useEffect(() => {
        let live = true;
        // Keep mounted cards while eligibility is refreshed. Clearing this list
        // launches then aborts the same new text once before remounting it.
        setCheckingServices(true);
        if (!serviceInstanceConfigMap || !pluginList || !privacyMode || !from || !to || (from === 'auto' && !detected))
            return;
        const { source, target } = translationLanguages(from, detected, to);
        (async () => {
            const status = {};
            if (translateServiceInstanceList.some((key) => key.split('@')[0] === 'local_mt')) {
                const models = new Set(
                    translateServiceInstanceList
                        .filter((key) => key.split('@')[0] === 'local_mt')
                        .map((key) => resolveLocalModel(serviceInstanceConfigMap[key], source, target))
                        .filter(Boolean)
                );
                for (const pair of models) {
                    try {
                        status[pair] = await invoke('local_mt_model_status', { pair });
                    } catch {
                        status[pair] = { installed: false };
                    }
                }
            }
            const next = translateServiceInstanceList.filter((key) => {
                const name = key.split('@')[0];
                const provider =
                    providers[name] ??
                    (pluginList.translate[name] ? { Language: pluginList.translate[name].language } : null);
                return !serviceEligibility(
                    key,
                    serviceInstanceConfigMap[key],
                    source,
                    target,
                    privacyMode,
                    provider,
                    status
                );
            });
            if (live) {
                setEligible(next);
                setCheckingServices(false);
            }
        })();
        return () => {
            live = false;
        };
    }, [from, to, detected, secondLanguage, privacyMode, serviceInstanceConfigMap, pluginList, revision, glossary]);
    const primaryServiceKey = eligible[0];

    return (
        pluginList && (
            <div
                className={`cup-v4 translate-shell bg-background h-screen w-screen ${
                    osType === 'Linux' && 'rounded-[10px] border-1 border-default-100'
                }`}
            >
                <Toaster />
                <div
                    data-tauri-drag-region='true'
                    className={`translate-titlebar ${osType === 'Darwin' ? 'translate-titlebar-macos' : ''} h-[44px] w-full flex ${osType === 'Darwin' ? 'justify-end' : 'justify-between'}`}
                >
                    <span
                        className='window-brand'
                        data-tauri-drag-region='true'
                    >
                        cup-translate
                    </span>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='flat'
                        disableAnimation
                        className='my-auto bg-transparent'
                        aria-label={t('translate.pin')}
                        aria-pressed={pined}
                        onPress={() => {
                            setPined(!pined);
                        }}
                    >
                        <LuPin className={`text-[20px] ${pined ? 'text-primary' : 'text-default-400'}`} />
                    </Button>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='flat'
                        disableAnimation
                        className={`my-auto ${osType === 'Darwin' && 'hidden'} bg-transparent`}
                        aria-label={t('common.close')}
                        onPress={() => {
                            void appWindow.close();
                        }}
                    >
                        <LuX className='text-[20px] text-default-400' />
                    </Button>
                </div>
                <div className={`${osType === 'Linux' ? 'h-[calc(100vh-46px)]' : 'h-[calc(100vh-44px)]'} `}>
                    <div className='translate-scroll h-full overflow-y-auto'>
                        <div>
                            {serviceInstanceConfigMap !== null && (
                                <SourceArea
                                    pluginList={pluginList}
                                    serviceInstanceConfigMap={serviceInstanceConfigMap}
                                />
                            )}
                        </div>
                        <div className={`${hideLanguage && 'hidden'}`}>
                            <LanguageArea />
                        </div>
                        {sourceText.trim() && checkingServices && (
                            <p
                                className='p-4 text-xs text-default-500'
                                role='status'
                            >
                                {t('models.checking_services')}
                            </p>
                        )}
                        {sourceText.trim() && !checkingServices && eligible.length === 0 && (
                            <p
                                className='p-4 text-sm'
                                role='status'
                            >
                                {t('models.no_services')}
                            </p>
                        )}
                        <DragDropContext onDragEnd={onDragEnd}>
                            <Droppable
                                droppableId='droppable'
                                direction='vertical'
                            >
                                {(provided) => (
                                    <div
                                        ref={provided.innerRef}
                                        {...provided.droppableProps}
                                    >
                                        {translateServiceInstanceList !== null &&
                                            serviceInstanceConfigMap !== null &&
                                            eligible.map((serviceInstanceKey, index) => {
                                                const config = serviceInstanceConfigMap[serviceInstanceKey] ?? {};
                                                const enable = config['enable'] ?? true;

                                                return enable ? (
                                                    <Draggable
                                                        key={serviceInstanceKey}
                                                        draggableId={serviceInstanceKey}
                                                        index={index}
                                                    >
                                                        {(provided) => (
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                            >
                                                                <TargetArea
                                                                    {...provided.dragHandleProps}
                                                                    requestRevision={revision}
                                                                    privacyMode={privacyMode}
                                                                    glossary={glossary}
                                                                    index={index}
                                                                    primary={serviceInstanceKey === primaryServiceKey}
                                                                    name={serviceInstanceKey}
                                                                    translateServiceInstanceList={eligible}
                                                                    pluginList={pluginList}
                                                                    serviceInstanceConfigMap={serviceInstanceConfigMap}
                                                                />
                                                                <Spacer y={2} />
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                ) : (
                                                    <></>
                                                );
                                            })}
                                    </div>
                                )}
                            </Droppable>
                        </DragDropContext>
                    </div>
                </div>
            </div>
        )
    );
}
