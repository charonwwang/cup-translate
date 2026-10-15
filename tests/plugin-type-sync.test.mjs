import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validPluginType } from '../src/utils/plugin_validation.js';

// 插件类型白名单在**两个语言里各写了一遍**：
//   src/utils/plugin_validation.js  const PLUGIN_TYPES  = [...]
//   src-tauri/src/cmd.rs            const PLUGIN_TYPES: &[&str] = &[...]
//
// 两侧不一致的后果是**静默的**：
//   · 前端多一个 -> 界面能选、后端 `valid_plugin_type` 拒绝，装插件报错
//   · 后端多一个 -> 该类型插件永远无法通过前端校验加载
// 此前没有任何护栏守着这件事（原有测试逐个硬编码四个类型，
// 只能发现「少了一个」，发现不了「多了一个」）。
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRepoFile(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function parseList(source, pattern, quote, label) {
    const match = pattern.exec(source);
    assert.ok(match, `could not find ${label} — has it been renamed or moved?`);
    return [...match[1].matchAll(new RegExp(`${quote}([^${quote}]+)${quote}`, 'g'))].map((m) => m[1]);
}

test('the frontend and Rust plugin-type whitelists are identical', () => {
    const jsList = parseList(
        readRepoFile('src/utils/plugin_validation.js'),
        /PLUGIN_TYPES\s*=\s*\[([^\]]*)\]/,
        "'",
        'PLUGIN_TYPES in plugin_validation.js'
    );
    const rustList = parseList(
        readRepoFile('src-tauri/src/cmd.rs'),
        /PLUGIN_TYPES:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/,
        '"',
        'PLUGIN_TYPES in cmd.rs'
    );

    // 顺序也要求一致：便于人工比对，且顺序本身是无害的强约束
    assert.deepEqual(
        jsList,
        rustList,
        'the two whitelists must stay in sync — an extra entry on either side silently breaks plugin loading'
    );
    // 非空，避免正则匹配到空数组时"假通过"
    assert.ok(jsList.length >= 4, 'the whitelist must not be empty or truncated');
});

test('every whitelisted type is actually accepted by validPluginType', () => {
    // 与上面互补：护栏比较的是**文本**，这里确认文本与运行时行为一致
    // （防止有人把列表改了却忘了让它参与判断）。
    for (const type of ['recognize', 'translate', 'tts', 'collection']) {
        assert.equal(validPluginType(type), true, `${type} must be accepted`);
    }
    // 白名单之外的一律拒绝
    for (const type of ['plugin', 'Translate', 'TRANSLATE', 'unknown', '', '../translate']) {
        assert.equal(validPluginType(type), false, `${type} must be rejected`);
    }
});

test('PLUGIN_TYPES is not exported without a consumer', () => {
    // round 49 的教训：导出但无人 import 会触发「no module exports a function
    // that nothing imports」这类护栏，也是无谓的公共 API。
    // 这里确认它保持模块内私有——若将来确实需要导出，请同时给它一个消费者。
    const source = readRepoFile('src/utils/plugin_validation.js');
    assert.ok(
        !/export\s+const\s+PLUGIN_TYPES/.test(source),
        'PLUGIN_TYPES must stay private until something imports it'
    );
});
