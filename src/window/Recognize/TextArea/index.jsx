import { Card, CardBody, CardFooter, Button, Skeleton, ButtonGroup, Tooltip } from '@nextui-org/react';
import { sendNotification } from '@tauri-apps/api/notification';
import { atom, useAtom, useAtomValue } from 'jotai';
import React, { useEffect, useState } from 'react';
import { CgSpaceBetween } from 'react-icons/cg';
import { MdContentCopy } from 'react-icons/md';
import { MdSmartButton } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { error as logError } from 'tauri-plugin-log-api';
import { nanoid } from 'nanoid';

import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../utils/service_instance';
import { currentServiceInstanceKeyAtom, languageAtom, recognizeFlagAtom } from '../ControlArea';
import { invoke_plugin } from '../../../utils/invoke_plugin';
import * as builtinServices from '../../../services/recognize';
import { useConfig } from '../../../hooks';
import { clipboardFailureMessage, writeClipboardSafely } from '../../../utils/clipboard';
import { base64Atom } from '../ImageArea';
import { pluginListAtom } from '..';

export const textAtom = atom();
let recognizeId = 0;

export default function TextArea(props) {
    const { serviceInstanceConfigMap } = props;
    const [autoCopy] = useConfig('recognize_auto_copy', false);
    const [deleteNewline] = useConfig('recognize_delete_newline', false);
    const [hideWindow] = useConfig('recognize_hide_window', false);
    const recognizeFlag = useAtomValue(recognizeFlagAtom);
    const currentServiceInstanceKey = useAtomValue(currentServiceInstanceKeyAtom);
    const language = useAtomValue(languageAtom);
    const base64 = useAtomValue(base64Atom);
    const [loading, setLoading] = useState(false);
    const [text, setText] = useAtom(textAtom);
    const [error, setError] = useState('');
    const pluginList = useAtomValue(pluginListAtom);
    const { t } = useTranslation();

    /**
     * 写入剪贴板并处理失败。修复前各调用点是 `writeText(...).then(...)`，
     * 没有 .catch：写失败时用户拿不到文本、也收不到任何提示，
     * 还留下无人处理的 promise rejection。
     *
     * mode: 'notification' 窗口已隐藏时发系统通知；'toast' 页面内提示；'silent' 不提示成功。
     * 失败在所有模式下都会记日志并弹错误提示。
     */
    const copyToClipboard = (text, mode = 'toast') => {
        return writeClipboardSafely(text, {
            onSuccess: () => {
                if (mode === 'notification') {
                    sendNotification({ title: t('common.write_clipboard'), body: text });
                }
            },
            onError: (e) => {
                // 该窗口没有渲染 react-hot-toast 的 <Toaster/>，toast 在此不可见，
                // 因此复用组件已有的 error 展示区（红色只读文本域），确保失败真的被看到。
                logError('clipboard write failed: ' + e);
                setError(clipboardFailureMessage(e, t));
            },
        });
    };

    useEffect(() => {
        setText('');
        setError('');
        if (
            base64 !== '' &&
            currentServiceInstanceKey &&
            autoCopy !== null &&
            deleteNewline !== null &&
            hideWindow !== null
        ) {
            setLoading(true);
            if (getServiceSouceType(currentServiceInstanceKey) === ServiceSourceType.PLUGIN) {
                if (language in pluginList[getServiceName(currentServiceInstanceKey)].language) {
                    let id = nanoid();
                    recognizeId = id;
                    const pluginConfig = serviceInstanceConfigMap[currentServiceInstanceKey] ?? {};

                    invoke_plugin('recognize', getServiceName(currentServiceInstanceKey)).then(
                        ([func, utils]) => {
                            func(base64, pluginList[getServiceName(currentServiceInstanceKey)].language[language], {
                                config: pluginConfig,
                                utils,
                            }).then(
                                (v) => {
                                    if (recognizeId !== id) return;
                                    v = v.trim();
                                    if (deleteNewline) {
                                        v = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                    }
                                    setText(v);
                                    setLoading(false);
                                    if (autoCopy) {
                                        copyToClipboard(v, hideWindow ? 'notification' : 'silent');
                                    }
                                },
                                (e) => {
                                    if (recognizeId !== id) return;
                                    setError(e.toString());
                                    setLoading(false);
                                }
                            );
                        },
                        (e) => {
                            if (recognizeId !== id) return;
                            setError(e.toString());
                            setLoading(false);
                        }
                    );
                }
            } else {
                const instanceConfig = serviceInstanceConfigMap[currentServiceInstanceKey] ?? {};
                if (language in builtinServices[getServiceName(currentServiceInstanceKey)].Language) {
                    let id = nanoid();
                    recognizeId = id;
                    builtinServices[getServiceName(currentServiceInstanceKey)]
                        .recognize(
                            base64,
                            builtinServices[getServiceName(currentServiceInstanceKey)].Language[language],
                            {
                                config: instanceConfig,
                            }
                        )
                        .then(
                            (v) => {
                                if (recognizeId !== id) return;
                                v = v.trim();
                                if (deleteNewline) {
                                    v = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                }
                                setText(v);
                                setLoading(false);
                                if (autoCopy) {
                                    copyToClipboard(v, hideWindow ? 'notification' : 'silent');
                                }
                            },
                            (e) => {
                                if (recognizeId !== id) return;
                                setError(e.toString());
                                setLoading(false);
                            }
                        );
                } else {
                    setError(t('common.language_not_supported'));
                    setLoading(false);
                }
            }
        }
    }, [base64, currentServiceInstanceKey, language, recognizeFlag, autoCopy, deleteNewline, hideWindow, t]);

    return (
        <Card
            shadow='none'
            className='bg-content1 h-full ml-[6px] mr-[12px]'
            radius='10'
        >
            <CardBody className='bg-content1 p-0 h-full'>
                {loading ? (
                    <div className='space-y-3 m-[12px]'>
                        <Skeleton className='w-3/5 rounded-lg'>
                            <div className='h-3 w-3/5 rounded-lg bg-default-200'></div>
                        </Skeleton>
                        <Skeleton className='w-4/5 rounded-lg'>
                            <div className='h-3 w-4/5 rounded-lg bg-default-200'></div>
                        </Skeleton>
                        <Skeleton className='w-2/5 rounded-lg'>
                            <div className='h-3 w-2/5 rounded-lg bg-default-300'></div>
                        </Skeleton>
                    </div>
                ) : (
                    <>
                        {text && (
                            <textarea
                                value={text}
                                className='bg-content1 h-full m-[12px] mb-0 resize-none focus:outline-none'
                                onChange={(e) => {
                                    setText(e.target.value);
                                }}
                            />
                        )}
                        {error && (
                            <textarea
                                value={error}
                                readOnly
                                className='bg-content1 h-full m-[12px] mb-0 resize-none focus:outline-none text-red-500'
                                onChange={(e) => {
                                    setText(e.target.value);
                                }}
                            />
                        )}
                    </>
                )}
            </CardBody>
            <CardFooter className='bg-content1 flex justify-start px-[12px]'>
                <ButtonGroup>
                    <Tooltip content={t('recognize.copy_text')}>
                        <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            onPress={() => {
                                copyToClipboard(text, 'silent');
                            }}
                        >
                            <MdContentCopy className='text-[16px]' />
                        </Button>
                    </Tooltip>
                    <Tooltip content={t('recognize.delete_newline')}>
                        <Button
                            isIconOnly
                            variant='light'
                            size='sm'
                            onPress={() => {
                                setText(text.replace(/\-\s+/g, '').replace(/\s+/g, ' '));
                            }}
                        >
                            <MdSmartButton className='text-[16px]' />
                        </Button>
                    </Tooltip>
                    <Tooltip content={t('recognize.delete_space')}>
                        <Button
                            isIconOnly
                            variant='light'
                            size='sm'
                            onPress={() => {
                                setText(text.replaceAll(' ', ''));
                            }}
                        >
                            <CgSpaceBetween className='text-[16px]' />
                        </Button>
                    </Tooltip>
                </ButtonGroup>
            </CardFooter>
        </Card>
    );
}
