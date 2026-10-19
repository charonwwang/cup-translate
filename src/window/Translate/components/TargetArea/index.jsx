import { resolveSpeechService, speechText } from '../../../../utils/speechService';
import { useSpeech } from '../../../../hooks/useSpeech';
import { resolveLocalPair } from '../../../../services/translate/local_mt/options';
import {
    Card,
    CardBody,
    CardHeader,
    CardFooter,
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@nextui-org/react';
import { LuChevronDown, LuChevronUp, LuGripVertical, LuRotateCcw } from 'react-icons/lu';
import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';
import { sendNotification } from '@tauri-apps/api/notification';
import React, { useEffect, useState, useRef } from 'react';
import PulseLoader from 'react-spinners/PulseLoader';
import { LuSquare, LuLoader2, LuVolume2, LuCopy, LuArrowLeftRight, LuBookPlus } from 'react-icons/lu';
import { semanticColors } from '@nextui-org/theme';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import Database from 'tauri-plugin-sql-api';
import { useTheme } from 'next-themes';
import { useAtomValue } from 'jotai';
import { nanoid } from 'nanoid';
import { useSpring, animated } from '@react-spring/web';
import useMeasure from 'react-use-measure';

import * as builtinCollectionServices from '../../../../services/collection';
import { isServiceConfigured } from '../../../../services/translate/required_config';
import { invoke } from '@tauri-apps/api/tauri';
import { sourceLanguageAtom, targetLanguageAtom } from '../LanguageArea';
import { useConfig, useToastStyle, useVoice } from '../../../../hooks';
import { sourceTextAtom, detectLanguageAtom } from '../SourceArea';
import { translationResultToText } from '../../../../utils/translationResult';
import { clipboardFailureMessage, writeClipboardSafely } from '../../../../utils/clipboard';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as builtinServices from '../../../../services/translate';
import * as builtinTtsServices from '../../../../services/tts';

import { info, error as logError } from 'tauri-plugin-log-api';
import {
    INSTANCE_NAME_CONFIG_KEY,
    ServiceSourceType,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherPluginService,
} from '../../../../utils/service_instance';

// Dictionary services sometimes return small HTML fragments for emphasis. Never
// insert that remote HTML into the privileged Tauri webview: an upstream service
// (or a local plugin) could otherwise execute script with desktop permissions.
function richTextToPlainText(value) {
    if (typeof value !== 'string') return '';

    const withLineBreaks = value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li)>/gi, '\n');
    const document = new DOMParser().parseFromString(withLineBreaks, 'text/html');
    return document.body.textContent ?? '';
}

