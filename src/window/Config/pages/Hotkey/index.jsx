import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Card, CardBody, Button, Input, Tooltip } from '@nextui-org/react';
import { LuRotateCcw, LuX, LuInfo } from 'react-icons/lu';
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api';

import { useConfig } from '../../../../hooks/useConfig';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { normalizeShortcut, saveShortcut, shortcutFromEvent } from '../../../../utils/shortcut';

function ShortcutEditor({ name, value, persist, title, description, bindings }) {
    const [draft, setDraft] = useState(value ?? '');
    const [saving, setSaving] = useState(false);
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    useEffect(() => setDraft(value ?? ''), [value]);
    const dirty = draft !== (value ?? '');
    const collision =
        draft &&
        bindings.some(
            ([key, binding]) => `hotkey_${key}` !== name && normalizeShortcut(binding) === normalizeShortcut(draft)
        );
    const [failure, setFailure] = useState('');

    async function save() {
        if (collision) return;
        setFailure('');
        setSaving(true);
        try {
            await saveShortcut(name, draft, {
                register: (name, shortcut) => invoke('register_shortcut_by_frontend', { name, shortcut }),
                persist,
            });
            toast.success(t('config.hotkey.success'), { style: toastStyle });
        } catch (error) {
            setFailure(t('config.hotkey.conflict_failed'));
            toast.error(t('config.hotkey.conflict_failed'), { style: toastStyle });
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className='config-item shortcut-row'>
            <div className='shortcut-description'>
                <h3>
                    {title}
                    {description && (
                        <Tooltip content={description}>
                            <span
                                className='shortcut-help'
                                tabIndex={0}
                                aria-label={description}
                            >
                                <LuInfo size={13} />
                            </span>
                        </Tooltip>
                    )}
                </h3>
            </div>
            <div className='shortcut-controls'>
                <Input
                    aria-label={title}
                    value={draft}
                    placeholder={t('config.hotkey.disabled')}
                    description={collision ? t('config.hotkey.duplicate') : failure || undefined}
                    isInvalid={Boolean(collision || failure)}
                    variant='bordered'
                    isReadOnly
                    isDisabled={saving || value === null}
                    onKeyDown={(event) => {
                        if (event.key === 'Tab') return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === 'Escape') {
                            setDraft(value ?? '');
                            return;
                        }
                        const shortcut = shortcutFromEvent(event, osType);
                        if (shortcut !== null) {
                            setDraft(shortcut);
                            setFailure('');
                        }
                    }}
                />
                <Button
                    isIconOnly
                    size='sm'
                    variant='light'
                    aria-label={t('config.hotkey.disable')}
                    isDisabled={saving || !draft}
                    onPress={() => setDraft('')}
                >
                    <LuX />
                </Button>
                <Button
                    isIconOnly
                    size='sm'
                    variant='light'
                    aria-label={t('config.hotkey.cancel')}
                    isDisabled={saving || !dirty}
                    onPress={() => setDraft(value ?? '')}
                >
                    <LuRotateCcw />
                </Button>
                <Button
                    size='sm'
                    color='primary'
                    isLoading={saving}
                    isDisabled={!dirty || value === null || Boolean(collision)}
                    onPress={save}
                >
                    {t('common.ok')}
                </Button>
            </div>
        </div>
    );
}

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
    const [trusted, setTrusted] = useState(null);
    useEffect(() => {
        if (osType === 'Darwin')
            invoke('accessibility_permission', { request: false })
                .then(setTrusted)
                .catch(() => setTrusted(false));
    }, []);
    const fields = [
        ['selection_translate', selectionTranslate, setSelectionTranslate],
        ['clipboard_translate', clipboardTranslate, setClipboardTranslate],
        ['input_translate', inputTranslate, setInputTranslate],
        ['ocr_recognize', ocrRecognize, setOcrRecognize],
        ['ocr_translate', ocrTranslate, setOcrTranslate],
    ];
    return (
        <Card data-cup-card>
            <Toaster />
            <CardBody data-cup-body>
                <p className='shortcut-intro'>{t('config.hotkey.record_hint')}</p>
                <details className='shortcut-details'>
                    <summary>{t('config.hotkey.conflict_details')}</summary>
                    <p>{t('config.hotkey.conflict_scope')}</p>
                </details>
                {osType === 'Darwin' && (
                    <div className='config-item'>
                        <span>
                            {t(trusted ? 'config.hotkey.permission_granted' : 'config.hotkey.permission_needed')}
                        </span>
                        <Button
                            size='sm'
                            onPress={() => invoke('accessibility_permission', { request: true }).then(setTrusted)}
                        >
                            {t('config.hotkey.check_permission')}
                        </Button>
                    </div>
                )}
                {fields.map(([key, value, persist]) => (
                    <ShortcutEditor
                        key={key}
                        name={`hotkey_${key}`}
                        value={value}
                        persist={persist}
                        bindings={fields}
                        title={t(`config.hotkey.${key}`)}
                        description={
                            ['selection_translate', 'clipboard_translate'].includes(key)
                                ? t(`config.hotkey.${key}_description`)
                                : undefined
                        }
                    />
                ))}
            </CardBody>
        </Card>
    );
}
