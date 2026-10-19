import { desktopManifest, releaseVersion, releaseRepository } from './release-manifest.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function releaseFiles(version) {
    const name = (suffix) => `cup-translate_${version}_${suffix}`;
    return [
        'source.tar.gz',
        'mac_arm64.dmg',
        'mac_x64.dmg',
        'mac_arm64.app.tar.gz',
        'mac_arm64.app.tar.gz.sig',
        'mac_x64.app.tar.gz',
        'mac_x64.app.tar.gz.sig',
        'windows_x64_setup.exe',
        'windows_x86_setup.exe',
        'windows_arm64_setup.exe',
        'windows_x64.msi',
        'windows_x86.msi',
        'windows_x64_setup.nsis.zip',
        'windows_x64_setup.nsis.zip.sig',
        'windows_x86_setup.nsis.zip',
        'windows_x86_setup.nsis.zip.sig',
        'windows_arm64_setup.nsis.zip',
        'windows_arm64_setup.nsis.zip.sig',
        'linux_x64.tar.gz',
        'linux_x64.tar.gz.sig',
        'linux_arm64.tar.gz',
    ].map(name);
}

export async function publishDesktop({ env = process.env, fetch = globalThis.fetch } = {}) {
    const repository = releaseRepository(
        env.RELEASE_REPOSITORY || env.GITHUB_REPOSITORY || 'charonwwang/cup-translate'
    );
    const version = releaseVersion(env.RELEASE_TAG);
    const token = env.GITHUB_TOKEN || env.RELEASE_PUBLISH_TOKEN;
    if (!token) throw new Error('Set GITHUB_TOKEN with Contents: write access to the release repository');
    const directory = env.RELEASE_DIRECTORY || 'release-assets';
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    const files = releaseFiles(version);
    // Validate every artifact and signing-key pair before mutating GitHub.
    for (const name of files)
        if (!(await readFile(join(directory, name))).length) throw new Error(`Empty release artifact: ${name}`);
    const notes = (await readFile('CHANGELOG', 'utf8')).slice(0, 40000);
    const manifest = await desktopManifest({
        directory,
        repository,
        tag: `v${version}`,
        notes,
        publicKey: config.tauri.updater.pubkey,
    });
    await writeFile(join(directory, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');
    files.push('update.json');
    const checksums = await Promise.all(
        files.map(
            async (name) =>
                `${createHash('sha256')
                    .update(await readFile(join(directory, name)))
                    .digest('hex')}  ${name}`
        )
    );
    await writeFile(join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
    files.push('SHA256SUMS');
    async function request(path, options = {}) {
        const url = path.startsWith('https://uploads.github.com/') ? path : `https://api.github.com${path}`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(300000),
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...options.headers,
            },
        });
        if (!response.ok) throw new Error(`GitHub release request failed (HTTP ${response.status})`);
        return response.status === 204 ? null : response.json();
    }
    const repo = await request(`/repos/${repository}`);
    if (repo.private)
        throw new Error('The download repository must be public; desktop clients do not contain a GitHub token');
    let release;
    const existing = await fetch(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (existing.status === 200) {
        release = await existing.json();
        if (!release.draft)
            throw new Error('This version is already published. Use a new version; released artifacts are immutable.');
    } else if (existing.status === 404) {
        release = await request(`/repos/${repository}/releases`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tag_name: `v${version}`,
                name: `cup-translate ${version}`,
                body: notes,
                draft: true,
                prerelease: false,
            }),
        });
    } else throw new Error(`Cannot inspect release (HTTP ${existing.status})`);
    for (const name of files) {
        const old = release.assets?.find((asset) => asset.name === name);
        if (old) await request(`/repos/${repository}/releases/assets/${old.id}`, { method: 'DELETE' });
        const upload = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`;
        await request(upload, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: await readFile(join(directory, name)),
        });
    }
    // Publication is last: clients never see a latest release with missing artifacts.
    await request(`/repos/${repository}/releases/${release.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false, make_latest: 'true' }),
    });
    let readable = false;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const response = await fetch(`https://github.com/${repository}/releases/latest/download/update.json`, {
                signal: AbortSignal.timeout(30000),
            });
            if (response.ok && (await response.json()).version === version) {
                readable = true;
                break;
            }
        } catch {}
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!readable)
        throw new Error('Published manifest is not yet publicly readable. Check the release before retrying.');
    console.log(
        `Published v${version}: macOS, Windows, Linux installers, signed updater archives, source, and manifests.`
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await publishDesktop();
