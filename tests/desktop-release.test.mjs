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

const updaterPlatformFiles = [
    'mac_arm64.app.tar.gz',
    'mac_x64.app.tar.gz',
    'windows_x64_setup.nsis.zip',
    'windows_x86_setup.nsis.zip',
    'windows_arm64_setup.nsis.zip',
    'linux_x64.AppImage.tar.gz',
];

const mainFiles = [
    'source.tar.gz',
    'mac_arm64.dmg',
    'mac_x64.dmg',
    'windows_x64_setup.exe',
    'windows_x86_setup.exe',
    'windows_arm64_setup.exe',
    'windows_x64.msi',
    'windows_x86.msi',
    'linux_x64.tar.gz',
    'linux_arm64.tar.gz',
];

test('desktop workflow builds all platforms and separates updater payloads', async () => {
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
        'linux_${{ matrix.arch }}.tar.gz',
        'linux_x64.AppImage.tar.gz',
        'updater/publish-desktop.mjs',
    ])
        assert.ok(workflow.includes(fragment), `release workflow must contain ${fragment}`);
});

test('dmgbuild packaging keeps updater archives rooted at the staged app', async () => {
    const packager = await readFile('packaging/package-macos.mjs', 'utf8');
    assert.match(
        packager,
        /const source = join\(stage, 'contents'\)/,
        'the fallback source directory must be declared outside the fallback branch'
    );
    assert.match(
        packager,
        /'-C',\s*useDmgbuild \? stage : source,\s*basename\(app\)/,
        'updater packaging must use the stage root for dmgbuild and contents/ for the fallback'
    );
});

test('desktop manifest points updater platforms at the dedicated updater release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cup-desktop-manifest-'));
    try {
        const key = signer();
        for (const suffix of updaterPlatformFiles) {
            const bytes = Buffer.from(suffix);
            const name = `cup-translate_3.0.11_${suffix}`;
            await writeFile(join(directory, name), bytes);
            await writeFile(join(directory, `${name}.sig`), key.signature(bytes));
        }
        const options = {
            directory,
            repository: 'owner/downloads',
            tag: 'v3.0.11',
            downloadTag: 'updater-v3.0.11',
            publicKey: key.publicKey,
        };
        const manifest = await desktopManifest(options);
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
            'https://github.com/owner/downloads/releases/download/updater-v3.0.11/cup-translate_3.0.11_windows_x64_setup.nsis.zip'
        );
        assert.equal(
            manifest.platforms['linux-x86_64'].url,
            'https://github.com/owner/downloads/releases/download/updater-v3.0.11/cup-translate_3.0.11_linux_x64.AppImage.tar.gz'
        );
        await writeFile(join(directory, 'cup-translate_3.0.11_linux_x64.AppImage.tar.gz'), 'tampered');
        await assert.rejects(desktopManifest(options));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('desktop publisher keeps installers and updater payloads in separate releases', async () => {
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
        for (const suffix of mainFiles) {
            const name = `cup-translate_3.0.11_${suffix}`;
            await writeFile(join(directory, 'release-assets', name), Buffer.from(suffix));
        }
        for (const suffix of updaterPlatformFiles) {
            const name = `cup-translate_3.0.11_${suffix}`;
            const bytes = Buffer.from(suffix);
            await writeFile(join(directory, 'release-assets', name), bytes);
            await writeFile(join(directory, 'release-assets', `${name}.sig`), key.signature(bytes));
        }
        process.chdir(directory);
        const uploaded = new Map([
            [1, []],
            [2, []],
        ]);
        let updaterPublished = false;
        let mainPublished = false;
        const fakeFetch = async (url, options = {}) => {
            if (url.includes('/releases/latest/download/update.json')) {
                assert.equal(mainPublished, true);
                assert.equal(options.headers?.Authorization, undefined);
                return Response.json({ version: '3.0.11' });
            }
            if (url.startsWith('https://uploads.github.com/')) {
                const id = Number(new URL(url).pathname.match(/releases\/(\d+)\/assets/)?.[1]);
                uploaded.get(id).push(new URL(url).searchParams.get('name'));
                return Response.json({});
            }
            if (url.endsWith('/releases/tags/v3.0.11') || url.endsWith('/releases/tags/updater-v3.0.11'))
                return new Response('', { status: 404 });
            if (url.endsWith('/releases') && options.method === 'POST') {
                const body = JSON.parse(options.body);
                const id = body.tag_name.startsWith('updater-') ? 1 : 2;
                return Response.json({
                    id,
                    upload_url: `https://uploads.github.com/repos/owner/downloads/releases/${id}/assets{?name}`,
                    assets: [],
                });
            }
            if (url.endsWith('/releases/1') && options.method === 'PATCH') {
                const body = JSON.parse(options.body);
                assert.deepEqual(body, { draft: false, prerelease: true });
                updaterPublished = true;
                return Response.json({});
            }
            if (url.endsWith('/releases/2') && options.method === 'PATCH') {
                const body = JSON.parse(options.body);
                assert.deepEqual(body, { draft: false, prerelease: false, make_latest: 'true' });
                assert.equal(updaterPublished, true);
                mainPublished = true;
                return Response.json({});
            }
            return Response.json({ private: false });
        };
        await publishDesktop({
            env: {
                RELEASE_TAG: 'v3.0.11',
                RELEASE_REPOSITORY: 'owner/downloads',
                GITHUB_TOKEN: 'disposable-test-token',
            },
            fetch: fakeFetch,
        });
        assert.equal(mainPublished, true);
        assert.equal(updaterPublished, true);
        assert.equal(uploaded.get(1).length, 12);
        assert.equal(uploaded.get(2).length, 12);
        for (const name of uploaded.get(2)) {
            assert.ok(!name.endsWith('.sig'));
            assert.ok(!name.endsWith('.nsis.zip'));
            assert.ok(!name.endsWith('.app.tar.gz'));
            assert.ok(!name.includes('AppImage'));
        }
        assert.ok(uploaded.get(2).includes('cup-translate_3.0.11_windows_arm64_setup.exe'));
        assert.ok(uploaded.get(2).includes('cup-translate_3.0.11_linux_arm64.tar.gz'));
        assert.ok(uploaded.get(2).includes('update.json'));
        assert.ok(uploaded.get(2).includes('SHA256SUMS'));
        assert.ok(uploaded.get(1).includes('cup-translate_3.0.11_linux_x64.AppImage.tar.gz'));
        const manifest = JSON.parse(await readFile('release-assets/update.json', 'utf8'));
        assert.ok(
            Object.values(manifest.platforms).every((platform) =>
                platform.url.includes('/releases/download/updater-v3.0.11/')
            )
        );
        const checksums = await readFile('release-assets/SHA256SUMS', 'utf8');
        assert.equal(checksums.trim().split('\n').length, 11);
        let requests = 0;
        await writeFile('release-assets/cup-translate_3.0.11_mac_x64.app.tar.gz', 'tampered');
        await assert.rejects(
            publishDesktop({
                env: {
                    RELEASE_TAG: 'v3.0.11',
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
