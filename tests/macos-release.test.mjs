import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    macosManifest,
    releaseVersion,
    releaseRepository,
    verifyUpdateSignature,
} from '../updater/release-manifest.mjs';

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

test('release signatures reject changed artifacts, comments and mismatched signing keys', () => {
    const key = signer();
    const bytes = Buffer.from('an updater archive');
    const signature = key.signature(bytes);
    assert.equal(verifyUpdateSignature(bytes, signature, key.publicKey), true);
    assert.throws(() => verifyUpdateSignature(Buffer.from('tampered'), signature, key.publicKey));
    assert.throws(() => verifyUpdateSignature(bytes, signature, signer().publicKey));
    const tampered = Buffer.from(
        Buffer.from(signature, 'base64').toString().replace('test artifact', 'changed')
    ).toString('base64');
    assert.throws(() => verifyUpdateSignature(bytes, tampered, key.publicKey));
});

test('manifest requires both signed architectures and uses public versioned asset URLs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cup-manifest-test-'));
    try {
        const key = signer();
        const options = { directory, repository: 'owner/downloads', tag: 'v3.0.8', publicKey: key.publicKey };
        await assert.rejects(macosManifest(options));
        for (const arch of ['aarch64', 'x64']) {
            const path = join(directory, `cup-translate_3.0.8_${arch}.app.tar.gz`);
            const bytes = Buffer.from(arch);
            await writeFile(path, bytes);
            await writeFile(`${path}.sig`, key.signature(bytes));
        }
        const manifest = await macosManifest(options);
        assert.equal(manifest.version, '3.0.8');
        assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64', 'darwin-x86_64']);
        assert.equal(
            manifest.platforms['darwin-x86_64'].url,
            'https://github.com/owner/downloads/releases/download/v3.0.8/cup-translate_3.0.8_x64.app.tar.gz'
        );
        await writeFile(join(directory, 'cup-translate_3.0.8_x64.app.tar.gz'), 'changed');
        await assert.rejects(macosManifest(options));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('release inputs reject unsafe paths and non-stable versions', () => {
    assert.equal(releaseVersion('v3.0.8'), '3.0.8');
    for (const tag of ['v3.0.8-beta', '../3.0.8', '', 'v3.0']) assert.throws(() => releaseVersion(tag));
    for (const repo of ['../owner/repo', 'https://github.com/a/b', 'a/b?token=x'])
        assert.throws(() => releaseRepository(repo));
});

test('publisher uploads all assets and source before making the release public', async () => {
    const { mkdir, readFile } = await import('node:fs/promises');
    const { publishMacos } = await import('../updater/publish-macos.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'cup-publish-test-'));
    const previous = process.cwd();
    try {
        const key = signer();
        await mkdir(join(directory, 'src-tauri'));
        await mkdir(join(directory, 'release-assets'));
        await writeFile(
            join(directory, 'src-tauri/tauri.conf.json'),
            JSON.stringify({ tauri: { updater: { pubkey: key.publicKey } } })
        );
        await writeFile(join(directory, 'CHANGELOG'), 'Test release');
        for (const arch of ['aarch64', 'x64']) {
            const bytes = Buffer.from(arch);
            for (const suffix of ['dmg', 'app.tar.gz'])
                await writeFile(join(directory, `release-assets/cup-translate_3.0.8_${arch}.${suffix}`), bytes);
            await writeFile(
                join(directory, `release-assets/cup-translate_3.0.8_${arch}.app.tar.gz.sig`),
                key.signature(bytes)
            );
        }
        await writeFile(join(directory, 'release-assets/cup-translate_3.0.8_source.tar.gz'), 'matching source');
        process.chdir(directory);
        const uploaded = [];
        let published = false;
        const fakeFetch = async (url, options = {}) => {
            if (url.includes('/releases/latest/')) {
                assert.equal(published, true);
                assert.equal(options.headers?.Authorization, undefined, 'public client verification must be anonymous');
                return Response.json({ version: '3.0.8' });
            }
            if (url.startsWith('https://uploads.github.com/')) {
                assert.equal(published, false);
                uploaded.push(new URL(url).searchParams.get('name'));
                return Response.json({});
            }
            if (url.endsWith('/releases/tags/v3.0.8')) return new Response('', { status: 404 });
            if (options.method === 'POST') {
                assert.equal(JSON.parse(options.body).draft, true);
                return Response.json({
                    id: 123,
                    upload_url: 'https://uploads.github.com/repos/owner/downloads/releases/123/assets{?name}',
                    assets: [],
                });
            }
            if (options.method === 'PATCH') {
                assert.equal(uploaded.length, 9);
                assert.ok(uploaded.includes('cup-translate_3.0.8_source.tar.gz'));
                assert.ok(uploaded.includes('update.json'));
                assert.ok(uploaded.includes('SHA256SUMS'));
                published = true;
                return Response.json({});
            }
            return Response.json({ private: false });
        };
        await publishMacos({
            env: {
                RELEASE_TAG: 'v3.0.8',
                RELEASE_REPOSITORY: 'owner/downloads',
                GITHUB_TOKEN: 'disposable-test-token',
            },
            fetch: fakeFetch,
        });
        assert.equal(published, true);
        const checksums = await readFile('release-assets/SHA256SUMS', 'utf8');
        assert.equal(checksums.trim().split('\n').length, 8);
        let requests = 0;
        await writeFile('release-assets/cup-translate_3.0.8_x64.app.tar.gz', 'tampered');
        await assert.rejects(
            publishMacos({
                env: {
                    RELEASE_TAG: 'v3.0.8',
                    RELEASE_REPOSITORY: 'owner/downloads',
                    GITHUB_TOKEN: 'disposable-test-token',
                },
                fetch: async () => {
                    requests++;
                    throw Error('must not reach network');
                },
            })
        );
        assert.equal(requests, 0, 'invalid signatures must fail before any GitHub mutation');
    } finally {
        process.chdir(previous);
        await rm(directory, { recursive: true, force: true });
    }
});

test('same-repository publishing uses the public endpoint and narrowly scoped workflow token', async () => {
    const { readFile } = await import('node:fs/promises');
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    assert.deepEqual(config.tauri.updater.endpoints, [
        'https://github.com/charonwwang/cup-translate/releases/latest/download/update.json',
    ]);
    const workflow = await readFile('.github/workflows/macos-release.yml', 'utf8');
    assert.match(workflow, /RELEASE_REPOSITORY: \$\{\{ github\.repository \}\}/);
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(workflow, /publish:\n        permissions:\n            contents: write/);
    assert.doesNotMatch(workflow, /secrets\.RELEASE_PUBLISH_TOKEN|cup-translate-releases/);
    const legacy = await readFile('.github/workflows/package.yml', 'utf8');
    const triggers = legacy.slice(legacy.indexOf('on:'), legacy.indexOf('permissions:'));
    assert.match(triggers, /workflow_dispatch:/);
    assert.doesNotMatch(triggers, /push:/);
});

test('version tags pin desktop builds to the triggering commit and retain the tag as release input', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile('.github/workflows/release-desktop.yml', 'utf8');
    assert.match(workflow, /push:\n        tags: \["v\*"\]/);
    assert.match(workflow, /ref: \$\{\{ inputs\.tag \|\| github\.sha \}\}/);
    assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| .*github\.ref_name.*\}\}/);
});
