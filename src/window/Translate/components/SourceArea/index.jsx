import SpeechPreference from '../../../../components/SpeechPreference';
import { resolveSpeechService } from '../../../../utils/speechService';
import { invalidateRequests } from '../../../../utils/requestRuntime';
import { useSpeech } from '../../../../hooks/useSpeech';
import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';
import React, { useEffect, useRef, useState } from 'react';
import { LuSquare, LuLoader2, LuVolume2, LuCopy, LuWrapText, LuLanguages } from 'react-icons/lu';
import { appWindow } from '@tauri-apps/api/window';
import toast from 'react-hot-toast';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { LuDelete } from 'react-icons/lu';
import { invoke } from '@tauri-apps/api';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../../utils/service_instance';
import { useConfig, useSyncAtom, useVoice, useToastStyle } from '../../../../hooks';
import { clipboardFailureMessage, writeClipboardSafely } from '../../../../utils/clipboard';
import { error as logError } from 'tauri-plugin-log-api';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as recognizeServices from '../../../../services/recognize';
import * as builtinTtsServices from '../../../../services/tts';
import detect from '../../../../utils/lang_detect';
import { getActiveSourceLanguage } from '../../../../utils/sourceLanguage';
import { detectLanguageAtom, sourceLanguageAtom, sourceTextAtom } from '../../atoms';
import { classifySourceText } from '../../resultView';
import { store } from '../../../../utils/store';
import { info } from 'tauri-plugin-log-api';
import { debug } from 'tauri-plugin-log-api';

