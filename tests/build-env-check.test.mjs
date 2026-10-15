import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const script = 'scripts/check-linux-build-env.sh';

/**
 * 背景：`scripts/check-linux-build-env.sh` 是 CLAUDE.md §9 要求的第一步
 * （「接到任务后建议顺序：1. bash scripts/check-linux-build-env.sh」）。
 *
 * 但它原本**没有任何平台判断**，§2/§3 检查的是 Linux 专有的 WebKitGTK 兼容层
 * （CLAUDE.md §2 坑 2 / docs/BUILD.md §3.2）。于是任何人在 macOS 上按文档
 * 第一步执行，都会看到「10 项通过，13 项失败」并 exit 1——而这些缺项在当前
 * 平台上根本无法修复，也不影响构建，纯属误导。
 *
 * 下面把「非 Linux 平台不把 Linux 专项检查判为失败」钉成回归护栏。
 */

async function runScript() {
    try {
        const { stdout } = await run('bash', [script]);
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.code ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
    }
}

const isLinux = process.platform === 'linux';

test('the env check skips Linux-only sections instead of failing them off-Linux', async () => {
    const source = await readFile(script, 'utf8');

    // 必须有平台判断，且 §2/§3 受它控制
    assert.match(source, /uname\s+-s/, 'the script must detect the host platform');
    const section2 = source.slice(source.indexOf('== 2. pkg-config'));
    const section3 = source.slice(source.indexOf('== 3. 链接库'));
    assert.match(section2.slice(0, 400), /is_linux/, 'the pkg-config section must be gated on Linux');
    assert.match(section3.slice(0, 400), /is_linux/, 'the linkage section must be gated on Linux');
});

test('off-Linux the script does not blame the host for missing Linux libraries', async () => {
    if (isLinux) {
        // 在 Linux 上这些检查本就应当真实执行，不适用的断言直接跳过
        return;
    }

    const { stdout } = await runScript();

    // 关键的误导性输出不该再出现：不能说「缺 webkit2gtk 请去修」
    assert.doesNotMatch(
        stdout,
        /✗.*webkit2gtk/,
        'off-Linux the script must not report webkit2gtk as a missing requirement to fix'
    );
    assert.match(stdout, /跳过/, 'off-Linux the Linux-only checks should be reported as skipped');
});

test('off-Linux the script exits 0 when no cross-platform check fails', async () => {
    if (isLinux) {
        return;
    }

    const { code, stdout } = await runScript();

    // 本机（macOS）跨平台项确实全部通过：cargo/rustc/node/pnpm/cc/cmake、
    // wry 版本、pnpm 放行、品牌与上游隔离。若将来某项真的坏了，这条会失败——
    // 那正是我们想要的信号。
    assert.equal(code, 0, `the env check should succeed off-Linux, got exit ${code}:\n${stdout}`);
    assert.doesNotMatch(stdout, /✗/, `no check should fail off-Linux:\n${stdout}`);
});

test('the script reports which platform it checked', async () => {
    const source = await readFile(script, 'utf8');
    // 结尾必须说明「本平台的构建环境是否真的被覆盖」，避免读者误以为
    // macOS 上通过就等于 Linux 构建环境也没问题
    assert.match(source, /未被本脚本检查|全部/, 'the summary must state the platform coverage');
});

test('the script is syntactically valid bash', async () => {
    await run('bash', ['-n', script]);
});
