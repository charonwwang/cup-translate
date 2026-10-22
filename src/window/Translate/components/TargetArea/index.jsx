import SpeechPreference from '../../../../components/SpeechPreference';
import { checkGlossary, matchGlossary, glossaryHint } from '../../../../utils/glossary';
import { checkPolicy } from '../../../../utils/requestRuntime';
import { resolveSpeechService, speechText } from '../../../../utils/speechService';
import { useSpeech } from '../../../../hooks/useSpeech';
import { resolveLocalModel } from '../../../../services/translate/local_mt/options';
import { supplementTranslation } from '../../../../utils/supplementTranslation';
import { Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Tooltip } from '@nextui-org/react';
import { LuChevronDown, LuChevronUp, LuGripVertical, LuRotateCcw } from 'react-icons/lu';
import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';
import { sendNotification } from '@tauri-apps/api/notification';
import React, { useEffect, useMemo, useState, useRef } from 'react';
import { LuSquare, LuLoader2, LuVolume2, LuCopy, LuArrowLeftRight } from 'react-icons/lu';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import Database from 'tauri-plugin-sql-api';
import { useAtomValue } from 'jotai';
import { nanoid } from 'nanoid';

import * as builtinCollectionServices from '../../../../services/collection';
import { isServiceConfigured } from '../../../../services/translate/required_config';
import { invoke } from '@tauri-apps/api/tauri';
import { useConfig, useToastStyle, useVoice } from '../../../../hooks';
import { translationResultToText } from '../../../../utils/translationResult';
import { clipboardFailureMessage, writeClipboardSafely } from '../../../../utils/clipboard';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as builtinServices from '../../../../services/translate';
import * as builtinTtsServices from '../../../../services/tts';
import { getActiveSourceLanguage } from '../../../../utils/sourceLanguage';
import { detectLanguageAtom, sourceLanguageAtom, sourceTextAtom, targetLanguageAtom } from '../../atoms';
import {
    buildParagraphEntry,
    buildPhraseEntry,
    buildSentencePairs,
    buildWordEntry,
    classifySourceText,
} from '../../resultView';

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

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightTerm(text, term) {
    const needle = String(term || '').trim();
    if (!needle || !text) return text;
    const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
    return parts.map((part, index) =>
        part.toLocaleLowerCase() === needle.toLocaleLowerCase() ? <mark key={index}>{part}</mark> : part
    );
}

