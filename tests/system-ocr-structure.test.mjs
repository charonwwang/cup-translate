import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const OCR = 'src-tauri/src/system_ocr.rs';

// system_ocr.rs 为三个平台各提供一份 `system_ocr`，用 `#[cfg(target_os = ...)]` 区分。
// 这里只做**结构断言**：本机只装了 macOS target，另两份无法编译验证，
// 但可以保证它们的 cfg 门、函数数量与关键分支没有在重构中被破坏。
const source = await readFile(OCR, 'utf8');

test('system_ocr.rs defines exactly one system_ocr per platform', () => {
    const impls = source.match(/#\[cfg\(target_os = "(windows|macos|linux)"\)\]\s*\npub fn system_ocr/g);
    assert.equal(impls?.length, 3, `expected 3 platform impls, found ${impls?.length ?? 0}`);
    for (const os of ['windows', 'macos', 'linux']) {
        assert.match(
            source,
            new RegExp(`#\\[cfg\\(target_os = "${os}"\\)\\]\\s*\\npub fn system_ocr`),
            `missing the ${os} implementation`
        );
    }
});

test('helper functions live at module level, not nested inside another fn', () => {
    // 曾经把 ensure_executable / chmod_executable 连同文档注释塞进 system_ocr 函数体内，
    // 缩进也因此错乱（文档注释缩进、函数体顶格）。虽然能编译，但极易误读。
    // 这里要求：顶层声明必须顶格，且文档注释也必须顶格。
    const lines = source.split('\n');
    // `#[cfg(test)] mod tests { ... }` 里的 fn 与文档注释**本来就该缩进**，
    // 不属于本断言要防的「把 helper 嵌进 system_ocr」。从测试模块起跳过。
    const testModAt = lines.findIndex((l) => /^#\[cfg\(test\)\]/.test(l));
    const scanEnd = testModAt === -1 ? lines.length : testModAt;
    const badIndentedDecls = [];
    lines.slice(0, scanEnd).forEach((line, i) => {
        // 顶层声明与文档注释在 Rust 里一律顶格（column 0）。
        //
        // 修复前的判据是 `/^\s+.../ && !/^\s{4,}/`，即「缩进 1-3 空格」才算违规——
        // 而函数体内嵌套的真实缩进是 4 的倍数，永远落在被排除的区间里，
        // 于是这条断言对「把 helper 嵌进 system_ocr」（正是它要防的历史缺陷）
        // **恒真且不报警**。实测：在 system_ocr 函数体内插入一个 4 空格缩进的
        // `fn nested_helper()`，5 条测试全绿。
        // 现在改成「行首只要有空白就不该是声明」。
        if (/^\s+(fn |pub fn |#\[cfg\(|#\[tauri::command)/.test(line)) {
            badIndentedDecls.push(`${i + 1}: ${line}`);
        }
        // 文档注释若缩进，说明它被写进了某个函数体
        if (/^\s+\/\/\//.test(line)) {
            badIndentedDecls.push(`${i + 1} (indented doc comment): ${line}`);
        }
    });
    assert.deepEqual(badIndentedDecls, [], 'declarations/doc comments must be at column 0');
    // 反向自检：确认确实扫到了非测试部分，避免 findIndex 出错导致整条断言空转
    assert.ok(scanEnd > 100, `guard should scan the real implementation, got ${scanEnd} lines`);
});

test('macOS impl still chmods the bundled binary before running it', () => {
    // 随包二进制的仓库权限是 0644，不 chmod 会直接 Permission denied
    assert.match(source, /ensure_executable\(&bin_path\)\?;/, 'must call ensure_executable');
    assert.match(source, /resolve_resource\(format!\("resources\/ocr-\{arch\}-apple-darwin"\)\)/);
    // 且必须缓存：每次调用都 spawn chmod 是无谓开销
    assert.match(source, /OnceLock<Mutex<HashSet<std::path::PathBuf>>>/, 'chmod must be cached');
    assert.match(source, /if guard\.contains\(bin_path\)/, 'must skip an already-fixed path');
});

test('linux impl keeps the actionable tesseract diagnostics', () => {
    // Linux 是项目首要目标平台，但本机无 Linux target 无法编译验证——至少锁住提示语
    assert.match(source, /Command::new\("tesseract"\)/, 'must invoke tesseract');
    assert.match(source, /Tesseract not installed!/, 'must tell the user tesseract is missing');
    assert.match(source, /Language data not installed!/, 'must explain missing language data');
    assert.match(source, /tesseract-ocr-\{lang\}/, 'must name the package to install');
});

test('each platform impl reads the screenshot from the cache dir', () => {
    // 三个实现都必须指向截图组件写出的同一路径，否则识别必然拿到旧图或失败
    const occurrences = source.match(/pot_screenshot_cut\.png/g);
    assert.equal(occurrences?.length, 3, 'all three platforms must use the same screenshot path');
});

// ── 本轮新增：macOS 分支「静默成功」的两条护栏 ──
//
// 背景（实测）：随包二进制 `ocr-aarch64-apple-darwin` 在**出错时也返回 exit=0
// 且 stderr 为空**。实测三条命令：
//     /tmp/ocrprobe /tmp/nonexistent.png en-US -> exit=0, stdout 空, stderr 空
//     /tmp/ocrprobe /tmp/blank.png       en-US -> exit=0, stdout 空, stderr 空
//     /tmp/ocrprobe /tmp/ocrtest_zh.png  zh-Hans -> exit=0, "你好世界\n"
// 前两条**完全无法区分**，而修复前只按退出码判断，于是「文件不存在」被报成
// `Ok("")`；前端拿到空串后 `setText('')`，界面一片空白且**没有任何错误提示**。
//
// 这两条断言只能放在源码层：macOS 的 `system_ocr` 需要真实 `AppHandle`
// 与真实二进制，无法单测。纯函数 `interpret_ocr_output` 的行为由
// `src-tauri/src/system_ocr.rs` 的 6 条 Rust 单测覆盖。

test('macOS impl checks the screenshot exists before trusting an empty exit-0 result', () => {
    // 存在性检查必须在 spawn **之前**，否则又回到「exit=0 就当作成功」
    const existsCheck = source.indexOf('if !app_cache_dir_path.exists()');
    const spawn = source.indexOf('std::process::Command::new(bin_path)');
    assert.notEqual(existsCheck, -1, 'macOS impl must check the screenshot exists before running the binary');
    assert.notEqual(spawn, -1, 'macOS impl must still spawn the bundled binary');
    assert.ok(
        existsCheck < spawn,
        'the existence check must come before spawning, otherwise it cannot disambiguate an empty result'
    );
    // 且必须给出可读的英文错误（服务层约定见 CLAUDE.md：throw 文案统一英文）
    assert.match(source, /Screenshot file not found/, 'must report a missing screenshot in plain words');
});

test('OCR output decoding never silently collapses to an empty string', () => {
    // 修复前是 `String::from_utf8(..).unwrap_or_default()`：非法 UTF-8
    // 会让**整段**结果静默变成空串（等于识别成功却没有文字）。
    // 已改为 lossy 解码，非法字节替换成 U+FFFD 而不是丢弃整段。
    //
    // ⚠️ 必须先剥掉注释、再切掉 `#[cfg(test)] mod tests`，然后才扫：
    //   · 文件里（含 Rust 测试模块的说明）会**提到**那个旧写法，不剥注释就会
    //     误报成「旧写法还在」——本会话反复出现的「注释里提到就算命中」陷阱；
    //   · Rust 测试模块里有一条**对照**断言，故意调用旧写法来固定「它确实会
    //     得到空串」这一事实，那不是生产代码，必须排除。
    // 两处都排除后，剩下的才是真正会被执行的实现。
    const code = source
        .replace(/^\s*\/\/\/.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split(/#\[cfg\(test\)\]/)[0];
    assert.doesNotMatch(
        code,
        // 注意要允许 from_utf8(...) 的参数里再嵌套一层括号：
        // `String::from_utf8(stdout.to_vec()).unwrap_or_default()` 是本轮
        // 变异测试真实用到的写法，早先的 `[^)]*` 匹配不到它 —— 变异因此逃逸。
        /String::from_utf8\((?:[^()]|\([^()]*\))*\)\s*\.\s*unwrap_or_default\(\)/,
        'silent unwrap_or_default() drops a whole result on invalid UTF-8'
    );
    assert.match(code, /String::from_utf8_lossy\(/, 'must decode lossily');
    // 成功/失败都必须走同一个解释函数，避免有人又写出按退出码分支的第三份逻辑
    assert.match(
        code,
        /interpret_ocr_output\(output\.status\.success\(\), &output\.stdout, &output\.stderr\)/,
        'macOS impl must delegate to interpret_ocr_output'
    );
    // Linux 分支同样不能再吞掉错误文本（否则下面的 contains("data") 必然落空）
    assert.match(
        code,
        /let content = String::from_utf8_lossy\(&output\.stderr\)\.into_owned\(\);/,
        'linux impl must decode stderr lossily too'
    );
    // 反向自检：确认剥注释 + 切测试模块后仍有实质内容，避免「把文件扫空了却全绿」
    assert.ok(code.length > 2500, `stripped source looks too small: ${code.length} bytes`);
    assert.match(code, /pub fn system_ocr/, 'the stripped view must still contain real code');
});
