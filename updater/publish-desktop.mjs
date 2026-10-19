import { desktopManifest, releaseVersion, releaseRepository } from './release-manifest.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function releaseAssets(version) {
    const name = (suffix) => `cup-translate_${version}_${suffix}`;
    return {
        main: [
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
        ].map(name),
        updater: [
            'mac_arm64.app.tar.gz',
            'mac_arm64.app.tar.gz.sig',
            'mac_x64.app.tar.gz',
            'mac_x64.app.tar.gz.sig',
            'windows_x64_setup.nsis.zip',
            'windows_x64_setup.nsis.zip.sig',
            'windows_x86_setup.nsis.zip',
            'windows_x86_setup.nsis.zip.sig',
            'windows_arm64_setup.nsis.zip',
            'windows_arm64_setup.nsis.zip.sig',
            'linux_x64.AppImage.tar.gz',
            'linux_x64.AppImage.tar.gz.sig',
        ].map(name),
    };
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
    const mainTag = `v${version}`;
    const updaterTag = `updater-v${version}`;
    const assets = releaseAssets(version);

    // Validate every artifact before mutating GitHub.
    for (const name of [...assets.main, ...assets.updater])
        if (!(await readFile(join(directory, name))).length) throw new Error(`Empty release artifact: ${name}`);

    const notes = (await readFile('CHANGELOG', 'utf8')).slice(0, 40000);
    const manifest = await desktopManifest({
        directory,
        repository,
        tag: mainTag,
        downloadTag: updaterTag,
        notes,
        publicKey: config.tauri.updater.pubkey,
    });
    await writeFile(join(directory, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');
    const mainFiles = [...assets.main, 'update.json'];
    const checksums = await Promise.all(
        mainFiles.map(
            async (name) =>
                `${createHash('sha256')
                    .update(await readFile(join(directory, name)))
                    .digest('hex')}  ${name}`
        )
    );
    await writeFile(join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
    mainFiles.push('SHA256SUMS');

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

    async function fetchRelease(tag) {
        const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
            signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
        if (response.status === 200) return response.json();
        if (response.status === 404) return null;
        throw new Error(`Cannot inspect release ${tag} (HTTP ${response.status})`);
    }

    const repo = await request(`/repos/${repository}`);
    if (repo.private)
        throw new Error('The download repository must be public; desktop clients do not contain a GitHub token');

    // Never start uploading if the immutable main release already exists.
    for (const tag of [mainTag, updaterTag]) {
        const existing = await fetchRelease(tag);
        if (existing && !existing.draft)
            throw new Error(`Release ${tag} is already published. Use a new version; released artifacts are immutable.`);
    }

    async function ensureDraft(tag, name, body, prerelease) {
        const existing = await fetchRelease(tag);
        if (existing) return existing;
        const payload = {
            tag_name: tag,
            name,
            body,
            draft: true,
            prerelease,
        };
        if (env.GITHUB_SHA) payload.target_commitish = env.GITHUB_SHA;
        return request(`/repos/${repository}/releases`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    }

    async function upload(release, files) {
        for (const name of files) {
            const old = release.assets?.find((asset) => asset.name === name);
            if (old) await request(`/repos/${repository}/releases/assets/${old.id}`, { method: 'DELETE' });
            const target = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`;
            await request(target, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: await readFile(join(directory, name)),
            });
        }
    }

    async function publish(release, { prerelease, latest }) {
        const body = { draft: false, prerelease };
        if (latest) body.make_latest = 'true';
        await request(`/repos/${repository}/releases/${release.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    const updaterRelease = await ensureDraft(
        updaterTag,
        `cup-translate ${version} updater payloads`,
        `自动更新专用文件，不是安装包。\n\n请从主发布下载安装包：https://github.com/${repository}/releases/tag/${mainTag}\n`,
        true
    );
    await upload(updaterRelease, assets.updater);
    const mainRelease = await ensureDraft(mainTag, `cup-translate ${version}`, notes, false);
    await upload(mainRelease, mainFiles);

    // Publish the updater payloads first so every URL in update.json is live
    // before the installer release becomes the public latest release.
    await publish(updaterRelease, { prerelease: true, latest: false });
    await publish(mainRelease, { prerelease: false, latest: true });

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
        `Published v${version}: 9 installers in the main release; updater payloads in ${updaterTag}; source and manifests included.`
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await publishDesktop();
