import { useNavigate, useLocation } from 'react-router-dom';
import { LuSlidersHorizontal, LuLanguages, LuScanLine, LuKeyboard, LuPuzzle, LuHistory, LuInfo } from 'react-icons/lu';
import { useTranslation } from 'react-i18next';
import { Button } from '@nextui-org/react';
import React from 'react';

const sections = [
    ['general', LuSlidersHorizontal],
    ['translate', LuLanguages],
    ['recognize', LuScanLine],
    ['hotkey', LuKeyboard],
    ['service', LuPuzzle],
    ['history', LuHistory],
    ['about', LuInfo],
];

export default function SideBar() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();

    return (
        <nav
            className='config-nav'
            aria-label={t('config.ui.navigation')}
        >
            {sections.map(([key, Icon]) => {
                const selected = location.pathname === `/${key}`;
                return (
                    <Button
                        key={key}
                        fullWidth
                        variant='light'
                        className={`config-nav-item ${selected ? 'is-active' : ''}`}
                        aria-current={selected ? 'page' : undefined}
                        onPress={() => navigate(`/${key}`)}
                        startContent={
                            <Icon
                                size={17}
                                aria-hidden='true'
                            />
                        }
                    >
                        <span>{t(`config.${key}.label`)}</span>
                    </Button>
                );
            })}
        </nav>
    );
}
