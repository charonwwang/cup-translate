import { appWindow } from '@tauri-apps/api/window';
import { BrowserRouter } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { warn } from 'tauri-plugin-log-api';
import React, { useEffect } from 'react';
import { useTheme } from 'next-themes';

import { invoke } from '@tauri-apps/api/tauri';
import Screenshot from './window/Screenshot';
import Translate from './window/Translate';
import Recognize from './window/Recognize';
import Updater from './window/Updater';
import { store } from './utils/store';
import Config from './window/Config';
import { useConfig } from './hooks';
import './style.css';
import './i18n';

const windowMap = {
    translate: <Translate />,
    screenshot: <Screenshot />,
    recognize: <Recognize />,
    config: <Config />,
    updater: <Updater />,
};

export default function App() {
    const [devMode] = useConfig('dev_mode', false);
    const [appTheme] = useConfig('app_theme', 'system');
    const [appLanguage] = useConfig('app_language', 'zh_cn');
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');
    const [appFontSize] = useConfig('app_font_size', 16);
    const { setTheme } = useTheme();
    const { i18n } = useTranslation();

    useEffect(() => {
        store.load();
    }, []);

    // 键盘监听：必须**具名**注册并在 cleanup 里移除。
    // 原来用匿名函数且没有 cleanup：`devMode` 由 useConfig 提供，
    // 初值是 null、异步读到磁盘值后才变成 true/false，`Object.is(null, false)`
    // 为 false 使得该 effect **每次挂载都重跑一次**，于是 document 上会残留
    // 一个再也无人移除的 keydown 监听器——按一次 Escape 会调用两次
    // appWindow.close()，且组件卸载后监听器依然附着。
    useEffect(() => {
        const onKeyDown = async (e) => {
            let allowKeys = ['c', 'v', 'x', 'a', 'z', 'y'];
            if (e.ctrlKey && !allowKeys.includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
            if (devMode !== null && devMode && e.key === 'F12') {
                await invoke('open_devtools');
            }
            if (e.key.startsWith('F') && e.key.length > 1) {
                e.preventDefault();
            }
            if (e.key === 'Escape') {
                await appWindow.close();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [devMode]);

    useEffect(() => {
        let mediaQuery = null;
        let onSystemThemeChange = null;
        if (appTheme !== null) {
            if (appTheme !== 'system') {
                setTheme(appTheme);
            } else {
                try {
                    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                        setTheme('dark');
                    } else {
                        setTheme('light');
                    }
                    // 具名 handler + cleanup：`appTheme` 同样经历 null -> 值 的变化，
                    // 不清理会让本 effect 每次挂载/切换主题都多留一个监听器。
                    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
                    onSystemThemeChange = (e) => {
                        if (e.matches) {
                            setTheme('dark');
                        } else {
                            setTheme('light');
                        }
                    };
                    mediaQuery.addEventListener('change', onSystemThemeChange);
                } catch {
                    warn("Can't detect system theme.");
                }
            }
        }
        return () => {
            if (mediaQuery && onSystemThemeChange) {
                mediaQuery.removeEventListener('change', onSystemThemeChange);
            }
        };
    }, [appTheme]);

    useEffect(() => {
        if (appLanguage !== null) {
            i18n.changeLanguage(appLanguage);
        }
    }, [appLanguage]);

    useEffect(() => {
        if (appFont !== null && appFallbackFont !== null) {
            document.documentElement.style.fontFamily = `"${appFont === 'default' ? 'sans-serif' : appFont}","${
                appFallbackFont === 'default' ? 'sans-serif' : appFallbackFont
            }"`;
        }
        if (appFontSize !== null) {
            document.documentElement.style.fontSize = `${appFontSize}px`;
        }
    }, [appFont, appFallbackFont, appFontSize]);

    return <BrowserRouter>{windowMap[appWindow.label]}</BrowserRouter>;
}
