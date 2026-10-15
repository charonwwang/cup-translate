import { useCallback, useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { useGetState } from './useGetState';
import { store } from '../utils/store';
import { debounce } from '../utils';

export const useConfig = (key, defaultValue, options = {}) => {
    const [property, setPropertyState, getProperty] = useGetState(null);
    const { sync = true } = options;

    // 同步到Store (State -> Store)
    const syncToStore = useCallback(
        debounce((v) => {
            store.set(key, v);
            store.save();
            let eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
            emit(`${eventKey}_changed`, v);
        }),
        []
    );

    // 同步到State (Store -> State)
    const syncToState = useCallback((v) => {
        if (v !== null) {
            setPropertyState(v);
        } else {
            store.get(key).then((v) => {
                if (v === null) {
                    setPropertyState(defaultValue);
                    store.set(key, defaultValue);
                    store.save();
                } else {
                    setPropertyState(v);
                }
            });
        }
    }, []);

    const setProperty = useCallback((v, forceSync = false) => {
        setPropertyState(v);
        const isSync = forceSync || sync;
        isSync && syncToStore(v);
    }, []);

    // 初始化（key 变化时重新订阅：serviceInstanceKey 等动态 key 的场景）
    useEffect(() => {
        syncToState(null);
        const eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
        const unlisten = listen(`${eventKey}_changed`, (e) => {
            syncToState(e.payload);
        });
        return () => {
            unlisten.then((f) => {
                f();
            });
            // 卸载/切换 key 时把待写盘的防抖调用立即落地。
            // syncToStore 有 500ms 防抖，而翻译窗口失焦后约 100ms 就被关闭，
            // 不 flush 会让用户刚改的设置（如「记住语言」下的源/目标语言）静默丢失。
            syncToStore.flush();
        };
    }, [key]);

    return [property, setProperty, getProperty];
};

export const deleteKey = (key) => {
    if (store.has(key)) {
        store.delete(key);
        store.save();
    }
};