export default function SourceArea(props) {
    const { pluginList, serviceInstanceConfigMap } = props;
    const [appFontSize] = useConfig('app_font_size', 16);
    const [sourceText, setSourceText, syncSourceText] = useSyncAtom(sourceTextAtom);
    const commitSourceText = useSetAtom(sourceTextAtom);
    const [detectLanguage, setDetectLanguage] = useAtom(detectLanguageAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const [incrementalTranslate] = useConfig('incremental_translate', false);
    const [dynamicTranslate] = useConfig('dynamic_translate', false);
    const [deleteNewline] = useConfig('translate_delete_newline', false);
    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const [recognizeServiceList] = useConfig('recognize_service_list', ['system', 'tesseract']);
    const [ttsServiceList] = useConfig('tts_service_list', ['google_tts']);
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [hideSource] = useConfig('hide_source', false);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const [windowType, setWindowType] = useState('[SELECTION_TRANSLATE]');
    const initialTextLoaded = useRef(false);
    const toastStyle = useToastStyle();

    /**
     * 写入剪贴板并处理失败。修复前 `writeText(sourceText)` 完全没有接错误：
     * 写失败时既无反馈，也留下未处理的 promise rejection。
     */
    const copyToClipboard = (text) => {
        return writeClipboardSafely(text, {
            onSuccess: () => {
                toast.success(t('common.copied'), { style: toastStyle });
            },
            onError: (e) => {
                logError('clipboard write failed: ' + e);
                toast.error(clipboardFailureMessage(e, t), { style: toastStyle });
            },
        });
    };
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const handleNewTextRef = useRef();
    const [speechPolicy] = useConfig('speech_policy', 'engine');
    const [showSpeechChoice, setShowSpeechChoice] = useState(false);
    const [privacyMode] = useConfig('privacy_mode', 'standard');
    const resolvedSourceSpeech = resolveSpeechService('source', speechPolicy, ttsServiceList);
    const sourceSpeechService =
        privacyMode === 'device_only' &&
        !['local_tts', 'piper_tts', 'kokoro_tts', 'qwen_tts'].includes(getServiceName(resolvedSourceSpeech ?? ''))
            ? null
            : resolvedSourceSpeech;
    const speak = useVoice();
    const activeSourceLanguage = getActiveSourceLanguage(sourceLanguage, detectLanguage);
    const speech = useSpeech(JSON.stringify([sourceText, activeSourceLanguage, sourceSpeechService, privacyMode]));
    const speechLabel = speech.status === 'idle' ? t('translate.speak') : t('translate.stop_speaking');
    const sourceMode = classifySourceText(sourceText);

    const inputEpoch = useRef(0);
    useEffect(
        () => () => {
            inputEpoch.current += 1;
        },
        []
    );
    const handleNewText = async (text) => {
        const epoch = ++inputEpoch.current;
        const current = () => epoch === inputEpoch.current;
        invalidateRequests();
        text = text.trim();
        if (hideWindow) {
            appWindow.hide();
        } else {
            appWindow.show();
            appWindow.setFocus();
        }
        // 清空检测语言
        setDetectLanguage('');
        if (text === '[INPUT_TRANSLATE]') {
            setWindowType('[INPUT_TRANSLATE]');
            appWindow.show();
            appWindow.setFocus();
            // setSourceText 来自 useSyncAtom，是普通 useState setter（只接受一个参数），
            // 且不会自动写回 sourceTextAtom。必须显式 syncSourceText()，
            // 否则界面清空了、atom 里还留着上一次的文本，TargetArea 会继续显示旧译文。
            setSourceText('');
            syncSourceText();
        } else if (text === '[IMAGE_TRANSLATE]') {
            setWindowType('[IMAGE_TRANSLATE]');
            const base64 = await invoke('get_base64');
            if (!current()) return;
            const serviceInstanceKey = recognizeServiceList[0];
            if (getServiceSouceType(serviceInstanceKey) === ServiceSourceType.PLUGIN) {
                if (recognizeLanguage in pluginList['recognize'][getServiceName(serviceInstanceKey)].language) {
                    const pluginConfig = serviceInstanceConfigMap[serviceInstanceKey];

                    let func, utils;
                    try {
                        [func, utils] = await invoke_plugin('recognize', getServiceName(serviceInstanceKey));
                    } catch (e) {
                        if (current()) setSourceText(e.toString());
                        return;
                    }
                    if (!current()) return;
                    func(
                        base64,
                        pluginList['recognize'][getServiceName(serviceInstanceKey)].language[recognizeLanguage],
                        {
                            config: pluginConfig,
                            utils,
                        }
                    ).then(
                        (v) => {
                            if (!current()) return;
                            let newText = v.trim();
                            if (deleteNewline) {
                                newText = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                            } else {
                                newText = v.trim();
                            }
                            // 空识别结果不追加，避免增量翻译累积空白
                            if (newText === '') return;
                            if (incrementalTranslate) {
                                setSourceText((old) => {
                                    return old ? old + ' ' + newText : newText;
                                });
                            } else {
                                setSourceText(newText);
                            }
                            detect_language(newText)
                                .then(() => {
                                    if (current()) syncSourceText();
                                })
                                .catch(() => {});
                        },
                        (e) => {
                            if (current()) setSourceText(e.toString());
                        }
                    );
                } else {
                    setSourceText(t('common.language_not_supported'));
                }
            } else {
                if (recognizeLanguage in recognizeServices[getServiceName(serviceInstanceKey)].Language) {
                    const instanceConfig = serviceInstanceConfigMap[serviceInstanceKey];
                    recognizeServices[getServiceName(serviceInstanceKey)]
                        .recognize(
                            base64,
                            recognizeServices[getServiceName(serviceInstanceKey)].Language[recognizeLanguage],
                            {
                                config: instanceConfig,
                            }
                        )
                        .then(
                            (v) => {
                                if (!current()) return;
                                let newText = v.trim();
                                if (deleteNewline) {
                                    newText = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                } else {
                                    newText = v.trim();
                                }
                                // 空识别结果不追加，避免增量翻译累积空白
                                if (newText === '') return;
                                if (incrementalTranslate) {
                                    setSourceText((old) => {
                                        return old ? old + ' ' + newText : newText;
                                    });
                                } else {
                                    setSourceText(newText);
                                }
                                detect_language(newText)
                                    .then(() => {
                                        if (current()) syncSourceText();
                                    })
                                    .catch(() => {});
                            },
                            (e) => {
                                if (current()) setSourceText(e.toString());
                            }
                        );
                } else {
                    setSourceText(t('common.language_not_supported'));
                }
            }
        } else {
            setWindowType('[SELECTION_TRANSLATE]');
            let newText = text.trim();
            if (deleteNewline) {
                newText = text.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
            } else {
                newText = text.trim();
            }
            // 空识别结果不追加，避免增量翻译累积空白
            if (newText === '') return;
            if (incrementalTranslate) {
                setSourceText((old) => {
                    return old ? old + ' ' + newText : newText;
                });
            } else {
                setSourceText(newText);
            }
            detect_language(newText)
                .then(() => {
                    syncSourceText();
                })
                .catch(() => {});
        }
    };

    // Keep the native event listener stable while ensuring it always sees the
    // latest service/config values after the settings window changes them.
    handleNewTextRef.current = handleNewText;

    const keyDown = async (event) => {
        if (event.altKey && event.shiftKey && event.code === 'KeyU') {
            event.preventDefault();
            const originText = textAreaRef.current.value;
            const selectionStart = textAreaRef.current.selectionStart;
            const selectionEnd = textAreaRef.current.selectionEnd;
            const selectionText = originText.substring(selectionStart, selectionEnd);

            const convertedText = transformVarName(selectionText);
            const targetText =
                originText.substring(0, selectionStart) + convertedText + originText.substring(selectionEnd);

            await changeSourceText(targetText);
            textAreaRef.current.selectionStart = selectionStart;
            textAreaRef.current.selectionEnd = selectionStart + convertedText.length;
        }

        if (event.isComposing) return;
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            detect_language(sourceText).then(() => {
                syncSourceText();
            });
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            appWindow.close();
        }
    };

    const handleSpeak = async () => {
        const instanceKey = sourceSpeechService;
        if (!instanceKey) {
            setShowSpeechChoice(true);
            return [];
        }
        let speechLanguage = activeSourceLanguage;
        if (speechLanguage === '') {
            speechLanguage = await detect(sourceText);
            setDetectLanguage(speechLanguage);
        }
        if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
            if (!(speechLanguage in ttsPluginInfo.language)) {
                throw new Error(t('common.language_not_supported'));
            }
            const pluginConfig = serviceInstanceConfigMap[instanceKey];
            let [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
            let data = await func(sourceText, ttsPluginInfo.language[speechLanguage], {
                config: pluginConfig,
                utils,
            });
            return data;
        } else {
            if (!(speechLanguage in builtinTtsServices[getServiceName(instanceKey)].Language)) {
                throw new Error(t('common.language_not_supported'));
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey] || {};
            let data = await builtinTtsServices[getServiceName(instanceKey)].tts(
                sourceText,
                builtinTtsServices[getServiceName(instanceKey)].Language[speechLanguage],
                {
                    config: instanceConfig,
                }
            );
            return data;
        }
    };

    useEffect(() => {
        if (hideWindow !== null) {
            let disposed = false;
            let stopListening;
            listen('new_text', (event) => {
                appWindow.setFocus();
                handleNewTextRef.current(event.payload);
            }).then((unlisten) => {
                if (disposed) {
                    unlisten();
                } else {
                    stopListening = unlisten;
                }
            });

            return () => {
                disposed = true;
                stopListening?.();
            };
        }
    }, [hideWindow]);

    useEffect(() => {
        if (ttsServiceList?.length > 0 && getServiceSouceType(ttsServiceList[0]) === ServiceSourceType.PLUGIN) {
            readTextFile(`plugins/tts/${getServiceName(ttsServiceList[0])}/info.json`, {
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
    }, [ttsServiceList]);

    useEffect(() => {
        if (
            deleteNewline !== null &&
            incrementalTranslate !== null &&
            recognizeLanguage !== null &&
            recognizeServiceList !== null &&
            hideWindow !== null
        ) {
            if (initialTextLoaded.current) return;
            initialTextLoaded.current = true;
            invoke('get_text')
                .then((v) => {
                    handleNewTextRef.current(v);
                })
                .catch((reason) => logError('Failed to read initial text: ' + reason));
        }
    }, [deleteNewline, incrementalTranslate, recognizeLanguage, recognizeServiceList, hideWindow]);

    useEffect(() => {
        textAreaRef.current.style.height = '42px';
        textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
    }, [sourceText, appFontSize]);

    const detect_language = async (text) => {
        const epoch = inputEpoch.current;
        const detected = await detect(text);
        if (epoch !== inputEpoch.current) throw new DOMException('Expired detection', 'AbortError');
        setDetectLanguage(detected);
    };

    // 用 useRef 而非局部变量：局部变量每次调用 changeSourceText 都重建，
    // 无法清理上一次调用留下的未触发定时器（连续输入时旧定时器会叠加触发）
    const sourceTextChangeTimerRef = useRef(null);
    const changeSourceText = async (text) => {
        inputEpoch.current += 1;
        invalidateRequests();
        setDetectLanguage('');
        await setSourceText(text);
        if (dynamicTranslate) {
            if (sourceTextChangeTimerRef.current) {
                clearTimeout(sourceTextChangeTimerRef.current);
            }
            sourceTextChangeTimerRef.current = setTimeout(() => {
                sourceTextChangeTimerRef.current = null;
                // 语言检测失败（离线、引擎异常、store 读取失败）也必须走到 syncSourceText()：
                // setSourceText 不会自动写回 sourceTextAtom，漏掉这一步会让 TargetArea
                // 继续显示上一段文本的译文。detect() 内部已兜底为 'en'，这里再保一层，
                // 保证「无论如何都同步」这一语义不被将来的改动破坏。
                detect_language(text)
                    .catch((error) => {
                        logError('Language detection failed in dynamic translate');
                        if (error?.name !== 'AbortError') setDetectLanguage('en');
                    })
                    .then(() => {
                        syncSourceText();
                    });
            }, 1000);
        }
    };

    const transformVarName = function (str) {
        let str2 = str;

        // snake_case to SNAKE_CASE
        if (/_[a-z]/.test(str2)) {
            str2 = str2
                .split('_')
                .map((it) => it.toLocaleUpperCase())
                .join('_');
        }
        if (str2 !== str) {
            return str2;
        }

        // SNAKE_CASE to kebab-case
        if (/^[A-Z]+(_[A-Z]+)*$/.test(str2)) {
            str2 = str2
                .split('_')
                .map((it) => it.toLocaleLowerCase())
                .join('-');
        }
        if (str2 !== str) {
            return str2;
        }

        // kebab-case to dot.notation
        if (/-/.test(str2)) {
            str2 = str2
                .split('-')
                .map((it) => it.toLocaleLowerCase())
                .join('.');
        }
        if (str2 !== str) {
            return str2;
        }

        // dot.notation to space separated
        if (/\.[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/(\.)([a-z])/g, (_, _2, it) => ' ' + it);
        }
        if (str2 !== str) {
            return str2;
        }

        // space separated to Title Case
        if (/\s[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([a-z])/g, (_, it) => ' ' + it.toLocaleUpperCase());
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // Title Case to CamelCase
        if (/\s[A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([A-Z])/g, (_, it) => it);
            str2 = str2.substring(0, 1).toLocaleLowerCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // CamelCase to PascalCase
        if (/^[a-z]+[A-Z]+/.test(str2)) {
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // PascalCase to snake_case
        if (/[^\s][A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/[A-Z]/g, (it, offset) => {
                return (offset == 0 ? '' : '_') + it.toLocaleLowerCase();
            });
        }

        return str2;
    };

    return (
        <div
            className={`cup-source-shell ${hideSource && windowType !== '[INPUT_TRANSLATE]' ? 'hidden' : ''}`}
            style={{ '--cup4-base': `${appFontSize || 16}px` }}
        >
            <section className='cup-source-panel'>
                <textarea
                    autoFocus
                    ref={textAreaRef}
                    className={`cup-source-text ${sourceMode}`}
                    aria-label={t('translate.source')}
                    placeholder={t('translate.input_hint')}
                    value={sourceText}
                    onKeyDown={keyDown}
                    onChange={(e) => {
                        const v = e.target.value;
                        changeSourceText(v);
                    }}
                />

                {showSpeechChoice && !sourceSpeechService && <SpeechPreference compact />}
                <div className='cup-source-tools'>
                    <button
                        type='button'
                        className='cup-source-tool'
                        title={speechLabel}
                        aria-label={speechLabel}
                        disabled={!sourceText}
                        data-active={speech.status !== 'idle'}
                        aria-pressed={speech.status !== 'idle'}
                        onClick={() => {
                            speech.toggle(handleSpeak).catch((e) => {
                                logError('[speech] failed');
                                toast.error(
                                    t(
                                        sourceSpeechService === 'piper_tts'
                                            ? 'models.piper_speech_failed'
                                            : sourceSpeechService === 'kokoro_tts'
                                              ? 'models.kokoro_speech_failed'
                                              : 'translate.speech_failed'
                                    ),
                                    { style: toastStyle }
                                );
                            });
                        }}
                    >
                        {speech.status === 'loading' ? (
                            <LuLoader2 className='animate-spin text-[14px]' />
                        ) : speech.status === 'playing' ? (
                            <LuSquare className='text-[12px]' />
                        ) : (
                            <LuVolume2 className='text-[15px]' />
                        )}
                    </button>
                    <button
                        type='button'
                        className='cup-source-tool'
                        title={t('translate.copy')}
                        aria-label={t('translate.copy')}
                        onClick={() => copyToClipboard(sourceText)}
                    >
                        <LuCopy className='text-[14px]' />
                    </button>
                    <button
                        type='button'
                        className='cup-source-tool'
                        title={t('translate.delete_newline')}
                        aria-label={t('translate.delete_newline')}
                        onClick={() => {
                            const newText = sourceText.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                            setSourceText(newText);
                            detect_language(newText)
                                .then(() => {
                                    syncSourceText();
                                })
                                .catch(() => {});
                        }}
                    >
                        <LuWrapText className='text-[14px]' />
                    </button>
                    <button
                        type='button'
                        className='cup-source-tool'
                        title={t('common.clear')}
                        aria-label={t('common.clear')}
                        disabled={sourceText === ''}
                        onClick={() => {
                            setSourceText('');
                            commitSourceText('');
                            setDetectLanguage('');
                        }}
                    >
                        <LuDelete className='text-[14px]' />
                    </button>
                    <button
                        type='button'
                        className='cup-source-tool'
                        title={t('translate.translate')}
                        aria-label={t('translate.translate')}
                        onClick={() => {
                            detect_language(sourceText).then(() => {
                                syncSourceText();
                            });
                        }}
                    >
                        <LuLanguages className='text-[14px]' />
                    </button>
                    {activeSourceLanguage !== '' && (
                        <span
                            className={`cup-lang-chip ${sourceLanguage === 'auto' ? '' : 'manual'}`}
                            aria-label={`${t('translate.source')}: ${t(`languages.${activeSourceLanguage}`)}`}
                        >
                            {t(`languages.${activeSourceLanguage}`)}
                        </span>
                    )}
                    <span className='cup-source-count'>{t('translate.characters', { count: sourceText.length })}</span>
                </div>
            </section>
        </div>
    );
}
