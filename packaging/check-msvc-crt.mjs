import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('Run the MSVC link regression on Windows');
const config = await readFile('.cargo/config.toml', 'utf8');
const configured = config.match(/^CMAKE_MSVC_RUNTIME_LIBRARY = \{ value = "([^"]+)"/m)?.[1];
const runtime = process.env.CMAKE_MSVC_RUNTIME_LIBRARY || configured;
const build = await mkdtemp(join(tmpdir(), 'cup-crt-contract-'));
function run(program, args) {
    const result = spawnSync(program, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} exited ${result.status}`);
}
try {
    // Match cmake-rs .static_crt(true): it supplies /MT as a compiler flag.
    // CMP0091's target default can still override it unless the property is set.
    const configure = (directory, selectedRuntime) => {
        const args = ['-S', resolve('packaging/msvc-crt-smoke'), '-B', directory, '-A', 'x64', '-DCMAKE_CXX_FLAGS=/MT'];
        if (selectedRuntime) args.push(`-DCMAKE_MSVC_RUNTIME_LIBRARY=${selectedRuntime}`);
        run('cmake', args);
    };
    if (process.argv.includes('--verify-regression')) {
        const baseline = join(build, 'baseline');
        configure(baseline, undefined);
        const result = spawnSync('cmake', ['--build', baseline, '--config', 'Release'], { encoding: 'utf8' });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (result.error || result.status === 0 || !/LNK2038|LNK2005/.test(output))
            throw new Error(`The original CRT mismatch was not reproduced: ${output}`);
        console.log('Original configuration reproduced the expected MSVC CRT link mismatch.');
    }
    const fixed = join(build, 'fixed');
    configure(fixed, runtime);
    run('cmake', ['--build', fixed, '--config', 'Release']);
    run(join(fixed, 'Release', 'crt_contract.exe'), []);
    console.log(`MSVC C++ link regression passed (${runtime || 'default runtime'})`);
} finally {
    await rm(build, { recursive: true, force: true });
}
