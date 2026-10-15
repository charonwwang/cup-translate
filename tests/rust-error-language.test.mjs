import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

/**
 * Rust 侧**返回给前端**的错误字符串必须用英文。
 *
 * 背景（本轮实测）：这些字符串会经前端的
 *   `toast.error(e.toString())` / `setError(e.toString())`
 * **原样显示给用户**。而项目的默认与回退语言是英文
 * （`src/i18n/index.jsx` 的 `fallbackLng` 最终 `default: ['en']`），
 * 用户在英文界面下看到的却可能是中文。
 *
 * 实测统计（修复前）：
 *   tts.rs      6 处 Err/format!/map_err，3 处含中文
 *   local_mt.rs 33 处，13 处含中文
 *   其余 11 个模块（cmd/config/hotkey/server/window/system_ocr/…）**全英文**
 * 所以「英文」是既有约定，中文才是例外——修复方向是让例外向多数看齐。
 *
 * 为什么不在 Rust 侧做 i18n：错误字符串只是诊断信息，且数量多、分散；
 * 项目已有的本地化机制是 `notification.rs`（系统通知，按 app_language 取文案）
 * 与前端的 `t()`。要在 UI 上本地化错误提示，应在**展示层**做，
 * 而不是把 i18n 实例塞进每个服务。
 *
 * 这类问题不会被编译或类型检查发现（任何字符串都合法），所以需要断言。
 */

/**
 * 允许保留中文的例外，附理由。
 *
 * 目前**为空**：许可证署名那行（local_mt.rs 的 `license:` 字段）
 * 根本不会被本测试扫到——它不是 `Err`/`format!`/`map_err` 构造出来的，
 * 所以不需要豁免。（我第一版把它写进例外，结果被
 * 「例外必须真实存在」那条测试当场抓出来，已删除。）
 * 保留这个空数组是为了给未来的正当例外一个带理由的位置。
 */
const ALLOWED = [];

/**
 * 从一行里取出「会返回给前端的字符串字面量」。
 * 只看 Err(...) / format!(...) / map_err(...) 这些构造错误的行。
 */
function errorLines(source) {
    const out = [];
    // `#[cfg(test)]` 之后的代码**永远不会进入用户可见的二进制**：
    // 单测里的断言文本、用于喂给被测函数的夹具字符串都不是「给用户看的错误文案」。
    // 不排除掉的话，一条 `assert_eq!(got, Ok("你好世界".to_string()))`
    // 就会被误报成「面向用户的错误不是英文」（本轮实际发生）。
    // 注意行号仍要在**原始全文**里数，否则报错位置会偏移。
    const testModAt = source.indexOf('#[cfg(test)]');
    const scanEnd = testModAt === -1 ? source.length : testModAt;
    let offset = 0;
    source.split('\n').forEach((line, index) => {
        const lineStart = offset;
        offset += line.length + 1;
        if (lineStart >= scanEnd) return; // 测试模块内的行，跳过
        const trimmed = line.trim();
        // 跳过注释：本项目用中文注释，不能误伤
        if (trimmed.startsWith('//') || trimmed.startsWith('///') || trimmed.startsWith('*')) return;
        if (!/(Err\(|format!\(|map_err|ok_or_else|\.to_string\(\))/.test(line)) return;
        if (!/[\u4e00-\u9fff]/.test(line)) return;
        out.push({ line: index + 1, text: trimmed });
    });
    return out;
}

test('user-visible Rust error strings are written in English', async () => {
    const dir = 'src-tauri/src';
    const files = (await readdir(dir)).filter((f) => f.endsWith('.rs'));
    assert.ok(files.length >= 15, `expected the Rust modules, got ${files.length}`);

    const offenders = [];
    for (const file of files) {
        const source = await readFile(`${dir}/${file}`, 'utf8');
        for (const hit of errorLines(source)) {
            const allowed = ALLOWED.some((a) => a.file === file && hit.text.includes(a.contains));
            if (!allowed) offenders.push(`${file}:${hit.line}  ${hit.text}`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'these Rust errors reach users verbatim via e.toString() but are not in English:\n' + offenders.join('\n')
    );
});

test('the exception list stays honest', async () => {
    // 例外必须真的存在，否则名单会变成「永久豁免」而没人发现它已失效。
    for (const entry of ALLOWED) {
        const source = await readFile(`src-tauri/src/${entry.file}`, 'utf8');
        const stillThere = errorLines(source).some((hit) => hit.text.includes(entry.contains));
        assert.ok(
            stillThere,
            `${entry.file} no longer contains the allowed Chinese string ${JSON.stringify(entry.contains)}; ` +
                'remove it from ALLOWED so the guard keeps its teeth'
        );
        assert.ok(entry.reason && entry.reason.length > 0, 'every exception needs a reason');
    }
});

test('messages that reach users keep their actionable detail', async () => {
    // 英文化**不能**把可操作信息弄丢：这些是用户唯一能自救的线索。
    const tts = await readFile('src-tauri/src/tts.rs', 'utf8');
    // 找不到本地引擎时要告诉用户装什么
    assert.match(tts, /apt install espeak-ng/, 'the no-engine error must still say how to fix it');

    const localMt = await readFile('src-tauri/src/local_mt.rs', 'utf8');
    // 模型未下载时要告诉用户去哪里下载
    assert.match(
        localMt,
        /Settings -> Translation Services/,
        'the model-missing error must still point users at the settings page'
    );
    // SHA256 校验失败要保留「镜像可能被篡改」这一判断
    assert.match(localMt, /mirror may be tampered/, 'the checksum error must still explain the likely cause');
});
