/**
 * 剪贴板写入的统一封装。
 *
 * 背景：项目里 10 处 `writeText(...)` 调用**全都没有 `.catch`**。
 * writeText 返回的 promise 会 reject（Tauri 的 Clipboard.writeText 失败时，
 * 例如剪贴板被其他进程占用、权限受限），于是：
 *   1. 用户想要的「文本进剪贴板」没达成；
 *   2. 却收不到任何提示——他只会以为自己没按中快捷键；
 *   3. reject 无人接管，WebView 里生成 UnhandledPromiseRejection，无法被上层捕获。
 *
 * 这里把「写入 + 失败上报」收口成一处，让每个调用点都得到一致行为。
 */

/**
 * 把文本写入剪贴板，成功/失败都会回调，绝不让 rejection 逃逸。
 *
 * @param {string} text 要写入的文本
 * @param {object} [options]
 * @param {(text: string) => Promise<void>} [options.writer] 实际写入函数，默认用 Tauri 的 writeText（便于注入测试）
 * @param {(error: unknown) => void} [options.onError] 失败回调
 * @param {() => void} [options.onSuccess] 成功回调
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function writeClipboardSafely(text, options = {}) {
    const { writer, onError, onSuccess } = options;

    let write = writer;
    if (!write) {
        // 动态 import：便于在 node 测试里注入 writer，不依赖 Tauri 运行时
        const mod = await import('@tauri-apps/api/clipboard');
        write = mod.writeText;
    }

    try {
        await write(text);
    } catch (error) {
        if (onError) {
            onError(error);
        }
        return false;
    }

    if (onSuccess) {
        onSuccess();
    }
    return true;
}

/**
 * 构造失败提示文案。
 *
 * 不新增 i18n key：一是 21 个语言文件都要同步，二是
 * 这里要传达的是「这次复制失败了」这一事实本身，附上底层错误更有助于自查。
 */
export function clipboardFailureMessage(error) {
    const detail = error && error.message ? error.message : String(error);
    return `复制到剪贴板失败：${detail}`;
}
