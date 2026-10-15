import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { clipboardFailureMessage, writeClipboardSafely } from '../src/utils/clipboard.js';

// ---------------------------------------------------------------------------
// 行为测试：直接执行真实实现（注入 writer，不依赖 Tauri 运行时）
// ---------------------------------------------------------------------------

test('a successful clipboard write invokes onSuccess and reports true', async () => {
    const calls = [];
    const ok = await writeClipboardSafely('hello', {
        writer: async (text) => calls.push(text),
        onSuccess: () => calls.push('success'),
        onError: (e) => calls.push(`error:${e}`),
    });

    assert.equal(ok, true);
    assert.deepEqual(calls, ['hello', 'success']);
});

test('a failing clipboard write is reported instead of throwing', async () => {
    // 缺陷背景：调用点用 `writeText(v).then(...)` 且无 .catch，
    // 写入失败时既没有提示、又留下未处理的 rejection。
    const boom = new Error('clipboard busy');
    const seen = [];

    const ok = await writeClipboardSafely('hello', {
        writer: async () => {
            throw boom;
        },
        onSuccess: () => seen.push('success'),
        onError: (e) => seen.push(e),
    });

    assert.equal(ok, false, 'a failed write must report failure');
    assert.deepEqual(seen, [boom], 'onError must receive the underlying error');
    // 关键：不得把 rejection 抛给调用方
});

test('a failed write never calls onSuccess', async () => {
    let successCalled = false;
    await writeClipboardSafely('x', {
        writer: async () => {
            throw new Error('nope');
        },
        onSuccess: () => {
            successCalled = true;
        },
        onError: () => {},
    });
    assert.equal(successCalled, false, 'must not claim success when the write failed');
});

test('an error without a writer still resolves rather than rejecting', async () => {
    // 不传 onError 也不能让异常逃逸
    const ok = await writeClipboardSafely('x', {
        writer: async () => {
            throw new Error('silent');
        },
    });
    assert.equal(ok, false);
});

test('failure message includes the underlying reason', () => {
    assert.match(
        clipboardFailureMessage(new Error('clipboard busy'), (k) => k),
        /clipboard busy/
    );
    assert.match(
        clipboardFailureMessage('plain string reason', (k) => k),
        /plain string reason/
    );
});

test('the failure message goes through the translation function', () => {
    // 修复前这里**硬编码简体中文**（`复制到剪贴板失败：…`），
    // 而用到它的两个窗口都是完整本地化的，于是英文界面下会弹出一句中文。
    // 现在前缀必须由 t() 提供，且传入的 key 必须真实存在。
    const seen = [];
    const t = (key) => {
        seen.push(key);
        return 'TRANSLATED';
    };
    const message = clipboardFailureMessage(new Error('busy'), t);
    assert.deepEqual(seen, ['common.clipboard_failed'], 'must translate exactly one key');
    assert.equal(message, 'TRANSLATED: busy');
});

test('no user-visible clipboard message falls back to hardcoded Chinese', () => {
    // 反向护栏：即使没有传 t，也**绝不能**退回中文——
    // 项目的默认/回退语言是英文（CLAUDE.md §4.2）。
    const message = clipboardFailureMessage(new Error('busy'));
    assert.ok(!/[\u4e00-\u9fff]/.test(message), `the no-t fallback must be English, got ${JSON.stringify(message)}`);
    assert.match(message, /busy/);
});

test('every clipboard failure call site passes t so the text is localizable', async () => {
    // 行为测试只证明「传了 t 就能本地化」，不证明调用点真的传了。
    // 这条扫描真实调用点（round 34 的教训：测纯函数 ≠ 测接线）。
    const targets = ['src/window/Recognize/TextArea/index.jsx', 'src/window/Translate/components/SourceArea/index.jsx'];
    for (const file of targets) {
        const source = await readFile(file, 'utf8');
        const call = /clipboardFailureMessage\(([^)]*)\)/.exec(source);
        assert.ok(call, `${file} should call clipboardFailureMessage`);
        assert.match(call[1], /,\s*t\s*$/, `${file} must pass t as the second argument, got (${call[1]})`);
    }
});

test('the clipboard_failed key exists in both baseline locales', async () => {
    for (const locale of ['en_US', 'zh_CN']) {
        const parsed = JSON.parse(await readFile(`src/i18n/locales/${locale}.json`, 'utf8'));
        // 记得剥掉 i18next 的 translation 外壳（CLAUDE.md §4.2）
        const value = parsed?.translation?.common?.clipboard_failed;
        assert.equal(typeof value, 'string', `${locale}.json is missing common.clipboard_failed`);
        assert.ok(value.trim() !== '', `${locale}.json has an empty clipboard_failed`);
        assert.notEqual(value, 'clipboard_failed', `${locale}.json just repeats the key`);
    }
    // 两个基准文件必须是**不同**的文案，否则等于没翻译
    const en = JSON.parse(await readFile('src/i18n/locales/en_US.json', 'utf8'));
    const zh = JSON.parse(await readFile('src/i18n/locales/zh_CN.json', 'utf8'));
    assert.notEqual(
        en.translation.common.clipboard_failed,
        zh.translation.common.clipboard_failed,
        'en_US and zh_CN must not share the same clipboard_failed text'
    );
});

// ---------------------------------------------------------------------------
// 源码护栏：所有 writeText 调用点都必须走安全封装
// ---------------------------------------------------------------------------

async function collectSourceFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectSourceFiles(path)));
        } else if (entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) {
            files.push(path);
        }
    }
    return files;
}

test('no call site uses raw writeText without handling failure', async () => {
    // 回归护栏：修复前 10 处调用全是 `writeText(...).then(...)`，无一处理失败。
    // 允许的用法只有经由 writeClipboardSafely 的封装。
    const files = await collectSourceFiles('src');
    const offenders = [];

    for (const file of files) {
        if (file.endsWith(join('utils', 'clipboard.js'))) continue; // 封装自身除外
        const source = await readFile(file, 'utf8');
        if (!/\bwriteText\s*\(/.test(source)) continue;
        // 直接 import writeText 并调用即为违规
        if (/import\s*\{[^}]*\bwriteText\b[^}]*\}\s*from\s*'@tauri-apps\/api\/clipboard'/.test(source)) {
            offenders.push(file);
        }
    }

    assert.deepEqual(offenders, [], `these files call raw writeText and ignore failures: ${offenders.join(', ')}`);
});

test('the clipboard helper is actually used by the translate target area', async () => {
    const source = await readFile('src/window/Translate/components/TargetArea/index.jsx', 'utf8');
    assert.match(source, /writeClipboardSafely/, 'TargetArea auto-copy must go through the failure-aware helper');
});
