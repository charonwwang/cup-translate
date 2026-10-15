/**
 * 把长文本切成不超过 maxLen 的片段。
 *
 * 分隔符（空格 / 句号）的语义是「留在前一段末尾」，因此按分隔符切时取
 * slice(0, cut + 1)，这样朗读时不会把词切断。
 * 找不到分隔符时（典型：中文长句没有空格）必须**硬切 maxLen 个字符**，
 * 不能复用 cut + 1 —— 此前统一用 cut + 1，导致中文文本每段恒为 201 字符、
 * 超出 maxLen。溢出量虽只有 1，但那是实打实的越界。
 *
 * 导出为纯函数以便 tests 直接执行真实实现（而不是复刻一份）。
 */
export function chunkText(text, maxLen = 200) {
    const chunks = [];
    let remaining = text.trim();
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }
        // 在**不超过 maxLen** 的范围内找最近的分隔符断句（分隔符归前一段）。
        // 注意搜索上界是 maxLen - 1 而不是 maxLen：分隔符要占用本段最后一个位置，
        // 所以它最远只能落在下标 maxLen - 1。若允许落在 maxLen，
        // 再 slice(0, cut + 1) 就会切出 maxLen + 1 个字符（实测 201）。
        const limit = maxLen - 1;
        let cut = remaining.lastIndexOf(' ', limit);
        if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('。', limit);
        if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('.', limit);
        if (cut < maxLen * 0.5) {
            // 找不到分隔符：硬切，不带分隔符
            chunks.push(remaining.slice(0, maxLen));
            remaining = remaining.slice(maxLen);
            continue;
        }
        chunks.push(remaining.slice(0, cut + 1));
        remaining = remaining.slice(cut + 1);
    }
    return chunks;
}