export default function TargetArea(props) {
    const {
        index,
        requestRevision,
        privacyMode,
        glossary,
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
    const [dictionarySupplement, setDictionarySupplement] = useState(null);
    const [dictionaryLoading, setDictionaryLoading] = useState(false);
    const dictionaryRequest = useRef(null);
    const resolvedSpeechService =
        (speechOverride === 'off' ? null : speechOverride) ||
        (speechOverride === 'off'
            ? null
            : resolveSpeechService(getServiceName(currentTranslateServiceInstanceKey), speechPolicy, ttsServiceList));
    const speechService =
        privacyMode === 'device_only' &&
        !['local_tts', 'piper_tts', 'kokoro_tts', 'qwen_tts'].includes(getServiceName(resolvedSpeechService ?? ''))
            ? null
            : resolvedSpeechService;
    useEffect(() => {
        setSpeechOverride('');
    }, [speechPolicy]);
    const effectiveTtsList = speechService ? [speechService] : [];
    const [historyDisable] = useConfig('history_disable', false);
    const [isLoading, setIsLoading] = useState(false);
    const [hide, setHide] = useState(true);

    const [result, setResult] = useState('');
    const [termChecks, setTermChecks] = useState([]);
    const requestController = useRef(null);
    const [backTranslation, setBackTranslation] = useState(null);
    const [showBack, setShowBack] = useState(false);
    const [backLoading, setBackLoading] = useState(false);
    const backRequest = useRef(0);
    const displayResult = showBack ? backTranslation : result;
    const activeRequest = useRef(null);
    const [error, setError] = useState('');
    const [skipped, setSkipped] = useState(false);
    const [paragraphView, setParagraphView] = useState('translation');

    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const [autoCopy] = useConfig('translate_auto_copy', 'disable');
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [clipboardMonitor] = useConfig('clipboard_monitor', false);

    const detectLanguage = useAtomValue(detectLanguageAtom);
    const activeSourceLanguage = getActiveSourceLanguage(sourceLanguage, detectLanguage);
    const spokenLanguage = showBack ? activeSourceLanguage : targetLanguage;
    useEffect(() => {
        backRequest.current += 1;
        setBackTranslation(null);
        setShowBack(false);
        setBackLoading(false);
        return () => {
            backRequest.current += 1;
        };
    }, [
        result,
        sourceText,
        sourceLanguage,
        targetLanguage,
        currentTranslateServiceInstanceKey,
        privacyMode,
        requestRevision,
        glossary,
    ]);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const speak = useVoice();
    const speech = useSpeech(displayResult);
    useEffect(() => {
        speech.stop();
        exampleSpeech.stop();
        sourceWordSpeech.stop();
    }, [sourceLanguage, targetLanguage, speechService]);
    const exampleSpeech = useSpeech('dictionary-example');
    const sourceWordSpeech = useSpeech('source-word');
    const [activeExample, setActiveExample] = useState('');
    const speechLabel = speech.status === 'idle' ? t('translate.speak') : t('translate.stop_speaking');
    const exampleSpeechLabel = exampleSpeech.status === 'idle' ? t('translate.speak') : t('translate.stop_speaking');
    const sourceWordSpeechLabel =
        sourceWordSpeech.status === 'idle' ? t('translate.speak') : t('translate.stop_speaking');

    useEffect(() => {
        if (exampleSpeech.status === 'idle') setActiveExample('');
    }, [exampleSpeech.status]);
    useEffect(() => {
        exampleSpeech.stop();
        setActiveExample('');
        setParagraphView('translation');
    }, [result]);
    useEffect(() => {
        sourceWordSpeech.stop();
    }, [sourceText]);

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
            logError(`[${currentTranslateServiceInstanceKey}]failed`);
            // 出错时自动展开卡片，避免失败被静默折叠、用户看不到任何反馈
            setHide(false);
        }
    }, [error]);

    // listen to translation
    useEffect(() => {
        setResult('');
        setTermChecks([]);
        dictionaryRequest.current?.abort();
        setDictionarySupplement(null);
        setDictionaryLoading(false);
        if (!sourceText.trim()) setHide(true);
        setError('');
        setSkipped(false);
        if (
            sourceText.trim() !== '' &&
            sourceLanguage &&
            activeSourceLanguage &&
            targetLanguage &&
            autoCopy !== null &&
            hideWindow !== null &&
            clipboardMonitor !== null
        ) {
            if (primary && autoCopy === 'source' && !clipboardMonitor) {
                copyToClipboard(sourceText, hideWindow ? 'notification' : 'toast');
            }
            translate();
        }
        return () => {
            activeRequest.current = null;
            requestController.current?.abort();
            dictionaryRequest.current?.abort();
        };
    }, [
        primary,
        sourceText,
        sourceLanguage,
        targetLanguage,
        autoCopy,
        hideWindow,
        currentTranslateServiceInstanceKey,
        clipboardMonitor,
        activeSourceLanguage,
        requestRevision,
        privacyMode,
        glossary,
        serviceInstanceConfigMap,
    ]);

    const addToHistory = async (
        text,
        source,
        target,
        serviceInstanceKey,
        result,
        isRetry = false,
        requestId = activeRequest.current
    ) => {
        let db;
        try {
            db = await Database.load('sqlite:history.db');
            if (activeRequest.current !== requestId || requestController.current?.signal.aborted) return;
            await db.execute(
                'INSERT into history (text, source, target, service, result, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                [
                    text,
                    source,
                    target,
                    serviceInstanceKey,
                    typeof result === 'string' ? result : JSON.stringify(result),
                    Date.now(),
                ]
            );
        } catch (e) {
            // 首次失败可能是表不存在，建表后重试一次；再失败则放弃（防止无限递归）
            if (!isRetry) {
                try {
                    await db.execute(
                        'CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,service TEXT NOT NULL, result TEXT NOT NULL,timestamp INTEGER NOT NULL)'
                    );
                    await addToHistory(text, source, target, serviceInstanceKey, result, true, requestId);
                } catch (e2) {
                    console.error('[history] create table failed');
                }
            } else {
                console.error('[history] insert failed after retry');
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
        activeRequest.current = null;
        requestController.current?.abort();
        setError('');
        requestController.current = new AbortController();
        const signal = requestController.current.signal;
        const currentController = requestController.current;
        const localMultilingual =
            serviceInstanceConfigMap[currentTranslateServiceInstanceKey]?.model === 'm2m100' &&
            currentTranslateServiceInstanceKey.split('@')[0] === 'local_mt';
        const timeout = setTimeout(() => currentController.abort(), localMultilingual ? 120000 : 30000);
        signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
        let id = nanoid();
        activeRequest.current = id;
        signal.addEventListener(
            'abort',
            () => {
                if (activeRequest.current === id) {
                    setIsLoading(false);
                    setError('Request cancelled or timed out');
                }
            },
            { once: true }
        );
        const target = targetLanguage;
        const matches = matchGlossary(sourceText, activeSourceLanguage, target, glossary);
        const finalize = (value) => {
            const final = typeof value === 'string' ? value.trim() : value;
            setTermChecks(checkGlossary(translationResultToText(final), matches));
            return final;
        };

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
                    const effectiveTarget = targetLanguage;
                    const pair = resolveLocalModel(
                        serviceInstanceConfigMap[currentTranslateServiceInstanceKey],
                        activeSourceLanguage,
                        effectiveTarget
                    );
                    const status = pair ? await invoke('local_mt_model_status', { pair }) : { installed: false };
                    if (activeRequest.current !== id || signal.aborted) return;
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
                const newTargetLanguage = targetLanguage;
                setIsLoading(true);
                setHide(true);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                // Keep the captured configuration immutable.
                const setHideOnce = invokeOnce((value) => setHide(primary ? value : true));
                let func, utils;
                try {
                    [func, utils] = await invoke_plugin('translate', translateServiceName);
                } catch (e) {
                    info(`[${currentTranslateServiceInstanceKey}]failed`);
                    if (activeRequest.current !== id || signal.aborted) return;
                    setError(e.toString());
                    setIsLoading(false);
                    setHide(false);
                    return;
                }
                func(
                    sourceText.trim(),
                    pluginInfo.language[activeSourceLanguage] ?? pluginInfo.language[sourceLanguage],
                    pluginInfo.language[newTargetLanguage],
                    {
                        signal,
                        config: structuredClone(instanceConfig),
                        detect: activeSourceLanguage,
                        setResult: (v) => {
                            if (activeRequest.current !== id || signal.aborted) return;
                            setResult(v);
                            setHideOnce(false);
                        },
                        utils,
                    }
                ).then(
                    (v) => {
                        clearTimeout(timeout);
                        info(`[${currentTranslateServiceInstanceKey}]completed`);
                        if (activeRequest.current !== id || signal.aborted) return;
                        v = finalize(v);
                        setResult(v);
                        setIsLoading(false);
                        if (v !== '') {
                            setHideOnce(false);
                        }
                        if (!historyDisable) {
                            addToHistory(
                                sourceText.trim(),
                                activeSourceLanguage,
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
                        clearTimeout(timeout);
                        if (e?.name === 'AbortError') return;
                        info(`[${currentTranslateServiceInstanceKey}]failed`);
                        if (activeRequest.current !== id || signal.aborted) return;
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
                const newTargetLanguage = targetLanguage;
                setIsLoading(true);
                setHide(true);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                const setHideOnce = invokeOnce((value) => setHide(primary ? value : true));
                builtinServices[translateServiceName]
                    .translate(
                        sourceText.trim(),
                        LanguageEnum[activeSourceLanguage] ?? LanguageEnum[sourceLanguage],
                        LanguageEnum[newTargetLanguage],
                        {
                            signal,
                            matches,
                            style: glossary?.style,
                            config: structuredClone(instanceConfig),
                            detect: activeSourceLanguage,
                            setResult: (v) => {
                                if (activeRequest.current !== id || signal.aborted) return;
                                setResult(v);
                                setHideOnce(false);
                            },
                        }
                    )
                    .then(
                        (v) => {
                            clearTimeout(timeout);
                            info(`[${currentTranslateServiceInstanceKey}]completed`);
                            if (activeRequest.current !== id || signal.aborted) return;
                            v = finalize(v);
                            setResult(v);
                            setIsLoading(false);
                            void supplementTranslation(
                                builtinServices[translateServiceName],
                                v,
                                LanguageEnum[activeSourceLanguage] ?? LanguageEnum[sourceLanguage],
                                LanguageEnum[newTargetLanguage],
                                { config: structuredClone(instanceConfig), signal },
                                (value) => {
                                    if (activeRequest.current === id && !signal.aborted) setResult(value);
                                }
                            );
                            if (v !== '') {
                                setHideOnce(false);
                            }
                            if (!historyDisable) {
                                addToHistory(
                                    sourceText.trim(),
                                    activeSourceLanguage,
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
                            clearTimeout(timeout);
                            if (e?.name === 'AbortError') return;
                            info(`[${currentTranslateServiceInstanceKey}]failed`);
                            if (activeRequest.current !== id || signal.aborted) return;
                            setError(e.toString());
                            setIsLoading(false);
                        }
                    );
            } else {
                setError(t('common.language_not_supported'));
            }
        }
    };

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
        if (!instanceKey || !text?.trim())
            throw new Error(
                t(
                    speechService === 'piper_tts'
                        ? 'models.piper_speech_failed'
                        : speechService === 'kokoro_tts'
                          ? 'models.kokoro_speech_failed'
                          : 'translate.speech_failed'
                )
            );
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
                logError('[speech] failed');
                toast.error(
                    t(
                        speechService === 'piper_tts'
                            ? 'models.piper_speech_failed'
                            : speechService === 'kokoro_tts'
                              ? 'models.kokoro_speech_failed'
                              : 'translate.speech_failed'
                    ),
                    { style: toastStyle }
                );
            });
    };

    const isSingleWord = sourceText.trim() !== '' && !/\s/.test(sourceText.trim());
    const serviceModule = builtinServices[getServiceName(currentTranslateServiceInstanceKey)];
    const serviceLanguage = serviceModule?.Language;
    const effectiveTargetLanguage = targetLanguage;
    const singleWordPronunciation = isSingleWord
        ? serviceModule?.translate?.pronunciationFor?.(
              sourceText.trim(),
              serviceLanguage?.[activeSourceLanguage] ?? activeSourceLanguage,
              serviceLanguage?.[effectiveTargetLanguage] ?? effectiveTargetLanguage
          ) || ''
        : '';
    const speakSourceWord = () => {
        if (!speechService || !isSingleWord) return;
        sourceWordSpeech
            .toggle(() => speakWithService(sourceText.trim(), activeSourceLanguage))
            .catch((e) => {
                logError('[speech] failed');
                toast.error(
                    t(
                        speechService === 'piper_tts'
                            ? 'models.piper_speech_failed'
                            : speechService === 'kokoro_tts'
                              ? 'models.kokoro_speech_failed'
                              : 'translate.speech_failed'
                    ),
                    { style: toastStyle }
                );
            });
    };

    const detailSpeechIcon = (key) => {
        if (activeExample === key && exampleSpeech.status === 'loading') {
            return <LuLoader2 className='animate-spin text-[12px]' />;
        }
        if (activeExample === key && exampleSpeech.status === 'playing') {
            return <LuSquare className='text-[10px]' />;
        }
        return <LuVolume2 className='text-[13px]' />;
    };

    const resultMode = classifySourceText(sourceText);
    const wordEntry = useMemo(() => {
        const base = buildWordEntry(result, sourceText, singleWordPronunciation);
        if (!dictionarySupplement) return base;
        const extra = buildWordEntry(
            dictionarySupplement,
            sourceText,
            builtinServices.google.translate.pronunciationFor?.(
                sourceText.trim(),
                builtinServices.google.Language[activeSourceLanguage],
                builtinServices.google.Language[effectiveTargetLanguage]
            ) ?? ''
        );
        return {
            ...base,
            pronunciations: base.pronunciations.length ? base.pronunciations : extra.pronunciations,
            examples: extra.examples,
            senses: base.senses,
        };
    }, [
        result,
        sourceText,
        singleWordPronunciation,
        dictionarySupplement,
        activeSourceLanguage,
        effectiveTargetLanguage,
    ]);
    const supplementDictionary = async () => {
        dictionaryRequest.current?.abort();
        const controller = new AbortController();
        dictionaryRequest.current = controller;
        const requestId = activeRequest.current;
        setDictionaryLoading(true);
        try {
            await checkPolicy('translate', 'google');
            const language = builtinServices.google.Language;
            const extra = await builtinServices.google.translate(
                sourceText.trim(),
                language[activeSourceLanguage] ?? 'auto',
                language[effectiveTargetLanguage],
                { config: serviceInstanceConfigMap.google ?? {}, signal: controller.signal }
            );
            if (controller.signal.aborted || requestId !== activeRequest.current) return;
            setDictionarySupplement(extra);
            void supplementTranslation(
                builtinServices.google,
                extra,
                language[activeSourceLanguage] ?? 'auto',
                language[effectiveTargetLanguage],
                { config: serviceInstanceConfigMap.google ?? {}, signal: controller.signal },
                (value) => {
                    if (!controller.signal.aborted && requestId === activeRequest.current)
                        setDictionarySupplement(value);
                }
            );
        } catch (error) {
            if (!controller.signal.aborted) toast.error(t('models.dictionary_failed'), { style: toastStyle });
        } finally {
            if (!controller.signal.aborted) setDictionaryLoading(false);
        }
    };
    const phraseEntry = useMemo(
        () =>
            showBack
                ? { translation: backTranslation || '', alternatives: [], usage: [], examples: [] }
                : buildPhraseEntry(result),
        [result, showBack, backTranslation]
    );
    const paragraphEntry = useMemo(() => buildParagraphEntry(displayResult), [displayResult]);
    const sentencePairs = useMemo(
        () => buildSentencePairs(sourceText, paragraphEntry.translation),
        [sourceText, paragraphEntry.translation]
    );
    const modeLabel =
        resultMode === 'word'
            ? t(
                  wordEntry.senses.some((sense) => sense.pos) || wordEntry.pronunciations.length
                      ? 'translate.dictionary_mode'
                      : 'translate.mode_word'
              )
            : resultMode === 'paragraph'
              ? t('translate.mode_paragraph')
              : t('translate.mode_phrase');
    const resultBadge =
        resultMode === 'word'
            ? wordEntry.senses.length > 0 && wordEntry.examples.length >= 2
                ? t('translate.entry_complete')
                : t(wordEntry.senses.some((sense) => sense.pos) ? 'translate.pos_count' : 'models.meaning_count', {
                      count: wordEntry.senses.some((sense) => sense.pos)
                          ? new Set(wordEntry.senses.filter((sense) => sense.pos).map((sense) => sense.pos)).size
                          : wordEntry.senses.length,
                  })
            : resultMode === 'paragraph'
              ? t('translate.sentence_count', { count: sentencePairs.length })
              : phraseEntry.alternatives.length
                ? t('translate.other_translations')
                : '';

    const copyableResult = translationResultToText(displayResult);

    const toggleBackTranslation = async () => {
        if (backTranslation !== null) {
            speech.stop();
            setShowBack(!showBack);
            return;
        }
        const token = ++backRequest.current;
        setBackLoading(true);
        try {
            const to = activeSourceLanguage;
            const serviceName = getServiceName(currentTranslateServiceInstanceKey);
            const plugin = whetherPluginService(currentTranslateServiceInstanceKey);
            const languages = plugin
                ? pluginList.translate[serviceName].language
                : builtinServices[serviceName].Language;
            if (!(targetLanguage in languages) || !(to in languages)) {
                throw new Error(t('common.language_not_supported'));
            }
            let translateFn, utils;
            if (plugin) [translateFn, utils] = await invoke_plugin('translate', serviceName);
            else translateFn = builtinServices[serviceName].translate;
            let streamed = '';
            const value = await translateFn(speechText(result), languages[targetLanguage], languages[to], {
                config: {
                    ...serviceInstanceConfigMap[currentTranslateServiceInstanceKey],
                    ...(plugin ? { enable: 'true' } : {}),
                },
                detect: targetLanguage,
                utils,
                setResult: (value) => {
                    streamed = translationResultToText(value);
                },
            });
            if (token !== backRequest.current) return;
            const text = translationResultToText(value) || streamed;
            if (!text.trim()) throw new Error(t('translate.empty_back_translation'));
            setBackTranslation(text);
            setShowBack(true);
            speech.stop();
        } catch (e) {
            if (token === backRequest.current) toast.error(e.toString(), { style: toastStyle });
        } finally {
            if (token === backRequest.current) setBackLoading(false);
        }
    };

    const addToCollection = async (collectionServiceInstanceName) => {
        try {
            if (getServiceSouceType(collectionServiceInstanceName) === ServiceSourceType.PLUGIN) {
                const pluginConfig = serviceInstanceConfigMap[collectionServiceInstanceName];
                const [func, utils] = await invoke_plugin('collection', getServiceName(collectionServiceInstanceName));
                await func(sourceText.trim(), translationResultToText(result), {
                    config: pluginConfig,
                    utils,
                });
            } else {
                const instanceConfig = serviceInstanceConfigMap[collectionServiceInstanceName];
                await builtinCollectionServices[getServiceName(collectionServiceInstanceName)].collection(
                    sourceText,
                    result,
                    { config: instanceConfig }
                );
            }
            toast.success(t('translate.add_collection_success'), { style: toastStyle });
        } catch (e) {
            toast.error(e.toString(), { style: toastStyle });
        }
    };

    const translateServiceName = getServiceName(currentTranslateServiceInstanceKey);
    const currentPluginService = whetherPluginService(currentTranslateServiceInstanceKey);
    const engineIcon = currentPluginService
        ? pluginList.translate[translateServiceName].icon
        : builtinServices[translateServiceName].info.icon;
    const engineDisplayName = getInstanceName(currentTranslateServiceInstanceKey, () =>
        currentPluginService
            ? pluginList.translate[translateServiceName].display
            : t(`services.translate.${translateServiceName}.title`)
    );
    const sourceTag = String(activeSourceLanguage || 'en')
        .split('_')[0]
        .toLocaleUpperCase();
    const targetTag = String(targetLanguage || 'zh_cn')
        .split('_')[0]
        .toLocaleUpperCase();
    const showSkeleton = isLoading && !result && !error && !skipped;

    return (
        <section
            className={`cup-result-card ${primary ? 'is-primary' : ''}`}
            style={{ '--cup4-base': `${appFontSize || 16}px` }}
        >
            <header className='cup-result-head'>
                <span
                    {...drag}
                    className='cup-drag-handle'
                    aria-label={t('translate.reorder')}
                >
                    <LuGripVertical className='text-[13px]' />
                </span>
                <Dropdown>
                    <DropdownTrigger>
                        <button
                            type='button'
                            className='cup-engine-button'
                        >
                            <img
                                src={engineIcon}
                                alt=''
                            />
                            <span>{engineDisplayName}</span>
                        </button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label='translate engine'
                        className='max-h-[40vh] overflow-y-auto'
                        onAction={(key) => setCurrentTranslateServiceInstanceKey(key)}
                    >
                        {translateServiceInstanceList.map((instanceKey) => {
                            const plugin = whetherPluginService(instanceKey);
                            const serviceName = getServiceName(instanceKey);
                            return (
                                <DropdownItem
                                    key={instanceKey}
                                    startContent={
                                        <img
                                            src={
                                                plugin
                                                    ? pluginList.translate[serviceName].icon
                                                    : builtinServices[serviceName].info.icon
                                            }
                                            className='h-[16px] w-[16px] object-contain'
                                            alt=''
                                        />
                                    }
                                >
                                    {getInstanceName(instanceKey, () =>
                                        plugin
                                            ? pluginList.translate[serviceName].display
                                            : t(`services.translate.${serviceName}.title`)
                                    )}
                                </DropdownItem>
                            );
                        })}
                    </DropdownMenu>
                </Dropdown>
                <span className='cup-result-mode'>/ {modeLabel}</span>
                {isLoading && <span className='cup-loading-dot' />}
                {resultBadge && <span className='cup-result-badge'>{resultBadge}</span>}
                <button
                    type='button'
                    className='cup-collapse-button'
                    aria-label={hide ? t('translate.expand') : t('translate.collapse')}
                    aria-expanded={!hide}
                    onClick={() => setHide(!hide)}
                >
                    {hide ? <LuChevronDown className='text-[14px]' /> : <LuChevronUp className='text-[14px]' />}
                </button>
            </header>

            <div className={`cup-result-body ${hide && !showSkeleton ? 'is-hidden' : ''}`}>
                {showSkeleton && (
                    <div
                        className='cup-skeleton'
                        aria-label={t('translate.result')}
                    >
                        <span />
                        <span />
                        <span />
                    </div>
                )}

                {resultMode === 'word' && result && (
                    <>
                        <div className='cup-word-heading'>
                            <div>
                                <h3 className='flex items-center gap-2'>
                                    {wordEntry.word}
                                    {speechService && !wordEntry.pronunciations.length && (
                                        <button
                                            type='button'
                                            className='cup-speak-button'
                                            aria-label={sourceWordSpeechLabel}
                                            onClick={speakSourceWord}
                                        >
                                            <LuVolume2 size={13} />
                                        </button>
                                    )}
                                </h3>
                                {wordEntry.pronunciations.length > 0 && (
                                    <div className='cup-phonetics'>
                                        {wordEntry.pronunciations.map((pronunciation, index) => (
                                            <span
                                                className='cup-phonetic'
                                                key={`${pronunciation.region}-${pronunciation.symbol}-${index}`}
                                            >
                                                {pronunciation.region && (
                                                    <span className='cup-phonetic-region'>{pronunciation.region}</span>
                                                )}
                                                {pronunciation.symbol}
                                                {speechService && (
                                                    <button
                                                        type='button'
                                                        className='cup-speak-button'
                                                        aria-label={sourceWordSpeechLabel}
                                                        data-active={sourceWordSpeech.status !== 'idle'}
                                                        onClick={() => {
                                                            if (pronunciation.voice) {
                                                                speak(pronunciation.voice);
                                                            } else {
                                                                speakSourceWord();
                                                            }
                                                        }}
                                                    >
                                                        {sourceWordSpeech.status === 'loading' ? (
                                                            <LuLoader2 className='animate-spin text-[11px]' />
                                                        ) : sourceWordSpeech.status === 'playing' ? (
                                                            <LuSquare className='text-[9px]' />
                                                        ) : (
                                                            <LuVolume2 className='text-[12px]' />
                                                        )}
                                                    </button>
                                                )}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <span className='cup-word-kind'>
                                {t('translate.mode_word')} · {t(`languages.${activeSourceLanguage || 'auto'}`)}
                            </span>
                        </div>

                        {result?.metadataSource === 'model' && (
                            <p className='cup-lexical-note'>{t('models.model_dictionary_note')}</p>
                        )}
                        {!wordEntry.pronunciations.length && !isLoading && (
                            <div className='cup-dictionary-tools'>
                                <span>{t('models.no_phonetics')}</span>
                                {
                                    <button
                                        type='button'
                                        disabled={privacyMode === 'device_only' || dictionaryLoading}
                                        title={
                                            privacyMode === 'device_only'
                                                ? t('models.google_blocked')
                                                : t('models.dictionary_network_hint')
                                        }
                                        onClick={supplementDictionary}
                                    >
                                        {dictionaryLoading ? t('models.checking') : t('models.get_google_dictionary')}
                                    </button>
                                }
                                {privacyMode === 'device_only' && <span>{t('models.no_offline_dictionary')}</span>}
                            </div>
                        )}
                        {(dictionarySupplement || result?.dictionarySource) && (
                            <p className='cup-lexical-note'>
                                {result?.dictionarySource
                                    ? t('models.dictionary_source_note')
                                    : t('models.google_dictionary_note')}
                            </p>
                        )}
                        {wordEntry.senses.length > 0 && (
                            <>
                                <div className='cup-section-label'>
                                    <span>{t('translate.dictionary')}</span>
                                    <span className='cup-section-count'>
                                        {t(
                                            wordEntry.senses.some((sense) => sense.pos)
                                                ? 'translate.pos_count'
                                                : 'models.meaning_count',
                                            {
                                                count: wordEntry.senses.some((sense) => sense.pos)
                                                    ? new Set(
                                                          wordEntry.senses
                                                              .filter((sense) => sense.pos)
                                                              .map((sense) => sense.pos)
                                                      ).size
                                                    : wordEntry.senses.length,
                                            }
                                        )}
                                    </span>
                                </div>
                                <div className='cup-senses'>
                                    {wordEntry.senses.map((sense, index) => {
                                        const speechKey = `sense-${index}`;
                                        return (
                                            <div
                                                className='cup-sense-row'
                                                key={`${sense.pos}-${index}`}
                                            >
                                                <span className='cup-pos'>{sense.pos}</span>
                                                <div className='cup-meanings select-text'>
                                                    {sense.meanings.map((meaning, meaningIndex) => (
                                                        <span
                                                            className='cup-meaning'
                                                            key={`${meaning}-${meaningIndex}`}
                                                        >
                                                            {meaning}
                                                        </span>
                                                    ))}
                                                </div>
                                                {speechService && (
                                                    <button
                                                        type='button'
                                                        className='cup-speak-button cup-sense-speak'
                                                        aria-label={exampleSpeechLabel}
                                                        data-active={activeExample === speechKey}
                                                        onClick={() =>
                                                            speakExample(
                                                                sense.meanings.join('；'),
                                                                targetLanguage,
                                                                speechKey
                                                            )
                                                        }
                                                    >
                                                        {detailSpeechIcon(speechKey)}
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}

                        {wordEntry.examples.length > 0 && (
                            <div className='cup-examples'>
                                <div className='cup-section-label'>
                                    <span>{t('translate.examples')}</span>
                                    <span className='cup-section-count'>
                                        {t('translate.example_count', {
                                            count: Math.min(2, wordEntry.examples.length),
                                        })}
                                    </span>
                                </div>
                                {wordEntry.examples.slice(0, 2).map((sentence, index) => (
                                    <article
                                        className='cup-example-card select-text'
                                        key={`${sentence.source}-${index}`}
                                    >
                                        {sentence.source && (
                                            <div className='cup-example-line'>
                                                <span className='cup-line-tag'>{sourceTag}</span>
                                                <p className='cup-example-source'>
                                                    {highlightTerm(
                                                        richTextToPlainText(sentence['source']),
                                                        wordEntry.word
                                                    )}
                                                </p>
                                                {speechService && (
                                                    <button
                                                        type='button'
                                                        className='cup-speak-button'
                                                        aria-label={exampleSpeechLabel}
                                                        data-active={activeExample === `example-${index}-source`}
                                                        onClick={() =>
                                                            speakExample(
                                                                richTextToPlainText(sentence.source),
                                                                activeSourceLanguage,
                                                                `example-${index}-source`
                                                            )
                                                        }
                                                    >
                                                        {detailSpeechIcon(`example-${index}-source`)}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        {sentence.target && (
                                            <div className='cup-example-line'>
                                                <span className='cup-line-tag'>{targetTag}</span>
                                                <p className='cup-example-target'>
                                                    {richTextToPlainText(sentence['target'])}
                                                </p>
                                                {speechService && (
                                                    <button
                                                        type='button'
                                                        className='cup-speak-button'
                                                        aria-label={exampleSpeechLabel}
                                                        data-active={activeExample === `example-${index}-target`}
                                                        onClick={() =>
                                                            speakExample(
                                                                richTextToPlainText(sentence.target),
                                                                targetLanguage,
                                                                `example-${index}-target`
                                                            )
                                                        }
                                                    >
                                                        {detailSpeechIcon(`example-${index}-target`)}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </article>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {resultMode === 'phrase' && result && (
                    <>
                        <div className='cup-phrase-pair'>
                            <div className='cup-phrase-row target'>
                                <span className='cup-phrase-label'>{targetTag}</span>
                                <span className='cup-phrase-text select-text'>{phraseEntry.translation}</span>
                                {speechService && (
                                    <button
                                        type='button'
                                        className='cup-speak-button'
                                        aria-label={speechLabel}
                                        data-active={speech.status !== 'idle'}
                                        disabled={!speechText(displayResult)}
                                        onClick={() =>
                                            speech.toggle(handleSpeak).catch((e) => {
                                                logError('[speech] failed');
                                                toast.error(
                                                    t(
                                                        speechService === 'piper_tts'
                                                            ? 'models.piper_speech_failed'
                                                            : speechService === 'kokoro_tts'
                                                              ? 'models.kokoro_speech_failed'
                                                              : 'translate.speech_failed'
                                                    ),
                                                    { style: toastStyle }
                                                );
                                            })
                                        }
                                    >
                                        {speech.status === 'loading' ? (
                                            <LuLoader2 className='animate-spin text-[12px]' />
                                        ) : speech.status === 'playing' ? (
                                            <LuSquare className='text-[10px]' />
                                        ) : (
                                            <LuVolume2 className='text-[13px]' />
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>

                        {phraseEntry.alternatives.length > 0 && (
                            <div className='cup-alternatives'>
                                <div className='cup-section-label'>
                                    <span>{t('translate.other_translations')}</span>
                                </div>
                                {phraseEntry.alternatives.map((alternative, index) => (
                                    <div
                                        className='cup-alternative-row select-text'
                                        key={`${alternative.text}-${index}`}
                                    >
                                        <span className='cup-alt-tag'>{alternative.tag || targetTag}</span>
                                        <span className='cup-alt-text'>{alternative.text}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {phraseEntry.usage.length > 0 && (
                            <div className='cup-usage select-text'>
                                <div className='cup-usage-title'>{t('translate.usage')}</div>
                                {phraseEntry.usage.join(' · ')}
                            </div>
                        )}

                        {phraseEntry.examples.length > 0 && (
                            <div className='cup-context-example select-text'>
                                <div className='cup-section-label'>
                                    <span>{t('translate.context_example')}</span>
                                </div>
                                {phraseEntry.examples.slice(0, 2).map((sentence, index) => (
                                    <div
                                        className='cup-example-card'
                                        style={{ background: 'transparent', border: 0, padding: 0 }}
                                        key={`${sentence.source}-${index}`}
                                    >
                                        {sentence.source && (
                                            <div className='cup-example-line'>
                                                <span className='cup-line-tag'>{sourceTag}</span>
                                                <p className='cup-example-source'>{sentence.source}</p>
                                            </div>
                                        )}
                                        {sentence.target && (
                                            <div className='cup-example-line'>
                                                <span className='cup-line-tag'>{targetTag}</span>
                                                <p className='cup-example-target'>
                                                    {richTextToPlainText(sentence['target'])}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {resultMode === 'paragraph' && result && (
                    <>
                        <div className='cup-paragraph-toolbar'>
                            <div className='cup-segmented'>
                                <button
                                    type='button'
                                    className={paragraphView === 'translation' ? 'on' : ''}
                                    onClick={() => setParagraphView('translation')}
                                >
                                    {t('translate.translation_view')}
                                </button>
                                <button
                                    type='button'
                                    className={paragraphView === 'comparison' ? 'on' : ''}
                                    onClick={() => setParagraphView('comparison')}
                                >
                                    {t('translate.comparison_view')}
                                </button>
                            </div>
                            {speechService && (
                                <button
                                    type='button'
                                    className='cup-read-all'
                                    onClick={() =>
                                        speech.toggle(handleSpeak).catch((e) => {
                                            logError('[speech] failed');
                                            toast.error(
                                                t(
                                                    speechService === 'piper_tts'
                                                        ? 'models.piper_speech_failed'
                                                        : speechService === 'kokoro_tts'
                                                          ? 'models.kokoro_speech_failed'
                                                          : 'translate.speech_failed'
                                                ),
                                                { style: toastStyle }
                                            );
                                        })
                                    }
                                >
                                    <LuVolume2 className='text-[12px]' />
                                    {t('translate.read_all')}
                                </button>
                            )}
                        </div>
                        <div className='cup-paragraph-meta'>
                            <span>
                                {paragraphView === 'translation'
                                    ? t('translate.translation_continuous')
                                    : t('translate.compare_sentences')}
                            </span>
                            <i className='cup-meta-dot' />
                            <span>{t('translate.sentence_count', { count: sentencePairs.length })}</span>
                            <i className='cup-meta-dot' />
                            <span>
                                {paragraphView === 'translation'
                                    ? t('translate.compare_hint')
                                    : t('translate.keep_source_order')}
                            </span>
                        </div>
                        {paragraphView === 'translation' ? (
                            <div className='cup-paragraph-reading select-text'>
                                <p>{paragraphEntry.translation}</p>
                            </div>
                        ) : (
                            <div className='cup-sentence-list'>
                                {sentencePairs.map((sentence, index) => (
                                    <article
                                        className='cup-sentence select-text'
                                        key={`${sentence.source}-${index}`}
                                    >
                                        <span className='cup-sentence-index'>{String(index + 1).padStart(2, '0')}</span>
                                        <div>
                                            <p className='cup-sentence-source'>{sentence.source}</p>
                                            <p className='cup-sentence-target'>{sentence.target}</p>
                                        </div>
                                        {speechService && (
                                            <button
                                                type='button'
                                                className='cup-speak-button'
                                                aria-label={exampleSpeechLabel}
                                                data-active={activeExample === `sentence-${index}-target`}
                                                onClick={() =>
                                                    speakExample(
                                                        sentence.target,
                                                        targetLanguage,
                                                        `sentence-${index}-target`
                                                    )
                                                }
                                            >
                                                {detailSpeechIcon(`sentence-${index}-target`)}
                                            </button>
                                        )}
                                    </article>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {termChecks.length > 0 && (
                    <div
                        className='p-2 text-xs text-default-500'
                        role='status'
                    >
                        {termChecks.map((check, i) => (
                            <p key={`${check.id}-${i}`}>
                                {check.source}: {t('models.source_match')} · {t(`models.term_${check.status}`)}
                                {check.unsupportedConstraint ? ` · ${t('models.no_constraint')}` : ''}
                            </p>
                        ))}
                        {glossaryHint(termChecks).truncated && <p>{t('models.hint_limit')}</p>}
                    </div>
                )}
                {skipped && <p className='cup-skipped'>{t('translate.unconfigured_skip')}</p>}
                {error && (
                    <div
                        className='cup-result-error'
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
                    <button
                        type='button'
                        className='cup-result-retry'
                        onClick={() => {
                            setError('');
                            setResult('');
                            setSkipped(false);
                            translate();
                        }}
                    >
                        <LuRotateCcw className='text-[12px]' />
                        {t('translate.retry')}
                    </button>
                )}
                {!hide && copyableResult && !speechService && <SpeechPreference compact />}
            </div>

            <footer className={`cup-result-foot ${hide || (!copyableResult && !error) ? 'is-hidden' : ''}`}>
                <Dropdown placement='top-start'>
                    <DropdownTrigger>
                        <button
                            type='button'
                            className='cup-foot-engine'
                        >
                            <span className='cup-provider-mark'>
                                {speechService === 'google_tts' ? 'G' : speechService ? '◉' : '·'}
                            </span>
                            {speechService === 'qwen_tts'
                                ? 'Qwen3-TTS'
                                : speechService === 'google_tts'
                                  ? 'Google'
                                  : speechService === 'lingva_tts'
                                    ? 'Lingva'
                                    : speechService === 'kokoro_tts'
                                      ? 'Kokoro'
                                      : speechService === 'piper_tts'
                                        ? 'Piper'
                                        : speechService
                                          ? t('translate.local_speech')
                                          : t('translate.speech_service')}
                        </button>
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
                            isDisabled={privacyMode === 'device_only'}
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
                        <DropdownItem key='piper_tts'>Piper · {t('models.offline_short')}</DropdownItem>
                        <DropdownItem key='kokoro_tts'>Kokoro · {t('models.offline_short')}</DropdownItem>
                        <DropdownItem key='qwen_tts'>Qwen3-TTS · {t('models.local_service')}</DropdownItem>
                        <DropdownItem key='off'>{t('models.no_speech')}</DropdownItem>
                    </DropdownMenu>
                </Dropdown>
                <div className='cup-foot-actions'>
                    <Tooltip content={showBack ? t('translate.show_translation') : t('translate.translate_back')}>
                        <button
                            type='button'
                            className='cup-foot-icon'
                            aria-label={showBack ? t('translate.show_translation') : t('translate.translate_back')}
                            aria-pressed={showBack}
                            disabled={!speechText(result) || backLoading}
                            onClick={toggleBackTranslation}
                        >
                            {backLoading ? (
                                <LuLoader2 className='animate-spin text-[14px]' />
                            ) : (
                                <LuArrowLeftRight className='text-[14px]' />
                            )}
                        </button>
                    </Tooltip>
                    {showBack && <span className='cup-back-label'>{t('translate.back_translation')}</span>}
                    {collectionServiceList?.map((collectionServiceInstanceName) => (
                        <button
                            type='button'
                            className='cup-foot-icon'
                            key={collectionServiceInstanceName}
                            onClick={() => addToCollection(collectionServiceInstanceName)}
                        >
                            <img
                                src={
                                    getServiceSouceType(collectionServiceInstanceName) === ServiceSourceType.PLUGIN
                                        ? pluginList.collection[getServiceName(collectionServiceInstanceName)].icon
                                        : builtinCollectionServices[getServiceName(collectionServiceInstanceName)].info
                                              .icon
                                }
                                className='h-[15px] w-[15px]'
                                alt=''
                            />
                        </button>
                    ))}
                </div>
                <button
                    type='button'
                    className='cup-copy-button'
                    disabled={!copyableResult}
                    onClick={() => copyToClipboard(copyableResult, 'toast')}
                >
                    <LuCopy className='text-[12px]' />
                    {resultMode === 'word' ? t('translate.copy_entry') : t('translate.copy_result')}
                </button>
            </footer>
        </section>
    );
}
