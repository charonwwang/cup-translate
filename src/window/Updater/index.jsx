import { Code, Card, CardBody, Button, Progress, Skeleton } from '@nextui-org/react';
import { installUpdate } from '@tauri-apps/api/updater';
import React, { useEffect, useRef, useState } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { relaunch } from '@tauri-apps/api/process';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';

import { useConfig, useToastStyle } from '../../hooks';
import { checkForUpdate } from '../../utils/updateCheck';
import { osType } from '../../utils/env';

export default function Updater() {
    const [transparent] = useConfig('transparent', true);
    const [downloaded, setDownloaded] = useState(0);
    const [total, setTotal] = useState(0);
    const [body, setBody] = useState('');
    const [manifest, setManifest] = useState(null);
    const [status, setStatus] = useState('checking');
    const busy = useRef(false);
    const [attempt, setAttempt] = useState(0);
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const formatDate = (value) => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
    };

    useEffect(() => {
        if (appWindow.label === 'updater') {
            appWindow.show();
        }
        let disposed = false;
        let eventId = 0;
        let removeListener;
        setStatus('checking');
        setBody('');
        setManifest(null);
        checkForUpdate().then(
            (update) => {
                if (disposed) return;
                setStatus(update.shouldUpdate ? 'available' : 'latest');
                if (update.shouldUpdate) {
                    setManifest(update.manifest || null);
                    setBody(update.manifest?.body || `v${update.manifest?.version || ''}`);
                } else {
                    setBody(t('updater.latest'));
                }
            },
            (e) => {
                if (disposed) return;
                setStatus('error');
                setBody(t('updater.check_failed'));
                console.error('Update check failed', e);
            }
        );
        {
            listen('tauri://update-download-progress', (e) => {
                if (eventId === 0) {
                    eventId = e.id;
                }
                if (e.id === eventId) {
                    // contentLength 可能为 null：Tauri 的 DownloadProgressEvent 把
                    // content_length 定义为 Option<u64>，值取自响应头的 Content-Length；
                    // 服务器用分块传输（chunked）不带该头时即为 None，经 serde 序列化成
                    // JSON null（tauri 1.8.1 src/updater/core.rs:663-667 取值、
                    // src/updater/mod.rs:124-129 定义）。
                    // 直接写进 total 会让 `downloaded / total` 变成 Infinity。
                    if (typeof e.payload.contentLength === 'number' && e.payload.contentLength > 0) {
                        setTotal(e.payload.contentLength);
                    }
                    setDownloaded((a) => {
                        return a + e.payload.chunkLength;
                    });
                }
            }).then((remove) => {
                if (disposed) remove();
                else removeListener = remove;
            });
        }
        return () => {
            disposed = true;
            removeListener?.();
        };
    }, [attempt]);

    return (
        <div
            className={`${transparent ? 'bg-background/90' : 'bg-background'} h-screen ${
                osType === 'Linux' && 'rounded-[10px] border-1 border-default-100'
            }`}
        >
            <Toaster />
            <div className='p-[5px] h-[35px] w-full select-none cursor-default'>
                <div
                    data-tauri-drag-region='true'
                    className={`h-full w-full flex ${osType === 'Darwin' ? 'justify-end' : 'justify-start'}`}
                >
                    <img
                        src='/icon.png'
                        className='h-[25px] w-[25px] mr-[10px]'
                        draggable={false}
                    />
                    <h2>{t('updater.title')}</h2>
                </div>
            </div>
            <Card className='mx-[24px] mt-[10px] overscroll-auto h-[calc(100vh-150px)]'>
                <CardBody>
                    {manifest && ['available', 'confirming', 'installing'].includes(status) && (
                        <div className='updater-version'>
                            <strong>v{manifest.version}</strong>
                            {manifest.date && <span>{formatDate(manifest.date)}</span>}
                        </div>
                    )}
                    {body === '' ? (
                        <div className='space-y-3'>
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
                        <ReactMarkdown
                            className='markdown-body select-text'
                            components={{
                                code: ({ node, ...props }) => {
                                    const { children } = props;
                                    return <Code size='sm'>{children}</Code>;
                                },
                                h2: ({ node, ...props }) => (
                                    <b>
                                        <h2
                                            className='text-[24px]'
                                            {...props}
                                        />
                                        <hr />
                                        <br />
                                    </b>
                                ),
                                h3: ({ node, ...props }) => (
                                    <b>
                                        <br />
                                        <h3
                                            className='text-[18px]'
                                            {...props}
                                        />
                                        <br />
                                    </b>
                                ),
                                li: ({ node, ...props }) => {
                                    const { children } = props;
                                    return (
                                        <li
                                            className='list-disc list-inside'
                                            children={children}
                                        />
                                    );
                                },
                            }}
                        >
                            {body}
                        </ReactMarkdown>
                    )}
                </CardBody>
            </Card>
            {status === 'installing' && (
                <Progress
                    aria-label='Downloading...'
                    label={t('updater.progress')}
                    // total 为 0 时不要做除法：服务器未给出 Content-Length 时
                    // 我们不知道总量，此时显示不确定进度（0）而不是 Infinity。
                    value={total > 0 ? (downloaded / total) * 100 : 0}
                    classNames={{
                        base: 'w-full px-[24px]',
                        track: 'drop-shadow-md border border-default',
                        indicator: 'bg-gradient-to-r from-emerald-600 to-teal-500',
                        label: 'tracking-wider font-medium text-default-600',
                        value: 'text-foreground/60',
                    }}
                    isIndeterminate={total <= 0}
                    showValueLabel={total > 0}
                    size='sm'
                />
            )}

            <div className='grid gap-4 grid-cols-2 h-[50px] my-[10px] mx-[24px]'>
                <Button
                    variant='flat'
                    isLoading={status === 'checking' || status === 'installing'}
                    isDisabled={status === 'checking' || status === 'installing' || status === 'latest'}
                    color='primary'
                    onPress={async () => {
                        if (status === 'error') {
                            setAttempt((value) => value + 1);
                            return;
                        }
                        if (status === 'available') {
                            setStatus('confirming');
                            return;
                        }
                        if (status !== 'confirming' || busy.current) return;
                        busy.current = true;
                        setDownloaded(0);
                        setTotal(0);
                        setStatus('installing');
                        try {
                            await installUpdate();
                            toast.success(t('updater.installed'), { style: toastStyle });
                            await relaunch();
                        } catch (error) {
                            setStatus('error');
                            setBody(t('updater.install_failed'));
                            console.error('Update installation failed', error);
                        } finally {
                            busy.current = false;
                        }
                    }}
                >
                    {status === 'installing'
                        ? total > 0 && downloaded > total
                            ? t('updater.installing')
                            : t('updater.downloading')
                        : t(
                              status === 'error'
                                  ? 'updater.retry'
                                  : status === 'confirming'
                                    ? 'updater.confirm_update'
                                    : status === 'checking'
                                      ? 'updater.checking'
                                      : 'updater.update'
                          )}
                </Button>
                <Button
                    variant='flat'
                    isDisabled={status === 'installing'}
                    color='default'
                    onPress={() => {
                        if (status === 'confirming') setStatus('available');
                        else appWindow.close();
                    }}
                >
                    {t('updater.cancel')}
                </Button>
            </div>
            {status === 'confirming' && (
                <p className='updater-note text-default-500 text-xs px-[24px] pb-[6px]'>{t('updater.cannot_cancel')}</p>
            )}
            {status === 'installing' && (
                <p className='updater-note text-default-500 text-xs px-[24px] pb-[6px]'>{t('updater.cannot_cancel')}</p>
            )}
        </div>
    );
}
