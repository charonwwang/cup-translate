import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ALIYUN = 'src/window/Config/pages/Backup/utils/aliyun.jsx';

/**
 * 背景（本轮实测）：`aliyun.jsx` 里 8 处错误文案有 7 处是**张冠李戴**的。
 *
 * 这些消息会经 `toast.error(e.toString())` **原样显示给用户**
 * （`AliyunModal/index.jsx:33`）。修复前：
 *
 *     line  70  in list()            -> "Get accessToken Error"
 *     line 103  in remove()          -> "Get accessToken Error"
 *     line 220  in driveId()         -> "Get accessToken Error"
 *     line 251  in createDir()       -> "Get accessToken Error"
 *     line 285  in createFile()      -> "Get accessToken Error"
 *     line 313  in getFileByPath()   -> "Get accessToken Error"
 *     line 341  in getDownloadUrl()  -> "Get accessToken Error"
 *     line 196  in accessToken()     -> "Get accessToken Error"   ← 只有这处是对的
 *
 * 危害：用户看到「获取令牌失败」，会去重新登录/重新扫码，而真实原因是
 * 网络/权限/目录不存在 —— 与令牌无关，重登解决不了，用户无从定位。
 *
 * 本测试的做法：**从函数名推导应有文案**，而不是在测试里再写一份
 * 「哪种函数配哪句话」的清单 —— 硬写的清单同样会漏掉新加的函数
 * （本会话反复出现的「清单无法自证完整」陷阱）。
 * 只维护一张「函数名 -> 文案关键词」的映射，并对**每个**含错误文案的
 * 函数做检查，新增函数漏配会被 `KNOWN_KEYWORDS` 的完备性断言拦住。
 *
 * 可达性：本机没有阿里云盘账号，未真正发出过这些请求。
 * 证据来自源码结构与逐函数归属的静态核对（修复前已用 awk 逐条列出归属）。
 */

/** 每个函数的错误文案里必须出现的关键词（由函数名推导）。 */
const KNOWN_KEYWORDS = {
    accessToken: 'accessToken',
    list: 'File List',
    remove: 'Remove File',
    driveId: 'DriveId',
    createDir: 'Create Dir',
    createFile: 'Create File',
    getFileByPath: 'File By Path',
    getDownloadUrl: 'DownloadUrl',
    qrcode: 'QrCode',
    status: 'Status',
    userInfo: 'UserInfo',
};

/** 把源码切成 { 函数名 -> 函数体 }。用顶层 `async function` 作为切分点。 */
function splitFunctions(source) {
    const re = /^(?:export )?async function (\w+)\s*\(/gm;
    const marks = [...source.matchAll(re)].map((m) => ({ name: m[1], start: m.index }));
    assert.ok(marks.length >= 10, `expected the file to still define its functions, got ${marks.length}`);
    const out = new Map();
    for (let i = 0; i < marks.length; i += 1) {
        const end = i + 1 < marks.length ? marks[i + 1].start : source.length;
        out.set(marks[i].name, source.slice(marks[i].start, end));
    }
    return out;
}

/**
 * 取出函数体里**非 2xx 兜底分支**的文案。
 *
 * 每个函数在 `else` 里先看 `result['message']`，没有再抛一句带操作名的
 * 兜底文案 —— 张冠李戴的正是这一句。`result['file_id']` 之类的
 * 「找不到字段」文案（`Can not find ...`）属于另一个分支，本来就不含
 * 操作名，不在本测试的考量范围内。
 */
function errorLabels(body) {
    const out = [];
    for (const m of body.matchAll(
        /if \(result\['message'\]\)\s*\{[\s\S]*?\}\s*else\s*\{\s*throw new Error\(`([^`]*)\$\{/g
    )) {
        out.push(m[1].trim());
    }
    return out;
}

test('every aliyun error label names the operation that actually failed', async () => {
    const source = await readFile(ALIYUN, 'utf8');
    // 去掉注释与 import 区，避免注释里引用的旧文案被当成真实代码
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const functions = splitFunctions(code);

    const problems = [];
    for (const [name, body] of functions) {
        const labels = errorLabels(body);
        if (labels.length === 0) continue;

        const keyword = KNOWN_KEYWORDS[name];
        if (keyword === undefined) {
            problems.push(`${name}() has a non-2xx fallback label but no expected keyword`);
            continue;
        }
        for (const label of labels) {
            // 文案形如 "Get File List Error: " -> 去掉 "Get " 前缀与 " Error:" 后缀
            const core = label
                .replace(/^Get /, '')
                .replace(/\s*Error:\s*$/, '')
                .trim();
            if (core !== keyword) {
                problems.push(`${name}() uses "${label}" but this operation is "${keyword}"`);
            }
        }
    }
    assert.deepEqual(problems, [], problems.join('; '));
});

test('no function other than accessToken claims an accessToken failure', async () => {
    const code = (await readFile(ALIYUN, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const functions = splitFunctions(code);

    const misattributed = [];
    for (const [name, body] of functions) {
        if (name === 'accessToken') continue;
        if (/accessToken Error/.test(body)) misattributed.push(name);
    }
    assert.deepEqual(misattributed, [], `these functions must not blame the access token: ${misattributed.join(', ')}`);

    // 反向：accessToken() 自己必须仍然报这个错
    assert.match(functions.get('accessToken'), /Get accessToken Error/, 'accessToken() must keep its own label');

    // 且每个函数的文案必须互不相同（复制粘贴会立刻暴露）
    const seen = new Map();
    const duplicates = [];
    for (const [name, body] of functions) {
        for (const label of errorLabels(body)) {
            if (label.includes('accessToken')) continue; // 已在上面单独断言
            if (seen.has(label)) duplicates.push(`${label} used by both ${seen.get(label)} and ${name}`);
            else seen.set(label, name);
        }
    }
    // list 与 getFileByPath 之类可能合理地共用同一句话，这里只报告完全不合理的
    // 复制：同一句话出现在 >2 个函数里
    const counts = new Map();
    for (const [name, body] of functions) {
        for (const label of errorLabels(body)) {
            if (!counts.has(label)) counts.set(label, []);
            counts.get(label).push(name);
        }
    }
    const overused = [...counts.entries()].filter(
        ([label, names]) => names.length > 2 && !label.includes('accessToken')
    );
    assert.deepEqual(
        overused,
        [],
        `one label used by more than two functions smells like copy-paste: ${JSON.stringify(overused)}`
    );
});