export default function TargetArea(props) {
    const {
        index,
        primary = index === 0,
        name,
        translateServiceInstanceList,
        pluginList,
        serviceInstanceConfigMap,
        ...drag
    } = props;

    const [currentTranslateServiceInstanceKey, setCurrentTranslateServiceInstanceKey] = useState(name);
    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    const [appFontSize] = useConfig('app_font_size', 16);
    const [collectionServiceList] = useConfig('collection_service_list', []);
    const [ttsServiceList] = useConfig('tts_service_list', ['google_tts']);
    const [speechPolicy] = useConfig('speech_policy', 'engine');
    const [speechOverride, setSpeechOverride] = useState('');
    const speechService =
        speechOverride ||
        resolveSpeechService(getServiceName(currentTranslateServiceInstanceKey), speechPolicy, ttsServiceList);
    const effectiveTtsList = speechService ? [speechService] : [];
    const [translateSecondLanguage] = useConfig('translate_second_language', 'en');
    const [historyDisable] = useConfig('history_disable', false);
    const [isLoading, setIsLoading] = useState(false);
    const [hide, setHide] = useState(true);

    const [result, setResult] = useState('');
    const [backTranslation, setBackTranslation] = useState(null);
    const [showBack, setShowBack] = useState(false);
    const [backLoading, setBackLoading] = useState(false);
    const backRequest = useRef(0);
    const displayResult = showBack ? backTranslation : result;
    const activeRequest = useRef(null);
    const [showAllExamples, setShowAllExamples] = useState(false);
    const [error, setError] = useState('');
    const [skipped, setSkipped] = useState(false);

    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const [autoCopy] = useConfig('translate_auto_copy', 'disable');
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [clipboardMonitor] = useConfig('clipboard_monitor', false);

    const detectLanguage = useAtomValue(detectLanguageAtom);
    const spokenLanguage = showBack ? (sourceLanguage === 'auto' ? detectLanguage : sourceLanguage) : targetLanguage;
    useEffect(() => {
        backRequest.current += 1;
        setBackTranslation(null);
        setShowBack(false);
        setBackLoading(false);
        return () => {
            backRequest.current += 1;
        };
    }, [result, sourceText, sourceLanguage, targetLanguage, currentTranslateServiceInstanceKey]);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const toastStyle = useToastStyle();
    const speak = useVoice();
    const speech = useSpeech(displayResult);
    const exampleSpeech = useSpeech('dictionary-example');
    const [activeExample, setActiveExample] = useState('');
    const speechLabel = speech.status === 'idle' ? t('translate.speak') : t('translate.stop_speaking');
    const exampleSpeechLabel = exampleSpeech.status === 'idle' ? t('translate.speak') : t('translate.stop_speaking');
    const theme = useTheme();

    useEffect(() => {
        if (exampleSpeech.status === 'idle') setActiveExample('');
    }, [exampleSpeech.status]);
    useEffect(() => {
        exampleSpeech.stop();
        setActiveExample('');
    }, [result]);

    const copyToClipboard = (text, feedback = 'toast') =>
        writeClipboardSafely(text, {
            onSuccess: () => {
                if (feedback === 'notification') {
                    sendNotification({ title: 'cup-translate', body: t('common.copied') }).catch((reason) =>
                        logError('Copy notification failed: ' + reason)
                    );
                } else {
                    toast.success(t('common.copied'), { style: toastStyle });
                }
            },
            onError: (reason) => {
                logError('clipboard write failed: ' + reason);
                toast.error(clipboardFailureMessage(reason, t), { style: toastStyle });
            },
        });

    useEffect(() => {
        if (error) {
            logError(`[${currentTranslateServiceInstanceKey}]happened error: ` + error);
            // 出错时自动展开卡片，避免失败被静默折叠、用户看不到任何反馈
            setHide(false);
        }
    }, [error]);

    // listen to translation
    useEffect(() => {
        setResult('');
        setShowAllExamples(false);
        if (!sourceText.trim()) setHide(true);
        setError('');
        setSkipped(false);
        if (
            sourceText.trim() !== '' &&
            sourceLanguage &&
            targetLanguage &&
            autoCopy !== null &&
            hideWindow !== null &&
            clipboardMonitor !== null
        ) {
            if (autoCopy === 'source' && !clipboardMonitor) {
                copyToClipboard(sourceText, hideWindow ? 'notification' : 'toast');
            }
            translate();
        }
        return () => {
            activeRequest.current = null;
        };
    }, [
        sourceText,
        sourceLanguage,
        targetLanguage,
        autoCopy,
        hideWindow,
        currentTranslateServiceInstanceKey,
        clipboardMonitor,
    ]);

    const addToHistory = async (text, source, target, serviceInstanceKey, result, isRetry = false) => {
        let db;
        try {
            db = await Database.load('sqlite:history.db');
            await db.execute(
                'INSERT into history (text, source, target, service, result, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                [text, source, target, serviceInstanceKey, result, Date.now()]
            );
        } catch (e) {
            // 首次失败可能是表不存在，建表后重试一次；再失败则放弃（防止无限递归）
            if (!isRetry) {
                try {
                    await db.execute(
                        'CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,service TEXT NOT NULL, result TEXT NOT NULL,timestamp INTEGER NOT NULL)'
                    );
                    await addToHistory(text, source, target, serviceInstanceKey, result, true);
                } catch (e2) {
                    console.error('[history] create table failed:', e2);
                }
            } else {
                console.error('[history] insert failed after retry:', e);
            }
        } finally {
            if (db) {
                try {
                    db.close();
                } catch {
                    // 忽略关闭失败
                }
            }
        }
    };

    function invokeOnce(fn) {
        let isInvoke = false;

        return (...args) => {
            if (isInvoke) {
                return;
            } else {
                fn(...args);
                isInvoke = true;
            }
        };
    }

    const translate = async () => {
        let id = nanoid();
        activeRequest.current = id;

        const translateServiceName = getServiceName(currentTranslateServiceInstanceKey);

        // 未配置的内置引擎直接跳过、不发无效请求（配置要求见 services/translate 的 isServiceConfigured）
        if (!whetherPluginService(currentTranslateServiceInstanceKey)) {
            const skipCheckConfig = serviceInstanceConfigMap
                ? serviceInstanceConfigMap[currentTranslateServiceInstanceKey]
                : null;
            if (!isServiceConfigured(translateServiceName, skipCheckConfig)) {
                info(`[${currentTranslateServiceInstanceKey}]skipped: unconfigured, request not sent`);
                setIsLoading(false);
                setSkipped(true);
                setHide(false);
                return;
            }
            // local_mt 需要先下载模型：未下载时优雅跳过（显示提示），不报错
            if (translateServiceName === 'local_mt') {
                try {
                    const effectiveTarget =
                        sourceLanguage === 'auto' && targetLanguage === detectLanguage
                            ? translateSecondLanguage
                            : targetLanguage;
                    const pair = resolveLocalPair(
                        sourceLanguage === 'auto' ? detectLanguage : sourceLanguage,
                        effectiveTarget
                    );
                    const status = pair ? await invoke('local_mt_model_status', { pair }) : { installed: true };
                    if (activeRequest.current !== id) return;
                    if (!status.installed) {
                        info(`[${currentTranslateServiceInstanceKey}]skipped: local_mt model not downloaded`);
                        setIsLoading(false);
                        setSkipped(true);
                        setHide(false);
                        return;
                    }
                } catch {
                    // 状态检查失败不阻塞翻译，继续尝试
                }
            }
        }

        if (whetherPluginService(currentTranslateServiceInstanceKey)) {
            const pluginInfo = pluginList['translate'][translateServiceName];
            if (sourceLanguage in pluginInfo.language && targetLanguage in pluginInfo.language) {
                let newTargetLanguage = targetLanguage;
                if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                    newTargetLanguage = translateSecondLanguage;
                }
                setIsLoading(true);
                setHide(true);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                instanceConfig['enable'] = 'true';
                const setHideOnce = invokeOnce((value) => setHide(primary ? value : true));
                let func, utils;
                try {
                    [func, utils] = await invoke_plugin('translate', translateServiceName);
                } catch (e) {
                    info(`[${currentTranslateServiceInstanceKey}]plugin load failed:` + e);
                    if (activeRequest.current !== id) return;
                    setError(e.toString());
                    setIsLoading(false);
                    setHide(false);
                    return;
                }
                func(sourceText.trim(), pluginInfo.language[sourceLanguage], pluginInfo.language[newTargetLanguage], {
                    config: instanceConfig,
                    detect: detectLanguage,
                    setResult: (v) => {
                        if (activeRequest.current !== id) return;
                        setResult(v);
                        setHideOnce(false);
                    },
                    utils,
                }).then(
                    (v) => {
                        info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                        if (activeRequest.current !== id) return;
                        setResult(typeof v === 'string' ? v.trim() : v);
                        setIsLoading(false);
                        if (v !== '') {
                            setHideOnce(false);
                        }
                        if (!historyDisable) {
                            addToHistory(
                                sourceText.trim(),
                                detectLanguage,
                                newTargetLanguage,
                                currentTranslateServiceInstanceKey,
                                typeof v === 'string' ? v.trim() : v
                            );
                        }
                        if (primary && !clipboardMonitor) {
                            switch (autoCopy) {
                                case 'target':
                                    copyToClipboard(translationResultToText(v), hideWindow ? 'notification' : 'toast');
                                    break;
                                case 'source_target':
                                    copyToClipboard(
                                        sourceText.trim() + '\n\n' + translationResultToText(v),
                                        hideWindow ? 'notification' : 'toast'
                                    );
                                    break;
                                default:
                                    break;
                            }
                        }
                    },
                    (e) => {
                        info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                        if (activeRequest.current !== id) return;
                        setError(e.toString());
                        setIsLoading(false);
                    }
                );
            } else {
                setError(t('common.language_not_supported'));
            }
        } else {
            const LanguageEnum = builtinServices[translateServiceName].Language;
            if (sourceLanguage in LanguageEnum && targetLanguage in LanguageEnum) {
                let newTargetLanguage = targetLanguage;
                if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                    newTargetLanguage = translateSecondLanguage;
                }
                setIsLoading(true);
                setHide(true);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                const setHideOnce = invokeOnce((value) => setHide(primary ? value : true));
                builtinServices[translateServiceName]
                    .translate(sourceText.trim(), LanguageEnum[sourceLanguage], LanguageEnum[newTargetLanguage], {
                        config: instanceConfig,
                        detect: detectLanguage,
                        setResult: (v) => {
                            if (activeRequest.current !== id) return;
                            setResult(v);
                            setHideOnce(false);
                        },
                    })
                    .then(
                        (v) => {
                            info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                            if (activeRequest.current !== id) return;
                            setResult(typeof v === 'string' ? v.trim() : v);
                            setIsLoading(false);
                            if (v !== '') {
                                setHideOnce(false);
                            }
                            if (!historyDisable) {
                                addToHistory(
                                    sourceText.trim(),
                                    detectLanguage,
                                    newTargetLanguage,
                                    currentTranslateServiceInstanceKey,
                                    typeof v === 'string' ? v.trim() : v
                                );
                            }
                            if (primary && !clipboardMonitor) {
                                switch (autoCopy) {
                                    case 'target':
                                        copyToClipboard(
                                            translationResultToText(v),
                                            hideWindow ? 'notification' : 'toast'
                                        );
                                        break;
                                    case 'source_target':
                                        copyToClipboard(
                                            sourceText.trim() + '\n\n' + translationResultToText(v),
                                            hideWindow ? 'notification' : 'toast'
                                        );
                                        break;
                                    default:
                                        break;
                                }
                            }
                        },
                        (e) => {
                            info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                            if (activeRequest.current !== id) return;
                            setError(e.toString());
                            setIsLoading(false);
                        }
                    );
            } else {
                setError(t('common.language_not_supported'));
            }
        }
    };

    // hide empty textarea
    useEffect(() => {
        if (textAreaRef.current) {
            textAreaRef.current.style.height = '0px';
            if (result !== '') {
                textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
            }
        }
    }, [displayResult, appFontSize]);

    // refresh tts config
    useEffect(() => {
        if (effectiveTtsList.length > 0 && getServiceSouceType(effectiveTtsList[0]) === ServiceSourceType.PLUGIN) {
            readTextFile(`plugins/tts/${getServiceName(effectiveTtsList[0])}/info.json`, {
                dir: BaseDirectory.AppConfig,
            }).then(
                (infoStr) => {
                    try {
                        setTtsPluginInfo(JSON.parse(infoStr));
                    } catch (e) {
                        console.error('[plugin] broken tts plugin info.json:', e);
                    }
                },
                (e) => {
                    console.error('[plugin] failed to read tts plugin info.json:', e);
                }
            );
        }
    }, [speechService]);

    // handle tts speak for any text, not just the main translation
    const speakWithService = async (text, language) => {
        const instanceKey = speechService;
        if (!instanceKey || !text?.trim()) throw new Error(t('translate.speech_failed'));
        if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
            const pluginConfig = serviceInstanceConfigMap[instanceKey];
            if (!(language in ttsPluginInfo.language)) {
                throw new Error(t('common.language_not_supported'));
            }
            let [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
            let data = await func(text, ttsPluginInfo.language[language], {
                config: pluginConfig,
                utils,
            });
            return data;
        } else {
            if (!(language in builtinTtsServices[getServiceName(instanceKey)].Language)) {
                throw new Error(t('common.language_not_supported'));
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey] || {};
            let data = await builtinTtsServices[getServiceName(instanceKey)].tts(
                text,
                builtinTtsServices[getServiceName(instanceKey)].Language[language],
                {
                    config: instanceConfig,
                }
            );
            return data;
        }
    };

    const handleSpeak = async () => speakWithService(speechText(displayResult), spokenLanguage);

    const speakExample = (text, language, key) => {
        if (!text?.trim() || !speechService) return;
        if (exampleSpeech.status !== 'idle' && activeExample === key) {
            exampleSpeech.stop();
            setActiveExample('');
            return;
        }
        if (exampleSpeech.status !== 'idle') exampleSpeech.stop();
        setActiveExample(key);
        exampleSpeech
            .toggle(() => speakWithService(text, language))
            .catch((e) => {
                logError(`[speech] ${e}`);
                toast.error(t('translate.speech_failed'), { style: toastStyle });
            });
    };

    const copyableResult = translationResultToText(displayResult);

    const [boundRef, bounds] = useMeasure({ scroll: true });
    const springs = useSpring({
        from: { height: 0 },
        to: { height: hide ? 0 : bounds.height },
    });

    return (
        <Card
            shadow='none'
            className={`result-panel ${primary ? 'result-primary' : ''}`}
            style={{
                '--cup-result-size': `${(appFontSize || 16) * 1.25}px`,
                '--cup-hero-size': `${(appFontSize || 16) * 1.5625}px`,
                '--cup-definition-size': `${(appFontSize || 16) * 1.0625}px`,
                '--cup-example-size': `${(appFontSize || 16) * 0.875}px`,
                '--cup-meta-size': `${(appFontSize || 16) * 0.75}px`,
            }}
        >
            <CardHeader
                data-cup-header
                className={`flex justify-between py-1 px-0 bg-content2 h-[30px] ${hide ? 'rounded-[10px]' : 'rounded-t-[10px]'}`}
            >
                {/* current service instance and available service instance to change */}
                <div className='flex result-service'>
                    <span
                        {...drag}
                        className='result-drag-handle'
                        aria-label={t('translate.reorder')}
                    >
                        <LuGripVertical />
                    </span>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button
                                size='sm'
                                variant='solid'
                                className='bg-transparent'
                                startContent={
                                    whetherPluginService(currentTranslateServiceInstanceKey) ? (
                                        <img
                                            src={
                                                pluginList['translate'][
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                ].icon
                                            }
                                            className='h-[20px] my-auto'
                                        />
                                    ) : (
                                        <img
                                            src={
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)].info
                                                    .icon
                                            }
                                            className='h-[20px] my-auto'
                                        />
                                    )
                                }
                            >
                                {whetherPluginService(currentTranslateServiceInstanceKey) ? (
                                    <div className='my-auto'>{`${getInstanceName(currentTranslateServiceInstanceKey, () => pluginList['translate'][getServiceName(currentTranslateServiceInstanceKey)].display)} `}</div>
                                ) : (
                                    <div className='my-auto'>
                                        {getInstanceName(currentTranslateServiceInstanceKey, () =>
                                            t(
                                                `services.translate.${getServiceName(currentTranslateServiceInstanceKey)}.title`
                                            )
                                        )}
                                    </div>
                                )}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='app language'
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => {
                                setCurrentTranslateServiceInstanceKey(key);
                            }}
                        >
                            {translateServiceInstanceList.map((instanceKey) => {
                                return (
                                    <DropdownItem
                                        key={instanceKey}
                                        startContent={
                                            whetherPluginService(instanceKey) ? (
                                                <img
                                                    src={pluginList['translate'][getServiceName(instanceKey)].icon}
                                                    className='h-[20px] my-auto'
                                                />
                                            ) : (
                                                <img
                                                    src={builtinServices[getServiceName(instanceKey)].info.icon}
                                                    className='h-[20px] my-auto'
                                                />
                                            )
                                        }
                                    >
                                        {whetherPluginService(instanceKey) ? (
                                            <div className='my-auto'>{`${getInstanceName(instanceKey, () => pluginList['translate'][getServiceName(instanceKey)].display)} `}</div>
                                        ) : (
                                            <div className='my-auto'>
                                                {getInstanceName(instanceKey, () =>
                                                    t(`services.translate.${getServiceName(instanceKey)}.title`)
                                                )}
                                            </div>
                                        )}
                                    </DropdownItem>
                                );
                            })}
                        </DropdownMenu>
                    </Dropdown>
                    <PulseLoader
                        loading={isLoading}
                        color={
                            theme.resolvedTheme === 'dark'
                                ? semanticColors.dark.default[500]
                                : semanticColors.light.default[500]
                        }
                        size={8}
                        cssOverride={{
                            display: 'inline-block',
                            margin: 'auto',
                            marginLeft: '20px',
                        }}
                    />
                </div>
                {/* content collapse */}
                <div className='flex'>
                    <Button
                        size='sm'
                        isIconOnly
                        variant='light'
                        className='h-[20px] w-[20px]'
                        aria-label={hide ? t('translate.expand') : t('translate.collapse')}
                        aria-expanded={!hide}
                        onPress={() => setHide(!hide)}
                    >
                        {hide ? <LuChevronDown className='text-[16px]' /> : <LuChevronUp className='text-[16px]' />}
                    </Button>
                </div>
            </CardHeader>
            <animated.div style={{ ...springs }}>
                <div ref={boundRef}>
                    {/* result content */}
                    <CardBody
                        data-cup-body
                        className={`p-[12px] pb-0 ${hide && 'h-0 p-0'}`}
                    >
                        {typeof displayResult === 'string' ? (
                            <textarea
                                ref={textAreaRef}
                                className='result-text h-0 resize-none bg-transparent select-text outline-none'
                                aria-label={t('translate.result')}
                                rows={1}
                                readOnly
                                value={displayResult}
                            />
                        ) : (
                            <div className='dictionary-result'>
                                {result['pronunciations']?.map((pronunciation, index) => (
                                    <div
                                        key={index}
                                        className='dictionary-pronunciation'
                                    >
                                        {pronunciation['region'] && <span>{pronunciation['region']}</span>}
                                        {pronunciation['symbol'] && <span>{pronunciation['symbol']}</span>}
                                        {pronunciation['voice'] && (
                                            <button
                                                aria-label={speechLabel}
                                                className='speech-button'
                                                data-active={speech.status !== 'idle'}
                                                aria-pressed={speech.status !== 'idle'}
                                                onClick={() => speak(pronunciation['voice'])}
                                            >
                                                <LuVolume2 />
                                            </button>
                                        )}
                                    </div>
                                ))}
                                {result['explanations']?.map((explanations, index) => {
                                    const explains = explanations['explains'] ?? [];
                                    if (!explains.length) return null;
                                    const primaryCount = index === 0 ? 3 : 2;
                                    return (
                                        <div
                                            key={index}
                                            className={`dictionary-entry ${index === 0 ? 'dictionary-hero' : ''}`}
                                        >
                                            {explanations['trait'] && (
                                                <span className='dictionary-trait'>{explanations['trait']}</span>
                                            )}
                                            <div
                                                className='dictionary-meaning-row'
                                                style={!explanations['trait'] ? { gridColumn: '1 / -1' } : undefined}
                                            >
                                                <div className='dictionary-meaning select-text'>
                                                    {explains.slice(0, primaryCount).join('；')}
                                                </div>
                                                {index === 0 && speechService && (
                                                    <button
                                                        aria-label={speechLabel}
                                                        className='speech-button dictionary-meaning-speech'
                                                        data-active={speech.status !== 'idle'}
                                                        aria-pressed={speech.status !== 'idle'}
                                                        onClick={() =>
                                                            speech.toggle(handleSpeak).catch((e) => {
                                                                logError(`[speech] ${e}`);
                                                                toast.error(t('translate.speech_failed'), {
                                                                    style: toastStyle,
                                                                });
                                                            })
                                                        }
                                                    >
                                                        {speech.status === 'loading' ? (
                                                            <LuLoader2 className='animate-spin text-[16px]' />
                                                        ) : speech.status === 'playing' ? (
                                                            <LuSquare className='text-[14px]' />
                                                        ) : (
                                                            <LuVolume2 className='text-[16px]' />
                                                        )}
                                                    </button>
                                                )}
                                            </div>
                                            {explains.length > primaryCount && (
                                                <div className='dictionary-more select-text'>
                                                    {explains.slice(primaryCount).join('、')}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {result['associations']?.map((association, index) => (
                                    <p
                                        key={index}
                                        className='dictionary-more select-text'
                                    >
                                        {association}
                                    </p>
                                ))}
                                {result['sentence']?.length > 0 && (
                                    <section className='dictionary-examples'>
                                        <div className='dictionary-section-title'>
                                            <span>{t('translate.examples')}</span>
                                            <span>
                                                {Math.min(
                                                    showAllExamples ? result['sentence'].length : 2,
                                                    result['sentence'].length
                                                )}{' '}
                                                / {result['sentence'].length}
                                            </span>
                                        </div>
                                        {result['sentence']
                                            .slice(0, showAllExamples ? undefined : 2)
                                            .map((sentence, index) => (
                                                <div
                                                    key={index}
                                                    className='dictionary-example select-text'
                                                >
                                                    {sentence['source'] && (
                                                        <div className='dictionary-example-line'>
                                                            <span>{richTextToPlainText(sentence['source'])}</span>
                                                            {speechService && (
                                                                <button
                                                                    type='button'
                                                                    aria-label={exampleSpeechLabel}
                                                                    className='speech-button dictionary-example-speech'
                                                                    data-active={activeExample === `${index}-source`}
                                                                    aria-pressed={activeExample === `${index}-source`}
                                                                    onClick={() =>
                                                                        speakExample(
                                                                            richTextToPlainText(sentence['source']),
                                                                            sourceLanguage === 'auto'
                                                                                ? detectLanguage
                                                                                : sourceLanguage,
                                                                            `${index}-source`
                                                                        )
                                                                    }
                                                                >
                                                                    {activeExample === `${index}-source` &&
                                                                    exampleSpeech.status === 'loading' ? (
                                                                        <LuLoader2 className='animate-spin text-[14px]' />
                                                                    ) : activeExample === `${index}-source` &&
                                                                      exampleSpeech.status === 'playing' ? (
                                                                        <LuSquare className='text-[12px]' />
                                                                    ) : (
                                                                        <LuVolume2 className='text-[14px]' />
                                                                    )}
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                    {sentence['target'] && (
                                                        <div className='dictionary-example-line dictionary-example-translation'>
                                                            <p>{richTextToPlainText(sentence['target'])}</p>
                                                            {speechService && (
                                                                <button
                                                                    type='button'
                                                                    aria-label={exampleSpeechLabel}
                                                                    className='speech-button dictionary-example-speech'
                                                                    data-active={activeExample === `${index}-target`}
                                                                    aria-pressed={activeExample === `${index}-target`}
                                                                    onClick={() =>
                                                                        speakExample(
                                                                            richTextToPlainText(sentence['target']),
                                                                            targetLanguage,
                                                                            `${index}-target`
                                                                        )
                                                                    }
                                                                >
                                                                    {activeExample === `${index}-target` &&
                                                                    exampleSpeech.status === 'loading' ? (
                                                                        <LuLoader2 className='animate-spin text-[14px]' />
                                                                    ) : activeExample === `${index}-target` &&
                                                                      exampleSpeech.status === 'playing' ? (
                                                                        <LuSquare className='text-[12px]' />
                                                                    ) : (
                                                                        <LuVolume2 className='text-[14px]' />
                                                                    )}
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        {result['sentence'].length > 2 && (
                                            <button
                                                className='dictionary-expand'
                                                aria-expanded={showAllExamples}
                                                onClick={() => setShowAllExamples(!showAllExamples)}
                                            >
                                                {showAllExamples
                                                    ? t('translate.fewer_examples')
                                                    : t('translate.more_examples')}
                                            </button>
                                        )}
                                    </section>
                                )}
                            </div>
                        )}
                        {skipped ? (
                            // 未配置引擎：不发请求，只留一行灰字提示（比错误卡片轻，但绝不静默）
                            <p className='text-default-500 text-xs'>{t('translate.unconfigured_skip')}</p>
                        ) : (
                            <></>
                        )}
                        {error && (
                            <div
                                className='result-error text-danger text-sm'
                                role='alert'
                            >
                                {error
                                    .split('\n')
                                    .filter((line) => line.trim())
                                    .slice(0, 3)
                                    .map((line, index) => (
                                        <p key={index}>{line.length > 100 ? line.slice(0, 100) + '…' : line}</p>
                                    ))}
                            </div>
                        )}
                        {error && (
                            <Button
                                size='sm'
                                variant='light'
                                className='result-retry'
                                startContent={<LuRotateCcw />}
                                onPress={() => {
                                    setError('');
                                    translate();
                                }}
                            >
                                {t('translate.retry')}
                            </Button>
                        )}
                    </CardBody>
                    {getServiceName(currentTranslateServiceInstanceKey) === 'local_mt' &&
                        !hide &&
                        copyableResult &&
                        !speechService && <p className='speech-service-note'>{t('translate.local_speech_hint')}</p>}
                    <CardFooter
                        data-cup-footer
                        className={`bg-content1 rounded-none rounded-b-[10px] flex px-[12px] p-[5px] ${hide || !copyableResult ? 'hidden' : ''}`}
                    >
                        <div className='result-action-cluster'>
                            <Dropdown placement='top-start'>
                                <DropdownTrigger>
                                    <Button
                                        size='sm'
                                        variant='light'
                                        className='speech-service-trigger'
                                        aria-label={t('translate.speech_service')}
                                        endContent={<LuChevronDown size={12} />}
                                    >
                                        <span className='speech-provider-dot' />
                                        {speechService === 'google_tts'
                                            ? 'Google'
                                            : speechService === 'lingva_tts'
                                              ? 'Lingva'
                                              : speechService
                                                ? t('translate.local_speech')
                                                : t('translate.speech_service')}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label={t('translate.speech_service')}
                                    selectionMode='single'
                                    disallowEmptySelection
                                    selectedKeys={new Set([speechOverride || 'engine'])}
                                    onAction={(key) => {
                                        speech.stop();
                                        setSpeechOverride(key === 'engine' ? '' : String(key));
                                    }}
                                >
                                    <DropdownItem
                                        key='engine'
                                        description={t('translate.follow_engine_hint')}
                                    >
                                        {t('translate.follow_engine')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='google_tts'
                                        description={t('translate.google_speech_short')}
                                    >
                                        Google
                                    </DropdownItem>
                                    <DropdownItem
                                        key='local_tts'
                                        description={t('translate.local_speech_short')}
                                    >
                                        {t('translate.local_speech')}
                                    </DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                            <span
                                className='result-action-divider'
                                aria-hidden='true'
                            />
                            {/* 词典模式的读音按钮放在释义旁；页脚只负责普通译文 */}
                            {typeof displayResult === 'string' && (
                                <Tooltip content={speechLabel}>
                                    <Button
                                        isIconOnly
                                        variant='light'
                                        size='sm'
                                        aria-label={speechLabel}
                                        className='speech-button'
                                        data-active={speech.status !== 'idle'}
                                        aria-pressed={speech.status !== 'idle'}
                                        isDisabled={!speechService || !speechText(displayResult)}
                                        onPress={() => {
                                            speech.toggle(handleSpeak).catch((e) => {
                                                logError(`[speech] ${e}`);
                                                toast.error(t('translate.speech_failed'), { style: toastStyle });
                                            });
                                        }}
                                    >
                                        {speech.status === 'loading' ? (
                                            <LuLoader2 className='animate-spin text-[16px]' />
                                        ) : speech.status === 'playing' ? (
                                            <LuSquare className='text-[14px]' />
                                        ) : (
                                            <LuVolume2 className='text-[16px]' />
                                        )}
                                    </Button>
                                </Tooltip>
                            )}
                            {/* translate back button */}
                            <Tooltip
                                content={showBack ? t('translate.show_translation') : t('translate.translate_back')}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={!speechText(result)}
                                    aria-label={
                                        showBack ? t('translate.show_translation') : t('translate.translate_back')
                                    }
                                    aria-pressed={showBack}
                                    className='speech-button'
                                    data-active={showBack}
                                    isLoading={backLoading}
                                    onPress={async () => {
                                        if (backTranslation !== null) {
                                            speech.stop();
                                            setShowBack(!showBack);
                                            return;
                                        }
                                        const token = ++backRequest.current;
                                        setBackLoading(true);
                                        try {
                                            const to = sourceLanguage === 'auto' ? detectLanguage : sourceLanguage;
                                            const serviceName = getServiceName(currentTranslateServiceInstanceKey);
                                            const plugin = whetherPluginService(currentTranslateServiceInstanceKey);
                                            const languages = plugin
                                                ? pluginList.translate[serviceName].language
                                                : builtinServices[serviceName].Language;
                                            if (!(targetLanguage in languages) || !(to in languages))
                                                throw new Error(t('common.language_not_supported'));
                                            let translateFn, utils;
                                            if (plugin)
                                                [translateFn, utils] = await invoke_plugin('translate', serviceName);
                                            else translateFn = builtinServices[serviceName].translate;
                                            let streamed = '';
                                            const value = await translateFn(
                                                speechText(result),
                                                languages[targetLanguage],
                                                languages[to],
                                                {
                                                    config: {
                                                        ...serviceInstanceConfigMap[currentTranslateServiceInstanceKey],
                                                        ...(plugin ? { enable: 'true' } : {}),
                                                    },
                                                    detect: targetLanguage,
                                                    utils,
                                                    setResult: (value) => {
                                                        streamed = translationResultToText(value);
                                                    },
                                                }
                                            );
                                            if (token !== backRequest.current) return;
                                            const text = translationResultToText(value) || streamed;
                                            if (!text.trim()) throw new Error(t('translate.empty_back_translation'));
                                            setBackTranslation(text);
                                            setShowBack(true);
                                            speech.stop();
                                        } catch (e) {
                                            if (token === backRequest.current)
                                                toast.error(e.toString(), { style: toastStyle });
                                        } finally {
                                            if (token === backRequest.current) setBackLoading(false);
                                        }
                                    }}
                                >
                                    {showBack ? (
                                        <LuRotateCcw className='text-[16px]' />
                                    ) : (
                                        <LuArrowLeftRight className='text-[16px]' />
                                    )}
                                </Button>
                            </Tooltip>
                            {showBack && (
                                <span className='back-translation-label'>{t('translate.back_translation')}</span>
                            )}
                            {/* error retry button */}
                            <Tooltip content={t('translate.retry')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    className={`${error === '' && 'hidden'}`}
                                    onPress={() => {
                                        setError('');
                                        setResult('');
                                        setSkipped(false);
                                        translate();
                                    }}
                                >
                                    <LuBookPlus className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* available collection service instance */}
                            {collectionServiceList &&
                                collectionServiceList.map((collectionServiceInstanceName) => {
                                    return (
                                        <Button
                                            key={collectionServiceInstanceName}
                                            isIconOnly
                                            variant='light'
                                            size='sm'
                                            onPress={async () => {
                                                if (
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                ) {
                                                    const pluginConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    let func, utils;
                                                    try {
                                                        [func, utils] = await invoke_plugin(
                                                            'collection',
                                                            getServiceName(collectionServiceInstanceName)
                                                        );
                                                    } catch (e) {
                                                        toast.error(e.toString(), { style: toastStyle });
                                                        return;
                                                    }
                                                    func(sourceText.trim(), result.toString(), {
                                                        config: pluginConfig,
                                                        utils,
                                                    }).then(
                                                        (_) => {
                                                            toast.success(t('translate.add_collection_success'), {
                                                                style: toastStyle,
                                                            });
                                                        },
                                                        (e) => {
                                                            toast.error(e.toString(), { style: toastStyle });
                                                        }
                                                    );
                                                } else {
                                                    const instanceConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    builtinCollectionServices[
                                                        getServiceName(collectionServiceInstanceName)
                                                    ]
                                                        .collection(sourceText, result, {
                                                            config: instanceConfig,
                                                        })
                                                        .then(
                                                            (_) => {
                                                                toast.success(t('translate.add_collection_success'), {
                                                                    style: toastStyle,
                                                                });
                                                            },
                                                            (e) => {
                                                                toast.error(e.toString(), { style: toastStyle });
                                                            }
                                                        );
                                                }
                                            }}
                                        >
                                            <img
                                                src={
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                        ? pluginList['collection'][
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].icon
                                                        : builtinCollectionServices[
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].info.icon
                                                }
                                                className='h-[16px] w-[16px]'
                                            />
                                        </Button>
                                    );
                                })}
                        </div>
                        <Button
                            size='sm'
                            variant='flat'
                            className='result-copy'
                            startContent={<LuCopy className='text-[14px]' />}
                            isDisabled={!copyableResult}
                            onPress={() => copyToClipboard(copyableResult, 'toast')}
                        >
                            {showBack ? t('translate.copy_back_translation') : t('translate.copy_result')}
                        </Button>
                    </CardFooter>
                </div>
            </animated.div>
        </Card>
    );
}
