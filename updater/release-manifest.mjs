import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function releaseVersion(tag) {
    if (!/^v?\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('Use a stable release tag such as v3.0.8');
    return tag.replace(/^v/, '');
}
export function releaseRepository(repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''))
        throw new Error('Set RELEASE_REPOSITORY to owner/download-repository');
    return repository;
}
export function verifyUpdateSignature(bytes, signature, publicKey) {
    const keyLines = Buffer.from(publicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
    const signatureLines = Buffer.from(signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
    const key = Buffer.from(keyLines.at(-1), 'base64');
    const signed = Buffer.from(signatureLines[1] || '', 'base64');
    if (key.length !== 42 || signed.length !== 74 || !key.subarray(2, 10).equals(signed.subarray(2, 10)))
        throw new Error('Updater signing key does not match the embedded public key');
    const algorithm = signed.subarray(0, 2).toString();
    if (!['ED', 'Ed'].includes(algorithm) || !signatureLines[2]?.startsWith('trusted comment: '))
        throw new Error('Invalid updater signature format');
    const publicObject = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
        format: 'der',
        type: 'spki',
    });
    const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
    if (
        !verify(null, message, publicObject, signed.subarray(10)) ||
        !verify(
            null,
            Buffer.concat([signed.subarray(10), Buffer.from(signatureLines[2].slice('trusted comment: '.length))]),
            publicObject,
            Buffer.from(signatureLines[3] || '', 'base64')
        )
    )
        throw new Error('Updater artifact signature verification failed');
    return true;
}
export async function macosManifest({
    directory,
    repository,
    tag,
    notes = '',
    publicKey,
    date = new Date().toISOString(),
}) {
    releaseRepository(repository);
    const version = releaseVersion(tag);
    const platforms = {};
    for (const [arch, target] of [
        ['aarch64', 'darwin-aarch64'],
        ['x64', 'darwin-x86_64'],
    ]) {
        const name = `cup-translate_${version}_${arch}.app.tar.gz`;
        const bytes = await readFile(`${directory}/${name}`);
        const signature = (await readFile(`${directory}/${name}.sig`, 'utf8')).trim();
        verifyUpdateSignature(bytes, signature, publicKey);
        platforms[target] = {
            url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
            signature,
        };
    }
    return { version, notes, pub_date: date, platforms };
}

const desktopPlatforms = [
    ['darwin-aarch64', 'mac_arm64.app.tar.gz'],
    ['darwin-x86_64', 'mac_x64.app.tar.gz'],
    ['windows-x86_64', 'windows_x64_setup.nsis.zip'],
    ['windows-i686', 'windows_x86_setup.nsis.zip'],
    ['windows-aarch64', 'windows_arm64_setup.nsis.zip'],
    ['linux-x86_64', 'linux_x64.AppImage.tar.gz'],
];

export async function desktopManifest({
    directory,
    repository,
    tag,
    downloadTag = tag,
    notes = '',
    publicKey,
    date = new Date().toISOString(),
}) {
    releaseRepository(repository);
    const version = releaseVersion(tag);
    const downloadVersion = String(downloadTag).match(/(\d+\.\d+\.\d+)$/)?.[1];
    if (!downloadVersion)
        throw new Error(`Invalid updater download tag: ${downloadTag}`);
    const platforms = {};
    for (const [target, suffix] of desktopPlatforms) {
        const name = `cup-translate_${version}_${suffix}`;
        const bytes = await readFile(`${directory}/${name}`);
        const signature = (await readFile(`${directory}/${name}.sig`, 'utf8')).trim();
        verifyUpdateSignature(bytes, signature, publicKey);
        platforms[target] = {
            url: `https://github.com/${repository}/releases/download/${downloadTag}/${name}`,
            signature,
        };
    }
    return { version, notes, pub_date: date, platforms };
}
