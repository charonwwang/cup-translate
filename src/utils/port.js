// 端口输入框的解析与夹紧。
//
// 放在 .js 而不是 .jsx 里是**刻意的**：node:test 无法 import .jsx
// （ERR_UNKNOWN_FILE_EXTENSION），而这些逻辑又是纯函数、值得被真实执行地测试。
// 同类先例见 src/services/tts/google_tts/chunkText.js。
//
// 背景：设置页过去用「几个 parseInt 分支 + 最后的 else」夹紧端口，
// 漏掉了 parseInt 返回 **NaN** 的情况——
//   if (v === '')                  -> 0
//   else if (parseInt(v) > 65535)  -> 65535
//   else if (parseInt(v) < 0)      -> 0
//   else                           -> parseInt(v)   // <-- NaN 掉进这里
// NaN 与任何值比较都是 false，于是 '-' / '.' / 'e' / 'abc' 全部落到最后的 else
// 被原样存进配置；而 `JSON.stringify({a:NaN})` 产出 `{"a":null}`，磁盘上留下一个 null。
// 后果不是崩溃（Rust 对 null 有兜底），但界面会显示为空、磁盘上却是另一个值。

/** 合法的 u16 端口上界 */
export const MAX_PORT = 65535;

/**
 * 把端口文本夹紧成合法端口；无法解析为整数时返回 null。
 *
 * 注意它与 [`isPortInputAllowed`] 的分工：正则负责「哪些输入可以被接受」，
 * 这里负责「接受的输入映射到哪个数值」。
 *
 * 实现上刻意**不使用 parseInt 的宽容解析**，而是 `Number()`：
 *   · parseInt('12abc') === 12   —— 会把垃圾后缀悄悄吞掉
 *   · Number('12abc')  === NaN   —— 直接判为非法
 *
 * 这里只用 `Number.isInteger` 一道判断，它同时覆盖三种非法情况：
 *   · NaN       —— 'abc' / '-' / '.' / '12abc'
 *   · ±Infinity —— 'Infinity'
 *   · 小数      —— '1.5'
 * （实测确认 `Number.isInteger(NaN) === false`、`Number.isInteger(Infinity) === false`，
 *   所以额外再写一个 `Number.isNaN` 分支属于**不可测的死防御**：
 *   删掉它不会有任何行为变化。少一道等价判断，读代码时就不必猜哪道在生效。）
 *
 * 输入端已由正则过滤，因此这里的判断是**第二道防线**：万一将来有人放宽了正则、
 * 或直接调用本函数，也不会让 NaN 漏进配置——NaN 经 JSON 序列化会变成 null，
 * 那正是本文件要消灭的东西。
 *
 * @param {unknown} raw
 * @returns {number|null} 合法端口，或 null（应忽略这次输入）
 */
function clampPort(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed)) {
        // 涵盖 NaN / ±Infinity / 小数（如 '1.5'）——端口必须是有限整数
        return null;
    }
    if (parsed < 0) {
        // 负数：输入框不允许负数端口，夹到 0（与修复前的行为一致）
        return 0;
    }
    if (parsed > MAX_PORT) {
        return MAX_PORT;
    }
    return parsed;
}

/**
 * 端口输入框只接受纯数字（或空串，代表「还没填」）。
 * 其余字符直接忽略——好过把它们解析成 NaN 再写进配置。
 */
function isPortInputAllowed(raw) {
    return typeof raw === 'string' && /^\d*$/.test(raw);
}

/**
 * 一步完成「校验 + 夹紧」，返回应写入配置的值；null 表示忽略这次输入。
 * 供设置页直接使用，避免各处重复写两遍判断。
 */
export function nextPortValue(raw) {
    if (!isPortInputAllowed(raw)) {
        return null;
    }
    return clampPort(raw);
}
