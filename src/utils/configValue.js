// 「这个配置值真的填了吗」的通用判定。
//
// 放在 .js 而不是 .jsx 是**刻意的**（同 utils/port.js、anki/port.js）：
// node:test 无法 import .jsx，而这是值得被真实执行测试的纯函数。
//
// 背景（round 48/49 实测，同一类缺陷反复出现）：
//   项目里多处用 `value === ''` / `value !== ''` 判断「是否填了」。
//   但那是**精确比较空串**，纯空白（`'   '` / `'\t'` / `'\n'`）会穿过去。
//   已经实测到两处真实后果：
//
//   · required_config.js（round 48）：配置闸门放行纯空白的 apiKey/requestPath，
//     **全部 11 个登记引擎**都会发出注定失败的请求。
//     （该文件有自己的私有 `isFilledString`，本轮未改动它，避免扩大改动面。）
//   · General/index.jsx（round 49，本轮修）：代理开关的校验
//     `proxyHost === '' || proxyPort === ''` 放行纯空白 host，
//     最终 `set_proxy()` 把 `http://   :7890` 写进 http_proxy/https_proxy/all_proxy，
//     而 `format!("http://{}:{}", host, port)` 完全看不出问题。
//
// 为什么「纯空白」必须与「空」同等对待：从网页/文档复制密钥或地址时，
// 尾部常带空格或换行。trim 后为空的值没有任何下游能用，
// 判为「没填」不会误伤；反之放行它就一定会失败。

/**
 * 判断一个值是否算「真的填了内容」：必须是非空、且 trim 后仍有内容的字符串。
 *
 * 只读不写——不会修改传入的值，也不会回写任何配置对象。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFilledString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

/**
 * 判断一个**端口**配置值是否有效。
 *
 * 为什么不能直接用 [`isFilledString`]：端口输入框经 `utils/port.js::nextPortValue`
 * 存进配置的是 **number**（不是字符串），而 `isFilledString(7890) === false`。
 * 若拿它判端口，所有正常填写的端口都会被判为「没填」——
 * 那比原缺陷更糟（会把功能直接锁死）。
 *
 * 实测确认的类型分布：
 *   · 用户在设置页填过 -> number（如 7890）
 *   · 从没填过 / 被清空 -> ''（空串）
 *   · 老配置里可能是字符串
 * 三种都要正确判断。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFilledPort(value) {
    if (typeof value === 'number') {
        // 0 不是合法端口（Rust 侧同样 `filter(|v| *v != 0)`）
        return Number.isInteger(value) && value >= 1 && value <= 65535;
    }
    // 字符串：允许 '7890'，但不允许 '' / '   ' / 非数字
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') {
            return false;
        }
        const parsed = Number(trimmed);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
    }
    return false;
}
