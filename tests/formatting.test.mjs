import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import prettier from 'prettier';

/**
 * 格式回归护栏。
 *
 * 背景：CLAUDE.md §5.1 规定前端由 prettier 强制（4 空格缩进、单引号、
 * 行宽 120、分号必需），但仓库里曾有 11 个 src 文件不符合该配置，
 * 且 CI 只跑 pnpm test + pnpm build，没有任何 prettier 检查——
 * 于是格式会持续无声漂移（新代码照抄旁边不合规的写法，越传越广）。
 *
 * 这里把「src 下所有 js/jsx 都符合项目 prettier 配置」变成一条会自动跑的测试。
 */

async function collectSourceFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectSourceFiles(path)));
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
            files.push(path);
        }
    }
    return files;
}

test('every frontend source file matches the project prettier config', async () => {
    const config = await prettier.resolveConfig('src/App.jsx');
    assert.ok(config, 'a prettier config must exist for src/');

    const files = await collectSourceFiles('src');
    assert.ok(files.length > 50, `expected to find the frontend sources, got ${files.length}`);

    const unformatted = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        const options = { ...config, filepath: file };
        if (!(await prettier.check(source, options))) {
            unformatted.push(file);
        }
    }

    assert.deepEqual(
        unformatted,
        [],
        `these files are not prettier-formatted (run: npx prettier --write <file>):\n  ${unformatted.join('\n  ')}`
    );
});

test('the prettier config still enforces the documented style rules', async () => {
    // 把 CLAUDE.md §5.1 的约定钉在测试里：若有人放宽这些规则，
    // 本测试会失败，从而必须同步更新文档而不是悄悄改掉。
    const config = await prettier.resolveConfig('src/App.jsx');

    assert.equal(config.tabWidth, 4, 'indentation must be 4 spaces');
    assert.equal(config.singleQuote, true, 'strings must use single quotes');
    assert.equal(config.printWidth, 120, 'line width must be 120');
    assert.equal(config.semi, true, 'semicolons are required');
    assert.equal(config.singleAttributePerLine, true, 'JSX attributes must be one per line');
});
