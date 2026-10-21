import { automaticTargetLanguage } from '../../../../utils/sourceLanguage';
import { Dropdown, DropdownMenu, DropdownTrigger, DropdownItem } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { BiTransferAlt } from 'react-icons/bi';
import { LuChevronDown } from 'react-icons/lu';
import React, { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';

import { languageList } from '../../../../utils/language';
import { getSystemTargetLanguage } from '../../../../utils/systemLanguage';
import { detectLanguageAtom, sourceLanguageAtom, targetLanguageAtom } from '../../atoms';
import { useConfig } from '../../../../hooks';

export default function LanguageArea() {
    const [rememberLanguage] = useConfig('translate_remember_language', false);
    const [translateSourceLanguage, setTranslateSourceLanguage] = useConfig('translate_source_language', 'auto');
    // 目标语言默认为系统语言（中文系统→中文），而非硬编码 zh_cn
    const [translateTargetLanguage, setTranslateTargetLanguage] = useConfig(
        'translate_target_language',
        getSystemTargetLanguage()
    );
    const [translateSecondLanguage] = useConfig('translate_second_language', 'en');

    const [sourceLanguage, setSourceLanguage] = useAtom(sourceLanguageAtom);
    const [targetLanguage, setTargetLanguage] = useAtom(targetLanguageAtom);
    const detectLanguage = useAtomValue(detectLanguageAtom);
    const { t } = useTranslation();
    const targetChosenByUser = useRef(false);
    const [languagesLoaded, setLanguagesLoaded] = useState(false);

    useEffect(() => {
        if (languagesLoaded || rememberLanguage === null || !translateSourceLanguage || !translateTargetLanguage)
            return;
        setSourceLanguage(translateSourceLanguage);
        setTargetLanguage(translateTargetLanguage);
        targetChosenByUser.current = rememberLanguage;
        setLanguagesLoaded(true);
    }, [languagesLoaded, rememberLanguage, translateSourceLanguage, translateTargetLanguage]);

    useEffect(() => {
        if (languagesLoaded && rememberLanguage) {
            setTranslateSourceLanguage(sourceLanguage);
            setTranslateTargetLanguage(targetLanguage);
        }
    }, [languagesLoaded, sourceLanguage, targetLanguage, rememberLanguage]);

    // 智能语言切换：检测到的源语言与目标语言相同时，自动切换目标为英语
    // （如中文系统翻译中文文本 → 自动切换为中→英）
    useEffect(() => {
        if (!languagesLoaded) return;
        const fallback = targetLanguage === 'en' ? getSystemTargetLanguage() : translateSecondLanguage;
        const target = automaticTargetLanguage(
            sourceLanguage,
            detectLanguage,
            targetLanguage,
            fallback,
            targetChosenByUser.current
        );
        if (target !== targetLanguage) setTargetLanguage(target);
    }, [detectLanguage, sourceLanguage, languagesLoaded]);

    return (
        <div className='cup-language-row'>
            <Dropdown>
                <DropdownTrigger>
                    <button
                        type='button'
                        className='cup-language-button'
                    >
                        {t(`languages.${sourceLanguage}`)}
                        <LuChevronDown className='text-[12px]' />
                    </button>
                </DropdownTrigger>
                <DropdownMenu
                    aria-label='Source Language'
                    className='max-h-[50vh] overflow-y-auto'
                    onAction={(key) => {
                        setSourceLanguage(key);
                    }}
                >
                    <DropdownItem key='auto'>{t('languages.auto')}</DropdownItem>
                    {languageList.map((x) => {
                        return <DropdownItem key={x}>{t(`languages.${x}`)}</DropdownItem>;
                    })}
                </DropdownMenu>
            </Dropdown>
            <button
                type='button'
                className='cup-language-swap'
                aria-label={t('translate.swap_languages')}
                onClick={async () => {
                    targetChosenByUser.current = true;
                    if (sourceLanguage !== 'auto') {
                        const oldSourceLanguage = sourceLanguage;
                        setSourceLanguage(targetLanguage);
                        setTargetLanguage(oldSourceLanguage);
                    } else {
                        if (detectLanguage !== '') {
                            if (targetLanguage === translateTargetLanguage) {
                                setTargetLanguage(detectLanguage);
                            } else {
                                setTargetLanguage(translateTargetLanguage);
                            }
                        } else {
                            if (targetLanguage === translateSecondLanguage) {
                                setTargetLanguage(translateTargetLanguage);
                            } else {
                                setTargetLanguage(translateSecondLanguage);
                            }
                        }
                    }
                }}
            >
                <BiTransferAlt />
            </button>
            <Dropdown>
                <DropdownTrigger>
                    <button
                        type='button'
                        className='cup-language-button end'
                    >
                        {t(`languages.${targetLanguage}`)}
                        <LuChevronDown className='text-[12px]' />
                    </button>
                </DropdownTrigger>
                <DropdownMenu
                    aria-label='Target Language'
                    className='max-h-[50vh] overflow-y-auto'
                    onAction={(key) => {
                        targetChosenByUser.current = true;
                        setTargetLanguage(key);
                    }}
                >
                    {languageList.map((x) => {
                        return <DropdownItem key={x}>{t(`languages.${x}`)}</DropdownItem>;
                    })}
                </DropdownMenu>
            </Dropdown>
        </div>
    );
}
