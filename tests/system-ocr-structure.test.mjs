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
    const badIndentedDecls = [];
    lines.forEach((line, i) => {
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
