import { unregister, isRegistered } from '@tauri-apps/api/globalShortcut';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { CardBody } from '@nextui-org/react';
import { Button } from '@nextui-org/react';
import { Input } from '@nextui-org/react';
import { Card } from '@nextui-org/react';
import React from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { invoke } from '@tauri-apps/api';

const keyMap = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Plus: 'PLUS',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Backspace: 'Backspace',
    CapsLock: 'Capslock',
    ContextMenu: 'Contextmenu',
    Space: 'Space',
    Tab: 'Tab',
    Convert: 'Convert',
    Delete: 'Delete',
    End: 'End',
    Help: 'Help',
    Home: 'Home',
    PageDown: 'Pagedown',
    PageUp: 'Pageup',
    Escape: 'Esc',
    PrintScreen: 'Printscreen',
    ScrollLock: 'Scrolllock',
    Pause: 'Pause',
    Insert: 'Insert',
    Suspend: 'Suspend',
};

export default function Hotkey() {
    const [selectionTranslate, setSelectionTranslate] = useConfig('hotkey_selection_translate', 'Alt+T', {
        sync: false,
    });
    const [clipboardTranslate, setClipboardTranslate] = useConfig('hotkey_clipboard_translate', 'Alt+Shift+T', {
        sync: false,
    });
    const [inputTranslate, setInputTranslate] = useConfig('hotkey_input_translate', '', { sync: false });
    const [ocrRecognize, setOcrRecognize] = useConfig('hotkey_ocr_recognize', '', { sync: false });
    const [ocrTranslate, setOcrTranslate] = useConfig('hotkey_ocr_translate', '', { sync: false });

    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    function keyDown(e, setKey) {
        e.preventDefault();
        if (e.keyCode === 8) {
            setKey('', true);
        } else {
            let newValue = '';
            if (e.ctrlKey) {
                newValue = 'Ctrl';
            }
            if (e.shiftKey) {
                newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Shift`;
            }
            if (e.metaKey) {
                newValue = `${newValue}${newValue.length > 0 ? '+' : ''}${osType === 'Darwin' ? 'Command' : 'Super'}`;
            }
            if (e.altKey) {
                newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Alt`;
            }
            let code = e.code;
            if (code.startsWith('Key')) {
                code = code.substring(3);
            } else if (code.startsWith('Digit')) {
                code = code.substring(5);
            } else if (code.startsWith('Numpad')) {
                code = 'Num' + code.substring(6);
            } else if (code.startsWith('Arrow')) {
                code = code.substring(5);
            } else if (code.startsWith('Intl')) {
                code = code.substring(4);
            } else if (/F\d+/.test(code)) {
            } else if (keyMap[code] !== undefined) {
                code = keyMap[code];
            } else {
                code = '';
            }
            // 用户真的按了键（含 Backspace = 显式禁用），这里必须落盘：
            // forceSync=true 是因为本页的 useConfig 用了 { sync: false }，
            // 只有「用户明确的改键动作」才写配置（见 onFocus 的注释）。
            setKey(`${newValue}${newValue.length > 0 && code.length > 0 ? '+' : ''}${code}`, true);
        }
    }

    /**
     * 注册用户刚按下的组合键。
     *
     * `persist` 是配套的 setter：本页的 useConfig 用 `{ sync: false }`，
     * 因此**只有在这里成功之后**才把新值写进配置。
     * 这样「注册失败」（例如组合键已被别的程序占用）不会污染配置，
     * 用户看到的输入框和磁盘上的值仍然一致。
     */
    function registerHandler(name, key, persist) {
        // `isRegistered` 是 `@tauri-apps/api/globalShortcut` 的
        // `invokeTauriCommand({ __tauriModule: 'GlobalShortcut', ... })`（真实 IPC），
        // **会 reject**。修复前这里只有 `.then()`、没有 `.catch`，
        // 于是一旦它失败，回调**从不执行**：
        //   · 用户按下组合键后界面**毫无反应** —— 既没有「已被占用」的错误提示，
        //     也没有成功提示；
        //   · 配置确实没被写入（`persist` 没被调用，这点是对的），
        //     但用户无法区分「失败了」和「没按上」，只会反复重试；
        //   · 同时留下一个未处理的 Promise 拒绝（仓库里没有任何
        //     `window.unhandledrejection` 兜底，已 grep 确认为空）。
        //
        // 注意**同一个函数内层**的 `invoke('register_shortcut_by_frontend')`
        // 本来就带了两参数形式的失败回调（下面那段），所以这里是把外层漏掉的那个
        // 补齐——失败时必须给出提示，不能静默。
        //
        // 文案沿用内层失败分支的做法（直接把错误对象交给 toast.error），
        // 不新增 i18n key：本项目没有母语校验能力，机翻会产出错误文案
        // （CLAUDE.md §4.2 / §9 红线）。
        isRegistered(key)
            .then((res) => {
                if (res) {
                    toast.error(t('config.hotkey.is_register'), { style: toastStyle });
                } else {
                    invoke('register_shortcut_by_frontend', {
                        name: name,
                        shortcut: key,
                    }).then(
                        () => {
                            persist(key, true);
                            toast.success(t('config.hotkey.success'), { style: toastStyle });
                        },
                        (e) => {
                            toast.error(e, { style: toastStyle });
                        }
                    );
                }
            })
            .catch((e) => {
                toast.error(e, { style: toastStyle });
            });
    }

    return (
        <Card>
            <Toaster />
            <CardBody>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('config.hotkey.selection_translate')}</h3>
                    {selectionTranslate !== null && (
                        <Input
                            type='hotkey'
                            variant='bordered'
                            value={selectionTranslate}
                            label={t('config.hotkey.set_hotkey')}
                            className='max-w-[50%]'
                            onKeyDown={(e) => {
                                keyDown(e, setSelectionTranslate);
                            }}
                            onFocus={() => {
                                // 只为「接下来要按新键」腾出输入框：
                                // 这里**不写配置**（本页 useConfig 为 sync:false）。
                                // 修复前 sync 默认为 true，这个空串会被立刻落盘——
                                // 用户只是点了一下输入框、随后点走，快捷键就被永久清掉，
                                // 而且界面上看不出发生过什么（下次启动不再注册，日志也不报错）。
                                unregister(selectionTranslate);
                                setSelectionTranslate('');
                            }}
                            endContent={
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className={`${selectionTranslate === '' && 'hidden'}`}
                                    onPress={() => {
                                        registerHandler(
                                            'hotkey_selection_translate',
                                            selectionTranslate,
                                            setSelectionTranslate
                                        );
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            }
                        />
                    )}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('config.hotkey.clipboard_translate')}</h3>
                    {clipboardTranslate !== null && (
                        <Input
                            type='hotkey'
                            variant='bordered'
                            value={clipboardTranslate}
                            label={t('config.hotkey.set_hotkey')}
                            className='max-w-[50%]'
                            onKeyDown={(e) => {
                                keyDown(e, setClipboardTranslate);
                            }}
                            onFocus={() => {
                                // 只为「接下来要按新键」腾出输入框：
                                // 这里**不写配置**（本页 useConfig 为 sync:false）。
                                // 修复前 sync 默认为 true，这个空串会被立刻落盘——
                                // 用户只是点了一下输入框、随后点走，快捷键就被永久清掉，
                                // 而且界面上看不出发生过什么（下次启动不再注册，日志也不报错）。
                                unregister(clipboardTranslate);
                                setClipboardTranslate('');
                            }}
                            endContent={
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className={`${clipboardTranslate === '' && 'hidden'}`}
                                    onPress={() => {
                                        registerHandler(
                                            'hotkey_clipboard_translate',
                                            clipboardTranslate,
                                            setClipboardTranslate
                                        );
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            }
                        />
                    )}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('config.hotkey.input_translate')}</h3>
                    {inputTranslate !== null && (
                        <Input
                            type='hotkey'
                            variant='bordered'
                            value={inputTranslate}
                            label={t('config.hotkey.set_hotkey')}
                            className='max-w-[50%]'
                            onKeyDown={(e) => {
                                keyDown(e, setInputTranslate);
                            }}
                            onFocus={() => {
                                // 只为「接下来要按新键」腾出输入框：
                                // 这里**不写配置**（本页 useConfig 为 sync:false）。
                                // 修复前 sync 默认为 true，这个空串会被立刻落盘——
                                // 用户只是点了一下输入框、随后点走，快捷键就被永久清掉，
                                // 而且界面上看不出发生过什么（下次启动不再注册，日志也不报错）。
                                unregister(inputTranslate);
                                setInputTranslate('');
                            }}
                            endContent={
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className={`${inputTranslate === '' && 'hidden'}`}
                                    onPress={() => {
                                        registerHandler('hotkey_input_translate', inputTranslate, setInputTranslate);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            }
                        />
                    )}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('config.hotkey.ocr_recognize')}</h3>
                    {ocrRecognize !== null && (
                        <Input
                            type='hotkey'
                            variant='bordered'
                            value={ocrRecognize}
                            label={t('config.hotkey.set_hotkey')}
                            className='max-w-[50%]'
                            onKeyDown={(e) => {
                                keyDown(e, setOcrRecognize);
                            }}
                            onFocus={() => {
                                // 只为「接下来要按新键」腾出输入框：
                                // 这里**不写配置**（本页 useConfig 为 sync:false）。
                                // 修复前 sync 默认为 true，这个空串会被立刻落盘——
                                // 用户只是点了一下输入框、随后点走，快捷键就被永久清掉，
                                // 而且界面上看不出发生过什么（下次启动不再注册，日志也不报错）。
                                unregister(ocrRecognize);
                                setOcrRecognize('');
                            }}
                            endContent={
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className={`${ocrRecognize === '' && 'hidden'}`}
                                    onPress={() => {
                                        registerHandler('hotkey_ocr_recognize', ocrRecognize, setOcrRecognize);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            }
                        />
                    )}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('config.hotkey.ocr_translate')}</h3>
                    {ocrTranslate !== null && (
                        <Input
                            type='hotkey'
                            variant='bordered'
                            value={ocrTranslate}
                            label={t('config.hotkey.set_hotkey')}
                            className='max-w-[50%]'
                            onKeyDown={(e) => {
                                keyDown(e, setOcrTranslate);
                            }}
                            onFocus={() => {
                                // 只为「接下来要按新键」腾出输入框：
                                // 这里**不写配置**（本页 useConfig 为 sync:false）。
                                // 修复前 sync 默认为 true，这个空串会被立刻落盘——
                                // 用户只是点了一下输入框、随后点走，快捷键就被永久清掉，
                                // 而且界面上看不出发生过什么（下次启动不再注册，日志也不报错）。
                                unregister(ocrTranslate);
                                setOcrTranslate('');
                            }}
                            endContent={
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className={`${ocrTranslate === '' && 'hidden'}`}
                                    onPress={() => {
                                        registerHandler('hotkey_ocr_translate', ocrTranslate, setOcrTranslate);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            }
                        />
                    )}
                </div>
            </CardBody>
        </Card>
    );
}
