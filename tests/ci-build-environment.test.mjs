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

test('unsupported native-model platforms retain IPC commands without compiling the unsupported CTranslate2 backend', async () => {
    const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
    const main = await readFile('src-tauri/src/main.rs', 'utf8');
    const stub = await readFile('src-tauri/src/local_mt_unsupported.rs', 'utf8');
    assert.match(
        cargo,
        /\[target\.'cfg\(any\(target_arch = "x86_64", all\(target_arch = "aarch64", not\(windows\)\)\)\)'\.dependencies\]\s*ct2rs/
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

test('Linux build selects a Node runtime executable on its native host', async () => {
    const source = await readFile('.github/actions/build-for-linux/entrypoint.sh', 'utf8');
    const selection = source.slice(source.indexOf('case "$(uname -m)"'), source.indexOf('wget '));
    for (const [host, expected] of [
        ['x86_64', 'x64'],
        ['aarch64', 'arm64'],
        ['arm64', 'arm64'],
    ]) {
        const result = spawnSync(
            'bash',
            [
                '-c',
                `uname() { echo "$BUILD_TEST_HOST"; }; ${selection}
echo "$node_arch"`,
            ],
            {
                encoding: 'utf8',
                env: { ...process.env, BUILD_TEST_HOST: host },
            }
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), expected);
    }
    const unsupported = spawnSync('bash', ['-c', `uname() { echo unsupported; }; ${selection}`]);
    assert.notEqual(unsupported.status, 0);
    assert.match(source, /file clang libclang-dev/);
});

test('release builds native ARM64 Linux tools and uses consistent Windows CRT', async () => {
    const workflow = await readFile('.github/workflows/release-desktop.yml', 'utf8');
    assert.match(workflow, /target: aarch64-unknown-linux-gnu\s+arch: arm64\s+os: ubuntu-24.04-arm/);
    assert.match(workflow, /ESPEAK_STATIC_CRT: '1'/);
    assert.match(workflow, /Run native Windows Rust regression tests/);
    assert.match(workflow, /needs: \[macos, windows, linux\]/);
});

test('eSpeak host and target tools can compile phonemes under long CI paths', async () => {
    const cargo = await readFile('.cargo/config.toml', 'utf8');
    assert.match(cargo, /\[env\]\s+CFLAGS = \{ value = "-DN_PATH_HOME=4096", force = false \}/);
    const failingPath =
        '/Users/runner/work/cup-translate/cup-translate/src-tauri/target/aarch64-apple-darwin/release/build/espeak-rs-sys-3ece65f6d5c6cc44/out/build/espeak-ng-data/../phsource/r3/r_trill_short';
    assert.ok(failingPath.length > 160 + 20);
    assert.ok(failingPath.length < 4096);
});

test('macOS compilation and installer metadata allow the C++ filesystem dependency', async () => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    assert.equal(config.tauri.bundle.macOS.minimumSystemVersion, '10.15');
    const workflow = await readFile('.github/workflows/release-desktop.yml', 'utf8');
    assert.match(workflow, /MACOSX_DEPLOYMENT_TARGET: '10.15'/);
});

test('all embedded MSVC engines use the same static runtime as CTranslate2', async () => {
    const cargo = await readFile('.cargo/config.toml', 'utf8');
    assert.match(cargo, /target-feature=\+crt-static/);
    for (const engine of ['LLAMA', 'ESPEAK']) {
        assert.ok(cargo.includes(`${engine}_STATIC_CRT = { value = "1", force = false }`));
    }
});

test('modern CMake targets explicitly select MT before the full release build starts', async () => {
    const config = await readFile('.cargo/config.toml', 'utf8');
    assert.match(config, /CMAKE_MSVC_RUNTIME_LIBRARY = \{ value = "MultiThreaded", force = false \}/);
    const workflow = await readFile('.github/workflows/release-desktop.yml', 'utf8');
    assert.equal((workflow.match(/needs: \[preflight, windows-runtime\]/g) || []).length, 3);
    assert.match(workflow, /node packaging\/check-msvc-crt\.mjs/);
    const cmake = await readFile('packaging/msvc-crt-smoke/CMakeLists.txt', 'utf8');
    assert.match(cmake, /MSVC_RUNTIME_LIBRARY MultiThreaded/);
    assert.match(cmake, /target_link_libraries\(crt_contract PRIVATE model_candidate\)/);
});
