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
 * 修复前这里**硬编码简体中文**（`复制到剪贴板失败：…`），而它出现的三个窗口
 * 都是完整本地化的（TextArea 6 处 t()、TargetArea 16 处、SourceArea 15 处）。
 * 于是英文界面下复制失败时，用户看到的是一句中文——
 * 与 `common.language_not_supported` 当初的问题完全同类。
 *
 * 原来的注释给了两条不新增 i18n key 的理由，两条都站不住：
 *   1. 「21 个语言文件都要同步」——不必。缺 key 时 i18next 会回退英文
 *      （`src/i18n/index.jsx` 的 `fallbackLng` 最终 `default: ['en']`），
 *      所以只需补 `en_US` / `zh_CN` 两个基准文件（CLAUDE.md §4.2）。
 *   2. 「传达的是这次复制失败了这一事实」——这恰恰是**用户可见文案**，
 *      正是应该本地化的那一类。
 *
 * 底层错误细节仍然保留（与 History 页 `clear_failed` 同一写法）：
 * 它有助于自查，且本身通常是英文原样，不参与翻译。
 *
 * @param {unknown} error 底层错误
 * @param {(key: string) => string} t i18next 的 t 函数
 */
export function clipboardFailureMessage(error, t) {
    const detail = error && error.message ? error.message : String(error);
    // 没拿到 t（例如被单独调用）时退回英文，绝不退回硬编码中文
    const prefix = typeof t === 'function' ? t('common.clipboard_failed') : 'Failed to copy to clipboard';
    return `${prefix}: ${detail}`;
}
