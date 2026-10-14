import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

async function findDebs(root) {
    const matches = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.name.endsWith('.deb')) matches.push(path);
        }
    }
    await visit(root);
    return matches;
}

function packageForSoname(soname) {
    if (soname === 'libwebkit2gtk-4.1.so.0') return 'libwebkit2gtk-4.1-0';
    if (soname === 'libwebkit2gtk-4.0.so.37') return 'libwebkit2gtk-4.0-37';
    if (soname === 'libjavascriptcoregtk-4.1.so.0') return 'libjavascriptcoregtk-4.1-0';
    if (soname === 'libjavascriptcoregtk-4.0.so.18') return 'libjavascriptcoregtk-4.0-18';
    return null;
}

async function normalizeDeb(debPath) {
    const workDir = await mkdtemp(join(tmpdir(), 'cup-translate-deb-'));
    try {
        run('dpkg-deb', ['--raw-extract', debPath, workDir]);
        const binary = join(workDir, 'usr/bin/cup-translate');
        const dynamicSection = run('readelf', ['-d', binary]);
        const requiredPackages = [...dynamicSection.matchAll(/Shared library: \[([^\]]+)\]/g)]
            .map((match) => packageForSoname(match[1]))
            .filter(Boolean);

        if (requiredPackages.length === 0) {
            throw new Error(`Could not detect WebKitGTK ABI used by ${binary}`);
        }

        const controlPath = join(workDir, 'DEBIAN/control');
        let control = await readFile(controlPath, 'utf8');
        control = control.replace(/^Depends: (.+)$/m, (_, rawDependencies) => {
            const dependencies = rawDependencies
                .split(',')
                .map((dependency) => dependency.trim())
                .filter(
                    (dependency) =>
                        dependency &&
                        !dependency.startsWith('libwebkit2gtk-') &&
                        !dependency.startsWith('libjavascriptcoregtk-')
                );
            return `Depends: ${[...new Set([...dependencies, ...requiredPackages])].join(', ')}`;
        });
        await writeFile(controlPath, control);
        run('dpkg-deb', ['--build', '--root-owner-group', workDir, debPath]);
        process.stdout.write(`Normalized dependencies in ${basename(debPath)}: ${requiredPackages.join(', ')}\n`);
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}

const targetRoot = resolve(process.argv[2] ?? 'src-tauri/target');
const debs = await findDebs(targetRoot);
if (debs.length === 0) throw new Error(`No .deb packages found below ${targetRoot}`);
for (const deb of debs) await normalizeDeb(deb);
