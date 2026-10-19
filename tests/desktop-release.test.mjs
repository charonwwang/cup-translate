import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { desktopManifest } from '../updater/release-manifest.mjs';

function signer() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const id = randomBytes(8);
    const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
    return {
        publicKey: Buffer.from(`untrusted comment: test key\n${key.toString('base64')}\n`).toString('base64'),
        signature(bytes) {
            const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
            const packet = Buffer.concat([Buffer.from('ED'), id, signature]);
            const comment = 'test artifact';
            const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
            return Buffer.from(
                `untrusted comment: test\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`
            ).toString('base64');
        },
    };
}

const platformFiles = [
    'mac_arm64.app.tar.gz',
    'mac_x64.app.tar.gz',
    'windows_x64_setup.nsis.zip',
    'windows_x86_setup.nsis.zip',
    'windows_arm64_setup.nsis.zip',
    'linux_x64.tar.gz',
];

test('desktop workflow builds macOS, Windows and Linux in one release', async () => {
    const workflow = await readFile('.github/workflows/release-desktop.yml', 'utf8');
    for (const fragment of [
        'macos-15',
        'macos-15-intel',
        'windows-latest',
        'x86_64-pc-windows-msvc',
        'i686-pc-windows-msvc',
        'aarch64-pc-windows-msvc',
        'x86_64-unknown-linux-gnu',
        'aarch64-unknown-linux-gnu',
        'mac_${new}.${suffix}',
        'windows_${{ matrix.arch }}_setup.exe',
        'linux_arm64.tar.gz',
        'updater/publish-desktop.mjs',
    ])
        assert.ok(workflow.includes(fragment), `release workflow must contain ${fragment}`);
});

test('desktop manifest covers every released updater platform', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cup-desktop-manifest-'));
    try {
        const key = signer();
        for (const suffix of platformFiles) {
            const bytes = Buffer.from(suffix);
            const name = `cup-translate_3.0.10_${suffix}`;
            await writeFile(join(directory, name), bytes);
            await writeFile(join(directory, `${name}.sig`), key.signature(bytes));
        }
        const manifest = await desktopManifest({
            directory,
            repository: 'owner/downloads',
            tag: 'v3.0.10',
            publicKey: key.publicKey,
        });
        assert.deepEqual(Object.keys(manifest.platforms).sort(), [
            'darwin-aarch64',
            'darwin-x86_64',
            'linux-x86_64',
            'windows-aarch64',
            'windows-i686',
            'windows-x86_64',
        ]);
        assert.equal(
            manifest.platforms['windows-x86_64'].url,
            'https://github.com/owner/downloads/releases/download/v3.0.10/cup-translate_3.0.10_windows_x64_setup.nsis.zip'
        );
        await writeFile(join(directory, 'cup-translate_3.0.10_linux_x64.tar.gz'), 'tampered');
        await assert.rejects(
            desktopManifest({
                directory,
                repository: 'owner/downloads',
                tag: 'v3.0.10',
                publicKey: key.publicKey,
            })
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('desktop publisher uploads all platforms before making the release public', async () => {
    const { publishDesktop } = await import('../updater/publish-desktop.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'cup-desktop-publish-'));
    const previous = process.cwd();
    try {
        const key = signer();
        await mkdir(join(directory, 'src-tauri'));
        await mkdir(join(directory, 'release-assets'));
        await writeFile(
            join(directory, 'src-tauri/tauri.conf.json'),
            JSON.stringify({ tauri: { updater: { pubkey: key.publicKey } } })
        );
        await writeFile(join(directory, 'CHANGELOG'), 'Desktop release');
        const binaries = [
            'source.tar.gz',
            'mac_arm64.dmg',
            'mac_x64.dmg',
            'mac_arm64.app.tar.gz',
            'mac_x64.app.tar.gz',
            'windows_x64_setup.exe',
            'windows_x86_setup.exe',
            'windows_arm64_setup.exe',
            'windows_x64.msi',
            'windows_x86.msi',
            'windows_x64_setup.nsis.zip',
            'windows_x86_setup.nsis.zip',
            'windows_arm64_setup.nsis.zip',
            'linux_x64.tar.gz',
            'linux_arm64.tar.gz',
        ];
        for (const suffix of binaries) {
            const name = `cup-translate_3.0.10_${suffix}`;
            const bytes = Buffer.from(suffix);
            await writeFile(join(directory, 'release-assets', name), bytes);
            if (platformFiles.includes(suffix))
                await writeFile(join(directory, 'release-assets', `${name}.sig`), key.signature(bytes));
        }
        process.chdir(directory);
        const uploaded = [];
        let published = false;
        const fakeFetch = async (url, options = {}) => {
            if (url.includes('/releases/latest/')) {
                assert.equal(published, true);
                assert.equal(options.headers?.Authorization, undefined);
                return Response.json({ version: '3.0.10' });
            }
            if (url.startsWith('https://uploads.github.com/')) {
                assert.equal(published, false);
                uploaded.push(new URL(url).searchParams.get('name'));
                return Response.json({});
            }
            if (url.endsWith('/releases/tags/v3.0.10')) return new Response('', { status: 404 });
            if (options.method === 'POST') {
                assert.equal(JSON.parse(options.body).draft, true);
                return Response.json({
                    id: 123,
                    upload_url: 'https://uploads.github.com/repos/owner/downloads/releases/123/assets{?name}',
                    assets: [],
                });
            }
            if (options.method === 'PATCH') {
                assert.equal(uploaded.length, 23);
                assert.ok(uploaded.includes('cup-translate_3.0.10_windows_arm64_setup.exe'));
                assert.ok(uploaded.includes('cup-translate_3.0.10_linux_arm64.tar.gz'));
                assert.ok(uploaded.includes('update.json'));
                assert.ok(uploaded.includes('SHA256SUMS'));
                published = true;
                return Response.json({});
            }
            return Response.json({ private: false });
        };
        await publishDesktop({
            env: {
                RELEASE_TAG: 'v3.0.10',
                RELEASE_REPOSITORY: 'owner/downloads',
                GITHUB_TOKEN: 'disposable-test-token',
            },
            fetch: fakeFetch,
        });
        assert.equal(published, true);
        const checksums = await readFile('release-assets/SHA256SUMS', 'utf8');
        assert.equal(checksums.trim().split('\n').length, 22);
        let requests = 0;
        await writeFile('release-assets/cup-translate_3.0.10_mac_x64.app.tar.gz', 'tampered');
        await assert.rejects(
            publishDesktop({
                env: {
                    RELEASE_TAG: 'v3.0.10',
                    RELEASE_REPOSITORY: 'owner/downloads',
                    GITHUB_TOKEN: 'disposable-test-token',
                },
                fetch: async () => {
                    requests++;
                    throw Error('must not reach network');
                },
            })
        );
        assert.equal(requests, 0);
    } finally {
        process.chdir(previous);
        await rm(directory, { recursive: true, force: true });
    }
});
