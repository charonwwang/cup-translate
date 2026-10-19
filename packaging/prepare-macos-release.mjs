import { readFile, writeFile } from 'node:fs/promises';
import { releaseVersion, releaseRepository } from '../updater/release-manifest.mjs';
const version = releaseVersion(process.env.RELEASE_TAG);
const repository = releaseRepository(process.env.RELEASE_REPOSITORY || 'charonwwang/cup-translate');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
packageJson.version = version;
config.package.version = version;
config.tauri.updater.endpoints = [`https://github.com/${repository}/releases/latest/download/update.json`];
await writeFile('package.json', JSON.stringify(packageJson, null, 4) + '\n');
await writeFile('src-tauri/tauri.conf.json', JSON.stringify(config, null, 4) + '\n');
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
await writeFile('src-tauri/Cargo.toml', cargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
console.log(`Prepared desktop release ${version} for ${repository}; embedded updater public key preserved.`);

const lock = await readFile('src-tauri/Cargo.lock', 'utf8');
await writeFile('src-tauri/Cargo.lock', lock.replace(/(name = "cup-translate"\nversion = )"[^"]+"/, `$1"${version}"`));
