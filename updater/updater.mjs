// cup-translate updater manifest generator
//
// 生成 update.json（Tauri v1 更新器清单），由 CI 的 release-update job 调用。
//
// 改动前务必阅读的背景：
//   - 本文件继承自 pot-app/pot-desktop，原版指向上游仓库与 pot_ 产物名，已全部改为 cup-translate。
//   - 产物名规则（与 CI package.yml 及各 bundle 实际输出一致）：
//       macOS   : cup-translate_<ver>_aarch64.app.tar.gz / _x64.app.tar.gz
//       Windows : cup-translate_<ver>_x64-setup.nsis.zip（另有 _x86 / _arm64）
//       Linux   : cup-translate_<ver>_amd64.AppImage.tar.gz
//   - macOS 的两个 .app.tar.gz 由 CI 的 "Change File Name" 步骤从 cup-translate.app.tar.gz 改名而来，
//     若改名步骤中的前缀改了，这里必须同步。
//   - Linux 仅保留 x86_64：CI 只为 x86_64 构建 AppImage，且 Tauri 更新器在 Linux 上只支持
//     AppImage 自替换。i686/aarch64/armv7 条目已删除——上游原版把这三项错误地指向 macOS 产物，
//     会导致用户下载到无法安装的包。
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
            'darwin-aarch64': await entry(`cup-translate_${assetVersion}_aarch64.app.tar.gz`),
            'darwin-x86_64': await entry(`cup-translate_${assetVersion}_x64.app.tar.gz`),
            'windows-x86_64': await entry(`cup-translate_${assetVersion}_x64-setup.nsis.zip`),
            'windows-i686': await entry(`cup-translate_${assetVersion}_x86-setup.nsis.zip`),
            'windows-aarch64': await entry(`cup-translate_${assetVersion}_arm64-setup.nsis.zip`),
            'linux-x86_64': await entry(`cup-translate_${assetVersion}_amd64.AppImage.tar.gz`),
        },
    };
    await writeFile('./update.json', JSON.stringify(updateData, null, 2));
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
