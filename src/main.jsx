import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { appWindow } from '@tauri-apps/api/window';
import { NextUIProvider } from '@nextui-org/react';
import ReactDOM from 'react-dom/client';
import React from 'react';

import { initStore } from './utils/store';
import { initEnv } from './utils/env';
import App from './App';

if (import.meta.env.PROD) {
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });
}

// 启动兜底：初始化（initStore 依赖 tauri IPC）或渲染一旦失败，必须给出可见的错误面板——
// 否则 React 永不挂载，窗口一片空白、用户得不到任何反馈（静默失败）。
function renderBootFailure(error) {
    const message = (error && (error.stack || error.message)) || String(error);
    return (
        <div
            style={{
                padding: '24px',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
            }}
        >
            <div
                style={{
                    fontSize: '18px',
                    fontWeight: 'bold',
                    marginBottom: '12px',
                }}
            >
                启动失败 / Failed to start
            </div>
            <div
                style={{
                    fontSize: '14px',
                    color: '#666',
                    marginBottom: '12px',
                }}
            >
                初始化出错，界面无法加载。完整日志：~/.config/com.cup-translate.app/logs/cup-translate.log /
                Initialization failed, see the log file for details.
            </div>
            <div style={{ fontSize: '12px' }}>{message.slice(0, 2000)}</div>
        </div>
    );
}

// 渲染期错误兜底：组件树抛错时显示错误面板，而不是整棵 React 树卸载后留白
class BootErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, errorInfo) {
        console.error('[boot] render error:', error, errorInfo);
        // 兜底面板必须可见：show() 原本由界面组件调用，渲染失败时没人调它
        appWindow.show().catch(() => {});
    }

    render() {
        if (this.state.error) {
            return renderBootFailure(this.state.error);
        }
        return this.props.children;
    }
}

initStore()
    .then(async () => {
        // initEnv 失败不致命：继续渲染，功能降级由 BootErrorBoundary 兜底
        try {
            await initEnv();
        } catch (error) {
            console.error('[boot] initEnv failed (non-fatal):', error);
        }
        const rootElement = document.getElementById('root');
        const root = ReactDOM.createRoot(rootElement);
        root.render(
            <BootErrorBoundary>
                <NextUIProvider>
                    <NextThemesProvider attribute='class'>
                        <App />
                    </NextThemesProvider>
                </NextUIProvider>
            </BootErrorBoundary>
        );
    })
    .catch((error) => {
        console.error('[boot] initStore failed:', error);
        const rootElement = document.getElementById('root');
        ReactDOM.createRoot(rootElement).render(renderBootFailure(error));
        // 兜底面板必须可见：show() 原本由界面组件调用，初始化失败时没人调它
        appWindow.show().catch(() => {});
    });
