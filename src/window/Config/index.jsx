import { useLocation, useRoutes } from 'react-router-dom';
import React, { useEffect, useRef, Suspense } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';

import WindowControl from '../../components/WindowControl';
import SideBar from './components/SideBar';
import { osType, appVersion } from '../../utils/env';
import routes from './routes';
import { useConfig } from '../../hooks';
import './style.css';
// Resource managers are also opened directly from the service settings route.
import './pages/Models/models.css';
import './dialogs.css';

export default function Config() {
    const [transparent] = useConfig('transparent', true);
    const { t } = useTranslation();
    const location = useLocation();
    const page = useRoutes(routes);
    const contentRef = useRef(null);
    useEffect(() => {
        contentRef.current?.scrollTo({ top: 0 });
    }, [location.pathname]);

    useEffect(() => {
        if (appWindow.label === 'config') {
            appWindow.show();
        }
    }, []);

    const pageKey = location.pathname.slice(1) || 'general';

    return (
        <div
            className={`config-shell ${transparent ? 'config-translucent' : ''} select-none cursor-default ${osType === 'Linux' ? 'rounded-[10px] border border-default-100' : ''}`}
        >
            <aside className='config-sidebar'>
                <div
                    className='h-[35px] shrink-0'
                    data-tauri-drag-region='true'
                />
                <div
                    className='config-brand'
                    data-tauri-drag-region='true'
                >
                    <img
                        alt=''
                        src='/icon.png'
                        className='config-logo'
                        draggable={false}
                    />
                    <span>cup-translate</span>
                </div>
                <SideBar />
                <div className='config-version'>cup-translate · {appVersion}</div>
            </aside>
            <div className='config-main'>
                <div
                    className='config-titlebar'
                    data-tauri-drag-region='true'
                >
                    <span className='config-title'>{t(`config.${pageKey}.title`)}</span>
                    {osType !== 'Darwin' && <WindowControl />}
                </div>
                <main
                    ref={contentRef}
                    tabIndex={0}
                    aria-label={t(`config.${pageKey}.title`)}
                    className='config-content'
                >
                    {pageKey !== 'models' && (
                        <div className='config-page-heading'>
                            <h1>{t(`config.${pageKey}.title`)}</h1>
                            <p>{t(`config.ui.${pageKey}_description`)}</p>
                        </div>
                    )}
                    <div className='config-page-body'>
                        <Suspense fallback={<div role='status'>cup-translate</div>}>{page}</Suspense>
                    </div>
                </main>
            </div>
        </div>
    );
}
