import { useCallback, useEffect, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { useGetState } from './useGetState';
import { store } from '../utils/store';
import { debounce } from '../utils';

export const useConfig = (key, defaultValue, options = {}) => {
    const [property, setPropertyState, getProperty] = useGetState(null);
    const { sync = true, immediate = false } = options;

    // defaultValue 用 ref 保存「最新值」，而不是放进依赖数组。
    //
    // 原因：调用方普遍传**内联字面量**（`useConfig(k, {})` / `useConfig(k, [])`，
    // 仓库里共 9 处）。每次渲染都是新引用，一旦进依赖数组就会——
    //   render -> defaultValue 新引用 -> syncToState 重建 -> effect 重跑
    //   -> syncToState(null) -> setPropertyState -> 再 render -> **无限循环**
    // ref 让 syncToState 只依赖 key（字符串，引用稳定），既拿到最新默认值又不会自激。
    const defaultValueRef = useRef(defaultValue);
    defaultValueRef.current = defaultValue;

    // Async reads must not overwrite a newer edit or another service instance.
    const readContext = useRef({ key, revision: 0 });
    if (readContext.current.key !== key) readContext.current = { key, revision: 0 };

    // 同步到Store (State -> Store)
    //
    // 依赖数组里**必须**有 key：debounce 的闭包捕获了 key，而 key 是动态的
    // （`serviceInstanceKey` 场景，见 PluginConfig）。若写成 []，切到另一个服务实例时
    // 这个闭包仍指向**首次渲染的 key**，于是 `setPluginConfig(v, true)` 会把新实例的
    // 配置写进旧实例的键——用户看到「保存成功」，重开却发现没保存。
    // 这与下面 useEffect 的 `[key]` 是同一件事的两半：那边重新订阅，这边重新绑定写入目标。
    const syncToStore = useCallback(
        debounce(async (v) => {
            try {
                await store.set(key, v);
                await store.save();
                // Events cross webviews: publish only the sealed value from the store.
                const safe = await store.get(key);
                const eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
                await emit(`${eventKey}_changed`, safe);
            } catch {
                console.error('Configuration save failed; credential store may be unavailable');
                return;
            }
        }),
        [key]
    );

    // 同步到State (Store -> State)
    //
    // 依赖里**必须**有 key：否则切换实例后 `store.get(key)` 读的仍是旧实例，
    // 表现是「打开 B 却显示 A 的配置」——界面与数据对不上。
    // 这里**只**依赖 key：defaultValue 走 ref（见上面的说明），
    // 若把它也放进依赖数组，9 个传内联 {} / [] 的调用点会无限重渲染。
    const syncToState = useCallback(
        (v) => {
            const context = readContext.current;
            const revision = ++context.revision;
            const current = () => readContext.current === context && context.revision === revision;
            if (v !== null) {
                setPropertyState(v);
            } else {
                store
                    .get(key)
                    .then(async (v) => {
                        if (!current()) return;
                        if (v === null) {
                            const fallback = defaultValueRef.current;
                            setPropertyState(fallback);
                            try {
                                await store.set(key, fallback);
                                await store.save();
                            } catch {
                                console.error(`[useConfig] failed to persist default for '${key}'`);
                            }
                        } else {
                            setPropertyState(v);
                        }
                    })
                    // ⚠️ `store.get` 是 `await invoke('plugin:store|get')`，**会 reject**
                    // （插件未注册 / IPC 失败 / 配置路径不可读；`utils/lang_detect.js:317`
                    // 已经记录过这一点）。
                    //
                    // 原先这里没有 `.catch`，于是读失败时：
                    //   · 上面的回调**从不执行** -> `setPropertyState` 一次都没被调用
                    //   · 本 hook 返回的 property **永远是 `null`**
                    //   · 同时留下一个**未处理的 Promise 拒绝**（仓库里没有任何
                    //     `window.unhandledrejection` 兜底，已 grep 确认）
                    // 本 hook 有 **140 处调用点**，全都依赖这个返回值渲染控件
                    // （开关、下拉框、输入框），拿到 `null` 就是控件状态错乱。
                    //
                    // 失败时退回到默认值（**只写 state、不写盘**）：读失败不代表
                    // 用户没配过，此时若照 `v === null` 分支去 `store.set` 落盘，
                    // 等于用一个默认值**覆盖用户真实配置** —— 那是数据丢失，
                    // 比显示默认值严重得多。写盘留给用户下次真实修改触发。
                    .catch((e) => {
                        console.error(`[useConfig] failed to read '${key}' from the store:`, e);
                        if (current()) setPropertyState(defaultValueRef.current);
                    });
            }
        },
        [key]
    );

    // 依赖 sync 与 syncToStore：sync 来自 options，syncToStore 会随 key 重建。
    // 若继续用 []，改变 options.sync 不会生效，且 setProperty 会一直调用**旧**的
    // syncToStore（连带把上面那两处修复一起抵消掉）。
    const setProperty = useCallback(
        (v, forceSync = false) => {
            readContext.current.revision++;
            setPropertyState(v);
            const isSync = forceSync || sync;
            if (isSync) {
                syncToStore(v);
                if (immediate) syncToStore.flush();
            }
        },
        [sync, syncToStore, immediate]
    );

    // 初始化（key 变化时重新订阅：serviceInstanceKey 等动态 key 的场景）
    useEffect(() => {
        syncToState(null);
        const eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
        const unlisten = listen(`${eventKey}_changed`, (e) => {
            syncToState(e.payload);
        });
        return () => {
            readContext.current.revision++;
            unlisten.then((f) => {
                f();
            });
            // 卸载/切换 key 时把待写盘的防抖调用立即落地。
            // syncToStore 有 500ms 防抖，而翻译窗口失焦后约 100ms 就被关闭，
            // 不 flush 会让用户刚改的设置（如「记住语言」下的源/目标语言）静默丢失。
            //
            // cleanup 里 flush 的必须是**本轮的** syncToStore：它随 key 重建（见上），
            // 所以依赖数组要带上 syncToStore，否则切换实例时旧实例的待写值会随
            // 旧 debounce 实例一起被丢弃（既没写盘、也没人再 flush 它）。
            syncToStore.flush();
        };
    }, [key, syncToState, syncToStore]);

    return [property, setProperty, getProperty];
};

export const deleteKey = async (key) => {
    try {
        if (!(await store.has(key))) return false;
        await store.delete(key);
        await store.save();
        return true;
    } catch {
        console.error('Configuration deletion failed');
        return false;
    }
};
