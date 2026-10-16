import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Windows build dependency includes the corrected Win32 constant types', async () => {
    const lock = await readFile('src-tauri/Cargo.lock', 'utf8');
    const version = lock.match(/name = "find-msvc-tools"\nversion = "([^"]+)"/)[1];
    assert.equal(version, '0.1.14', '0.1.13 exposes FILE_ATTRIBUTE_TEMPORARY as i32 and breaks cc on Windows');
});

test('Linux build refreshes package indexes strictly and installs native CMake dependencies', async () => {
    const dockerfile = await readFile('.github/actions/build-for-linux/Dockerfile', 'utf8');
    const entrypoint = await readFile('.github/actions/build-for-linux/entrypoint.sh', 'utf8');
    assert.match(dockerfile, /FROM rust:bookworm/);
    assert.match(entrypoint, /APT::Update::Error-Mode=any/);
    assert.match(entrypoint, /cmake pkg-config file/);
    for (const script of ['.github/actions/build-for-linux/entrypoint.sh', '.github/actions/build.sh']) {
        const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
});

test('desktop verification builds installers without granting publication permissions or signing secrets', async () => {
    const workflow = await readFile('.github/workflows/build-desktop.yml', 'utf8');
    assert.match(workflow, /contents: read/);
    assert.doesNotMatch(workflow, /contents: write|secrets\.|action-gh-release/);
    for (const target of [
        'x86_64-pc-windows-msvc',
        'i686-pc-windows-msvc',
        'aarch64-pc-windows-msvc',
        'x86_64-unknown-linux-gnu',
        'i686-unknown-linux-gnu',
        'aarch64-unknown-linux-gnu',
        'armv7-unknown-linux-gnueabihf',
    ])
        assert.ok(workflow.includes(target));
});

test('legacy 32-bit clients retain IPC commands without compiling the unsupported CTranslate2 backend', async () => {
    const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
    const main = await readFile('src-tauri/src/main.rs', 'utf8');
    const stub = await readFile('src-tauri/src/local_mt_unsupported.rs', 'utf8');
    assert.match(
        cargo,
        /\[target\.'cfg\(any\(target_arch = "x86_64", target_arch = "aarch64"\)\)'\.dependencies\]\s*ct2rs/
    );
    assert.match(main, /path = "local_mt_unsupported.rs"/);
    for (const name of [
        'local_mt_model_status',
        'local_mt_download_model',
        'local_mt_delete_model',
        'local_mt_unload_model',
        'local_mt_translate',
    ])
        assert.ok(stub.includes(`pub async fn ${name}`));
    assert.match(stub, /"supported":false/);
    assert.match(stub, /Err\(UNSUPPORTED.into\(\)\)/);
});
