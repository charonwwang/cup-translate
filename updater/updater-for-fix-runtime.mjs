// cup-translate updater manifest generator (Windows, WebView2 fixed-runtime variant)
//
// 生成 update-fix-runtime.json，由 CI 的 release-update job 调用。
//
// 用途：面向未预装 WebView2 的 Windows 用户，安装包内嵌 WebView2 固定版本运行时。
// 产物名中的 `_fix_webview2_runtime` 段由 CI 的 build-for-windows-fix-runtime job 重命名产生，
// 若该 job 中的前缀改了，这里必须同步。
import fetch from 'node-fetch';
import { writeFile } from 'node:fs/promises';

const REPO = 'charonwwang/cup-translate';
const RELEASES = `https://github.com/${REPO}/releases/download`;

async function resolveUpdater() {
    const token = process.env.GITHUB_TOKEN;
    const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
    if (!token || !tag) {
        throw new Error('GITHUB_TOKEN and RELEASE_TAG are required');
    }

    const release = await getRelease(token, tag);
    const version = release.tag_name;
    const changelog = release.body;

    // tag 可能是 v3.1.0，而产物名中的版本号不带 v 前缀（来自 tauri.conf.json 的 version）。
    const assetVersion = version.replace(/^v/, '');
    const url_ = (name) => `${RELEASES}/${version}/${name}`;
    const entry = async (name) => ({
        url: url_(name),
        signature: await getSignature(url_(`${name}.sig`)),
    });

    let updateData = {
        name: version,
        notes: changelog,
        pub_date: new Date().toISOString(),
        platforms: {
            'windows-x86_64': await entry(`cup-translate_${assetVersion}_x64_fix_webview2_runtime-setup.nsis.zip`),
            'windows-i686': await entry(`cup-translate_${assetVersion}_x86_fix_webview2_runtime-setup.nsis.zip`),
            'windows-aarch64': await entry(`cup-translate_${assetVersion}_arm64_fix_webview2_runtime-setup.nsis.zip`),
        },
    };
    await writeFile('./update-fix-runtime.json', JSON.stringify(updateData, null, 2));
}

async function getRelease(token, tag) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!res.ok) {
        throw new Error(`Cannot resolve release ${tag} from ${REPO} (status ${res.status})`);
    }
    return res.json();
}

async function getSignature(url) {
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!response.ok) {
        throw new Error(`Cannot fetch signature: ${url} (status ${response.status})`);
    }
    const signature = (await response.text()).trim();
    if (!signature) throw new Error(`Empty signature: ${url}`);
    return signature;
}

resolveUpdater().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
