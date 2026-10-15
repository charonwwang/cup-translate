import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

/**
 * 所有会发 HTTP 请求的前端文件都必须走 `fetchWithTimeout`。
 *
 * 背景（本轮实测）：`@tauri-apps/api/http` 的 `fetch` **不会自动超时**。
 * 网络卡死或服务端挂起时，请求会无限等待，界面永久停在 loading——
 * 用户既等不到结果，也等不到错误。
 *
 * 项目已经有 `src/utils/fetchWithTimeout.js`（默认 30 秒）来兜这件事，
 * 33 个文件都用了它，但**漏了 2 个**：
 *   · services/translate/chatglm/index.jsx —— 用裸全局 fetch，
 *     且它是 19 个翻译引擎里唯一漏掉的
 *   · window/Recognize/ControlArea/index.jsx —— 直接 import 裸
 *     `@tauri-apps/api/http` 的 fetch
 * 两者都在正常使用路径上，不是死代码。
 *
 * 这类问题不会被构建或类型检查发现（`fetch` 两种写法都合法），
 * 所以需要断言。
 */

/** 允许直接 import 裸 http fetch 的例外，附理由。 */
const ALLOWED_RAW_IMPORTS = [
    {
        file: 'src/utils/fetchWithTimeout.js',
        reason: 'this IS the wrapper; it must import the raw fetch',
    },
];

/** 递归收集 src/ 下所有 js/jsx 文件 */
async function collectSources(dir = 'src') {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...(await collectSources(full)));
        else if (/\.jsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

test('no source file imports the raw Tauri http fetch', async () => {
    const offenders = [];
    for (const file of await collectSources()) {
        const source = await readFile(file, 'utf8');
        // 直接 import 裸 fetch（如 `import { fetch, Body } from '@tauri-apps/api/http'`）
        if (/import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*'@tauri-apps\/api\/http'/.test(source)) {
            if (ALLOWED_RAW_IMPORTS.some((a) => a.file === file)) continue;
            offenders.push(`${file}: imports the raw fetch from @tauri-apps/api/http`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        'these files bypass fetchWithTimeout, so their requests can hang forever:\n' + offenders.join('\n')
    );
});

test('every file that calls fetch() imports the timeout wrapper', async () => {
    // 比上一条更宽：即使没显式 import 裸 fetch，用了全局 fetch 也一样危险。
    const offenders = [];
    for (const file of await collectSources()) {
        const source = await readFile(file, 'utf8');
        // 去掉注释，避免注释里的 "fetch(" 误报
        const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const callsFetch = /\bawait\s+fetch\(|\bfetch\(\s*[`'"]/.test(code);
        if (!callsFetch) continue;
        // 必须检查**真实的 import 语句**，而不是「文件里是否出现这个词」——
        // 后者会被一条恰好提到 fetchWithTimeout 的注释骗过
        //（我第一版的探针变异就是这样逃逸的，已据此收紧了判定）。
        if (
            /import\s*\{[^}]*\b(fetchWithTimeout\s+as\s+fetch|fetchWithTimeout)\b[^}]*\}\s*from\s*'[^']*fetchWithTimeout'/.test(
                code
            )
        ) {
            continue;
        }
        // 明确不打算请求网络的除外（例如把 fetch 当参数传进来的测试替身）
        offenders.push(`${file}: calls fetch() but never imports fetchWithTimeout`);
    }
    assert.deepEqual(offenders, [], 'these files call fetch() without the timeout wrapper:\n' + offenders.join('\n'));
});

test('the timeout wrapper actually applies a default timeout', async () => {
    // 行为测试：直接跑真实实现，注入一个假的 tauriFetch。
    // 注意 fetchWithTimeout 的 `...options` 在 `timeout` **之后**展开，
    // 所以调用方传入的 timeout 会覆盖默认值——这是有意的（允许按需放宽），
    // 但必须真的存在一个默认值，否则「统一加超时」就是空话。
    const source = await readFile('src/utils/fetchWithTimeout.js', 'utf8');
    assert.match(source, /DEFAULT_TIMEOUT_SECONDS\s*=\s*\d+/, 'there must be a numeric default timeout');

    const seconds = Number(/DEFAULT_TIMEOUT_SECONDS\s*=\s*(\d+)/.exec(source)[1]);
    assert.ok(seconds > 0 && seconds <= 120, `default timeout should be sane, got ${seconds}s`);

    // 真实执行：把 tauriFetch 换掉，断言 timeout 被传下去
    const calls = [];
    // 去掉所有 import / re-export 语句，得到可直接 new Function 的函数体。
    // 逐行过滤比正则替换更稳：`export { Body, ResponseType } from '...'`
    // 与 `import { fetch as tauriFetch } from '...'` 形态不同，
    // 容易只替换掉其中一个而漏掉另一个（第一版就是这么 SyntaxError 的）。
    const stripped = source
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            if (t.startsWith('import ')) return false;
            // re-export：`export { ... } from '...'`
            if (/^export\s*\{[^}]*\}\s*from\s*['"]/.test(t)) return false;
            return true;
        })
        .join('\n')
        // `export const` / `export async function` 去掉 export 关键字即可
        .replace(/^export\s+/gm, '');
    const factory = new Function('tauriFetch', `${stripped}\nreturn { fetchWithTimeout, DEFAULT_TIMEOUT_SECONDS };`);
    const { fetchWithTimeout, DEFAULT_TIMEOUT_SECONDS: exported } = factory(async (url, options) => {
        calls.push({ url, options });
        return { ok: true };
    });

    assert.equal(exported, seconds, 'the exported constant must match the parsed one');
    await fetchWithTimeout('https://example.com/api', { method: 'GET' });
    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].options.timeout,
        seconds,
        'the default timeout must be applied when the caller does not specify one'
    );
    assert.equal(calls[0].options.method, 'GET', 'caller options must still be forwarded');

    // 调用方显式指定的 timeout 应当生效（覆盖默认）
    await fetchWithTimeout('https://example.com/slow', { timeout: 5 });
    assert.equal(calls[1].options.timeout, 5, 'an explicit timeout must win');
});

test('the two previously-missing files now use the wrapper', async () => {
    // 回归护栏：这两个是实测会永久卡住的调用点。
    for (const file of ['src/services/translate/chatglm/index.jsx', 'src/window/Recognize/ControlArea/index.jsx']) {
        const source = await readFile(file, 'utf8');
        assert.match(
            source,
            /from\s*'[^']*utils\/fetchWithTimeout'/,
            `${file} must import from utils/fetchWithTimeout`
        );
    }
});
