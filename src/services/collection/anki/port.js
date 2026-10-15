// Anki Connect 端口的解析。
//
// 放在 .js 而不是 .jsx 里是**刻意的**（同 src/utils/port.js）：node:test 无法
// import .jsx（ERR_UNKNOWN_FILE_EXTENSION），而这些逻辑是纯函数、值得被真实执行地测试。
//
// 背景（round 47 实测）：
//   src/services/collection/anki/index.jsx 原本写的是
//       const port = ankiConfig['port'] ?? 8765;
//   但 `??` **只挡 null / undefined**，空串会原样穿过：
//       实测 ('' ?? 8765) === ''     但 (null ?? 8765) === 8765
//   而设置页把输入框的值**原样**存进配置（onValueChange 不做校验），
//   于是用户把端口清空就会得到 URL `http://127.0.0.1:`。
//
//   用 node 的真实 URL 解析器实测三类后果：
//       'http://127.0.0.1:'      -> 合法，port 为空 -> 连到默认端口，**不是**用户要的
//       'http://127.0.0.1:abc'   -> **抛 Invalid URL**
//       'http://127.0.0.1:99999' -> **抛 Invalid URL**（超出 u16）
//       'http://127.0.0.1:-1'    -> **抛 Invalid URL**
//   即：清空端口会静默连错端口，输入非数字会直接在拼 URL 时抛错，
//   而用户看到的是「收集失败」，完全不知道原因在端口上。

/** Anki Connect 的默认端口 */
export const ANKI_DEFAULT_PORT = 8765;

/**
 * 把配置里的端口解析成一个可安全拼进 URL 的端口号。
 *
 * 与 `utils/port.js` 的 [`nextPortValue`] 分工不同：那个用于**输入框写入**，
 * 这个用于**读取配置后拼 URL**，所以它总是返回一个可用的数字——
 * 而不是 null（读取路径上没有「忽略这次输入」这个选项，必须兜底到默认值）。
 *
 * 为什么接受 number 也接受 string：配置里两种都可能出现——
 * 默认值 `port: 8765` 是数字，而用户输入后存进去的是字符串。
 *
 * @param {unknown} raw 配置里的端口值
 * @returns {number} 合法端口（1-65535）；任何非法输入都回退到 {@link ANKI_DEFAULT_PORT}
 */
export function resolveAnkiPort(raw) {
    // ⚠️ 本函数里有两处**实测等价冗余**（round 47 变异测试发现，已实测确认）：
    //
    //  1) 空串分支
    //     删掉 `if (trimmed === '') return ANKI_DEFAULT_PORT;` 不会改变任何行为：
    //     `Number('') === 0`，而 0 是整数、会通过 Number.isInteger，
    //     随后被 `parsed < 1` 判为非法并回退默认值 —— 路径不同，结果相同。
    //
    //  2) `raw.trim()`
    //     改成 `raw` 也不改变行为：`Number('  3000  ') === 3000`，
    //     `Number('   ') === 0` —— Number() 自己就会忽略首尾空白。
    //
    // 两处都**保留**：空串是最常见的输入（用户清空输入框），显式分支让意图一目了然；
    // trim() 则让「空串」的判定不依赖 Number() 的宽松解析这一隐式细节。
    // 它们不是「不可测的死防御」——下面的测试用真实输入覆盖了这两条路径
    // （`''` / `'   '` / `' 3000 '`），只是**删掉也不会红**，
    // 所以它们属于「可读性投资」，与此文件注释风格保持一致。

    if (typeof raw === 'number') {
        return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : ANKI_DEFAULT_PORT;
    }
    if (typeof raw !== 'string') {
        return ANKI_DEFAULT_PORT;
    }
    const trimmed = raw.trim();
    // 空串是「用户清空了输入框」这一最常见的情况，必须有兜底
    if (trimmed === '') {
        return ANKI_DEFAULT_PORT;
    }
    // 刻意不用 parseInt：parseInt('12abc') === 12 会把垃圾后缀悄悄吞掉，
    // 让「写错了」变成「悄悄用了另一个端口」。Number('12abc') === NaN 才会走到兜底。
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return ANKI_DEFAULT_PORT;
    }
    return parsed;
}
