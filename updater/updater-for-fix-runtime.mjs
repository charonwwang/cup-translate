// cup-translate updater manifest generator (Windows, WebView2 fixed-runtime variant)
//
// 生成 update-fix-runtime.json，由 CI 的 release-update job 调用。
//
// 用途：面向未预装 WebView2 的 Windows 用户，安装包内嵌 WebView2 固定版本运行时。
// 产物名中的 `_fix_webview2_runtime` 段由 CI 的 build-for-windows-fix-runtime job 重命名产生，
// 若该 job 中的前缀改了，这里必须同步。
import fetch from 'node-fetch';
import fs from 'fs';

const REPO = 'charonwwang/cup-translate';
const RELEASES = `https://github.com/${REPO}/releases/download`;

async function resolveUpdater() {
    if (process.env.GITHUB_TOKEN === undefined) {
        throw new Error('GITHUB_TOKEN is required');
    }

    const TOKEN = process.env.GITHUB_TOKEN;
    let version = await getVersion(TOKEN);
    let changelog = await getChangeLog(TOKEN);

    if (!version) {
        throw new Error(`Cannot resolve the latest release tag from ${REPO}. Has a release been published?`);
    }

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
    fs.writeFile('./update-fix-runtime.json', JSON.stringify(updateData, null, 2), (e) => {
        if (e) console.error(e);
    });
}

async function getRelease(token) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.ok) {
        return await res.json();
    }
    return null;
}

async function getVersion(token) {
    const data = await getRelease(token);
    return data && data['tag_name'];
}

async function getChangeLog(token) {
    const data = await getRelease(token);
    return data && data['body'];
}

async function getSignature(url) {
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (response.ok) {
        return response.text();
    } else {
        // 空签名会让用户端在安装阶段验签失败并中止。
        console.error(`WARNING: cannot fetch signature: ${url} (status ${response.status})`);
        return '';
    }
}

resolveUpdater().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
