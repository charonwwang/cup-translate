/**
 * 防抖包装。
 *
 * 返回值带一个 `flush()`：立即执行尚未触发的最后一次调用（没有待执行调用时是 no-op），
 * 以及一个 `cancel()`：丢弃待执行调用。
 *
 * 之所以需要 `flush`：组件卸载/窗口关闭时，待触发的防抖调用会随定时器一起消失。
 * `useConfig` 用它把配置写盘，而翻译窗口在失焦后约 100ms 就关闭，
 * 小于 500ms 的防抖延迟——不 flush 会静默丢掉用户刚改的设置。
 */
export const debounce = (fn, delay = 500) => {
    let timer = null;
    let pendingArgs = null;

    const debounced = (...args) => {
        timer && clearTimeout(timer);
        pendingArgs = args;
        timer = setTimeout(() => {
            timer = null;
            const finalArgs = pendingArgs;
            pendingArgs = null;
            fn(...finalArgs);
        }, delay);
    };

    debounced.flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (pendingArgs !== null) {
            const finalArgs = pendingArgs;
            pendingArgs = null;
            fn(...finalArgs);
        }
    };

    debounced.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        pendingArgs = null;
    };

    return debounced;
};
