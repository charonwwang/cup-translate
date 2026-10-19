/**
 * 返回当前真正生效的源语言。
 *
 * 手动选择优先于自动识别：用户把“自动检测”改成英语后，即使上一次自动识别
 * 仍是意大利语，显示标签、发音和回译也必须使用英语。自动模式下才使用检测值。
 */
export function getActiveSourceLanguage(selectedSourceLanguage, detectedLanguage) {
    if (selectedSourceLanguage && selectedSourceLanguage !== 'auto') {
        return selectedSourceLanguage;
    }
    return detectedLanguage || '';
}
