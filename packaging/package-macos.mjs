import { mkdtemp, cp, symlink, rm, mkdir, readFile, rename, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyUpdateSignature } from '../updater/release-manifest.mjs';
function run(program, args) {
    const result = spawnSync(program, args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${program} failed`);
}
if (process.platform !== 'darwin') throw new Error('macOS packaging requires macOS');
const target = process.env.RELEASE_TARGET;
const bundle = target ? `src-tauri/target/${target}/release/bundle` : 'src-tauri/target/release/bundle';
const app = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || `${bundle}/macos/cup-translate.app`);
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const version = config.package.version;
// Local previews can avoid Finder reusing an already-mounted release volume.
const volumeName = process.env.DMG_VOLUME_NAME || 'cup-translate';
const arch = target?.startsWith('x86_64') || (!target && process.arch === 'x64') ? 'x64' : 'aarch64';
const output = resolve(process.env.RELEASE_OUTPUT || `${bundle}/dmg`);
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(tmpdir(), 'cup-dmg-'));
const source = join(stage, 'contents');
const python = process.env.DMGBUILD_PYTHON || 'python3';
const probe = spawnSync(python, ['-c', 'import dmgbuild'], { stdio: 'ignore' });
const useDmgbuild = Boolean(process.env.DMGBUILD) || probe.status === 0;
try {
    const stagedApp = join(stage, basename(app));
    await cp(app, stagedApp, { recursive: true, verbatimSymlinks: true });
    // Sign outside Desktop/iCloud, which can re-add Finder metadata during signing.
    run('bash', ['packaging/sign-macos-local.sh', stagedApp]);
    await symlink('/Applications', join(stage, 'Applications'));
    await copyFile('LICENSE', join(stage, '.LICENSE.txt'));
    const dmg = join(output, `cup-translate_${version}_${arch}.dmg`);
    await rm(dmg, { force: true });
    if (useDmgbuild) {
        // dmgbuild writes .DS_Store directly, so the background and icon
        // positions do not depend on Finder automation in headless CI.
        const settingsPath = join(stage, 'dmgbuild-settings.py');
        const settings = `
app = ${JSON.stringify(stagedApp)}
license_file = ${JSON.stringify(join(stage, '.LICENSE.txt'))}
files = [app, license_file]
symlinks = {'Applications': '/Applications'}
icon_locations = {
    ${JSON.stringify(basename(app))}: (382, 254),
    'Applications': (650, 254),
}
background = ${JSON.stringify(resolve('packaging/dmg-background.png'))}
icon = ${JSON.stringify(resolve('src-tauri/icons_mac/icon.icns'))}
# 480 points of content plus the 32-point Finder title bar.
window_rect = ((200, 200), (800, 512))
default_view = 'icon-view'
icon_size = 112
text_size = 13
label_pos = 'bottom'
arrange_by = None
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
format = 'UDZO'
`;
        await writeFile(settingsPath, settings);
        const command = process.env.DMGBUILD || python;
        const args = process.env.DMGBUILD ? [] : ['-m', 'dmgbuild'];
        run(command, [...args, '-s', settingsPath, volumeName, dmg]);
    } else {
        console.warn('dmgbuild is not installed; falling back to a plain hdiutil layout');
        const pending = join(stage, 'installer.dmg');
        // The image must be outside its own source folder.
        await mkdir(source);
        for (const name of [basename(app), 'Applications', '.LICENSE.txt'])
            await rename(join(stage, name), join(source, name));
        run('hdiutil', [
            'create',
            '-volname',
            volumeName,
            '-srcfolder',
            source,
            '-ov',
            '-format',
            'UDZO',
            pending,
        ]);
        await copyFile(pending, dmg);
    }
    run('hdiutil', ['verify', dmg]);
    if (process.argv.includes('--updater')) {
        if (!process.env.TAURI_PRIVATE_KEY) throw new Error('TAURI_PRIVATE_KEY is required for updater artifacts');
        const archive = join(output, `cup-translate_${version}_${arch}.app.tar.gz`);
        // dmgbuild keeps the app at the stage root; the fallback moves it into contents/.
        run('tar', ['-czf', archive, '-C', useDmgbuild ? stage : source, basename(app)]);
        const keyPath = join(stage, 'updater.key');
        await writeFile(keyPath, process.env.TAURI_PRIVATE_KEY, { mode: 0o600 });
        // Invoke directly: pnpm echoes command arguments and could expose the password.
        run(resolve('node_modules/.bin/tauri'), [
            'signer',
            'sign',
            '--private-key-path',
            keyPath,
            '--password',
            process.env.TAURI_KEY_PASSWORD || '',
            archive,
        ]);
        verifyUpdateSignature(
            await readFile(archive),
            await readFile(`${archive}.sig`, 'utf8'),
            config.tauri.updater.pubkey
        );
    }
    console.log(`DMG ready: ${dmg}`);
} finally {
    await rm(stage, { recursive: true, force: true });
}
